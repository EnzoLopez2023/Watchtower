import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  assertLowerHex,
  assertSafeDestination,
  findGitWorktreeRoot,
  isInside,
  sha256File
} from "../../lib/recovery/paths.js";
import {
  RECENCY_COLUMNS,
  readSchemaVersionIdentity,
  readTableSnapshots,
  runSnapshotChecks
} from "../../lib/recovery/snapshot.js";
import { RecoveryError, describeRecoveryError, isRecoveryError } from "../../lib/recovery/errors.js";
import { buildAuthorityFixture, makeScratchDir, removeScratchDir } from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

test("isInside only accepts strict descendants", () => {
  assert.ok(isInside("/a/b", "/a/b/c"));
  assert.ok(isInside("/a/b", "/a/b/c/d.db"));
  assert.ok(!isInside("/a/b", "/a/b"));
  assert.ok(!isInside("/a/b", "/a/c"));
  assert.ok(!isInside("/a/b", "/a/b/../c"));
});

test("findGitWorktreeRoot detects both .git directories and gitdir files", () => {
  const directory = scratch("paths-git");
  const nested = join(directory, "nested", "deeper");
  mkdirSync(nested, { recursive: true });
  // The scratch directory may itself sit under a repository, so assert on the
  // transition rather than on an absolute null.
  assert.notEqual(findGitWorktreeRoot(nested), directory);

  writeFileSync(join(directory, ".git"), "gitdir: /elsewhere\n");
  assert.equal(findGitWorktreeRoot(nested), directory);

  const isolated = join(directory, "nested", "isolated");
  mkdirSync(join(isolated, ".git"), { recursive: true });
  assert.equal(findGitWorktreeRoot(isolated), isolated);
});

