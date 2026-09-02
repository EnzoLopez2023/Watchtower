import "dotenv/config";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { BUILD_IDENTITY } from "../lib/buildIdentity.js";
import { enforcePersistentStorageContract } from "../lib/deployment/index.js";
import { openDatabase } from "../lib/db/connection.js";
import { migrateDatabase } from "../lib/db/migrate.js";
import { SqliteAuditRepository } from "../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../lib/db/repositories/identityRepository.js";
import { SqliteInstanceLeaseRepository } from "../lib/db/repositories/instanceLeaseRepository.js";
import {
  PRODUCTION_OWNED_SCHEMA_DIGEST,
  SqliteReadinessRepository
} from "../lib/db/repositories/readinessRepository.js";
import { SqliteSettingsRepository } from "../lib/db/repositories/settingsRepository.js";
import { ensureWatchtowerSchema } from "../lib/db/repositories/watchtower/schema.js";
import { createApp } from "./app.js";
import { authenticate } from "./auth/authorize.js";
import { EntraAccessTokenVerifier } from "./auth/entra.js";
import { loadConfig } from "./config.js";
import { auditInteractiveMutations } from "./domain/auditTrail.js";
import { createWatchtowerContainer } from "./domain/container.js";
import { runOffhostRecoveryPass } from "./domain/offhostRecovery.js";
import { setServerErrorLog } from "./routes/features/http.js";
import { createFeatureRouters } from "./routes/index.js";
import type { LifecycleState } from "./routes/core.js";
import { InstanceLeaseWorker } from "./workers/instanceLease.js";
import { WorkerManager, type ManagedWorker } from "./workers/manager.js";
import { AlertEngineWorker } from "./workers/watchtower/alertEngineWorker.js";
import { createMonitoringArchiveWorker } from "./workers/watchtower/monitoringArchiveWorker.js";
import { createOffhostRecoveryWorker } from "./workers/watchtower/offhostRecoveryWorker.js";
import { createOutagePostmortemWorker } from "./workers/watchtower/outagePostmortemWorker.js";
import { createUnifiLogsBackfillWorker } from "./workers/watchtower/unifiLogsBackfillWorker.js";

const startedAt = Date.now();
const config = loadConfig();
// Persistent App Service storage gate. In production this rejects — with a
// clear, secret-safe error and a non-zero exit — before any SQLite file is
// created, unless /home/data/watchtower.db is the selected authority on a real,
// writable, persistent /home mount (verified via the kernel mount table and a
// device-distinctness + write probe), not an ephemeral image-local directory.
// It runs strictly before openDatabase so a rejected startup never creates a
// database file. It is a no-op outside production.
enforcePersistentStorageContract(config);
const database = openDatabase({
  ...config.database,
  fileMustExist: config.environment === "production"
});
migrateDatabase(database);
if (config.environment !== "production") ensureWatchtowerSchema(database);

const identities = new SqliteIdentityRepository(database);
const audit = new SqliteAuditRepository(database);
const readiness = new SqliteReadinessRepository(
  database,
  undefined,
  config.environment === "production" ? PRODUCTION_OWNED_SCHEMA_DIGEST : undefined
);
if (config.environment === "production" && !(await readiness.check()).ok) {
  database.close();
  throw new Error(
    "The production SQLite authority is not the reconciled Watchtower schema; run the verified legacy import"
  );
}
const settings = new SqliteSettingsRepository(database);
const container = createWatchtowerContainer(database, config, {
  log: (message) => console.warn(JSON.stringify({ event: "watchtower.monitoring", message }))
});
setServerErrorLog((message) => console.error(message));
const routers = createFeatureRouters(container);

/**
 * Stable identity for the SQLite authority lease. App Service supplies a per
 * instance id; anywhere else the host and pid identify the process uniquely
 * enough to tell two live owners apart in the lease row.
 */
const instanceOwner = (process.env.WEBSITE_INSTANCE_ID?.trim() || `${hostname()}:${process.pid}`).slice(
  0,
  128
);

