import { connect, type ClientHttp2Session, constants } from "node:http2";
import { createHash } from "node:crypto";
import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import type { AppConfig } from "../config.js";

const DEFAULT_ALERT_TTL_SECONDS = 60 * 60;
const MIN_ALERT_TTL_SECONDS = 60;
const MAX_ALERT_TTL_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
// APNs provider tokens are valid up to 60 minutes and must be reused (≤ 1 per 20).
const TOKEN_REUSE_MS = 45 * 60 * 1000;

export type ApnsEnvironment = "production" | "sandbox";
export type InterruptionLevel = "critical" | "time-sensitive";

export interface ApnsNotification {
  readonly title: string;
  readonly body: string;
  readonly critical?: boolean;
  readonly threadId?: string;
  readonly expiration?: number;
  readonly collapseId?: string;
  readonly apnsId?: string;
}

export interface ApnsResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
  readonly retryAfter: string | null;
  readonly transport: boolean;
  readonly invalidatedAt?: number | null;
}

export interface ApnsDeliveryMetadata {
  readonly environment: ApnsEnvironment;
  readonly topic: string;
  readonly interruptionLevel: InterruptionLevel;
  readonly expiration: number;
  readonly expiresAt: number;
}

export interface ApnsRequestEnvelope {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: string;
}

export function buildApnsRequestEnvelope(options: {
  readonly deviceToken: string;
  readonly notification: ApnsNotification;
  readonly authorizationToken: string;
  readonly topic: string;
  readonly criticalAlertsEnabled: boolean;
  readonly expiration: number;
}): ApnsRequestEnvelope {
  const criticalAllowed =
    options.notification.critical === true && options.criticalAlertsEnabled;
  const headers: Record<string, string> = {
    [constants.HTTP2_HEADER_METHOD]: "POST",
    [constants.HTTP2_HEADER_PATH]: `/3/device/${options.deviceToken}`,
    authorization: `bearer ${options.authorizationToken}`,
    "apns-topic": options.topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(options.expiration)
  };
  if (options.notification.collapseId) {
    headers["apns-collapse-id"] = options.notification.collapseId;
  }
  if (options.notification.apnsId) headers["apns-id"] = options.notification.apnsId;

  return {
    headers,
    payload: JSON.stringify({
      aps: {
        alert: {
          title: options.notification.title,
          body: options.notification.body
        },
        sound: criticalAllowed
          ? { critical: 1, name: "default", volume: 1.0 }
          : "default",
        "interruption-level": criticalAllowed ? "critical" : "time-sensitive",
        "thread-id": options.notification.threadId ?? "hearth-infra"
      }
    })
  };
}

export type ApnsSend = (deviceToken: string, notification: ApnsNotification) => Promise<ApnsResult>;

export interface ApnsProvider {
  configured(): boolean;
  environment(): ApnsEnvironment;
  criticalAlertsEnabled(): boolean;
  alertTtlSeconds(): number;
  deliveryMetadata(options?: { critical?: boolean; now?: number }): ApnsDeliveryMetadata;
  /**
   * Stable hash of the credential identity (key id, team id, private key), used
   * to scope fail-closed blocks so rotating credentials releases them.
   */
  identityFingerprint(): string;
  send: ApnsSend;
}

export type ApnsConfig = AppConfig["apns"];

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function invalidationTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function normalizePrivateKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const pem = raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  return pem.includes("BEGIN PRIVATE KEY") ? pem : null;
}

/**
 * APNs sender over native HTTP/2 with a `jose` ES256 provider JWT.
 *
 * Device tokens never leave this transport boundary, and `send` never throws:
 * connection and HTTP failures resolve with `ok: false` so the durable delivery
 * layer above can decide whether an outcome is retryable.
 */
export class NativeApnsProvider implements ApnsProvider {
  private cachedToken: string | null = null;
  private cachedAt = 0;
  private cachedIdentity: string | null = null;
  private signingKey: CryptoKey | null = null;
  private signingKeyPem: string | null = null;

