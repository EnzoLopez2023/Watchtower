import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPLOYMENT_CONTRACT,
  DeploymentContractError,
  assertPersistentStorage,
  enforcePersistentStorageContract,
  verifyPersistentStorage,
  type PersistentStorageProbe,
  type StorageRejectionCode,
  type StorageVerification,
  type WriteProbeResult
} from "../../lib/deployment/index.js";

const AUTHORITY = DEPLOYMENT_CONTRACT.persistentStorage.databasePath;
const ENV_NAME = DEPLOYMENT_CONTRACT.persistentStorage.requiredEnv.name;
const STORAGE_ON: NodeJS.ProcessEnv = { [ENV_NAME]: "true" };

/**
 * Synthetic probe. Defaults describe a genuine writable persistent mount:
 * `/home` is a real mount and `/home/data` sits on a different device than `/`.
 * Each test overrides only the branch it exercises.
 */
function fakeProbe(overrides: {
  readonly mountPoints?: readonly string[];
  readonly devices?: Readonly<Record<string, number | undefined>>;
  readonly writable?: WriteProbeResult;
  /** Symlink targets; a path absent here resolves to itself. */
  readonly realPaths?: Readonly<Record<string, string | undefined>>;
  /** Paths that do not exist at all (realPath returns undefined). */
  readonly missing?: readonly string[];
} = {}): PersistentStorageProbe {
  const devices = overrides.devices ?? { "/": 1, "/home/data": 42 };
  const missing = new Set(overrides.missing ?? ["/home/data/watchtower.db"]);
  return {
    mountPoints: () => overrides.mountPoints ?? ["/", "/home"],
    deviceId: (path) => devices[path],
    writeProbe: () => overrides.writable ?? { ok: true },
    realPath: (path) => {
      if (missing.has(path)) return undefined;
      return overrides.realPaths?.[path] ?? path;
    }
  };
}

function expectReject(
  result: StorageVerification,
  code: StorageRejectionCode
): asserts result is { ok: false; code: StorageRejectionCode; reason: string } {
  assert.equal(result.ok, false, `expected rejection ${code}, got acceptance`);
  if (!result.ok) assert.equal(result.code, code);
}

// ── 1. Missing flag ──────────────────────────────────────────────────────────

test("rejects when the storage flag is missing", () => {
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: {},
    probe: fakeProbe()
  });
  expectReject(result, "APP_SERVICE_STORAGE_DISABLED");
});

// ── 2. Flag not exactly "true" ───────────────────────────────────────────────

test('rejects every value that is not exactly "true"', () => {
  for (const value of ["false", "1", "TRUE", "True", " true", "true ", "yes", ""]) {
    const result = verifyPersistentStorage({
      databasePath: AUTHORITY,
      env: { [ENV_NAME]: value },
      probe: fakeProbe()
    });
    expectReject(result, "APP_SERVICE_STORAGE_DISABLED");
  }
});

// ── 3. DB path is not the authority ──────────────────────────────────────────

test("rejects when the database path is not the contract authority", () => {
  for (const path of ["/home/data/other.db", "/home/watchtower.db", "./data/watchtower.db"]) {
    const result = verifyPersistentStorage({
      databasePath: path,
      env: STORAGE_ON,
      probe: fakeProbe()
    });
    expectReject(result, "DATABASE_PATH_NOT_AUTHORITY");
  }
});

test("accepts a non-normalized spelling of the authority path", () => {
  const result = verifyPersistentStorage({
    databasePath: "/home/./data/../data/watchtower.db",
    env: STORAGE_ON,
    probe: fakeProbe()
  });
  assert.equal(result.ok, true);
});

// ── 4. Data directory absent ─────────────────────────────────────────────────

test("rejects when /home is mounted but /home/data does not exist", () => {
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe({ mountPoints: ["/", "/home"], devices: { "/": 1 } })
  });
  expectReject(result, "DATA_DIRECTORY_ABSENT");
});

// ── 5. Docker image-layer directory (the key regression) ─────────────────────

test("rejects the Docker image-layer case: same device as / and absent from mountinfo", () => {
  // Exactly what `mkdir -p /home/data` in an image layer produces with no mount.
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe({ mountPoints: ["/"], devices: { "/": 1, "/home/data": 1 } })
  });
  expectReject(result, "PERSISTENT_MOUNT_ABSENT");
});

test("the device-distinctness guard is not vacuous: mounted name but same device is rejected", () => {
  // Even if a mount entry for /home somehow exists, a data dir sharing the root
  // device is not the persistent share and must still be rejected.
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe({ mountPoints: ["/", "/home"], devices: { "/": 7, "/home/data": 7 } })
  });
  expectReject(result, "PERSISTENT_MOUNT_NOT_DISTINCT");
});

test("rejects when the root device evidence is unavailable", () => {
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe({ mountPoints: ["/", "/home"], devices: { "/home/data": 42 } })
  });
  expectReject(result, "MOUNT_EVIDENCE_UNAVAILABLE");
});

// ── 6. Real mount but not writable ───────────────────────────────────────────

test("rejects a real, distinct mount that is not writable", () => {
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe({ writable: { ok: false, code: "EROFS" } })
  });
  expectReject(result, "PERSISTENT_MOUNT_NOT_WRITABLE");
});

// ── 7. All conditions satisfied ──────────────────────────────────────────────

test("accepts a genuine writable persistent mount", () => {
  const result = verifyPersistentStorage({
    databasePath: AUTHORITY,
    env: STORAGE_ON,
    probe: fakeProbe()
  });
  assert.equal(result.ok, true);
});

test("assertPersistentStorage throws a coded, secret-safe error on rejection", () => {
  try {
    assertPersistentStorage({
      databasePath: AUTHORITY,
      env: { [ENV_NAME]: "super-secret-should-never-appear" },
      probe: fakeProbe()
    });
    assert.fail("expected a DeploymentContractError");
  } catch (error) {
    assert.ok(error instanceof DeploymentContractError);
    assert.equal(error.code, "APP_SERVICE_STORAGE_DISABLED");
    assert.doesNotMatch(error.message, /super-secret-should-never-appear/);
  }
});

test("assertPersistentStorage is silent when the contract is satisfied", () => {
  assert.doesNotThrow(() =>
    assertPersistentStorage({ databasePath: AUTHORITY, env: STORAGE_ON, probe: fakeProbe() })
  );
});

// ── 9. Development / test are unaffected by the gate ─────────────────────────

test("the gate is a no-op outside production even with a hostile probe", () => {
  const rejecting = fakeProbe({ mountPoints: [], devices: {}, writable: { ok: false, code: "EACCES" } });
  for (const environment of ["development", "test"]) {
    assert.doesNotThrow(() =>
      enforcePersistentStorageContract(
        { environment, database: { path: "./data/watchtower.db" } },
        { env: {}, probe: rejecting }
      )
    );
  }
});

test("the same rejecting inputs DO throw in production", () => {
  assert.throws(
    () =>
      enforcePersistentStorageContract(
        { environment: "production", database: { path: AUTHORITY } },
        { env: {}, probe: fakeProbe({ mountPoints: [] }) }
      ),
    DeploymentContractError
  );
});

test("production with a satisfied contract does not throw", () => {
  assert.doesNotThrow(() =>
    enforcePersistentStorageContract(
      { environment: "production", database: { path: AUTHORITY } },
      { env: STORAGE_ON, probe: fakeProbe() }
    )
  );
});
