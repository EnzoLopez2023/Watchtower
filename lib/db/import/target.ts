/**
 * Target database safety and preparation.
 *
 * The importer refuses to write to anything that is not a fresh, empty,
 * non-aliasing database outside any Git working tree.
 */

import { existsSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { quoteIdentifier } from "./schema.js";

export type LoadSynchronous = "off" | "normal" | "full";

export interface TargetOptions {
  readonly targetPath: string;
  readonly sourceRealPath: string;
  readonly busyTimeoutMs: number;
  readonly loadSynchronous: LoadSynchronous;
  readonly ownedTables: readonly string[];
  /** Escape hatch for tests that legitimately run inside a repository sandbox. */
  readonly allowInsideGitWorktree?: boolean;
}

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

/**
 * Tables that may legitimately hold rows in an "empty" target. `schema_migrations`
 * is migration bookkeeping written by the app's own `migrateDatabase`, so a target
 * that has been migrated but holds no product data is still empty for import
 * purposes.
 */
const BOOKKEEPING_TABLES: ReadonlySet<string> = new Set(["schema_migrations"]);

/** Walks upward looking for a `.git` directory or file. */
export function findGitWorktreeRoot(startPath: string): string | null {
  let current = resolve(startPath);
  const root = parse(current).root;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Rejects unsafe target paths before any file is created.
 *
 * Refuses: aliasing the source (same path, symlink or inode), existing SQLite
 * sidecar files, missing parent directories, and any path inside a Git working
 * tree (a target database must never be committable).
 */
export function assertTargetPathSafe(options: {
  readonly targetPath: string;
  readonly sourceRealPath: string;
  readonly allowInsideGitWorktree?: boolean;
}): string {
  const targetPath = resolve(options.targetPath);
  const parent = dirname(targetPath);

  if (!existsSync(parent)) {
    throw new ImportError("TARGET_PATH_UNSAFE", `Target parent directory does not exist: ${parent}`);
  }
  if (!statSync(parent).isDirectory()) {
    throw new ImportError("TARGET_PATH_UNSAFE", `Target parent is not a directory: ${parent}`);
  }

  const sourceReal = resolve(options.sourceRealPath);
  if (targetPath === sourceReal) {
    throw new ImportError("TARGET_ALIASES_SOURCE", "Target path is the source database");
  }

  const parentReal = realpathSync(parent);
  const resolvedTarget = join(parentReal, targetPath.slice(parent.length + 1));
  if (resolvedTarget === sourceReal) {
    throw new ImportError("TARGET_ALIASES_SOURCE", "Target path resolves to the source database");
  }

  if (existsSync(targetPath)) {
    const targetStats = statSync(targetPath);
    if (!targetStats.isFile()) {
      throw new ImportError("TARGET_PATH_UNSAFE", `Target exists and is not a regular file: ${targetPath}`);
    }
    const sourceStats = statSync(sourceReal);
    if (targetStats.ino === sourceStats.ino && targetStats.dev === sourceStats.dev) {
      throw new ImportError("TARGET_ALIASES_SOURCE", "Target is a hard link to the source database");
    }
  }

  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(`${targetPath}${suffix}`)) {
      throw new ImportError("TARGET_SIDECAR_PRESENT", `Stale SQLite sidecar present: ${targetPath}${suffix}`);
    }
  }

  if (options.allowInsideGitWorktree !== true) {
    const gitRoot = findGitWorktreeRoot(parent);
    if (gitRoot !== null) {
      throw new ImportError(
        "TARGET_IN_GIT_WORKTREE",
        `Refusing to create a target database inside the Git working tree at ${gitRoot}`,
        { targetPath, gitRoot }
      );
    }
  }

  return targetPath;
}

export interface OpenTargetResult {
  readonly database: SqliteDatabase;
  readonly targetPath: string;
  readonly createdFile: boolean;
  readonly preexistingTables: readonly string[];
}

/**
 * Opens (creating if needed) an empty target database configured for import.
 *
 * "Empty" means: none of the owned tables already exist, and every user table
 * that does exist holds zero rows. That admits a target where the app's own
 * migrations have already run, and refuses any target that holds data.
 */
export function openEmptyTarget(options: TargetOptions): OpenTargetResult {
  const targetPath = assertTargetPathSafe({
    targetPath: options.targetPath,
    sourceRealPath: options.sourceRealPath,
    allowInsideGitWorktree: options.allowInsideGitWorktree
  });

  const createdFile = !existsSync(targetPath);

  const database = new Database(targetPath, { timeout: options.busyTimeoutMs });
  try {
    database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    database.pragma("foreign_keys = OFF");

    const journalMode = String(database.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
    if (journalMode !== "delete") {
      throw new ImportError("TARGET_PRAGMA_REJECTED", `Target journal mode must be DELETE, received ${journalMode}`);
    }
    database.pragma(`synchronous = ${options.loadSynchronous.toUpperCase()}`);
    database.defaultSafeIntegers(true);

    const tables = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    const collisions = tables.filter((table) => options.ownedTables.includes(table));
    if (collisions.length > 0) {
      throw new ImportError("TARGET_NOT_EMPTY", "Target already contains owned Watchtower tables", {
        targetPath,
        tables: collisions
      });
    }

    const nonEmpty: { table: string; rows: number }[] = [];
    for (const table of tables) {
      if (BOOKKEEPING_TABLES.has(table)) continue;
      const row = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get() as {
        c: bigint | number;
      };
      const count = typeof row.c === "bigint" ? Number(row.c) : row.c;
      if (count > 0) nonEmpty.push({ table, rows: count });
    }
    if (nonEmpty.length > 0) {
      throw new ImportError("TARGET_NOT_EMPTY", "Target database already contains rows", {
        targetPath,
        tables: nonEmpty
      });
    }

    return { database, targetPath, createdFile, preexistingTables: Object.freeze(tables) };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Applies the post-load runtime contract: foreign keys ON, journal DELETE,
 * durable synchronous setting, bounded busy timeout.
 */
export function finalizeTarget(database: SqliteDatabase, busyTimeoutMs: number): void {
  database.pragma("foreign_keys = ON");
  const foreignKeys = Number(database.pragma("foreign_keys", { simple: true }));
  if (foreignKeys !== 1) {
    throw new ImportError("TARGET_PRAGMA_REJECTED", "Target refused foreign_keys = ON");
  }

  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode !== "delete") {
    throw new ImportError("TARGET_PRAGMA_REJECTED", `Target journal mode must remain DELETE, found ${journalMode}`);
  }

  database.pragma("synchronous = FULL");
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
}

/** Opens an existing target read-only for reconciliation. */
export function openTargetReadonly(targetPath: string, busyTimeoutMs: number): SqliteDatabase {
  const database = new Database(resolve(targetPath), {
    readonly: true,
    fileMustExist: true,
    timeout: busyTimeoutMs
  });
  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("query_only = 1");
  database.defaultSafeIntegers(true);
  return database;
}
