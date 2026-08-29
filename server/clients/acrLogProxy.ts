/**
 * Server-side ACR build-log proxy internals.
 *
 * A container-registry run stores its build log as a blob and hands out a
 * short-lived SAS URL to read it. That URL is a bearer credential — anyone who
 * holds it can replay the download until it expires — so it must never reach the
 * browser. This module fetches the blob server-side under strict bounds
 * (timeout, byte budget, content type) and scrubs the text of ANSI control
 * sequences and any secret-bearing material before it is returned. The upstream
 * URL, the SAS query and any provider error string stay on the server.
 */

/** 2 MiB. Enough for a full build log without letting a hostile blob exhaust memory. */
export const ACR_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Content types we are willing to treat as a plain-text build log. Azure blobs
 * usually carry `application/octet-stream` (or nothing); an error page comes
 * back as `text/html`/`application/xml`/`application/json`, which we reject so a
 * provider error never masquerades as log text.
 */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "",
  "text/plain",
  "text/x-log",
  "application/octet-stream",
  "application/x-log",
]);

export interface AcrLogLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export type AcrLogFailureReason =
  | "upstream_error"
  | "timeout"
  | "unsupported_content_type"
  | "untrusted_url"
  | "network";

export interface AcrLogSuccess {
  readonly ok: true;
  /** Sanitized log text (ANSI stripped, control chars removed, secrets redacted). */
  readonly text: string;
  /** Bytes read from the upstream blob after applying the byte budget. */
  readonly bytes: number;
  /** True when the byte budget stopped the read before the blob ended. */
  readonly truncated: boolean;
}

export interface AcrLogFailure {
  readonly ok: false;
  readonly reason: AcrLogFailureReason;
}

export type AcrLogResult = AcrLogSuccess | AcrLogFailure;

export function isTrustedAcrLogUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.toLowerCase().endsWith(".blob.core.windows.net")
    );
  } catch {
    return false;
  }
}

// ── Sanitization ─────────────────────────────────────────────────────────────

// A CSI/OSC escape sequence. The escape introducers (ESC 0x1B, CSI 0x9B) are
// control characters, hence the scoped rule opt-out.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

// C0 controls except tab (\t) and newline (\n), plus DEL and the C1 range.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// Any Azure Blob Storage URL, SAS query and all — redacted whole so neither the
// host nor the signature survives.
const BLOB_URL_PATTERN = /https?:\/\/[A-Za-z0-9.-]*blob\.core\.windows\.net\/[^\s"'<>`]*/gi;

// Residual SAS query parameters that may appear outside a blob host.
const SAS_QUERY_PATTERN = /([?&](?:sig|se|sp|sv|st|srt|ss|spr|sr|skoid|sktid)=)[^&\s"'<>`]+/gi;

// `Authorization: Bearer <token>` style secrets carried inside a log line.
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

// A three-segment JWT (e.g. an access token echoed into a log).
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

// Storage / connection-string secrets.
const CONNECTION_SECRET_PATTERN = /\b(AccountKey|SharedAccessSignature|SharedAccessKey|AccessKey|Password|pwd)=[^;\s"'<>`]+/gi;

/**
 * Strip terminal escapes and control characters and redact any secret-bearing
 * URL/query material from a build-log body. Redaction is deliberately broad:
 * over-scrubbing a benign query string is preferable to leaking a live SAS
 * signature or bearer token.
 */
export function sanitizeAcrLogText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n");
  text = text.replace(ANSI_PATTERN, "");
  text = text.replace(CONTROL_PATTERN, "");
  text = text.replace(BLOB_URL_PATTERN, "[redacted-url]");
  text = text.replace(SAS_QUERY_PATTERN, "$1[redacted]");
  text = text.replace(BEARER_PATTERN, "Bearer [redacted]");
  text = text.replace(JWT_PATTERN, "[redacted-token]");
  text = text.replace(CONNECTION_SECRET_PATTERN, (_match, key: string) => `${key}=[redacted]`);
  return text;
}

// ── Bounded fetch ────────────────────────────────────────────────────────────

function contentTypeAllowed(header: string): boolean {
  const essence = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_CONTENT_TYPES.has(essence);
}

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError`; a manual abort surfaces as
 * an `AbortError`. Either way the read did not complete in time.
 */
function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = Reflect.get(error, "name");
  return name === "TimeoutError" || name === "AbortError";
}

interface BoundedRead {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * Read the response body incrementally, stopping once `maxBytes` have been
 * accumulated. The stream is cancelled at the cap so an oversized blob is never
 * fully buffered.
 */
async function readBounded(response: Response, maxBytes: number): Promise<BoundedRead> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return { text: "", bytes: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - length;
      if (remaining <= 0) {
        // The budget was filled exactly on a previous chunk and more data
        // follows, so the log really is longer than we are willing to read.
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        length += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  return { text: Buffer.concat(chunks, length).toString("utf8"), bytes: length, truncated };
}

/**
 * Fetch and sanitize an ACR run log from a resolved SAS URL under the supplied
 * bounds. Never throws for an upstream/transport failure: every failure mode is
 * reported as a typed reason with no upstream detail attached.
 */
export async function fetchAcrRunLog(
  sasUrl: string,
  fetchImpl: typeof fetch,
  limits: AcrLogLimits
): Promise<AcrLogResult> {
  if (!isTrustedAcrLogUrl(sasUrl)) {
    return { ok: false, reason: "untrusted_url" };
  }
  let response: Response;
  try {
    response = await fetchImpl(sasUrl, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: isAbortLike(error) ? "timeout" : "network" };
  }

  if (!response.ok) {
    // Release the socket; the typed reason below is the real outcome, and a
    // failure to cancel an already-broken stream is not actionable.
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "upstream_error" };
  }

  if (!contentTypeAllowed(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "unsupported_content_type" };
  }

  let read: BoundedRead;
  try {
    read = await readBounded(response, limits.maxBytes);
  } catch (error) {
    return { ok: false, reason: isAbortLike(error) ? "timeout" : "network" };
  }

  return {
    ok: true,
    text: sanitizeAcrLogText(read.text),
    bytes: read.bytes,
    truncated: read.truncated,
  };
}
