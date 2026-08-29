/**
 * Database-native consistent backup and local verification.
 *
 * The snapshot is produced with SQLite's online backup API (better-sqlite3's
 * `Database#backup`), never a byte copy of a live file. The bundle is a
 * directory containing the snapshot plus a versioned JSON manifest.
 */

import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { RecoveryError } from "./errors.js";
import { assertLowerHex, assertSafeDestination, sha256File } from "./paths.js";
import {
  readSchemaVersionIdentity,
  readTableSnapshots,
  runSnapshotChecks,
  type SchemaVersionIdentity,
  type SnapshotChecks,
  type TableSnapshot
} from "./snapshot.js";

export const BACKUP_CONTRACT = "watchtower.sqlite-backup-manifest";
export const BACKUP_CONTRACT_VERSION = 1;
export const BACKUP_SNAPSHOT_FILE = "watchtower.sqlite3";
export const BACKUP_MANIFEST_FILE = "manifest.json";

export interface BackupManifest {
  readonly contract: string;
  readonly contractVersion: number;
  readonly app: string;
  readonly bundleId: string;
  readonly createdUtc: string;
  readonly appVersion: string | null;
  readonly buildId: string | null;
  readonly sourceCommit: string | null;
  readonly database: {
    readonly file: string;
    readonly sourcePath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly identity: SchemaVersionIdentity;
    readonly tables: readonly TableSnapshot[];
    readonly checks: SnapshotChecks;
  };
}

export interface CreateBackupOptions {
  readonly sourcePath: string;
  /** Directory that will receive the `<bundleId>` bundle directory. */
  readonly backupRoot: string;
  readonly appVersion?: string | null;
  readonly buildId?: string | null;
  readonly sourceCommit?: string | null;
  readonly busyTimeoutMs?: number;
  readonly allowInsideGitWorktree?: boolean;
  readonly now?: Date;
}

export interface CreateBackupResult {
  readonly bundleDir: string;
  readonly snapshotPath: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
  readonly durationMs: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const PARTIAL_SUFFIX = ".partial";
/** A partial older than this is considered abandoned. */
export const DEFAULT_STALE_PARTIAL_MS = 6 * 60 * 60 * 1000;
/** `<bundleId>.partial` where bundleId is the exact generated shape. */
const PARTIAL_DIRECTORY_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{16}\.partial$/;

export interface PrunedPartial {
  readonly name: string;
  readonly ageMs: number;
}

/**
 * Removes abandoned `<bundleId>.partial` directories under a backup root.
 *
 * Deliberately narrow: only direct children of the resolved root, only names
 * matching the exact generated bundle-id shape, only real directories (never a
 * symlink, so a planted link cannot redirect the delete), and only once older
 * than `olderThanMs`. Anything else is left alone.
 */
export async function pruneStalePartials(options: {
  readonly backupRoot: string;
  readonly olderThanMs?: number;
  readonly now?: Date;
}): Promise<PrunedPartial[]> {
  const backupRoot = resolve(options.backupRoot);
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_PARTIAL_MS;
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new RecoveryError("ARGUMENT_INVALID", "Stale-partial age must be a non-negative number of milliseconds");
  }
  if (!existsSync(backupRoot)) return [];

  const nowMs = (options.now ?? new Date()).getTime();
  const pruned: PrunedPartial[] = [];

  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    if (!PARTIAL_DIRECTORY_PATTERN.test(entry.name)) continue;

    const candidate = join(backupRoot, entry.name);
    // `lstat`, not `stat`: a symlink named like a partial must never be followed.
    const info = await lstat(candidate);
    if (!info.isDirectory()) continue;
    if (dirname(candidate) !== backupRoot) continue;

    const ageMs = nowMs - info.mtimeMs;
    if (ageMs < olderThanMs) continue;

    await rm(candidate, { recursive: true, force: true });
    pruned.push({ name: entry.name, ageMs });
  }

  return pruned.sort((a, b) => a.name.localeCompare(b.name));
}

function bundleIdFor(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
  const suffix = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
  return `${stamp}-${suffix}`;
}

