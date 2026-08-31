import { isAbsolute, resolve } from "node:path";
import { PRODUCTION_DATABASE_PATH } from "../lib/deployment/contract.js";
import {
  assertManagedIdentityOnlyEnvironment,
  validateStorageAccount,
  validateStorageContainer
} from "../lib/recovery/managedIdentityBlob.js";

export type RuntimeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly environment: RuntimeEnvironment;
  readonly port: number;
  readonly database: {
    readonly path: string;
    readonly busyTimeoutMs: number;
  };
  readonly entra: {
    readonly tenantId: string;
    readonly clientId: string;
    readonly audience: string;
    readonly adminOid?: string;
    readonly configured: boolean;
  };
  readonly corsOrigins: readonly string[];
  /**
   * Distinct shared secrets for the headless service surface. Each collector
   * family keeps its own secret so revoking one cannot authorize another; the
   * Protect and Network Observer collectors fall back to the UniFi secret
   * exactly as production does, because they run on the same trusted host.
   */
  readonly serviceTokens: {
    readonly unifi?: string;
    readonly ups?: string;
    readonly protect?: string;
    readonly synology?: string;
    readonly sonarr?: string;
    readonly networkObserver?: string;
    readonly agentLog?: string;
    readonly mobile?: string;
  };
  readonly azure: {
    readonly subscriptionId: string;
    readonly tenantId: string;
    readonly defaultResourceGroup: string;
    readonly requestTimeoutMs: number;
    readonly enabled: boolean;
  };
  readonly monitoringArchive: {
    readonly account?: string;
    readonly container: string;
    readonly settleHours: number;
    readonly intervalHours: number;
    readonly maxDaysPerRun: number;
    readonly leaseMs: number;
    readonly enabled: boolean;
  };
  readonly alerts: {
    readonly pollSeconds: number;
    readonly enabled: boolean;
  };
  readonly outagePostmortems: {
    readonly enabled: boolean;
  };
  /**
   * Scheduled off-host recovery. Disabled unless `OFFHOST_BACKUP_ENABLED` is
   * exactly "true" *and* every Watchtower-owned destination is supplied, so a
   * half-configured environment never silently skips its backups.
   */
  readonly offhostRecovery: {
    readonly enabled: boolean;
    readonly account?: string;
    readonly container: string;
    readonly backupRoot: string;
    readonly prefix?: string;
    readonly intervalHours: number;
    readonly startDelayMs: number;
    readonly retryDelayMs: number;
    readonly retentionCount: number;
    readonly requestTimeoutMs: number;
    readonly verifyRestore: boolean;
  };
  readonly marquee: {
    readonly baseUrl?: URL;
    readonly tenantId?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly scope?: string;
    readonly timeoutMs: number;
  };
  readonly apns: {
    readonly teamId?: string;
    readonly keyId?: string;
    readonly privateKey?: string;
    readonly topic?: string;
    readonly environment: "development" | "production";
    readonly criticalAlerts: boolean;
    readonly alertTtlSeconds: number;
  };
}

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_VAULT_REFERENCE_PATTERN = /^\s*@Microsoft\.KeyVault\(/i;

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function rejectUnresolvedKeyVaultReferences(env: NodeJS.ProcessEnv): void {
  const unresolved = Object.entries(env)
    .filter(([, value]) => value !== undefined && KEY_VAULT_REFERENCE_PATTERN.test(value))
    .map(([key]) => key)
    .sort();
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved Azure Key Vault references: ${unresolved.join(", ")}`
    );
  }
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = optional(env, key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === undefined || value === "development") return "development";
  if (value === "test" || value === "production") return value;
  throw new Error("NODE_ENV must be development, test, or production");
}

function parseGuid(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (!GUID_PATTERN.test(value)) throw new Error(`${key} must be a GUID`);
  return value.toLowerCase();
}

function parseUrl(
  value: string | undefined,
  key: string,
  options: { readonly requireHttps: boolean }
): URL | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${key} must use HTTP or HTTPS`);
  }
  // Plain HTTP stays available for development and the local contract tests; a
  // deployed instance sends a workload token on every call, so the transport
  // must be encrypted.
  if (options.requireHttps && url.protocol !== "https:") {
    throw new Error(`${key} must use HTTPS in production`);
  }
  return url;
}

/**
 * Marquee is called with an Entra workload token, never a shared secret, so the
 * scope has to be an application-permission scope: an absolute resource URI
 * followed by `/.default`. Anything else silently requests delegated permissions
 * the managed identity does not have, and fails at runtime instead of at boot.
 */
function parseMarqueeScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {
    throw new Error(
      "MARQUEE_SCOPE must be an application scope such as api://<resource>/.default"
    );
  };
  if (!value.endsWith("/.default")) invalid();
  let scope: URL;
  try {
    scope = new URL(value);
  } catch {
    return invalid();
  }
  if (!scope.host || scope.pathname !== "/.default") invalid();
  return value;
}

/**
 * Marquee authentication is workload-identity only. Rejecting these outright
 * means a static bearer token cannot be introduced by configuration and then
 * quietly ignored, which would leave an operator believing the integration is
 * authenticated when it is not.
 */
const STATIC_MARQUEE_CREDENTIAL_KEYS = [
  "MARQUEE_TOKEN",
  "MARQUEE_API_KEY",
  "MARQUEE_API_TOKEN",
  "MARQUEE_ACCESS_TOKEN",
  "MARQUEE_BEARER_TOKEN",
  "MARQUEE_SHARED_SECRET"
] as const;

/**
 * Watchtower has no application-wide shared token and must never grow one:
 * interactive callers present a verified Entra identity, and each collector
 * holds its own distinct ingest secret. A single global token would collapse
 * both of those boundaries into one credential.
 */
const GLOBAL_SHARED_TOKEN_KEYS = [
  "WATCHTOWER_API_TOKEN",
  "WATCHTOWER_SHARED_TOKEN",
  "AGENT_INGEST_TOKEN"
] as const;

function rejectStaticCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of STATIC_MARQUEE_CREDENTIAL_KEYS) {
    if (optional(env, key) !== undefined) {
      throw new Error(
        `${key} is not supported; Marquee is called with an Entra workload token via MARQUEE_SCOPE`
      );
    }
  }
  for (const key of GLOBAL_SHARED_TOKEN_KEYS) {
    if (optional(env, key) !== undefined) {
      throw new Error(
        `${key} is not supported; use Entra for interactive callers and a per-collector ingest secret for agents`
      );
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = parseEnvironment(optional(env, "NODE_ENV"));
  if (environment === "production") rejectUnresolvedKeyVaultReferences(env);
  const configuredPath = optional(env, "DB_PATH");
  // The authority path is defined once, in the machine-readable deployment
  // contract, and shared with the runtime storage gate.
  const productionPath = PRODUCTION_DATABASE_PATH;
  if (environment === "production" && configuredPath && resolve(configuredPath) !== productionPath) {
    throw new Error("Production DB_PATH is fixed to /home/data/watchtower.db");
  }

  const tenantId = parseGuid(optional(env, "AZURE_AD_TENANT_ID"), "AZURE_AD_TENANT_ID");
  const clientId = parseGuid(optional(env, "AZURE_AD_CLIENT_ID"), "AZURE_AD_CLIENT_ID");
  const adminOid = parseGuid(optional(env, "ADMIN_OID"), "ADMIN_OID");
  const audience = optional(env, "AZURE_AD_AUDIENCE");
  const entraConfigured = Boolean(tenantId && clientId && audience);
  if (environment === "production" && !entraConfigured) {
    throw new Error(
      "AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, and AZURE_AD_AUDIENCE are required in production"
    );
  }

  rejectStaticCredentials(env);
  const marqueeBaseUrl = parseUrl(optional(env, "MARQUEE_BASE_URL"), "MARQUEE_BASE_URL", {
    requireHttps: environment === "production"
  });
  const marqueeTenantId = parseGuid(optional(env, "MARQUEE_TENANT_ID"), "MARQUEE_TENANT_ID");
  const marqueeClientId = parseGuid(optional(env, "MARQUEE_CLIENT_ID"), "MARQUEE_CLIENT_ID");
  const marqueeScope = parseMarqueeScope(optional(env, "MARQUEE_SCOPE"));
  const marqueeClientSecret = optional(env, "MARQUEE_CLIENT_SECRET");
  if (environment === "production" && marqueeClientSecret) {
    throw new Error(
      "MARQUEE_CLIENT_SECRET is not permitted in production; Marquee uses the system-assigned managed identity"
    );
  }
  if (marqueeClientSecret && (!marqueeTenantId || !marqueeClientId)) {
    throw new Error(
      "MARQUEE_TENANT_ID and MARQUEE_CLIENT_ID are required with MARQUEE_CLIENT_SECRET"
    );
  }
  if (
    environment === "production" &&
    (!marqueeBaseUrl || !marqueeScope)
  ) {
    throw new Error(
      "MARQUEE_BASE_URL and MARQUEE_SCOPE are required"
    );
  }

  // A fresh authority has no app_role_grants rows, so without an explicit
  // bootstrap administrator nobody can ever reach the admin surface that hands
  // out roles. The grant is keyed on the verified Entra object id, never on an
  // email address, which is mutable and reassignable. It escalates that one
  // identity only; every other identity's imported grants stay authoritative.
  if (environment === "production" && !adminOid) {
    throw new Error(
      "ADMIN_OID must be the GUID object id of the bootstrap administrator in production"
    );
  }

  // Scheduled off-host recovery stays off unless the flag is unambiguously
  // "true"; a truthy-looking value such as "1" or "yes" is rejected rather than
  // guessed, because guessing wrong means either no backups at all or
  // unexpected egress from a machine that was meant to stay quiet.
  const offhostFlag = optional(env, "OFFHOST_BACKUP_ENABLED");
  if (offhostFlag !== undefined && offhostFlag !== "true" && offhostFlag !== "false") {
    throw new Error('OFFHOST_BACKUP_ENABLED must be exactly "true" or "false"');
  }
  const offhostRequested = offhostFlag === "true";
  const offhostAccount = optional(env, "OFFHOST_BACKUP_ACCOUNT");
  const offhostContainer = optional(env, "OFFHOST_BACKUP_CONTAINER") ?? "watchtower-backups";
  const offhostBackupRoot = optional(env, "BACKUP_ROOT") ?? "/home/data/backups/watchtower";
  const offhostPrefix = optional(env, "OFFHOST_BACKUP_PREFIX");
  if (offhostRequested) {
    if (!offhostAccount) {
      throw new Error("OFFHOST_BACKUP_ACCOUNT is required when OFFHOST_BACKUP_ENABLED is true");
    }
    validateStorageAccount(offhostAccount);
    validateStorageContainer(offhostContainer);
    if (!isAbsolute(offhostBackupRoot)) {
      throw new Error("BACKUP_ROOT must be an absolute, app-owned directory");
    }
    // The upload path authenticates with a managed identity only. A shared key,
    // SAS or connection string in the environment is a configuration error, not
    // a fallback to be used silently.
    assertManagedIdentityOnlyEnvironment(env);
  }

  const configuredApnsEnvironment =
    optional(env, "APNS_ENVIRONMENT") ?? optional(env, "APNS_ENV") ?? "production";
  const apnsEnvironment =
    configuredApnsEnvironment === "sandbox" ? "development" : configuredApnsEnvironment;
  if (apnsEnvironment !== "development" && apnsEnvironment !== "production") {
    throw new Error("APNS_ENVIRONMENT must be development, sandbox, or production");
  }

  const azureSubscriptionId = parseGuid(
    optional(env, "AZURE_SUBSCRIPTION_ID"),
    "AZURE_SUBSCRIPTION_ID"
  );
  const azureTenantId = parseGuid(optional(env, "AZURE_TENANT_ID"), "AZURE_TENANT_ID") ?? tenantId;
  const archiveAccount = optional(env, "MONITORING_ARCHIVE_ACCOUNT");

  return {
    environment,
    port: parseInteger(env, "PORT", 3000, 1, 65_535),
    database: {
      path:
        environment === "production"
          ? productionPath
          : resolve(configuredPath ?? "./data/watchtower.db"),
      busyTimeoutMs: parseInteger(env, "SQLITE_BUSY_TIMEOUT_MS", 5_000, 250, 10_000)
    },
    entra: {
      tenantId: tenantId ?? "00000000-0000-0000-0000-000000000000",
      clientId: clientId ?? "00000000-0000-0000-0000-000000000000",
      audience: audience ?? "unconfigured",
      ...(adminOid ? { adminOid } : {}),
      configured: entraConfigured
    },
    corsOrigins: (optional(env, "CORS_ORIGINS") ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    serviceTokens: {
      ...(optional(env, "UNIFI_INGEST_TOKEN")
        ? { unifi: optional(env, "UNIFI_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "UPS_INGEST_TOKEN") ? { ups: optional(env, "UPS_INGEST_TOKEN") } : {}),
      ...(optional(env, "PROTECT_INGEST_TOKEN")
        ? { protect: optional(env, "PROTECT_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "SYNOLOGY_INGEST_TOKEN")
        ? { synology: optional(env, "SYNOLOGY_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "SONARR_INGEST_TOKEN")
        ? { sonarr: optional(env, "SONARR_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "NETWORK_OBSERVER_INGEST_TOKEN")
        ? { networkObserver: optional(env, "NETWORK_OBSERVER_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "AGENT_LOG_INGEST_TOKEN")
        ? { agentLog: optional(env, "AGENT_LOG_INGEST_TOKEN") }
        : {}),
      ...(optional(env, "MOBILE_API_TOKEN") ? { mobile: optional(env, "MOBILE_API_TOKEN") } : {})
    },
    azure: {
      subscriptionId: azureSubscriptionId ?? "",
      tenantId: azureTenantId ?? "",
      defaultResourceGroup: optional(env, "AZURE_DEFAULT_RESOURCE_GROUP") ?? "rg-personal-apps-prod",
      requestTimeoutMs: parseInteger(env, "AZURE_REQUEST_TIMEOUT_MS", 20_000, 1_000, 60_000),
      enabled: Boolean(azureSubscriptionId)
    },
    monitoringArchive: {
      ...(archiveAccount ? { account: archiveAccount } : {}),
      container: optional(env, "MONITORING_ARCHIVE_CONTAINER") ?? "monitoring-archive",
      settleHours: parseInteger(env, "MONITORING_ARCHIVE_SETTLE_HOURS", 6, 0, 72),
      intervalHours: parseInteger(env, "MONITORING_ARCHIVE_INTERVAL_HOURS", 6, 1, 168),
      maxDaysPerRun: parseInteger(env, "MONITORING_ARCHIVE_MAX_DAYS_PER_RUN", 7, 1, 90),
      leaseMs: parseInteger(env, "MONITORING_ARCHIVE_LEASE_MS", 30 * 60_000, 60_000, 6 * 3_600_000),
      enabled: Boolean(archiveAccount)
    },
    alerts: {
      pollSeconds: parseInteger(env, "ALERT_POLL_SECONDS", 60, 5, 3_600),
      enabled: optional(env, "ALERT_ENGINE_ENABLED") !== "false"
    },
    outagePostmortems: {
      enabled: optional(env, "OUTAGE_POSTMORTEM_ENABLED") !== "false"
    },
    offhostRecovery: {
      enabled: offhostRequested,
      ...(offhostAccount ? { account: offhostAccount } : {}),
      container: offhostContainer,
      backupRoot: offhostBackupRoot,
      ...(offhostPrefix ? { prefix: offhostPrefix } : {}),
      intervalHours: parseInteger(env, "BACKUP_INTERVAL_HOURS", 24, 1, 168),
      startDelayMs: parseInteger(env, "OFFHOST_BACKUP_START_DELAY_MS", 60_000, 1_000, 3_600_000),
      retryDelayMs: parseInteger(env, "OFFHOST_BACKUP_RETRY_DELAY_MS", 60_000, 1_000, 3_600_000),
      retentionCount: parseInteger(env, "BACKUP_RETENTION_COUNT", 2, 1, 30),
      requestTimeoutMs: parseInteger(
        env,
        "OFFHOST_BACKUP_REQUEST_TIMEOUT_MS",
        15 * 60_000,
        1_000,
        60 * 60_000
      ),
      verifyRestore: optional(env, "OFFHOST_BACKUP_VERIFY_RESTORE") !== "false"
    },
    marquee: {
      ...(marqueeBaseUrl ? { baseUrl: marqueeBaseUrl } : {}),
      ...(marqueeTenantId ? { tenantId: marqueeTenantId } : {}),
      ...(marqueeClientId ? { clientId: marqueeClientId } : {}),
      ...(marqueeClientSecret ? { clientSecret: marqueeClientSecret } : {}),
      ...(marqueeScope ? { scope: marqueeScope } : {}),
      timeoutMs: parseInteger(env, "MARQUEE_TIMEOUT_MS", 5_000, 250, 15_000)
    },
    apns: {
      ...(optional(env, "APNS_TEAM_ID") ? { teamId: optional(env, "APNS_TEAM_ID") } : {}),
      ...(optional(env, "APNS_KEY_ID") ? { keyId: optional(env, "APNS_KEY_ID") } : {}),
      ...(optional(env, "APNS_PRIVATE_KEY") ?? optional(env, "APNS_KEY_P8")
        ? {
            privateKey: (optional(env, "APNS_PRIVATE_KEY") ?? optional(env, "APNS_KEY_P8"))?.replaceAll(
              "\\n",
              "\n"
            )
          }
        : {}),
      ...(optional(env, "APNS_TOPIC") ?? optional(env, "APNS_BUNDLE_ID")
        ? { topic: optional(env, "APNS_TOPIC") ?? optional(env, "APNS_BUNDLE_ID") }
        : {}),
      environment: apnsEnvironment,
      criticalAlerts: optional(env, "APNS_CRITICAL_ALERTS") === "true",
      alertTtlSeconds: parseInteger(env, "APNS_ALERT_TTL_SECONDS", 3_600, 0, 86_400)
    }
  };
}
