/**
 * Recovery drill: backup -> verify -> disposable restore, in one command, with a
 * small preserved evidence artefact.
 *
 * The drill exercises exactly the path an operator would run for real, against a
 * real database file. It never contacts off-host storage — replication is a
 * separate command — so a drill can be run anywhere without credentials.
 *
 * Large intermediates (the snapshot bundle and the restored copy) are optionally
 * removed once the evidence has been collected, so a multi-gigabyte drill leaves
 * behind only a few kilobytes of JSON.
 */

import { rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { RecoveryError } from "./errors.js";
import { sha256File } from "./paths.js";
import { createBackup, verifyBackup, type BackupManifest } from "./backup.js";
import { restoreBundle } from "./offhost.js";
import type { SnapshotChecks, TableSnapshot } from "./snapshot.js";

export const DRILL_CONTRACT = "watchtower.recovery-drill-evidence";
export const DRILL_CONTRACT_VERSION = 1;

export interface DrillStepTiming {
  readonly step: "backup" | "verify" | "restore";
  readonly durationMs: number;
  readonly ok: boolean;
}

export interface RecoveryDrillEvidence {
  readonly contract: string;
  readonly contractVersion: number;
  readonly generatedUtc: string;
  readonly app: string;
  readonly runner: { readonly node: string; readonly platform: string; readonly sqliteVersion: string | null };
  readonly source: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly bundle: {
    readonly id: string;
    readonly createdUtc: string;
    readonly appVersion: string | null;
    readonly buildId: string | null;
    readonly sourceCommit: string | null;
    readonly snapshotBytes: number;
    readonly snapshotSha256: string;
    readonly schemaSha256: string;
    readonly userVersion: number;
    readonly applicationId: number;
    readonly schemaObjectCounts: BackupManifest["database"]["identity"]["schemaObjectCounts"];
    readonly migrations: BackupManifest["database"]["identity"]["migrations"];
    readonly tableCount: number;
    readonly totalRows: number;
    readonly tables: readonly TableSnapshot[];
    readonly checks: SnapshotChecks;
  };
  readonly verify: {
    readonly bytes: number;
    readonly sha256: string;
    readonly identityMatches: boolean;
    readonly tableCountsMatch: boolean;
    readonly checks: SnapshotChecks;
  };
  readonly restore: {
    readonly destinationRoot: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly identityMatches: boolean;
    readonly tableCountsMatch: boolean;
    readonly checks: SnapshotChecks;
  };
  readonly digestsAgree: boolean;
  readonly timings: readonly DrillStepTiming[];
  readonly totalDurationMs: number;
  readonly artifactsRemoved: boolean;
  readonly offhostContacted: false;
  readonly ok: boolean;
}

export interface RecoveryDrillOptions {
  readonly databasePath: string;
  readonly backupRoot: string;
  readonly restoreRoot: string;
  readonly restoreFileName?: string;
  readonly appVersion?: string | null;
  readonly buildId?: string | null;
  readonly sourceCommit?: string | null;
  readonly protectedPaths?: readonly string[];
  readonly busyTimeoutMs?: number;
  readonly allowInsideGitWorktree?: boolean;
  /** Remove the snapshot bundle and restored copy once evidence is collected. */
  readonly removeArtifacts?: boolean;
  readonly now?: Date;
  readonly onProgress?: (message: string) => void;
}

export interface RecoveryDrillResult {
  readonly evidence: RecoveryDrillEvidence;
  readonly bundleDir: string;
  readonly restoredPath: string;
}

function totalRows(tables: readonly TableSnapshot[]): number {
  return tables.reduce((sum, table) => sum + table.rowCount, 0);
}

/** Runs backup -> verify -> restore against a real database and returns evidence. */
export async function runRecoveryDrill(options: RecoveryDrillOptions): Promise<RecoveryDrillResult> {
  const startedAt = process.hrtime.bigint();
  const databasePath = resolve(options.databasePath);
  const restoreRoot = resolve(options.restoreRoot);
  const timings: DrillStepTiming[] = [];

  const sourceStats = await stat(databasePath);
  const sourceSha256 = await sha256File(databasePath);

  options.onProgress?.("drill: backup");
  const backup = await createBackup({
    sourcePath: databasePath,
    backupRoot: options.backupRoot,
    appVersion: options.appVersion ?? null,
    buildId: options.buildId ?? null,
    sourceCommit: options.sourceCommit ?? null,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.allowInsideGitWorktree === undefined
      ? {}
      : { allowInsideGitWorktree: options.allowInsideGitWorktree }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  timings.push({ step: "backup", durationMs: backup.durationMs, ok: true });

  options.onProgress?.("drill: verify");
  const verifyStartedAt = process.hrtime.bigint();
  const verified = await verifyBackup({
    bundleDir: backup.bundleDir,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs })
  });
  timings.push({
    step: "verify",
    durationMs: Number(process.hrtime.bigint() - verifyStartedAt) / 1e6,
    ok: verified.identityMatches && verified.tableCountsMatch
  });

  options.onProgress?.("drill: restore");
  const restoredPath = resolve(restoreRoot, options.restoreFileName ?? `${backup.manifest.bundleId}.sqlite3`);
  const restored = await restoreBundle({
    bundleDir: backup.bundleDir,
    destination: restoredPath,
    allowedRoot: restoreRoot,
    protectedPaths: [databasePath, ...(options.protectedPaths ?? [])],
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.allowInsideGitWorktree === undefined
      ? {}
      : { allowInsideGitWorktree: options.allowInsideGitWorktree })
  });
  timings.push({
    step: "restore",
    durationMs: restored.durationMs,
    ok: restored.identityMatches && restored.tableCountsMatch
  });

  const manifest = backup.manifest;
  const digestsAgree =
    manifest.database.sha256 === verified.sha256 && verified.sha256 === restored.sha256;
  if (!digestsAgree) {
    throw new RecoveryError("RESTORE_VERIFICATION_FAILED", "Drill digests disagree across backup, verify and restore", {
      backup: manifest.database.sha256,
      verify: verified.sha256,
      restore: restored.sha256
    });
  }

  let artifactsRemoved = false;
  if (options.removeArtifacts === true) {
    await rm(backup.bundleDir, { recursive: true, force: true });
    await rm(restored.destination, { force: true });
    artifactsRemoved = true;
    options.onProgress?.("drill: large artifacts removed");
  }

  const evidence: RecoveryDrillEvidence = {
    contract: DRILL_CONTRACT,
    contractVersion: DRILL_CONTRACT_VERSION,
    generatedUtc: (options.now ?? new Date()).toISOString(),
    app: manifest.app,
    runner: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      sqliteVersion: null
    },
    source: { path: databasePath, bytes: sourceStats.size, sha256: sourceSha256 },
    bundle: {
      id: manifest.bundleId,
      createdUtc: manifest.createdUtc,
      appVersion: manifest.appVersion,
      buildId: manifest.buildId,
      sourceCommit: manifest.sourceCommit,
      snapshotBytes: manifest.database.bytes,
      snapshotSha256: manifest.database.sha256,
      schemaSha256: manifest.database.identity.schemaSha256,
      userVersion: manifest.database.identity.userVersion,
      applicationId: manifest.database.identity.applicationId,
      schemaObjectCounts: manifest.database.identity.schemaObjectCounts,
      migrations: manifest.database.identity.migrations,
      tableCount: manifest.database.tables.length,
      totalRows: totalRows(manifest.database.tables),
      tables: manifest.database.tables,
      checks: manifest.database.checks
    },
    verify: {
      bytes: verified.bytes,
      sha256: verified.sha256,
      identityMatches: verified.identityMatches,
      tableCountsMatch: verified.tableCountsMatch,
      checks: verified.checks
    },
    restore: {
      destinationRoot: restoreRoot,
      bytes: restored.bytes,
      sha256: restored.sha256,
      identityMatches: restored.identityMatches,
      tableCountsMatch: restored.tableCountsMatch,
      checks: restored.checks
    },
    digestsAgree,
    timings: Object.freeze(timings),
    totalDurationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    artifactsRemoved,
    offhostContacted: false,
    ok: timings.every((timing) => timing.ok) && digestsAgree
  };

  return { evidence, bundleDir: backup.bundleDir, restoredPath: restored.destination };
}

export function writeDrillEvidence(path: string, evidence: RecoveryDrillEvidence): string {
  const target = resolve(path);
  try {
    writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
  } catch (cause) {
    throw new RecoveryError("BACKUP_MANIFEST_INVALID", `Cannot write drill evidence to ${target}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
  return target;
}
