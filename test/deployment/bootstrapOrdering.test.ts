import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { openDatabase, type SqliteDatabase } from "../../lib/db/connection.js";
import {
  enforcePersistentStorageContract,
  type DeploymentContract,
  type PersistentStorageProbe,
  type WriteProbeResult
} from "../../lib/deployment/index.js";

const SCRATCH = resolve("./.scratch/wt/tmp");
const ENV_NAME = "WEBSITES_ENABLE_APP_SERVICE_STORAGE";
const STORAGE_ON: NodeJS.ProcessEnv = { [ENV_NAME]: "true" };
const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

interface Layout {
  readonly base: string;
  readonly mountDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly contract: DeploymentContract;
}

function layout(name: string): Layout {
  const base = join(SCRATCH, `bootstrap-order-${name}-${process.pid}`);
  const mountDir = join(base, "home");
  const dataDir = join(mountDir, "data");
  const dbPath = join(dataDir, "watchtower.db");
  mkdirSync(base, { recursive: true });
  createdDirs.push(base);
  const contract: DeploymentContract = {
    schema: "test.deployment.contract",
    platform: "test",
    containerRegistry: {
      mode: "shared-existing",
      name: "acrenzolopez01",
      loginServer: "acrenzolopez01.azurecr.io",
      dedicatedRegistryAllowed: false
    },
    persistentStorage: {
      requiredEnv: { name: ENV_NAME, value: "true" },
      mountPoint: mountDir,
      dataDirectory: dataDir,
      databasePath: dbPath,
      backupRoot: join(dataDir, "backups", "watchtower"),
      journalMode: { name: "SQLITE_JOURNAL_MODE", value: "DELETE" }
    },
    evidence: {
      deploymentProfile: "sqlite-one-worker",
      dataStorageMode: "persistent",
      numberOfWorkers: 1,
      alwaysOn: true,
      containerPort: 3000,
      healthCheckPath: "/api/live",
      readinessPath: "/api/ready",
      forbiddenImageVolumePrefix: mountDir
    }
  };
  return { base, mountDir, dataDir, dbPath, contract };
}

function probe(overrides: {
  readonly mountPoints?: readonly string[];
  readonly devices?: Readonly<Record<string, number | undefined>>;
  readonly writable?: WriteProbeResult;
  /** Paths that do not exist; the database file is absent on first boot. */
  readonly missing?: readonly string[];
}): PersistentStorageProbe {
  return {
    mountPoints: () => overrides.mountPoints ?? [],
    deviceId: (path) => (overrides.devices ? overrides.devices[path] : undefined),
    writeProbe: () => overrides.writable ?? { ok: true },
    realPath: (path: string) => (overrides.missing?.includes(path) ? undefined : path)
  };
}

/**
 * Faithfully mirrors the bootstrap ordering: enforce the storage contract, then
 * (only if it did not throw) open the database. `opened` proves whether control
 * ever reached openDatabase.
 */
function startupDatabaseStep(args: {
  readonly configuredPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly probe: PersistentStorageProbe;
  readonly contract: DeploymentContract;
}): { database: SqliteDatabase; opened: boolean } {
  let opened = false;
  enforcePersistentStorageContract(
    { environment: "production", database: { path: args.configuredPath } },
    { env: args.env, probe: args.probe, contract: args.contract }
  );
  opened = true;
  const database = openDatabase({
    path: args.configuredPath,
    busyTimeoutMs: 500,
    fileMustExist: false
  });
  return { database, opened };
}

interface RejectionCase {
  readonly name: string;
  readonly configuredPath: (l: Layout) => string;
  readonly env: NodeJS.ProcessEnv;
  readonly probe: (l: Layout) => PersistentStorageProbe;
}

const REJECTIONS: readonly RejectionCase[] = [
  {
    name: "flag-missing",
    configuredPath: (l) => l.dbPath,
    env: {},
    probe: (l) => probe({ mountPoints: [l.mountDir], devices: { "/": 1, [l.dataDir]: 42 } })
  },
  {
    name: "path-not-authority",
    configuredPath: (l) => join(l.base, "wrong.db"),
    env: STORAGE_ON,
    probe: (l) => probe({ mountPoints: [l.mountDir], devices: { "/": 1, [l.dataDir]: 42 } })
  },
  {
    name: "mount-absent",
    configuredPath: (l) => l.dbPath,
    env: STORAGE_ON,
    probe: () => probe({ mountPoints: [] })
  },
  {
    name: "data-dir-absent",
    configuredPath: (l) => l.dbPath,
    env: STORAGE_ON,
    probe: (l) => probe({ mountPoints: [l.mountDir], devices: { "/": 1 } })
  },
  {
    name: "same-device-image-layer",
    configuredPath: (l) => l.dbPath,
    env: STORAGE_ON,
    probe: (l) => probe({ mountPoints: [l.mountDir], devices: { "/": 1, [l.dataDir]: 1 } })
  },
  {
    name: "not-writable",
    configuredPath: (l) => l.dbPath,
    env: STORAGE_ON,
    probe: (l) =>
      probe({
        mountPoints: [l.mountDir],
        devices: { "/": 1, [l.dataDir]: 42 },
        writable: { ok: false, code: "EACCES" }
      })
  }
];

for (const rejection of REJECTIONS) {
  test(`no database file is created before rejection: ${rejection.name}`, () => {
    const l = layout(rejection.name);
    const configuredPath = rejection.configuredPath(l);

    let threw = false;
    let reachedOpen = false;
    try {
      const result = startupDatabaseStep({
        configuredPath,
        env: rejection.env,
        probe: rejection.probe(l),
        contract: l.contract
      });
      reachedOpen = result.opened;
      result.database.close();
    } catch {
      threw = true;
    }

    assert.equal(threw, true, "the storage gate must reject this startup");
    assert.equal(reachedOpen, false, "openDatabase must never be reached on rejection");
    // The core guarantee: no SQLite file (nor its parent data dir) was created.
    assert.equal(existsSync(l.dbPath), false, "the authority DB file must not exist");
    assert.equal(existsSync(configuredPath), false, "no DB file must exist at the configured path");
    assert.equal(existsSync(l.dataDir), false, "the data directory must not be created");
  });
}

test("when the contract is satisfied, startup proceeds and the DB file is created", () => {
  const l = layout("accepted");
  const result = startupDatabaseStep({
    configuredPath: l.dbPath,
    env: STORAGE_ON,
    probe: probe({ mountPoints: [l.mountDir], devices: { "/": 1, [l.dataDir]: 42 } }),
    contract: l.contract
  });
  try {
    assert.equal(result.opened, true, "openDatabase must be reached once the gate passes");
    assert.equal(existsSync(l.dbPath), true, "the DB file is created only after the gate passes");
  } finally {
    result.database.close();
  }
});