// First in the array, so WorkerManager starts it before any domain worker and —
// because stop() unwinds in reverse start order — releases it only after every
// domain worker has stopped writing.
const offhostRecovery = createOffhostRecoveryWorker({
  enabled: config.offhostRecovery.enabled,
  run: (signal) =>
    runOffhostRecoveryPass(
      {
        config: config.offhostRecovery,
        databasePath: config.database.path,
        appVersion: BUILD_IDENTITY.version,
        buildId: String(BUILD_IDENTITY.source.build),
        sourceCommit: BUILD_IDENTITY.source.commit,
        log: (message) => console.info(JSON.stringify({ event: "watchtower.recovery", message }))
      },
      signal
    ),
  intervalMs: config.offhostRecovery.intervalHours * 60 * 60 * 1000,
  startDelayMs: config.offhostRecovery.startDelayMs,
  retryDelayMs: config.offhostRecovery.retryDelayMs,
  log: (message) => console.info(message)
});
const managedWorkers: ManagedWorker[] = [
  new InstanceLeaseWorker(
    new SqliteInstanceLeaseRepository(database),
    instanceOwner,
    () => {
      // Losing the lease means another process now owns this database. Continuing
      // would mean two writers, so take the ordinary graceful shutdown path.
      console.error(
        JSON.stringify({ event: "watchtower.instance_lease_lost", owner: instanceOwner })
      );
      void shutdown("instance_lease_lost").finally(() => {
        process.exitCode = 1;
      });
    }
  ),
  // Immediately after the lease so no historical rewrite is ever written by a
  // process that does not own this database, and so startup is not blocked.
  createUnifiLogsBackfillWorker({
    repository: container.repositories.unifiLogs
  }),
  // Between the lease and the writers: it needs the lease held for its whole
  // pass, and reverse-order shutdown then stops it after the writers have gone
  // quiet but before the lease is released and the database is closed.
  offhostRecovery,
  createMonitoringArchiveWorker({
    config: config.monitoringArchive,
    repository: container.repositories.archive
  }),
  createOutagePostmortemWorker({
    config: config.outagePostmortems,
    repository: container.repositories.outage
  })
];
if (config.alerts.enabled) {
  managedWorkers.push(
    new AlertEngineWorker({
      engine: container.services.alertEngine,
      pollSeconds: config.alerts.pollSeconds,
      log: (message) => console.warn(JSON.stringify({ event: "watchtower.alerts", message }))
    })
  );
}
const workers = new WorkerManager(managedWorkers);
const verifier = new EntraAccessTokenVerifier(config.entra);
let lifecycle: LifecycleState = { state: "starting" };

const app = createApp({
  config,
  core: {
    startedAt,
    databasePath: config.database.path,
    lifecycle: () => lifecycle,
    readiness,
    workers,
    recovery: {
      status: () => {
        const outcome = offhostRecovery.lastOutcome();
        return {
          enabled: config.offhostRecovery.enabled,
          uploadConfigured: config.offhostRecovery.account !== undefined,
          restoreVerificationEnabled: config.offhostRecovery.verifyRestore,
          lastOutcome: outcome === null
            ? null
            : {
                status: outcome.status,
                at: outcome.at,
                durationMs: outcome.status === "success" ? outcome.durationMs : null
              }
        };
      }
    },
    identities,
    audit,
    settings
  },
  authenticate: authenticate(verifier, identities, config.entra.adminOid),
  service: routers.service,
  auditTrail: auditInteractiveMutations({
    audit,
    log: (message) => console.warn(JSON.stringify({ event: "watchtower.audit", message }))
  }),
  features: routers.interactive
});

const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

async function abandonStartup(event: string, error: unknown): Promise<never> {
  console.error(
    JSON.stringify({
      event,
      message: error instanceof Error ? error.message : "unknown"
    })
  );
  // Already on the failure path; a stop() error must be reported but must not
  // stop us from closing the database and releasing the lease.
  await workers.stop().catch((stopError: unknown) => {
    console.error(
      JSON.stringify({
        event: "watchtower.worker_stop_failed",
        message: stopError instanceof Error ? stopError.message : "unknown"
      })
    );
  });
  database.close();
  process.exit(1);
}

try {
  await workers.start();
} catch (error) {
  // WorkerManager has already unwound whatever it started, which releases the
  // lease if a later worker was the one that failed.
  await abandonStartup("watchtower.worker_start_failed", error);
}

try {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
} catch (error) {
  await abandonStartup("watchtower.listen_failed", error);
}
lifecycle = { state: "ready" };
console.info(
  JSON.stringify({
    event: "watchtower.started",
    port: config.port,
    database: config.database.path,
    build: BUILD_IDENTITY
  })
);

let shutdownPromise: Promise<void> | undefined;
async function shutdown(reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  lifecycle = { state: "draining" };
  shutdownPromise = (async () => {
    console.info(JSON.stringify({ event: "watchtower.stopping", reason }));
    server.closeIdleConnections();
    await Promise.all([
      workers.stop(),
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      })
    ]);
    database.close();
    lifecycle = { state: "stopped" };
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "watchtower.stop_failed",
            message: error instanceof Error ? error.message : "unknown"
          })
        );
        process.exitCode = 1;
      });
  });
}