test("assertSafeDestination refuses paths outside the allowed root", () => {
  const directory = scratch("paths-root");
  const allowed = join(directory, "allowed");
  mkdirSync(allowed, { recursive: true });

  assert.equal(assertSafeDestination({
    destination: join(allowed, "ok.db"),
    allowedRoot: allowed,
    allowInsideGitWorktree: true
  }), join(allowed, "ok.db"));

  assert.throws(
    () =>
      assertSafeDestination({
        destination: join(directory, "outside.db"),
        allowedRoot: allowed,
        allowInsideGitWorktree: true
      }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );

  assert.throws(
    () =>
      assertSafeDestination({
        destination: join(allowed, "ok.db"),
        allowedRoot: join(directory, "missing-root"),
        allowInsideGitWorktree: true
      }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );
});

test("assertSafeDestination refuses protected paths, existing files and sidecars", () => {
  const directory = scratch("paths-guards");
  const allowed = join(directory, "allowed");
  mkdirSync(allowed, { recursive: true });

  const protectedPath = join(allowed, "live.db");
  writeFileSync(protectedPath, "live");
  assert.throws(
    () =>
      assertSafeDestination({
        destination: protectedPath,
        allowedRoot: allowed,
        protectedPaths: [protectedPath],
        allowInsideGitWorktree: true
      }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );

  const existing = join(allowed, "existing.db");
  writeFileSync(existing, "x");
  assert.throws(
    () => assertSafeDestination({ destination: existing, allowedRoot: allowed, allowInsideGitWorktree: true }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_EXISTS"
  );

  const withSidecar = join(allowed, "sidecar.db");
  writeFileSync(`${withSidecar}-journal`, "");
  assert.throws(
    () => assertSafeDestination({ destination: withSidecar, allowedRoot: allowed, allowInsideGitWorktree: true }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );
});

test("assertSafeDestination refuses Git worktrees by default", () => {
  const directory = scratch("paths-git-guard");
  const allowed = join(directory, "allowed");
  mkdirSync(allowed, { recursive: true });
  writeFileSync(join(directory, ".git"), "gitdir: /elsewhere\n");

  assert.throws(
    () => assertSafeDestination({ destination: join(allowed, "in-git.db"), allowedRoot: allowed }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );
});

test("assertLowerHex enforces 64 lowercase hex characters", () => {
  const digest = "a".repeat(64);
  assert.equal(assertLowerHex(digest, "digest"), digest);
  for (const bad of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}z`]) {
    assert.throws(
      () => assertLowerHex(bad, "digest"),
      (error: unknown) => error instanceof RecoveryError && error.code === "ARGUMENT_INVALID"
    );
  }
});

test("sha256File matches a known digest", async () => {
  const directory = scratch("paths-hash");
  const file = join(directory, "bytes.bin");
  writeFileSync(file, "");
  assert.equal(await sha256File(file), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("table snapshots report counts and the highest-priority recency column", () => {
  const directory = scratch("snapshot-tables");
  const authority = buildAuthorityFixture(directory);
  const database = new Database(authority.path, { readonly: true, fileMustExist: true });
  try {
    const snapshots = new Map(readTableSnapshots(database).map((table) => [table.name, table]));
    assert.equal(snapshots.get("ups_readings")?.rowCount, 4);
    assert.equal(snapshots.get("ups_readings")?.recency?.column, "received_at");
    assert.equal(snapshots.get("outage_incidents")?.recency?.column, "updated_at");
    assert.equal(snapshots.get("schema_migrations")?.recency?.column, "applied_at");
    assert.ok(!snapshots.has("sqlite_sequence"));

    // `updated_at` outranks `received_at` in the priority list.
    assert.ok(RECENCY_COLUMNS.indexOf("updated_at") < RECENCY_COLUMNS.indexOf("received_at"));
  } finally {
    database.close();
  }
});

test("an empty table reports no recency instead of a null maximum", () => {
  const directory = scratch("snapshot-empty");
  const path = join(directory, "empty.db");
  const database = new Database(path);
  try {
    database.exec("CREATE TABLE empty_table (id INTEGER PRIMARY KEY, received_at INTEGER)");
    const snapshots = readTableSnapshots(database);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots.at(0)?.rowCount, 0);
    assert.equal(snapshots.at(0)?.recency, null);
  } finally {
    database.close();
  }
});

test("schema/version identity covers objects and applied migrations", () => {
  const directory = scratch("snapshot-identity");
  const authority = buildAuthorityFixture(directory);
  const database = new Database(authority.path, { fileMustExist: true });
  try {
    const before = readSchemaVersionIdentity(database);
    assert.match(before.schemaSha256, /^[0-9a-f]{64}$/);
    assert.equal(before.userVersion, 0);
    assert.equal(before.schemaObjectCounts.triggers, 1);
    assert.equal(before.migrations?.length, 1);

    database.exec("CREATE INDEX idx_extra ON ups_readings(ups_status)");
    const after = readSchemaVersionIdentity(database);
    assert.notEqual(after.schemaSha256, before.schemaSha256);
    assert.equal(after.schemaObjectCounts.indexes, before.schemaObjectCounts.indexes + 1);
  } finally {
    database.close();
  }
});

test("runSnapshotChecks passes on a healthy database and throws on FK violations", () => {
  const directory = scratch("snapshot-checks");
  const authority = buildAuthorityFixture(directory);

  const healthy = new Database(authority.path, { readonly: true, fileMustExist: true });
  try {
    const checks = runSnapshotChecks(healthy);
    assert.deepEqual(checks.quickCheck.messages, ["ok"]);
    assert.deepEqual(checks.integrityCheck.messages, ["ok"]);
    assert.deepEqual(checks.foreignKeyCheck.violations, []);
  } finally {
    healthy.close();
  }

  const broken = new Database(authority.path);
  broken.pragma("foreign_keys = OFF");
  broken
    .prepare("INSERT INTO outage_incident_evidence (incident_id, received_at) VALUES (?, ?)")
    .run("nope", 1);
  broken.close();

  const reopened = new Database(authority.path, { readonly: true, fileMustExist: true });
  try {
    assert.throws(
      () => runSnapshotChecks(reopened),
      (error: unknown) =>
        error instanceof RecoveryError && error.code === "BACKUP_FOREIGN_KEY_CHECK_FAILED"
    );
  } finally {
    reopened.close();
  }
});

test("recovery errors carry stable codes and frozen details", () => {
  const error = new RecoveryError("BLOB_NAME_INVALID", "bad name", { name: "../x" });
  assert.ok(isRecoveryError(error));
  assert.deepEqual(describeRecoveryError(error), { code: "BLOB_NAME_INVALID", message: "bad name" });
  assert.throws(() => {
    (error.details as Record<string, unknown>).name = "mutated";
  });
  assert.deepEqual(describeRecoveryError(new Error("plain")), {
    code: "UNEXPECTED_ERROR",
    message: "plain"
  });
  assert.deepEqual(describeRecoveryError("string failure"), {
    code: "UNEXPECTED_ERROR",
    message: "string failure"
  });
});