  public constructor(private readonly config: ApnsConfig) {}

  public configured(): boolean {
    return Boolean(
      this.config.keyId &&
        this.config.teamId &&
        this.config.topic &&
        normalizePrivateKey(this.config.privateKey)
    );
  }

  public environment(): ApnsEnvironment {
    return this.config.environment === "development" ? "sandbox" : "production";
  }

  public criticalAlertsEnabled(): boolean {
    return this.config.criticalAlerts === true;
  }

  public alertTtlSeconds(): number {
    const configured = this.config.alertTtlSeconds;
    if (!Number.isFinite(configured)) return DEFAULT_ALERT_TTL_SECONDS;
    return Math.min(Math.max(configured, MIN_ALERT_TTL_SECONDS), MAX_ALERT_TTL_SECONDS);
  }

  /** Resolved once per logical delivery so every device and retry shares an expiry. */
  public deliveryMetadata(options: { critical?: boolean; now?: number } = {}): ApnsDeliveryMetadata {
    const now = options.now ?? Date.now();
    const ttlSeconds = this.alertTtlSeconds();
    const criticalAllowed = options.critical === true && this.criticalAlertsEnabled();
    return {
      environment: this.environment(),
      topic: this.config.topic ?? "",
      interruptionLevel: criticalAllowed ? "critical" : "time-sensitive",
      expiration: Math.floor(now / 1000) + ttlSeconds,
      expiresAt: now + ttlSeconds * 1000
    };
  }

  public identityFingerprint(): string {
    const keyHash = createHash("sha256")
      .update(normalizePrivateKey(this.config.privateKey) ?? "")
      .digest("hex")
      .slice(0, 16);
    return createHash("sha256")
      .update(
        JSON.stringify({
          keyId: this.config.keyId ?? null,
          teamId: this.config.teamId ?? null,
          keyHash
        })
      )
      .digest("hex");
  }

  public send: ApnsSend = async (deviceToken, notification) => {
    let authorizationToken: string;
    try {
      authorizationToken = await this.providerToken();
    } catch (error) {
      return {
        ok: false,
        status: 0,
        reason: error instanceof Error ? error.message : "provider token failed",
        apnsId: notification.apnsId ?? null,
        retryAfter: null,
        transport: false
      };
    }
    return this.post(deviceToken, notification, authorizationToken);
  };

  private async signingMaterial(): Promise<CryptoKey> {
    const pem = normalizePrivateKey(this.config.privateKey);
    if (!pem) throw new Error("APNs private key is not configured");
    if (this.signingKey && this.signingKeyPem === pem) return this.signingKey;
    this.signingKey = await importPKCS8(pem, "ES256");
    this.signingKeyPem = pem;
    return this.signingKey;
  }

  private async providerToken(): Promise<string> {
    const now = Date.now();
    const pem = normalizePrivateKey(this.config.privateKey);
    const identity = [this.config.keyId ?? "", this.config.teamId ?? "", pem ?? ""].join("\u0000");
    if (this.cachedToken && this.cachedIdentity === identity && now - this.cachedAt < TOKEN_REUSE_MS) {
      return this.cachedToken;
    }
    if (!this.config.keyId || !this.config.teamId) {
      throw new Error("APNS_KEY_ID and APNS_TEAM_ID are required");
    }
    const key = await this.signingMaterial();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(key);
    this.cachedToken = token;
    this.cachedAt = now;
    this.cachedIdentity = identity;
    return token;
  }

  private clearProviderToken(rejected: string): void {
    if (this.cachedToken !== rejected) return;
    this.cachedToken = null;
    this.cachedAt = 0;
    this.cachedIdentity = null;
  }

  private host(): string {
    return this.environment() === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  }

