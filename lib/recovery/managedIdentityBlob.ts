/**
 * Azure Blob access with a system-assigned managed identity only.
 *
 * `@azure/identity` and `undici` are loaded through dynamic `import()` so this
 * module (and everything that re-exports it) stays importable when off-host
 * storage is disabled or those packages are not installed. Shared keys, SAS
 * tokens and connection strings are rejected outright — there is never a static
 * secret in this path.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { RecoveryError } from "./errors.js";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_API_VERSION = "2023-11-03";
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** Environment variables that would imply a shared secret. Never permitted. */
export const FORBIDDEN_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([
  "AZURE_STORAGE_CONNECTION_STRING",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_STORAGE_KEY",
  "AZURE_STORAGE_SAS_TOKEN",
  "WATCHTOWER_BACKUP_CONNECTION_STRING",
  "WATCHTOWER_BACKUP_ACCOUNT_KEY",
  "WATCHTOWER_BACKUP_SAS_TOKEN",
  "OFFHOST_BACKUP_CONNECTION_STRING",
  "OFFHOST_BACKUP_ACCOUNT_KEY",
  "OFFHOST_BACKUP_SAS_TOKEN"
]);

export function assertManagedIdentityOnlyEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const forbidden = FORBIDDEN_CREDENTIAL_VARIABLES.filter((name) => String(env[name] ?? "").trim() !== "");
  if (forbidden.length > 0) {
    throw new RecoveryError(
      "STORAGE_SHARED_CREDENTIAL_REJECTED",
      `Shared-key, SAS and connection-string credentials are prohibited: ${forbidden.join(", ")}`,
      { forbidden }
    );
  }
}

export function validateStorageAccount(account: string): string {
  const value = String(account ?? "").trim();
  if (!/^[a-z0-9]{3,24}$/.test(value)) {
    throw new RecoveryError(
      "BLOB_CONFIGURATION_INVALID",
      "Azure Storage account must be 3-24 lowercase letters or digits"
    );
  }
  return value;
}

export function validateStorageContainer(container: string): string {
  const value = String(container ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value) || value.includes("--")) {
    throw new RecoveryError(
      "BLOB_CONFIGURATION_INVALID",
      "Azure Blob container must be 3-63 lowercase letters, digits or single dashes"
    );
  }
  return value;
}

export function validateBlobName(name: string): string {
  const value = String(name ?? "").trim();
  if (value === "") {
    throw new RecoveryError("BLOB_NAME_INVALID", "Azure Blob name is required");
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new RecoveryError("BLOB_NAME_INVALID", "Azure Blob name is not canonical");
  }
  return value;
}

export function blobUrl(account: string, container: string, name: string): string {
  const encoded = validateBlobName(name).split("/").map(encodeURIComponent).join("/");
  return `https://${validateStorageAccount(account)}.blob.core.windows.net/${encodeURIComponent(
    validateStorageContainer(container)
  )}/${encoded}`;
}

export interface BlobClientOptions {
  readonly account: string;
  readonly container: string;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to a real managed-identity token. */
  readonly tokenProvider?: () => Promise<string>;
  /** Injected in tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface AzureIdentityModule {
  readonly ManagedIdentityCredential: new () => {
    getToken(scope: string): Promise<{ token: string } | null>;
  };
}

async function managedIdentityToken(): Promise<string> {
  let identityModule: AzureIdentityModule;
  try {
    identityModule = await import("@azure/identity");
  } catch (cause) {
    throw new RecoveryError(
      "STORAGE_DEPENDENCY_MISSING",
      "@azure/identity is not installed; off-host recovery requires it",
      { cause: cause instanceof Error ? cause.message : String(cause) }
    );
  }
  const credential = new identityModule.ManagedIdentityCredential();
  const token = await credential.getToken(STORAGE_SCOPE);
  if (!token?.token) {
    throw new RecoveryError("BLOB_REQUEST_FAILED", "Managed identity returned no access token");
  }
  return token.token;
}

function errorCodeFor(status: number, headers: Headers): RecoveryError["code"] {
  void headers;
  void status;
  return "BLOB_REQUEST_FAILED";
}

export interface BlobUploadResult {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly etag: string | null;
}

/** Streams a local file into a block blob using a managed-identity token. */
export async function uploadBlob(
  options: BlobClientOptions & { readonly blobName: string; readonly filePath: string }
): Promise<BlobUploadResult> {
  assertManagedIdentityOnlyEnvironment(options.env ?? process.env);
  const url = blobUrl(options.account, options.container, options.blobName);
  const token = await (options.tokenProvider ?? managedIdentityToken)();
  const doFetch = options.fetchImpl ?? fetch;

  const stats = await stat(options.filePath);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(options.filePath, { highWaterMark: 8 * 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  const sha256 = hash.digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );

  try {
    const body = createReadStream(options.filePath, { highWaterMark: 8 * 1024 * 1024 });
    const request = {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-ms-version": STORAGE_API_VERSION,
        "x-ms-blob-type": "BlockBlob",
        "content-length": String(stats.size),
        "content-type": "application/octet-stream"
      },
      body,
      duplex: "half",
      signal: controller.signal
    } as unknown as RequestInit;
    const response = await doFetch(url, request);

    if (!response.ok) {
      throw new RecoveryError(errorCodeFor(response.status, response.headers), `Azure Blob upload failed`, {
        status: response.status,
        serviceCode: response.headers.get("x-ms-error-code")
      });
    }
    return { url, bytes: stats.size, sha256, etag: response.headers.get("etag") };
  } finally {
    clearTimeout(timeout);
  }
}

export interface BlobReadbackResult {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Reads a blob back and returns its byte length and SHA-256. */
export async function readBlobDigest(
  options: BlobClientOptions & { readonly blobName: string }
): Promise<BlobReadbackResult> {
  assertManagedIdentityOnlyEnvironment(options.env ?? process.env);
  const url = blobUrl(options.account, options.container, options.blobName);
  const token = await (options.tokenProvider ?? managedIdentityToken)();
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "x-ms-version": STORAGE_API_VERSION },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new RecoveryError(errorCodeFor(response.status, response.headers), "Azure Blob read-back failed", {
        status: response.status,
        serviceCode: response.headers.get("x-ms-error-code")
      });
    }
    // `Response.body` is typed as `ReadableStream<any>` here, so it is narrowed
    // once at the boundary and every chunk below is a checked `Uint8Array`.
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (body === null) {
      throw new RecoveryError("BLOB_REQUEST_FAILED", "Azure Blob read-back returned no body");
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const reader = body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
      bytes += chunk.value.byteLength;
    }
    return { url, bytes, sha256: hash.digest("hex") };
  } finally {
    clearTimeout(timeout);
  }
}
