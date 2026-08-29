import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEPLOYMENT_CONTRACT } from "../../lib/deployment/contract.js";
import {
  verifyPersistentStorage,
  type StorageRejectionCode,
  type StorageVerification
} from "../../lib/deployment/storageGate.js";
import type {
  PersistentStorageProbe,
  WriteProbeResult
} from "../../lib/deployment/persistentStorageProbe.js";

/**
 * Alignment with the authoritative infrastructure declaration.
 *
 * The values here are transcribed from `azure-infra`'s
 * `new-apps/watchtower.bicepparam` and `new-apps/templates/app.bicep`. If the
 * platform declaration moves, this file is the thing that fails, which is the
 * point: the app's runtime preflight and the template must describe the same
 * deployment.
 */

const STORAGE = DEPLOYMENT_CONTRACT.persistentStorage;
const EVIDENCE = DEPLOYMENT_CONTRACT.evidence;

const DB_PATH = "/home/data/watchtower.db";

function probe(overrides: {
  readonly mountPoints?: readonly string[];
  readonly devices?: Readonly<Record<string, number | undefined>>;
  readonly writable?: WriteProbeResult;
  readonly realPaths?: Readonly<Record<string, string | undefined>>;
  readonly missing?: readonly string[];
} = {}): PersistentStorageProbe {
  const devices = overrides.devices ?? { "/": 1, "/home/data": 42 };
  const missing = new Set(overrides.missing ?? [DB_PATH]);
  return {
    mountPoints: () => overrides.mountPoints ?? ["/", "/home"],
    deviceId: (path) => devices[path],
    writeProbe: () => overrides.writable ?? { ok: true },
    realPath: (path) => (missing.has(path) ? undefined : overrides.realPaths?.[path] ?? path)
  };
}

function healthyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { WEBSITES_ENABLE_APP_SERVICE_STORAGE: "true", ...extra };
}

function expectReject(
  result: StorageVerification,
  code: StorageRejectionCode
): void {
  assert.equal(result.ok, false, `expected rejection ${code}, got acceptance`);
  if (!result.ok) assert.equal(result.code, code, result.reason);
}

// ── Contract mirrors the bicepparam ──────────────────────────────────────────

test("the contract mirrors the authoritative bicepparam settings", () => {
  assert.equal(STORAGE.databasePath, "/home/data/watchtower.db", "DB_PATH");
  assert.equal(STORAGE.backupRoot, "/home/data/backups/watchtower", "BACKUP_ROOT");
  assert.equal(STORAGE.journalMode.name, "SQLITE_JOURNAL_MODE");
  assert.equal(STORAGE.journalMode.value, "DELETE");
  assert.equal(STORAGE.requiredEnv.name, "WEBSITES_ENABLE_APP_SERVICE_STORAGE");
  assert.equal(STORAGE.requiredEnv.value, "true");
  assert.equal(STORAGE.mountPoint, "/home");
});

test("the contract mirrors the authoritative template site configuration", () => {
  assert.equal(EVIDENCE.deploymentProfile, "sqlite-one-worker");
  assert.equal(EVIDENCE.dataStorageMode, "persistent");
  assert.equal(EVIDENCE.numberOfWorkers, 1, "a second worker would mean two SQLite writers");
  assert.equal(EVIDENCE.alwaysOn, true);
  assert.equal(EVIDENCE.containerPort, 3000);
  assert.equal(EVIDENCE.healthCheckPath, "/api/live");
  assert.equal(EVIDENCE.readinessPath, "/api/ready");
});

test("the app's own config agrees with the declared container port and backup root", async () => {
  const { loadConfig } = await import("../../server/config.js");
  const config = loadConfig({
    NODE_ENV: "production",
    ADMIN_OID: "11111111-2222-3333-4444-555555555555",
    AZURE_AD_TENANT_ID: "22222222-3333-4444-5555-666666666666",
    AZURE_AD_CLIENT_ID: "33333333-4444-5555-6666-777777777777",
    AZURE_AD_AUDIENCE: "api://watchtower",
    MARQUEE_BASE_URL: "https://marquee.example.com",
    MARQUEE_SCOPE: "api://marquee/.default",
    MARQUEE_TENANT_ID: "22222222-3333-4444-5555-666666666666",
    MARQUEE_CLIENT_ID: "44444444-5555-6666-7777-888888888888",
    DB_PATH: STORAGE.databasePath
  });
  assert.equal(config.port, EVIDENCE.containerPort, "PORT must match containerPort");
  assert.equal(config.offhostRecovery.backupRoot, STORAGE.backupRoot);
  assert.equal(config.database.path, STORAGE.databasePath);
});

// ── Symlink escape ───────────────────────────────────────────────────────────

test("a data directory symlinked off the mount is rejected", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv(),
    probe: probe({ realPaths: { "/home/data": "/tmp/ephemeral-data" } })
  });
  expectReject(result, "DATABASE_PATH_SYMLINK_ESCAPE");
});