  private post(
    deviceToken: string,
    notification: ApnsNotification,
    authorizationToken: string
  ): Promise<ApnsResult> {
    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      let client: ClientHttp2Session | null = null;
      let request: ReturnType<ClientHttp2Session["request"]> | null = null;
      let status = 0;
      let data = "";
      let responseApnsId: string | null = null;
      let retryAfter: string | null = null;

      const done = (result: ApnsResult, destroy = false): void => {
        if (settled) return;
        settled = true;
        if (destroy) {
          try {
            request?.close();
          } catch {
            /* already closed */
          }
          try {
            client?.destroy();
          } catch {
            /* already destroyed */
          }
        } else {
          try {
            client?.close();
          } catch {
            /* already closed */
          }
        }
        resolve(result);
      };
      const interrupted = (reason: string): ApnsResult => ({
        ok: false,
        status,
        reason,
        apnsId: responseApnsId ?? notification.apnsId ?? null,
        retryAfter,
        transport: status === 0
      });

      try {
        client = connect(this.host());
      } catch (error) {
        done(interrupted(error instanceof Error ? error.message : "connect failed"), true);
        return;
      }
      client.once("error", (error: Error) => done(interrupted(error.message), true));

      const envelope = buildApnsRequestEnvelope({
        deviceToken,
        notification,
        authorizationToken,
        topic: this.config.topic ?? "",
        criticalAlertsEnabled: this.criticalAlertsEnabled(),
        expiration:
          notification.expiration ??
          this.deliveryMetadata({ critical: notification.critical === true }).expiration
      });

      try {
        request = client.request(envelope.headers);
      } catch (error) {
        done(
          {
            ok: false,
            status: 0,
            reason: error instanceof Error ? error.message : "request failed",
            apnsId: notification.apnsId ?? null,
            retryAfter: null,
            transport: false
          },
          true
        );
        return;
      }

      request.on("response", (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS]) || 0;
        responseApnsId = headerValue(responseHeaders["apns-id"]);
        retryAfter = headerValue(responseHeaders["retry-after"]);
        if (status === 200) {
          done({
            ok: true,
            status,
            apnsId: responseApnsId ?? notification.apnsId ?? null,
            retryAfter,
            transport: false
          });
        }
      });
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        data += chunk;
      });
      request.on("end", () => {
        const base = {
          status,
          apnsId: responseApnsId ?? notification.apnsId ?? null,
          retryAfter,
          transport: false
        };
        if (status === 200) {
          done({ ok: true, ...base });
          return;
        }
        if (status === 0) {
          done(
            {
              ok: false,
              ...base,
              reason: "APNs stream ended before response headers",
              transport: true
            },
            true
          );
          return;
        }
        let reason: string;
        let invalidatedAt: number | null = null;
        try {
          const error = JSON.parse(data) as { reason?: string; timestamp?: unknown };
          reason = String(error.reason ?? "");
          invalidatedAt = invalidationTimestamp(error.timestamp);
        } catch {
          reason = data;
        }
        if (reason === "ExpiredProviderToken") this.clearProviderToken(authorizationToken);
        done({ ok: false, ...base, reason: reason || "Unknown APNs error", invalidatedAt });
      });
      request.once("aborted", () => done(interrupted("APNs stream aborted"), true));
      request.once("close", () => {
        if (settled) return;
        if (status > 0) {
          done(
            {
              ok: false,
              status,
              reason: "APNs stream closed before response completed",
              apnsId: responseApnsId ?? notification.apnsId ?? null,
              retryAfter,
              transport: false
            },
            true
          );
          return;
        }
        done(interrupted("APNs stream closed before response headers"), true);
      });
      request.once("error", (error: Error) => done(interrupted(error.message), true));
      request.setTimeout(REQUEST_TIMEOUT_MS, () => done(interrupted("timeout"), true));
      try {
        request.end(envelope.payload);
      } catch (error) {
        done(interrupted(error instanceof Error ? error.message : "write failed"), true);
      }
    });
  }
}

export function createApnsProvider(config: ApnsConfig): ApnsProvider {
  return new NativeApnsProvider(config);
}
