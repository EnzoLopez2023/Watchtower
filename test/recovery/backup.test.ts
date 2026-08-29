import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  BACKUP_CONTRACT,
  BACKUP_CONTRACT_VERSION,
  BACKUP_MANIFEST_FILE,
  BACKUP_SNAPSHOT_FILE,
  createBackup,
  readBackupManifest,
  verifyBackup
} from "../../lib/recovery/backup.js";
import { restoreBundle } from "../../lib/recovery/offhost.js";
import { RecoveryError } from "../../lib/recovery/errors.js";
import { sha256File } from "../../lib/recovery/paths.js";
import { runSnapshotChecks, readTableSnapshots } from "../../lib/recovery/snapshot.js";
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

test("createBackup produces a verified bundle with full evidence", async () => {
  const directory = scratch("backup-create");
  const authority = buildAuthorityFixture(directory);

  const result = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    appVersion: "1.0.0",
    buildId: "42",
    sourceCommit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871",
    allowInsideGitWorktree: true
  });

  assert.ok(existsSync(result.snapshotPath));
  assert.ok(existsSync(result.manifestPath));
  assert.match(result.manifest.bundleId, /^\d{8}T\d{9}Z-[0-9a-f]{16}$/);
  assert.equal(result.manifest.contract, BACKUP_CONTRACT);
  assert.equal(result.manifest.contractVersion, BACKUP_CONTRACT_VERSION);
  assert.equal(result.manifest.database.file, BACKUP_SNAPSHOT_FILE);
  assert.equal(result.manifest.appVersion, "1.0.0");
  assert.equal(result.manifest.sourceCommit, "f0b05fc1dbf53e8aa26c215d8e858894a2793871");

  assert.match(result.manifest.database.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.manifest.database.sha256, await sha256File(result.snapshotPath));
  assert.ok(result.manifest.database.bytes > 0);

  assert.ok(result.manifest.database.checks.quickCheck.ok);
  assert.ok(result.manifest.database.checks.integrityCheck.ok);
  assert.ok(result.manifest.database.checks.foreignKeyCheck.ok);

  const identity = result.manifest.database.identity;
  assert.match(identity.schemaSha256, /^[0-9a-f]{64}$/);
  assert.equal(identity.schemaObjectCounts.tables, 5); // 4 user tables + sqlite_sequence
  assert.equal(identity.schemaObjectCounts.triggers, 1);
  assert.equal(identity.migrations?.at(0)?.name, "app-local-identity-audit-settings");

  const tables = new Map(result.manifest.database.tables.map((table) => [table.name, table]));
  assert.equal(tables.get("ups_readings")?.rowCount, authority.rowCounts.ups_readings);
  assert.equal(tables.get("ups_readings")?.recency?.column, "received_at");
  assert.equal(tables.get("ups_readings")?.recency?.raw, 1_790_000_004_000);
  assert.equal(tables.get("outage_incidents")?.recency?.column, "updated_at");
});

test("the backup uses the online backup API, not a byte copy", async () => {
  const directory = scratch("backup-online");
  const authority = buildAuthorityFixture(directory);

  // Hold an open write handle and an uncommitted change while backing up.
  const live = new Database(authority.path);
  live.pragma("journal_mode = DELETE");
  live.exec("BEGIN");
  live.prepare("INSERT INTO ups_readings (received_at, ups_status) VALUES (?, ?)").run(1_790_000_009_000, "PENDING");

  const result = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  live.exec("ROLLBACK");
  live.close();

  // The snapshot is internally consistent and does not contain the rolled-back row.
  const snapshot = new Database(result.snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const checks = runSnapshotChecks(snapshot);
    assert.ok(checks.integrityCheck.ok);
    const row = snapshot.prepare("SELECT COUNT(*) AS c FROM ups_readings WHERE ups_status = 'PENDING'").get() as {
      c: number;
    };
    assert.equal(Number(row.c), 0);
  } finally {
    snapshot.close();
  }

  // A snapshot is a fresh file, never the same inode as the authority.
  assert.notEqual(result.snapshotPath, authority.path);
});

