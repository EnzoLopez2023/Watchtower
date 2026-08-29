/**
 * Snapshot evidence: schema/version identity, all-table counts and recency,
 * `quick_check`, `integrity_check` and `foreign_key_check`.
 *
 * These run explicitly, on demand, against a snapshot file. They are never
 * wired into startup or request paths.
 */

import { createHash } from "node:crypto";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { RecoveryError } from "./errors.js";

/**
 * Candidate "most recent activity" columns, in priority order. The first column
 * that exists on a table is used to report recency.
 */
export const RECENCY_COLUMNS: readonly string[] = Object.freeze([
  "updated_at",
  "last_updated_at",
  "received_at",
  "sampled_at",
  "checked_at",
  "completed_at",
  "created_at",
  "timestamp",
  "event_ts",
  "flow_ts",
  "start_ms",
  "detected_at",
  "archived_at",
  "last_seen_at",
  "last_seen",
  "ts",
  "occurred_at",
  "granted_at",
  "applied_at"
]);

export interface TableSnapshot {
  readonly name: string;
  readonly rowCount: number;
  readonly recency: { readonly column: string; readonly raw: string | number | null } | null;
}

export interface SnapshotChecks {
  readonly quickCheck: { readonly ok: boolean; readonly messages: readonly string[] };
  readonly integrityCheck: { readonly ok: boolean; readonly messages: readonly string[] };
  readonly foreignKeyCheck: {
    readonly ok: boolean;
    readonly violations: readonly { table: string; rowid: number | null; parent: string; foreignKeyIndex: number }[];
  };
}

export interface SchemaVersionIdentity {
  readonly userVersion: number;
  readonly applicationId: number;
  readonly schemaObjectCounts: { readonly tables: number; readonly indexes: number; readonly triggers: number; readonly views: number };
  readonly schemaSha256: string;
  readonly migrations: readonly { readonly version: number; readonly name: string; readonly checksum: string }[] | null;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Pragma results are scalars; anything else degrades to "" rather than "[object Object]". */
function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function pragmaMessages(database: SqliteDatabase, pragma: string): string[] {
  const rows = database.pragma(pragma) as Record<string, unknown>[];
  return rows.map((row) => scalarText(Object.values(row)[0])).filter((message) => message !== "");
}

/** Runs quick_check, integrity_check and foreign_key_check; throws on failure. */
export function runSnapshotChecks(database: SqliteDatabase): SnapshotChecks {
  const quickMessages = pragmaMessages(database, "quick_check");
  const integrityMessages = pragmaMessages(database, "integrity_check");
  const violations = (database.pragma("foreign_key_check") as Record<string, unknown>[])
    .map((row) => ({
      table: String(row.table),
      rowid: row.rowid === null || row.rowid === undefined ? null : Number(row.rowid),
      parent: String(row.parent),
      foreignKeyIndex: Number(row.fkid)
    }))
    .sort(
      (a, b) =>
        a.table.localeCompare(b.table) ||
        (a.rowid ?? -1) - (b.rowid ?? -1) ||
        a.parent.localeCompare(b.parent) ||
        a.foreignKeyIndex - b.foreignKeyIndex
    );

  const checks: SnapshotChecks = {
    quickCheck: { ok: quickMessages.length === 1 && quickMessages[0] === "ok", messages: quickMessages },
    integrityCheck: {
      ok: integrityMessages.length === 1 && integrityMessages[0] === "ok",
      messages: integrityMessages
    },
    foreignKeyCheck: { ok: violations.length === 0, violations }
  };

  if (!checks.quickCheck.ok) {
    throw new RecoveryError("BACKUP_QUICK_CHECK_FAILED", "Snapshot quick_check did not return ok", {
      messages: quickMessages
    });
  }
  if (!checks.integrityCheck.ok) {
    throw new RecoveryError("BACKUP_INTEGRITY_CHECK_FAILED", "Snapshot integrity_check did not return ok", {
      messages: integrityMessages
    });
  }
  if (!checks.foreignKeyCheck.ok) {
    throw new RecoveryError(
      "BACKUP_FOREIGN_KEY_CHECK_FAILED",
      `Snapshot foreign_key_check returned ${violations.length} violation(s)`,
      { violations: violations.slice(0, 20) }
    );
  }

  return checks;
}

/** Row counts and most-recent-activity value for every user table. */
export function readTableSnapshots(database: SqliteDatabase): TableSnapshot[] {
  const tables = (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);

  const snapshots: TableSnapshot[] = [];
  for (const name of tables) {
    const countRow = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(name)}`).get() as {
      c: bigint | number;
    };
    const rowCount = typeof countRow.c === "bigint" ? Number(countRow.c) : countRow.c;

    const columns = new Set(
      (database.pragma(`table_info(${quoteIdentifier(name)})`) as { name: unknown }[]).map((row) => String(row.name))
    );
    const recencyColumn = RECENCY_COLUMNS.find((column) => columns.has(column)) ?? null;

    let recency: TableSnapshot["recency"] = null;
    if (recencyColumn !== null && rowCount > 0) {
      const row = database
        .prepare(`SELECT MAX(${quoteIdentifier(recencyColumn)}) AS m FROM ${quoteIdentifier(name)}`)
        .get() as { m: unknown };
      const raw =
        row.m === null || row.m === undefined
          ? null
          : typeof row.m === "bigint"
            ? Number(row.m)
            : typeof row.m === "number" || typeof row.m === "string"
              ? row.m
              : scalarText(row.m);
      recency = { column: recencyColumn, raw };
    }

    snapshots.push({ name, rowCount, recency });
  }
  return snapshots;
}

/** Schema and version identity of a snapshot. */
export function readSchemaVersionIdentity(database: SqliteDatabase): SchemaVersionIdentity {
  const objects = database
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; sql: string | null }[];

  const counts = { tables: 0, indexes: 0, triggers: 0, views: 0 };
  const hash = createHash("sha256");
  for (const object of objects) {
    if (object.type === "table") counts.tables += 1;
    else if (object.type === "index") counts.indexes += 1;
    else if (object.type === "trigger") counts.triggers += 1;
    else if (object.type === "view") counts.views += 1;
    hash.update(`${object.type}\u0000${object.name}\u0000${object.sql ?? ""}\u0001`);
  }

  let migrations: SchemaVersionIdentity["migrations"] = null;
  const hasMigrations = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (hasMigrations !== undefined) {
    migrations = (
      database
        .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
        .all() as { version: bigint | number; name: string; checksum: string }[]
    ).map((row) => ({
      version: typeof row.version === "bigint" ? Number(row.version) : row.version,
      name: row.name,
      checksum: row.checksum
    }));
  }

  return {
    userVersion: Number(database.pragma("user_version", { simple: true })),
    applicationId: Number(database.pragma("application_id", { simple: true })),
    schemaObjectCounts: counts,
    schemaSha256: hash.digest("hex"),
    migrations
  };
}