function openSourceForBackup(path: string, busyTimeoutMs: number): SqliteDatabase {
  if (!existsSync(path)) {
    throw new RecoveryError("SOURCE_NOT_FOUND", `Database not found at ${path}`);
  }
  let database: SqliteDatabase;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  } catch (cause) {
    throw new RecoveryError("SOURCE_NOT_READABLE", `Cannot open ${path} read-only`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("query_only = 1");
  return database;
}

/**
 * Produces a consistent snapshot with the SQLite online backup API and writes a
 * verified bundle. The live database is never byte-copied.
 */
/**
 * Test seam for fault injection. Each hook runs at the named stage; throwing from
 * one proves the partial working directory is still cleaned up.
 */
export interface BackupFaultHooks {
  readonly afterSnapshotWritten?: () => void;
  readonly afterSnapshotOpened?: () => void;
  readonly afterJournalAssertion?: () => void;
  readonly afterChecks?: () => void;
  readonly afterCollection?: () => void;
  readonly afterHash?: () => void;
  readonly beforeManifestWrite?: () => void;
  readonly beforeRename?: () => void;
}

export async function createBackup(
  options: CreateBackupOptions & { readonly faults?: BackupFaultHooks }
): Promise<CreateBackupResult> {
  const startedAt = process.hrtime.bigint();
  const now = options.now ?? new Date();
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const sourcePath = resolve(options.sourcePath);
  const backupRoot = resolve(options.backupRoot);
  const faults = options.faults ?? {};

  await mkdir(backupRoot, { recursive: true, mode: 0o750 });

  const bundleId = bundleIdFor(now);
  const bundleDir = assertSafeDestination({
    destination: join(backupRoot, bundleId),
    allowedRoot: backupRoot,
    protectedPaths: [sourcePath],
    allowInsideGitWorktree: options.allowInsideGitWorktree
  });

  const workingDir = `${bundleDir}${PARTIAL_SUFFIX}`;
  await rm(workingDir, { recursive: true, force: true });
  await mkdir(workingDir, { recursive: true, mode: 0o750 });

  // Everything from here on is inside one lifecycle: any failure closes open
  // handles and removes the partial working directory before rethrowing. The
  // catch is not a silencer \u2014 it re-throws every error unchanged apart from
  // wrapping the raw better-sqlite3 backup failure in a typed code.
  let promoted = false;
  let sourceHandle: SqliteDatabase | null = null;
  let snapshotHandle: SqliteDatabase | null = null;

  try {
    const snapshotPath = join(workingDir, BACKUP_SNAPSHOT_FILE);
    sourceHandle = openSourceForBackup(sourcePath, busyTimeoutMs);

    try {
      await sourceHandle.backup(snapshotPath);
    } catch (cause) {
      throw new RecoveryError("BACKUP_FAILED", `SQLite online backup failed for ${sourcePath}`, {
        cause: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      sourceHandle.close();
      sourceHandle = null;
    }
    faults.afterSnapshotWritten?.();

    snapshotHandle = new Database(snapshotPath, { fileMustExist: true, timeout: busyTimeoutMs });
    faults.afterSnapshotOpened?.();

    let identity: SchemaVersionIdentity;
    let tables: TableSnapshot[];
    let checks: SnapshotChecks;
    try {
      snapshotHandle.pragma(`busy_timeout = ${busyTimeoutMs}`);
      const journalMode = String(snapshotHandle.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
      if (journalMode !== "delete") {
        throw new RecoveryError("BACKUP_FAILED", `Snapshot journal mode must be DELETE, received ${journalMode}`);
      }
      faults.afterJournalAssertion?.();

      snapshotHandle.pragma("foreign_keys = ON");
      checks = runSnapshotChecks(snapshotHandle);
      faults.afterChecks?.();

      identity = readSchemaVersionIdentity(snapshotHandle);
      tables = readTableSnapshots(snapshotHandle);
      faults.afterCollection?.();
    } finally {
      snapshotHandle.close();
      snapshotHandle = null;
    }

    const bytes = (await stat(snapshotPath)).size;
    const sha256 = await sha256File(snapshotPath);
    faults.afterHash?.();

    const manifest: BackupManifest = {
      contract: BACKUP_CONTRACT,
      contractVersion: BACKUP_CONTRACT_VERSION,
      app: "watchtower",
      bundleId,
      createdUtc: now.toISOString(),
      appVersion: options.appVersion ?? null,
      buildId: options.buildId ?? null,
      sourceCommit: options.sourceCommit ?? null,
      database: {
        file: BACKUP_SNAPSHOT_FILE,
        sourcePath,
        bytes,
        sha256,
        identity,
        tables,
        checks
      }
    };

    faults.beforeManifestWrite?.();
    const manifestPath = join(workingDir, BACKUP_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });

    faults.beforeRename?.();
    await rename(workingDir, bundleDir);
    promoted = true;

    return {
      bundleDir,
      snapshotPath: join(bundleDir, BACKUP_SNAPSHOT_FILE),
      manifestPath: join(bundleDir, BACKUP_MANIFEST_FILE),
      manifest,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
    };
  } finally {
    sourceHandle?.close();
    snapshotHandle?.close();
    if (!promoted) {
      // Best effort by necessity: the original failure must win, so a cleanup
      // problem is reported on stderr rather than replacing it.
      await rm(workingDir, { recursive: true, force: true }).catch((cause: unknown) => {
        process.stderr.write(
          `warning: could not remove partial backup ${workingDir}: ${
            cause instanceof Error ? cause.message : String(cause)
          }\n`
        );
      });
    }
  }
}


export interface VerifyBackupResult {
  readonly bundleDir: string;
  readonly manifest: BackupManifest;
  readonly bytes: number;
  readonly sha256: string;
  readonly checks: SnapshotChecks;
  readonly identityMatches: boolean;
  readonly tableCountsMatch: boolean;
  readonly tableCountDifferences: readonly { table: string; manifest: number | null; actual: number | null }[];
}

export async function readBackupManifest(bundleDir: string): Promise<BackupManifest> {
  const manifestPath = join(resolve(bundleDir), BACKUP_MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new RecoveryError("BACKUP_MANIFEST_INVALID", `Cannot read backup manifest at ${manifestPath}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  const manifest = parsed as BackupManifest;
  if (
    manifest?.contract !== BACKUP_CONTRACT ||
    manifest.contractVersion !== BACKUP_CONTRACT_VERSION ||
    typeof manifest.database?.sha256 !== "string" ||
    typeof manifest.database?.bytes !== "number" ||
    typeof manifest.database?.file !== "string"
  ) {
    throw new RecoveryError("BACKUP_MANIFEST_INVALID", `Backup manifest at ${manifestPath} is not a supported contract`);
  }
  assertLowerHex(manifest.database.sha256, "manifest.database.sha256");
  if (basename(manifest.database.file) !== manifest.database.file) {
    throw new RecoveryError("BACKUP_MANIFEST_INVALID", "manifest.database.file must be a bare file name");
  }
  return manifest;
}

/**
 * Verifies a local bundle: bytes, SHA-256, schema identity, per-table counts and
 * all three integrity checks.
 */
export async function verifyBackup(options: {
  readonly bundleDir: string;
  readonly busyTimeoutMs?: number;
}): Promise<VerifyBackupResult> {
  const bundleDir = resolve(options.bundleDir);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const manifest = await readBackupManifest(bundleDir);
  const snapshotPath = join(bundleDir, manifest.database.file);

  if (!existsSync(snapshotPath)) {
    throw new RecoveryError("BACKUP_MANIFEST_MISMATCH", `Backup snapshot missing at ${snapshotPath}`);
  }

  const bytes = (await stat(snapshotPath)).size;
  if (bytes !== manifest.database.bytes) {
    throw new RecoveryError("BACKUP_BYTES_MISMATCH", "Backup snapshot byte length does not match the manifest", {
      expected: manifest.database.bytes,
      actual: bytes
    });
  }

  const sha256 = await sha256File(snapshotPath);
  if (sha256 !== manifest.database.sha256) {
    throw new RecoveryError("BACKUP_SHA_MISMATCH", "Backup snapshot SHA-256 does not match the manifest", {
      expected: manifest.database.sha256,
      actual: sha256
    });
  }

  const database = new Database(snapshotPath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  let checks: SnapshotChecks;
  let identity: SchemaVersionIdentity;
  let tables: TableSnapshot[];
  try {
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    database.pragma("foreign_keys = ON");
    checks = runSnapshotChecks(database);
    identity = readSchemaVersionIdentity(database);
    tables = readTableSnapshots(database);
  } finally {
    database.close();
  }

  const manifestCounts = new Map(manifest.database.tables.map((table) => [table.name, table.rowCount]));
  const actualCounts = new Map(tables.map((table) => [table.name, table.rowCount]));
  const differences: { table: string; manifest: number | null; actual: number | null }[] = [];
  for (const name of new Set([...manifestCounts.keys(), ...actualCounts.keys()])) {
    const expected = manifestCounts.get(name) ?? null;
    const actual = actualCounts.get(name) ?? null;
    if (expected !== actual) differences.push({ table: name, manifest: expected, actual });
  }
  differences.sort((a, b) => a.table.localeCompare(b.table));

  const identityMatches = identity.schemaSha256 === manifest.database.identity.schemaSha256;
  if (!identityMatches || differences.length > 0) {
    throw new RecoveryError("BACKUP_MANIFEST_MISMATCH", "Backup content does not match its manifest", {
      identityMatches,
      tableCountDifferences: differences.slice(0, 20)
    });
  }

  return {
    bundleDir,
    manifest,
    bytes,
    sha256,
    checks,
    identityMatches,
    tableCountsMatch: differences.length === 0,
    tableCountDifferences: Object.freeze(differences)
  };
}
