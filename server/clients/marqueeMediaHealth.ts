import {
  ClientSecretCredential,
  DefaultAzureCredential,
  type TokenCredential
} from "@azure/identity";
import type { AppConfig } from "../config.js";

const CONTRACT_PATH = "/api/contracts/v1/media-health";
const MAX_RESPONSE_BYTES = 256 * 1024;

export type MediaHealthOverall = "healthy" | "degraded" | "unavailable";

export interface ProviderObservation {
  readonly configured: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly latencyMs: number | null;
}

export interface MediaHealthV1 {
  readonly schema: "marquee.media-health.v1";
  readonly generatedAt: string;
  readonly overall: MediaHealthOverall;
  readonly build: Readonly<Record<string, unknown>>;
  readonly sqlite: {
    readonly ready: boolean;
    readonly schemaVersion: number;
  };
  readonly providers: {
    readonly plex: ProviderObservation;
    readonly tautulli: ProviderObservation;
  };
  readonly sonarr: Readonly<Record<string, unknown>> & {
    readonly present: boolean;
  };
  readonly duplicates: Readonly<Record<string, unknown>>;
}

export class MediaHealthClientError extends Error {
  public constructor(
    public readonly code:
      | "not_configured"
      | "token_failed"
      | "timeout"
      | "upstream_error"
      | "invalid_contract",
    message: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

export interface MediaHealthClient {
  get(signal?: AbortSignal): Promise<MediaHealthV1>;
}

interface ClientOptions {
  readonly baseUrl: URL;
  readonly scope: string;
  readonly timeoutMs: number;
  readonly credential: TokenCredential;
  readonly fetch?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function provider(value: unknown): value is ProviderObservation {
  return (
    record(value) &&
    typeof value.configured === "boolean" &&
    nullableString(value.lastSuccessAt) &&
    nullableString(value.lastFailureAt) &&
    (value.latencyMs === null ||
      (typeof value.latencyMs === "number" &&
        Number.isFinite(value.latencyMs) &&
        value.latencyMs >= 0))
  );
}

async function readBoundedBody(response: Response): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MediaHealthClientError(
        "invalid_contract",
        "Marquee media health exceeded its response limit"
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

export function parseMediaHealthV1(value: unknown): MediaHealthV1 {
  if (
    !record(value) ||
    value.schema !== "marquee.media-health.v1" ||
    typeof value.generatedAt !== "string" ||
    Number.isNaN(Date.parse(value.generatedAt)) ||
    !["healthy", "degraded", "unavailable"].includes(String(value.overall)) ||
    !record(value.build) ||
    !record(value.sqlite) ||
    typeof value.sqlite.ready !== "boolean" ||
    !Number.isInteger(value.sqlite.schemaVersion) ||
    !record(value.providers) ||
    !provider(value.providers.plex) ||
    !provider(value.providers.tautulli) ||
    !record(value.sonarr) ||
    typeof value.sonarr.present !== "boolean" ||
    !record(value.duplicates)
  ) {
    throw new MediaHealthClientError(
      "invalid_contract",
      "Marquee returned an invalid media-health v1 document"
    );
  }
  return value as unknown as MediaHealthV1;
}

export class EntraMediaHealthClient implements MediaHealthClient {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: ClientOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  public async get(signal?: AbortSignal): Promise<MediaHealthV1> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let accessToken: string;
    try {
      const token = await this.options.credential.getToken(this.options.scope, {
        abortSignal: requestSignal
      });
      if (!token?.token) throw new Error("credential returned no token");
      accessToken = token.token;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new MediaHealthClientError("timeout", "Marquee workload token timed out");
      }
      throw new MediaHealthClientError(
        "token_failed",
        "Unable to acquire a Marquee-audienced workload token"
      );
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(CONTRACT_PATH, this.options.baseUrl), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`
        },
        redirect: "error",
        signal: requestSignal
      });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new MediaHealthClientError("timeout", "Marquee media health timed out");
      }
      throw error;
    }

    if (!response.ok) {
      throw new MediaHealthClientError(
        "upstream_error",
        `Marquee media health returned HTTP ${response.status}`,
        response.status
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new MediaHealthClientError(
        "invalid_contract",
        "Marquee media health exceeded its response limit"
      );
    }
    let body: string;
    try {
      body = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof MediaHealthClientError) throw error;
      if (timeoutSignal.aborted && !signal?.aborted) {
        throw new MediaHealthClientError("timeout", "Marquee media health timed out");
      }
      throw new MediaHealthClientError(
        "upstream_error",
        "Marquee media health response could not be read"
      );
    }
    try {
      return parseMediaHealthV1(JSON.parse(body) as unknown);
    } catch (error) {
      if (error instanceof MediaHealthClientError) throw error;
      throw new MediaHealthClientError(
        "invalid_contract",
        "Marquee media health was not valid JSON"
      );
    }
  }
}

export function createMediaHealthClient(config: AppConfig["marquee"]): MediaHealthClient {
  if (!config.baseUrl || !config.scope || !config.tenantId || !config.clientId) {
    return {
      async get(): Promise<never> {
        throw new MediaHealthClientError(
          "not_configured",
          "Marquee workload identity is not configured"
        );
      }
    };
  }
  const credential: TokenCredential = config.clientSecret
    ? new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret)
    : new DefaultAzureCredential({ managedIdentityClientId: config.clientId });
  return new EntraMediaHealthClient({
    baseUrl: config.baseUrl,
    scope: config.scope,
    timeoutMs: config.timeoutMs,
    credential
  });
}
