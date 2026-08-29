/**
 * Source database identity verification.
 *
 * The importer only ever reads a supplied immutable backup file. Before any read
 * it verifies the file size and SHA-256 against the reviewed baseline, and after
 * the import it re-verifies that the file was not mutated.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";

export interface SourceFileIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly inode: number;
  readonly device: number;
}

const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Verifies the immutable source file matches the reviewed bytes/hash.
 * Fails closed: an unreadable file, wrong size or wrong digest aborts.
 */
export async function verifySourceFile(options: {
  readonly path: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}): Promise<SourceFileIdentity> {
  const path = resolve(options.path);

  let stats;
  try {
    stats = await stat(path);
  } catch (cause) {
    throw new ImportError("SOURCE_MISSING", `Source database is not readable at ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  if (!stats.isFile()) {
    throw new ImportError("SOURCE_MISSING", `Source database at ${path} is not a regular file`);
  }

  if (stats.size !== options.expectedBytes) {
    throw new ImportError("SOURCE_IDENTITY_MISMATCH", "Source database byte length does not match the baseline", {
      path,
      expectedBytes: options.expectedBytes,
      actualBytes: stats.size
    });
  }

  const sha256 = await hashFile(path);
  const expected = options.expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new ImportError("ARGUMENT_INVALID", "Expected source SHA-256 must be 64 lowercase hex characters");
  }
  if (sha256 !== expected) {
    throw new ImportError("SOURCE_IDENTITY_MISMATCH", "Source database SHA-256 does not match the baseline", {
      path,
      expectedSha256: expected,
      actualSha256: sha256
    });
  }

  return Object.freeze({
    path,
    realPath: await realpath(path),
    bytes: stats.size,
    sha256,
    mtimeMs: stats.mtimeMs,
    inode: Number(stats.ino),
    device: Number(stats.dev)
  });
}

/** Confirms the source file is byte-identical to the pre-import identity. */
export async function assertSourceUnchanged(
  identity: SourceFileIdentity,
  options: { readonly rehash: boolean }
): Promise<{ bytes: number; mtimeMs: number; sha256: string | null }> {
  const stats = await stat(identity.path);
  if (stats.size !== identity.bytes) {
    throw new ImportError("SOURCE_MUTATED", "Source database size changed during the import", {
      path: identity.path,
      before: identity.bytes,
      after: stats.size
    });
  }

  let sha256: string | null = null;
  if (options.rehash) {
    sha256 = await hashFile(identity.path);
    if (sha256 !== identity.sha256) {
      throw new ImportError("SOURCE_MUTATED", "Source database SHA-256 changed during the import", {
        path: identity.path,
        before: identity.sha256,
        after: sha256
      });
    }
  }

  return { bytes: stats.size, mtimeMs: stats.mtimeMs, sha256 };
}

/**
 * Opens the immutable source strictly read-only.
 *
 * `query_only` is set as belt-and-braces on top of the read-only handle, and
 * `defaultSafeIntegers` guarantees SQLite INTEGER values arrive as `bigint` so
 * INTEGER and REAL remain distinguishable.
 */
export function openSourceReadonly(path: string, busyTimeoutMs: number): SqliteDatabase {
  let database: SqliteDatabase;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  } catch (cause) {
    throw new ImportError("SOURCE_NOT_READABLE", `Cannot open source database at ${path} read-only`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  database.pragma(`busy_timeout = ${busyTimeoutMs}`);
  database.pragma("query_only = 1");
  database.defaultSafeIntegers(true);

  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode === "wal") {
    database.close();
    throw new ImportError("SOURCE_NOT_READABLE", "Source database is in WAL mode; supply a quiesced DELETE-mode backup");
  }

  return database;
}

/** Asserts every owned table exists in the source before any copying starts. */
export function assertOwnedTablesPresent(database: SqliteDatabase, tables: readonly string[]): void {
  const present = new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name
    )
  );
  const missing = tables.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new ImportError("SOURCE_SCHEMA_INCOMPLETE", "Source database is missing owned tables", {
      missing: missing.sort()
    });
  }
}
