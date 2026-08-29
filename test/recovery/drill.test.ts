import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  DRILL_CONTRACT,
  DRILL_CONTRACT_VERSION,
  runRecoveryDrill,
  writeDrillEvidence
} from "../../lib/recovery/drill.js";
import { RecoveryError } from "../../lib/recovery/errors.js";
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

function drillRoots(directory: string): { backupRoot: string; restoreRoot: string } {
  const backupRoot = join(directory, "backups");
  const restoreRoot = join(directory, "restore");
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(restoreRoot, { recursive: true });
  return { backupRoot, restoreRoot };
}

test("the drill runs backup, verify and restore and agrees on one digest", async () => {
  const directory = scratch("drill-happy");
  const authority = buildAuthorityFixture(directory);
  const { backupRoot, restoreRoot } = drillRoots(directory);

  const result = await runRecoveryDrill({
    databasePath: authority.path,
    backupRoot,
    restoreRoot,
    appVersion: "1.0.0",
    buildId: "42",
    sourceCommit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871",
    allowInsideGitWorktree: true,
    removeArtifacts: false
  });

  const evidence = result.evidence;
  assert.ok(evidence.ok);
  assert.equal(evidence.contract, DRILL_CONTRACT);
  assert.equal(evidence.contractVersion, DRILL_CONTRACT_VERSION);
  assert.equal(evidence.app, "watchtower");
  assert.equal(evidence.offhostContacted, false);

  assert.ok(evidence.digestsAgree);
  assert.equal(evidence.bundle.snapshotSha256, evidence.verify.sha256);
  assert.equal(evidence.verify.sha256, evidence.restore.sha256);
  assert.equal(evidence.bundle.snapshotBytes, evidence.restore.bytes);

  assert.ok(evidence.verify.identityMatches);
  assert.ok(evidence.verify.tableCountsMatch);
  assert.ok(evidence.restore.identityMatches);
  assert.ok(evidence.restore.tableCountsMatch);

  for (const checks of [evidence.bundle.checks, evidence.verify.checks, evidence.restore.checks]) {
    assert.ok(checks.quickCheck.ok);
    assert.ok(checks.integrityCheck.ok);
    assert.ok(checks.foreignKeyCheck.ok);
  }

  assert.deepEqual(
    evidence.timings.map((timing) => timing.step),
    ["backup", "verify", "restore"]
  );
  assert.ok(evidence.timings.every((timing) => timing.ok && timing.durationMs >= 0));
  assert.ok(evidence.totalDurationMs > 0);

  assert.equal(evidence.bundle.appVersion, "1.0.0");
  assert.equal(evidence.bundle.sourceCommit, "f0b05fc1dbf53e8aa26c215d8e858894a2793871");
  assert.equal(evidence.bundle.migrations?.[0]?.name, "app-local-identity-audit-settings");

  const counts = new Map(evidence.bundle.tables.map((table) => [table.name, table.rowCount]));
  assert.equal(counts.get("ups_readings"), authority.rowCounts.ups_readings);
  assert.equal(
    evidence.bundle.totalRows,
    Object.values(authority.rowCounts).reduce((sum, value) => sum + value, 0)
  );
  assert.equal(evidence.bundle.tableCount, evidence.bundle.tables.length);

  // Artifacts kept when asked.
  assert.ok(existsSync(result.bundleDir));
  assert.ok(existsSync(result.restoredPath));
  assert.equal(evidence.artifactsRemoved, false);
});

test("the drill removes large artifacts by default but keeps the evidence", async () => {
  const directory = scratch("drill-cleanup");
  const authority = buildAuthorityFixture(directory);
  const { backupRoot, restoreRoot } = drillRoots(directory);

  const result = await runRecoveryDrill({
    databasePath: authority.path,
    backupRoot,
    restoreRoot,
    allowInsideGitWorktree: true,
    removeArtifacts: true
  });

  assert.ok(result.evidence.ok);
  assert.equal(result.evidence.artifactsRemoved, true);
  assert.ok(!existsSync(result.bundleDir), "snapshot bundle must be removed");
  assert.ok(!existsSync(result.restoredPath), "restored copy must be removed");

  // The source authority is untouched.
  assert.ok(existsSync(authority.path));

  const evidencePath = writeDrillEvidence(join(directory, "drill-evidence.json"), result.evidence);
  const parsed = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.contract, DRILL_CONTRACT);
  assert.equal(parsed.ok, true);
  // Evidence stays small even though the database it describes may be large.
  assert.ok(readFileSync(evidencePath).byteLength < 64 * 1024);
});

test("the drill records the source identity it started from", async () => {
  const directory = scratch("drill-source");
  const authority = buildAuthorityFixture(directory);
  const { backupRoot, restoreRoot } = drillRoots(directory);

  const result = await runRecoveryDrill({
    databasePath: authority.path,
    backupRoot,
    restoreRoot,
    allowInsideGitWorktree: true,
    removeArtifacts: true
  });

  assert.equal(result.evidence.source.path, authority.path);
  assert.match(result.evidence.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.evidence.source.bytes > 0);
  // A live database is never byte-copied: the snapshot is produced by the online
  // backup API, so its digest need not equal the source file's.
  assert.match(result.evidence.bundle.snapshotSha256, /^[0-9a-f]{64}$/);
});

test("a drill over a database with foreign key violations fails closed", async () => {
  const directory = scratch("drill-fk");
  const authority = buildAuthorityFixture(directory);
  const { backupRoot, restoreRoot } = drillRoots(directory);

  const database = new Database(authority.path);
  database.pragma("foreign_keys = OFF");
  database
    .prepare("INSERT INTO outage_incident_evidence (incident_id, received_at) VALUES (?, ?)")
    .run("missing-incident", 1_790_000_007_000);
  database.close();

  await assert.rejects(
    runRecoveryDrill({
      databasePath: authority.path,
      backupRoot,
      restoreRoot,
      allowInsideGitWorktree: true,
      removeArtifacts: true
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_FOREIGN_KEY_CHECK_FAILED"
  );
});

test("the drill refuses a restore destination that is the live authority", async () => {
  const directory = scratch("drill-protect");
  const authority = buildAuthorityFixture(directory);
  const { backupRoot } = drillRoots(directory);

  // Restoring into the directory that holds the authority, under its own name.
  await assert.rejects(
    runRecoveryDrill({
      databasePath: authority.path,
      backupRoot,
      restoreRoot: directory,
      restoreFileName: "watchtower.db",
      allowInsideGitWorktree: true,
      removeArtifacts: true
    }),
    (error: unknown) =>
      error instanceof RecoveryError &&
      (error.code === "RESTORE_DESTINATION_UNSAFE" || error.code === "RESTORE_DESTINATION_EXISTS")
  );
});
