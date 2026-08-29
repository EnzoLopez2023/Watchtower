import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import type { MonitoringArchiveStorage, PutBytesOptions } from "../../lib/monitoring/monitoringArchive.js";
import { RecoveryError } from "../../lib/recovery/errors.js";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_API_VERSION = "2023-11-03";
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const FORBIDDEN_CREDENTIAL_VARIABLES = [
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "MONITORING_ARCHIVE_CONNECTION_STRING",
  "MONITORING_ARCHIVE_ACCOUNT_KEY",
  "MONITORING_ARCHIVE_SAS_TOKEN",
];

function assertManagedIdentityOnly(): void {
  const forbidden = FORBIDDEN_CREDENTIAL_VARIABLES.filter((n) =>
    String(process.env[n] ?? "").trim()
  );
  if (forbidden.length > 0) {
    throw new RecoveryError(
      "STORAGE_SHARED_CREDENTIAL_REJECTED",
      `Shared-key and connection-string credentials are prohibited: ${forbidden.join(", ")}`
    );
  }
}

function validateAccount(account: string): string {
  const value = account.trim();
  if (!value) {
    throw new RecoveryError("BLOB_CONFIGURATION_INVALID", "Azure Storage account is required");
  }
  if (!/^[a-z0-9]{3,24}$/.test(value)) {
    throw new RecoveryError(
      "BLOB_CONFIGURATION_INVALID",
      "Azure Storage account must be 3-24 lowercase alphanumeric characters"
    );
  }
  return value;
}

function validateContainer(container: string): string {
  const value = container.trim();
  if (!value) {
    throw new RecoveryError("BLOB_CONFIGURATION_INVALID", "Azure Storage container is required");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value)) {
    throw new RecoveryError("BLOB_CONFIGURATION_INVALID", "Azure Blob container name is invalid");
  }
  return value;
}

function blobUrl(account: string, container: string, name: string): string {
  const encoded = name
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://${account}.blob.core.windows.net/${encodeURIComponent(container)}/${encoded}`;
}

function rawErrorCode(status: number, headers: Record<string, string | string[] | undefined>): string {
  const svc = String(headers["x-ms-error-code"] ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 48);
  return svc ? `AZURE_BLOB_${status}_${svc}` : `AZURE_BLOB_HTTP_${status}`;
}


export class MonitoringArchiveBlobClient implements MonitoringArchiveStorage {
  public readonly account: string;
  public readonly container: string;
  private readonly credential: DefaultAzureCredential;
  private readonly timeoutMs: number;

  public constructor(opts: {
    account: string;
    container: string;
    timeoutMs?: number;
  }) {
    assertManagedIdentityOnly();
    this.account = validateAccount(opts.account);
    this.container = validateContainer(opts.container);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.credential = new DefaultAzureCredential();
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.credential.getToken(STORAGE_SCOPE);
    if (!token?.token) {
      throw new RecoveryError(
        "BLOB_REQUEST_FAILED",
        "Managed identity did not return an Azure Storage token"
      );
    }
    return {
      Authorization: `Bearer ${token.token}`,
      "x-ms-date": new Date().toUTCString(),
      "x-ms-version": STORAGE_API_VERSION,
      ...extra,
    };
  }

  public async headBlob(
    name: string,
    opts: { allowNotFound?: boolean } = {}
  ): Promise<{ etag: string; bytes: number } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(blobUrl(this.account, this.container, name), {
        method: "HEAD",
        headers: await this.authHeaders(),
        signal: controller.signal,
      });
      if (opts.allowNotFound && resp.status === 404) return null;
      if (!resp.ok) {
        throw new RecoveryError(
          "BLOB_REQUEST_FAILED",
          `Azure Blob HEAD failed with ${resp.status}`
        );
      }
      return {
        etag: resp.headers.get("etag") ?? "",
        bytes: Number(resp.headers.get("content-length") ?? 0),
      };
    } catch (err) {
      if (err instanceof RecoveryError) throw err;
      throw new RecoveryError("BLOB_REQUEST_FAILED", "Azure Blob HEAD request failed", {
        cause: String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  public async putBytes(
    name: string,
    body: Buffer,
    opts: PutBytesOptions = {}
  ): Promise<{ etag: string | null }> {
    const { createOnly = false, ifMatch, contentType = "application/octet-stream", contentEncoding, metadata = {} } = opts;
    const md5 = createHash("md5").update(body).digest("base64");
    const extraHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Content-MD5": md5,
      "x-ms-blob-type": "BlockBlob",
      ...(contentEncoding ? { "Content-Encoding": contentEncoding } : {}),
      ...(createOnly ? { "If-None-Match": "*" } : {}),
      ...(ifMatch ? { "If-Match": ifMatch } : {}),
      ...Object.fromEntries(
        Object.entries(metadata).map(([k, v]) => [`x-ms-meta-${k}`, String(v)])
      ),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(blobUrl(this.account, this.container, name), {
        method: "PUT",
        headers: await this.authHeaders(extraHeaders),
        body,
        signal: controller.signal,
      });
      if ((createOnly || ifMatch) && (resp.status === 409 || resp.status === 412)) {
        throw new RecoveryError(
          "BLOB_REQUEST_FAILED",
          createOnly ? "Create-only Azure Blob already exists" : "Azure Blob ETag changed"
        );
      }
      if (!resp.ok) {
        throw new RecoveryError("BLOB_REQUEST_FAILED", `Azure Blob PUT failed with ${resp.status}`);
      }
      return { etag: resp.headers.get("etag") };
    } catch (err) {
      if (err instanceof RecoveryError) throw err;
      throw new RecoveryError("BLOB_REQUEST_FAILED", "Azure Blob PUT request failed", {
        cause: String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  public async hashBlob(
    name: string,
    opts: { ifMatch?: string } = {}
  ): Promise<{ sha256: string; bytes: number; etag: string | null }> {
    const headers = await this.authHeaders(
      opts.ifMatch ? { "If-Match": opts.ifMatch } : {}
    );
    let response: Response;
    try {
      response = await fetch(blobUrl(this.account, this.container, name), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RecoveryError("BLOB_REQUEST_FAILED", "Azure Blob GET request failed", {
        cause: String(err),
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RecoveryError(
        "BLOB_REQUEST_FAILED",
        `Azure Blob GET failed with ${response.status}: ${rawErrorCode(response.status, Object.fromEntries(response.headers.entries()))}`
      );
    }
    const hash = createHash("sha256");
    let bytes = 0;
    if (response.body) {
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        hash.update(chunk.value);
        bytes += chunk.value.length;
      }
    }
    return {
      sha256: hash.digest("hex"),
      bytes,
      etag: response.headers.get("etag") ?? null,
    };
  }
}

export function assertBlobHash(
  actual: { sha256: string; bytes: number },
  expectedSha256: string,
  expectedBytes: number,
  label: string
): void {
  if (actual.sha256 !== expectedSha256 || actual.bytes !== expectedBytes) {
    throw new RecoveryError(
      "BLOB_READBACK_MISMATCH",
      `${label} readback hash or bytes do not match`
    );
  }
}