test("an existing database file symlinked off the mount is rejected", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv(),
    // The file exists (not in `missing`) but resolves elsewhere.
    probe: probe({ missing: [], realPaths: { [DB_PATH]: "/var/ephemeral/watchtower.db" } })
  });
  expectReject(result, "DATABASE_PATH_SYMLINK_ESCAPE");
});

test("an absent database file is normal on first boot and is accepted", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv(),
    probe: probe({ missing: [DB_PATH] })
  });
  assert.equal(result.ok, true, "a fresh deployment has no database file yet");
});

test("an existing database file that resolves to itself is accepted", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv(),
    probe: probe({ missing: [] })
  });
  assert.equal(result.ok, true);
});

// ── Journal mode ─────────────────────────────────────────────────────────────

test("a non-DELETE journal mode is rejected before the database is opened", () => {
  for (const mode of ["WAL", "wal", "TRUNCATE", "MEMORY", "delete"]) {
    const result = verifyPersistentStorage({
      databasePath: DB_PATH,
      env: healthyEnv({ SQLITE_JOURNAL_MODE: mode }),
      probe: probe()
    });
    expectReject(result, "SQLITE_JOURNAL_MODE_INVALID");
  }
});

test("the declared DELETE journal mode is accepted", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv({ SQLITE_JOURNAL_MODE: "DELETE" }),
    probe: probe()
  });
  assert.equal(result.ok, true);
});

test("an unset journal mode is accepted because the connection forces DELETE", () => {
  const result = verifyPersistentStorage({
    databasePath: DB_PATH,
    env: healthyEnv(),
    probe: probe()
  });
  assert.equal(result.ok, true);
});

test("the SQLite connection itself refuses anything but DELETE", () => {
  const source = readFileSync("lib/db/connection.ts", "utf8");
  assert.match(source, /journal_mode = DELETE/);
  assert.match(source, /journal mode must be DELETE/i);
});

// ── Sentinel probe discipline ────────────────────────────────────────────────

test("the sentinel is a private file round trip, never a database row", () => {
  const source = readFileSync("lib/deployment/persistentStorageProbe.ts", "utf8");
  // Create exclusively + readable, write, fsync, read back, unlink.
  assert.match(source, /openSync\(probeFile, "wx\+", 0o600\)/, "private exclusive create");
  assert.match(source, /writeSync\(/, "explicit write");
  assert.match(source, /fsyncSync\(/, "durability barrier");
  assert.match(source, /readSync\(/, "read-back verification");
  assert.match(source, /unlinkSync\(probeFile\)/, "sentinel is removed");

  // Nothing in the gate may touch the database: it has not been opened yet.
  const gate = readFileSync("lib/deployment/storageGate.ts", "utf8");
  for (const forbidden of ["better-sqlite3", "openDatabase", "INSERT", "CREATE TABLE", "prepare("]) {
    assert.ok(
      !gate.includes(forbidden),
      `the storage gate must not reference ${forbidden}: the sentinel is a file, never a database row`
    );
  }
});

test("a probe that cannot read back its own sentinel is rejected", () => {
  for (const code of [
    "EIO_SHORT_WRITE",
    "EIO_SIZE_MISMATCH",
    "EIO_SHORT_READ",
    "EIO_READBACK_MISMATCH"
  ]) {
    const result = verifyPersistentStorage({
      databasePath: DB_PATH,
      env: healthyEnv(),
      probe: probe({ writable: { ok: false, code } })
    });
    expectReject(result, "PERSISTENT_MOUNT_NOT_WRITABLE");
    if (!result.ok) {
      assert.ok(result.reason.includes(code), "the failing round-trip stage must be named");
    }
  }
});

// ── Image evidence ───────────────────────────────────────────────────────────

test("the image declares no Docker VOLUME at or below the persistent mount", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const prefix = EVIDENCE.forbiddenImageVolumePrefix;
  const offenders: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const trimmed = line.trim();
    if (!/^VOLUME\b/i.test(trimmed)) continue;
    // A VOLUME anywhere at or under /home would shadow the platform's
    // persistent share with an anonymous ephemeral volume that still looks
    // like a genuine non-root-device mount to every runtime probe.
    if (trimmed.includes(prefix)) offenders.push(trimmed);
  }
  assert.deepEqual(offenders, [], "an image VOLUME would silently defeat the storage gate");
});

test("the image does not pre-create the data directory", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const creates = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))
    .filter((line) => /mkdir[^\n]*\/home/.test(line));
  assert.deepEqual(
    creates,
    [],
    "an image-local /home/data is the ephemeral case the gate exists to reject"
  );
});

test("the checked-in JSON contract stays identical to the code contract", () => {
  const raw: unknown = JSON.parse(
    readFileSync("lib/deployment/deployment.contract.json", "utf8")
  );
  assert.deepEqual(raw, JSON.parse(JSON.stringify(DEPLOYMENT_CONTRACT)));
});
