/**
 * Deterministic schema recreation and streaming row copy.
 *
 * Rows are read from a read-only source handle with `defaultSafeIntegers(true)`
 * and bound straight back into the target, so storage classes (NULL / INTEGER /
 * REAL / TEXT / BLOB) and exact BLOB bytes are preserved. Nothing is buffered
 * beyond one batch.
 */

import type { Database as SqliteDatabase, Statement } from "better-sqlite3";
import { ImportError } from "./errors.js";
import {
  orderByClause,
  quoteIdentifier,
  readOwnedSchemaObjects,
  readTableSchema,
  tableExists,
  type SchemaObject,
  type TableSchema
} from "./schema.js";
import type { SqliteValue } from "./canonical.js";

/** SQLite's default SQLITE_MAX_VARIABLE_NUMBER since 3.32 is 32766. */
const MAX_BOUND_PARAMETERS = 30_000;
const DEFAULT_MAX_BATCH_ROWS = 1_000;

export interface CopyTableResult {
  readonly table: string;
  readonly rows: number;
  readonly batches: number;
  readonly durationMs: number;
  readonly copiedRowid: boolean;
}

export interface SchemaCopyResult {
  readonly tables: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
}

/**
 * Recreates the exact `CREATE TABLE` statements for the owned tables.
 * Indexes and triggers are created after the rows are loaded.
 */
export function createOwnedTables(
  source: SqliteDatabase,
  target: SqliteDatabase,
  tables: readonly string[]
): Map<string, TableSchema> {
  const schemas = new Map<string, TableSchema>();
  for (const table of [...tables].sort()) {
    const schema = readTableSchema(source, table);
    target.exec(schema.sql);
    schemas.set(table, schema);
  }
  return schemas;
}

/** Creates every explicit index and trigger attached to the owned tables. */
export function createOwnedIndexesAndTriggers(
  source: SqliteDatabase,
  target: SqliteDatabase,
  tables: readonly string[]
): SchemaCopyResult {
  const { indexes, triggers } = readOwnedSchemaObjects(source, tables);
  const applied = (objects: readonly SchemaObject[]): string[] => {
    const names: string[] = [];
    for (const object of objects) {
      if (object.sql === null) continue;
      target.exec(object.sql);
      names.push(object.name);
    }
    return names;
  };

  return {
    tables: Object.freeze([...tables].sort()),
    indexes: Object.freeze(applied(indexes)),
    triggers: Object.freeze(applied(triggers))
  };
}

function batchRowsFor(columnCount: number, requested: number | null): number {
  const ceiling = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / Math.max(1, columnCount)));
  const desired = requested ?? DEFAULT_MAX_BATCH_ROWS;
  return Math.max(1, Math.min(ceiling, desired));
}

function insertStatement(
  target: SqliteDatabase,
  table: string,
  columns: readonly string[],
  rowsPerBatch: number
): Statement {
  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ");
  const placeholderRow = `(${columns.map(() => "?").join(", ")})`;
  const values = Array.from({ length: rowsPerBatch }, () => placeholderRow).join(", ");
  return target.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES ${values}`);
}

/**
 * Streams every row of one table from source to target in bounded batches.
 *
 * For rowid tables whose primary key is not an INTEGER PRIMARY KEY alias the
 * implicit `rowid` is copied explicitly so row identity is byte-for-byte equal.
 */
export function copyTableRows(options: {
  readonly source: SqliteDatabase;
  readonly target: SqliteDatabase;
  readonly schema: TableSchema;
  readonly batchRows?: number | null;
  readonly onProgress?: (table: string, rowsCopied: number) => void;
}): CopyTableResult {
  const { source, target, schema } = options;
  const startedAt = process.hrtime.bigint();

  const copiedRowid = schema.hasRowid && schema.rowidAlias === null;
  const selectColumns = (copiedRowid ? ["rowid", ...schema.columnNames] : [...schema.columnNames])
    .map((column) => (column === "rowid" ? "rowid" : quoteIdentifier(column)))
    .join(", ");
  const insertColumns = copiedRowid ? ["rowid", ...schema.columnNames] : [...schema.columnNames];

  const rowsPerBatch = batchRowsFor(insertColumns.length, options.batchRows ?? null);
  const batchInsert = insertStatement(target, schema.name, insertColumns, rowsPerBatch);
  const singleInsert = insertStatement(target, schema.name, insertColumns, 1);

  const select = source
    .prepare(`SELECT ${selectColumns} FROM ${quoteIdentifier(schema.name)} ORDER BY ${orderByClause(schema)}`)
    .raw(true);

  let rows = 0;
  let batches = 0;

  const runBatch = target.transaction((flat: SqliteValue[], count: number) => {
    if (count === rowsPerBatch) {
      batchInsert.run(flat);
      return;
    }
    for (let offset = 0; offset < flat.length; offset += insertColumns.length) {
      singleInsert.run(flat.slice(offset, offset + insertColumns.length));
    }
  });

  let buffer: SqliteValue[] = [];
  let buffered = 0;

  for (const row of select.iterate() as IterableIterator<SqliteValue[]>) {
    for (const value of row) buffer.push(value);
    buffered += 1;
    if (buffered === rowsPerBatch) {
      runBatch(buffer, buffered);
      rows += buffered;
      batches += 1;
      buffer = [];
      buffered = 0;
      options.onProgress?.(schema.name, rows);
    }
  }

  if (buffered > 0) {
    runBatch(buffer, buffered);
    rows += buffered;
    batches += 1;
    options.onProgress?.(schema.name, rows);
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { table: schema.name, rows, batches, durationMs, copiedRowid };
}

/**
 * Copies `sqlite_sequence` values for owned AUTOINCREMENT tables.
 *
 * SQLite creates `sqlite_sequence` rows implicitly while inserting, but the
 * implicit value only reaches the largest inserted rowid. The source value can
 * be higher (rows deleted after the peak), so it is written explicitly.
 */
export function copySequences(
  source: SqliteDatabase,
  target: SqliteDatabase,
  tables: readonly string[]
): Record<string, string> {
  if (!tableExists(source, "sqlite_sequence")) return {};

  const owned = new Set(tables);
  const rows = (
    source.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() as {
      name: string;
      seq: bigint | number;
    }[]
  ).filter((row) => owned.has(row.name));

  if (rows.length === 0) return {};

  if (!tableExists(target, "sqlite_sequence")) {
    throw new ImportError(
      "SEQUENCE_MISMATCH",
      "Target has no sqlite_sequence table; no AUTOINCREMENT table was created"
    );
  }

  const upsert = target.transaction((entries: { name: string; seq: bigint | number }[]) => {
    const remove = target.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
    const insert = target.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
    for (const entry of entries) {
      remove.run(entry.name);
      insert.run(entry.name, entry.seq);
    }
  });
  upsert(rows);

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.name] = typeof row.seq === "bigint" ? row.seq.toString(10) : String(row.seq);
  }
  return result;
}

/** Counts rows in a table using the target/source handle. */
export function countRows(database: SqliteDatabase, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get() as {
    c: bigint | number;
  };
  return typeof row.c === "bigint" ? Number(row.c) : row.c;
}
