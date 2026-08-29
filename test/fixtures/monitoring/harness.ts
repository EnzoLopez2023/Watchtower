import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type Express } from "express";
import { openDatabase, type SqliteDatabase } from "../../../lib/db/connection.js";
import type { AppIdentity, AppRole } from "../../../lib/db/repositories/identityRepository.js";
import { ensureWatchtowerSchema } from "../../../lib/db/repositories/watchtower/schema.js";
import type {
  MediaHealthClient,
  MediaHealthV1
} from "../../../server/clients/marqueeMediaHealth.js";
import type { ApnsProvider, ApnsResult, ApnsSend } from "../../../server/clients/apns.js";
import { loadConfig, type AppConfig } from "../../../server/config.js";
import { createWatchtowerContainer, type WatchtowerContainer } from "../../../server/domain/container.js";
import { errorHandler, notFoundHandler } from "../../../server/http/errors.js";
import { createFeatureRouters } from "../../../server/routes/index.js";

const SCRATCH_DIR = resolve("./.scratch/wt/tmp");
let counter = 0;

export function temporaryDatabasePath(prefix: string): string {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  return join(SCRATCH_DIR, `${prefix}-${process.pid}-${++counter}.db`);
}

export function openTestDatabase(prefix: string): { database: SqliteDatabase; path: string } {
  const path = temporaryDatabasePath(prefix);
  const database = openDatabase({ path, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(database);
  return { database, path };
}

export function removeDatabase(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

export const HEALTHY_MEDIA_HEALTH: MediaHealthV1 = {
  schema: "marquee.media-health.v1",
  generatedAt: "2026-08-28T00:00:00.000Z",
  overall: "healthy",
  build: { app: "marquee" },
  sqlite: { ready: true, schemaVersion: 4 },
  providers: {
    plex: { configured: true, lastSuccessAt: null, lastFailureAt: null, latencyMs: 12 },
    tautulli: { configured: true, lastSuccessAt: null, lastFailureAt: null, latencyMs: 9 }
  },
  sonarr: { present: true },
  duplicates: {}
};

export function stubMediaHealth(
  document: MediaHealthV1 | Error = HEALTHY_MEDIA_HEALTH
): MediaHealthClient {
  return {
    async get(): Promise<MediaHealthV1> {
      if (document instanceof Error) throw document;
      return document;
    }
  };
}

export interface StubApnsOptions {
  readonly configured?: boolean;
  readonly criticalAlerts?: boolean;
  readonly send?: ApnsSend;
}

export interface StubApns extends ApnsProvider {
  readonly sent: Array<{ token: string; title: string; body: string; critical: boolean }>;
}

export function stubApns(options: StubApnsOptions = {}): StubApns {
  const sent: StubApns["sent"] = [];
  const accepted: ApnsResult = {
    ok: true,
    status: 200,
    apnsId: "stub-apns-id",
    retryAfter: null,
    transport: false
  };
  const provider: StubApns = {
    sent,
    configured: () => options.configured !== false,
    environment: () => "production",
    criticalAlertsEnabled: () => options.criticalAlerts === true,
    alertTtlSeconds: () => 3600,
    deliveryMetadata: ({ critical = false, now = Date.now() } = {}) => ({
      environment: "production",
      topic: "test.watchtower",
      interruptionLevel: critical && options.criticalAlerts === true ? "critical" : "time-sensitive",
      expiration: Math.floor(now / 1000) + 3600,
      expiresAt: now + 3_600_000
    }),
    identityFingerprint: () => "stub-identity",
    send:
      options.send ??
      (async (token, notification) => {
        sent.push({
          token,
          title: notification.title,
          body: notification.body,
          critical: notification.critical === true
        });
        return accepted;
      })
  };
  return provider;
}

export interface TestConfigOverrides {
  readonly serviceTokens?: Partial<AppConfig["serviceTokens"]>;
  readonly azure?: Partial<AppConfig["azure"]>;
  readonly monitoringArchive?: Partial<AppConfig["monitoringArchive"]>;
  readonly alerts?: Partial<AppConfig["alerts"]>;
}

export function testConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig({ NODE_ENV: "test", DB_PATH: "./.scratch/wt/tmp/config.db" });
  return {
    ...base,
    serviceTokens: { ...base.serviceTokens, ...overrides.serviceTokens },
    azure: { ...base.azure, ...overrides.azure },
    monitoringArchive: { ...base.monitoringArchive, ...overrides.monitoringArchive },
    alerts: { ...base.alerts, ...overrides.alerts }
  };
}

export function identity(...roles: readonly AppRole[]): AppIdentity {
  return identityWithFeatures({ roles });
}

export interface IdentityOptions {
  readonly roles: readonly AppRole[];
  /**
   * Imported Hearth per-view rows. Absent views keep Hearth's defaults, which
   * are visible and read-only — so a write test must grant `canEdit` explicitly,
   * exactly as production requires.
   */
  readonly featurePermissions?: AppIdentity["featurePermissions"];
}

export function identityWithFeatures(options: IdentityOptions): AppIdentity {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    oid: "00000000-0000-0000-0000-000000000002",
    email: "operator@example.test",
    displayName: "Test Operator",
    roles: [...options.roles],
    featurePermissions: options.featurePermissions ?? {},
    firstSeenAt: 0,
    lastSeenAt: 0
  };
}

/** Grants edit rights on the named views, leaving every other view at default. */
export function canEditFeatures(
  ...views: readonly string[]
): AppIdentity["featurePermissions"] {
  return Object.fromEntries(
    views.map((view) => [view, { canEdit: true, isHidden: false }])
  );
}

/** Hides the named views, leaving every other view at default. */
export function hiddenFeatures(
  ...views: readonly string[]
): AppIdentity["featurePermissions"] {
  return Object.fromEntries(
    views.map((view) => [view, { canEdit: false, isHidden: true }])
  );
}

export interface TestHarness {
  readonly app: Express;
  readonly container: WatchtowerContainer;
  readonly database: SqliteDatabase;
  close(): void;
}

export interface HarnessOptions {
  readonly prefix?: string;
  readonly config?: AppConfig;
  readonly mediaHealth?: MediaHealthClient;
  readonly apns?: ApnsProvider;
  /** Roles granted to the simulated verified identity; omit to be unauthenticated. */
  readonly roles?: readonly AppRole[];
  /** Imported per-view rows for that identity. Absent views keep Hearth defaults. */
  readonly featurePermissions?: AppIdentity["featurePermissions"];
}

/**
 * Builds the real service + interactive router split over a temporary database,
 * with a stubbed identity in place of the Entra gate. Service routes still run
 * ahead of the global JSON parser, exactly as in production.
 */
export function createTestHarness(options: HarnessOptions = {}): TestHarness {
  const { database, path } = openTestDatabase(options.prefix ?? "watchtower");
  const config =
    options.config ??
    testConfig({
      serviceTokens: {
        unifi: "unifi-secret",
        ups: "ups-secret",
        protect: "protect-secret",
        synology: "synology-secret",
        sonarr: "sonarr-secret",
        networkObserver: "observer-secret",
        mobile: "mobile-secret"
      }
    });
  const container = createWatchtowerContainer(database, config, {
    mediaHealth: options.mediaHealth ?? stubMediaHealth(),
    apns: options.apns ?? stubApns()
  });
  const routers = createFeatureRouters(container);

  const app = express();
  app.disable("x-powered-by");
  app.use(routers.service);
  app.use(express.json({ limit: "2mb", strict: true }));
  if (options.roles) {
    const current = identityWithFeatures({
      roles: options.roles,
      ...(options.featurePermissions ? { featurePermissions: options.featurePermissions } : {})
    });
    app.use((_request, response, next) => {
      response.locals.identity = current;
      next();
    });
  }
  app.use(routers.interactive);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    container,
    database,
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

/** `SELECT COUNT(*)` helper; better-sqlite3's `get()` is untyped. */
export function countRows(
  database: SqliteDatabase,
  table: string,
  where = "",
  ...parameters: ReadonlyArray<string | number>
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM ${table} ${where ? `WHERE ${where}` : ""}`)
    .get(...parameters) as { c: number } | undefined;
  return row?.c ?? 0;
}