test("verifyBackup accepts a good bundle", async () => {
  const directory = scratch("backup-verify-ok");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const verified = await verifyBackup({ bundleDir: created.bundleDir });
  assert.equal(verified.sha256, created.manifest.database.sha256);
  assert.equal(verified.bytes, created.manifest.database.bytes);
  assert.ok(verified.identityMatches);
  assert.ok(verified.tableCountsMatch);
  assert.deepEqual(verified.tableCountDifferences, []);
});

test("verifyBackup rejects a corrupted snapshot", async () => {
  const directory = scratch("backup-verify-corrupt");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const bytes = readFileSync(created.snapshotPath);
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  writeFileSync(created.snapshotPath, bytes);

  await assert.rejects(
    verifyBackup({ bundleDir: created.bundleDir }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_SHA_MISMATCH"
  );
});

test("verifyBackup rejects a truncated snapshot", async () => {
  const directory = scratch("backup-verify-truncated");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const bytes = readFileSync(created.snapshotPath);
  writeFileSync(created.snapshotPath, bytes.subarray(0, bytes.length - 4096));

  await assert.rejects(
    verifyBackup({ bundleDir: created.bundleDir }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_BYTES_MISMATCH"
  );
});

test("verifyBackup rejects content that drifted from its manifest", async () => {
  const directory = scratch("backup-verify-drift");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  // Add a row, then rewrite the manifest so bytes/sha match but counts do not.
  const snapshot = new Database(created.snapshotPath);
  snapshot.pragma("journal_mode = DELETE");
  snapshot.prepare("INSERT INTO ups_readings (received_at, ups_status) VALUES (?, ?)").run(1_790_000_010_000, "OL");
  snapshot.close();

  const manifest = JSON.parse(readFileSync(created.manifestPath, "utf8")) as Record<string, never>;
  const database = manifest.database as unknown as Record<string, unknown>;
  const { statSync } = await import("node:fs");
  database.bytes = statSync(created.snapshotPath).size;
  database.sha256 = await sha256File(created.snapshotPath);
  writeFileSync(created.manifestPath, JSON.stringify(manifest));

  await assert.rejects(
    verifyBackup({ bundleDir: created.bundleDir }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_MANIFEST_MISMATCH"
  );
});

test("readBackupManifest rejects an unsupported or unsafe manifest", async () => {
  const directory = scratch("backup-manifest-bad");
  const bundle = join(directory, "bundle");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bundle, { recursive: true });

  await assert.rejects(
    readBackupManifest(bundle),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_MANIFEST_INVALID"
  );

  writeFileSync(join(bundle, BACKUP_MANIFEST_FILE), JSON.stringify({ contract: "other", contractVersion: 1 }));
  await assert.rejects(
    readBackupManifest(bundle),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_MANIFEST_INVALID"
  );

  writeFileSync(
    join(bundle, BACKUP_MANIFEST_FILE),
    JSON.stringify({
      contract: BACKUP_CONTRACT,
      contractVersion: BACKUP_CONTRACT_VERSION,
      database: { file: "../escape.db", bytes: 1, sha256: "b".repeat(64) }
    })
  );
  await assert.rejects(
    readBackupManifest(bundle),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_MANIFEST_INVALID"
  );
});

test("restoreBundle restores into a disposable destination and verifies it", async () => {
  const directory = scratch("restore-ok");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const restoreRoot = join(directory, "restore");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(restoreRoot, { recursive: true });

  const restored = await restoreBundle({
    bundleDir: created.bundleDir,
    destination: join(restoreRoot, "drill.db"),
    allowedRoot: restoreRoot,
    protectedPaths: [authority.path],
    allowInsideGitWorktree: true
  });

  assert.equal(restored.sha256, created.manifest.database.sha256);
  assert.ok(restored.identityMatches);
  assert.ok(restored.tableCountsMatch);
  assert.ok(restored.checks.quickCheck.ok);
  assert.ok(restored.checks.integrityCheck.ok);
  assert.ok(restored.checks.foreignKeyCheck.ok);

  const database = new Database(restored.destination, { readonly: true, fileMustExist: true });
  try {
    const counts = new Map(readTableSnapshots(database).map((table) => [table.name, table.rowCount]));
    assert.equal(counts.get("ups_readings"), authority.rowCounts.ups_readings);
    assert.equal(counts.get("outage_incident_evidence"), authority.rowCounts.outage_incident_evidence);

    const blob = database.prepare("SELECT raw FROM ups_readings WHERE received_at = ?").get(1_790_000_004_000) as {
      raw: Buffer;
    };
    assert.deepEqual(blob.raw, Buffer.from("日本語", "utf8"));
  } finally {
    database.close();
  }
});

test("restore refuses the live authority and paths outside the allowed root", async () => {
  const directory = scratch("restore-unsafe");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const restoreRoot = join(directory, "restore");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(restoreRoot, { recursive: true });

  await assert.rejects(
    restoreBundle({
      bundleDir: created.bundleDir,
      destination: authority.path,
      allowedRoot: directory,
      protectedPaths: [authority.path],
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );

  await assert.rejects(
    restoreBundle({
      bundleDir: created.bundleDir,
      destination: join(directory, "..", "escaped.db"),
      allowedRoot: restoreRoot,
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_UNSAFE"
  );
});

test("restore refuses to overwrite an existing destination", async () => {
  const directory = scratch("restore-exists");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const restoreRoot = join(directory, "restore");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(restoreRoot, { recursive: true });
  const destination = join(restoreRoot, "existing.db");
  writeFileSync(destination, "already here");

  await assert.rejects(
    restoreBundle({
      bundleDir: created.bundleDir,
      destination,
      allowedRoot: restoreRoot,
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "RESTORE_DESTINATION_EXISTS"
  );
  assert.equal(readFileSync(destination, "utf8"), "already here");
});

test("restore of a corrupted bundle fails and leaves no partial file", async () => {
  const directory = scratch("restore-corrupt");
  const authority = buildAuthorityFixture(directory);
  const created = await createBackup({
    sourcePath: authority.path,
    backupRoot: join(directory, "backups"),
    allowInsideGitWorktree: true
  });

  const bytes = readFileSync(created.snapshotPath);
  bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
  writeFileSync(created.snapshotPath, bytes);

  const restoreRoot = join(directory, "restore");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(restoreRoot, { recursive: true });
  const destination = join(restoreRoot, "drill.db");

  await assert.rejects(
    restoreBundle({
      bundleDir: created.bundleDir,
      destination,
      allowedRoot: restoreRoot,
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_SHA_MISMATCH"
  );
  assert.ok(!existsSync(destination));
});

test("backup of a missing database fails closed", async () => {
  const directory = scratch("backup-missing");
  await assert.rejects(
    createBackup({
      sourcePath: join(directory, "absent.db"),
      backupRoot: join(directory, "backups"),
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "SOURCE_NOT_FOUND"
  );
});

test("snapshot checks reject a database with foreign key violations", async () => {
  const directory = scratch("backup-fk");
  const authority = buildAuthorityFixture(directory);

  const database = new Database(authority.path);
  database.pragma("foreign_keys = OFF");
  database
    .prepare("INSERT INTO outage_incident_evidence (incident_id, received_at) VALUES (?, ?)")
    .run("missing-incident", 1_790_000_007_000);
  database.close();

  await assert.rejects(
    createBackup({
      sourcePath: authority.path,
      backupRoot: join(directory, "backups"),
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_FOREIGN_KEY_CHECK_FAILED"
  );
});

test("two backups of the same unchanged database agree on content", async () => {
  const directory = scratch("backup-repeat");
  const authority = buildAuthorityFixture(directory);
  const root = join(directory, "backups");

  const first = await createBackup({ sourcePath: authority.path, backupRoot: root, allowInsideGitWorktree: true });
  const second = await createBackup({ sourcePath: authority.path, backupRoot: root, allowInsideGitWorktree: true });

  assert.notEqual(first.manifest.bundleId, second.manifest.bundleId);
  assert.equal(first.manifest.database.sha256, second.manifest.database.sha256);
  assert.equal(
    first.manifest.database.identity.schemaSha256,
    second.manifest.database.identity.schemaSha256
  );
  assert.deepEqual(
    first.manifest.database.tables.map((table) => [table.name, table.rowCount]),
    second.manifest.database.tables.map((table) => [table.name, table.rowCount])
  );
});
