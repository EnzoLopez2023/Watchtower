/**
 * SQLite schema introspection shared by the importer and the reconciler.
 *
 * Everything here is derived from the database itself (never hard-coded DDL) so
 * the import recreates the exact source table SQL, indexes and triggers.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { stableJsonDigest } from "./canonical.js";

export interface ColumnInfo {
  readonly cid: number;
  readonly name: string;
  readonly declaredType: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly pkPosition: number;
}

/** `PRAGMA index_list` origin: constraint, unique index, or primary key. */
export type IndexOrigin = "c" | "u" | "pk";

export interface IndexInfo {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: IndexOrigin;
  readonly partial: boolean;
  readonly columns: readonly (string | null)[];
  readonly sql: string | null;
}

export interface ForeignKeyInfo {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface TableSchema {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly ColumnInfo[];
  readonly columnNames: readonly string[];
  readonly primaryKeyColumns: readonly string[];
  readonly rowidAlias: string | null;
  readonly hasRowid: boolean;
  readonly uniqueKeys: readonly (readonly string[])[];
  readonly businessKey: readonly string[] | null;
  readonly orderingColumns: readonly string[];
  readonly orderingSource: "integer-primary-key" | "primary-key" | "unique-index" | "all-columns";
  readonly blobColumns: readonly string[];
  readonly indexes: readonly IndexInfo[];
  readonly foreignKeys: readonly ForeignKeyInfo[];
  readonly hasAutoincrement: boolean;
}

export interface SchemaObject {
  readonly type: "table" | "index" | "trigger" | "view";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Pragma columns are scalars; anything else degrades to "" rather than "[object Object]". */
function normalizeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toIndexOrigin(value: string): IndexOrigin {
  return value === "u" || value === "pk" ? value : "c";
}

function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function pragmaRows(database: SqliteDatabase, pragma: string): Record<string, unknown>[] {
  const result = database.pragma(pragma);
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

export function tableExists(database: SqliteDatabase, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function detectRowid(database: SqliteDatabase, name: string): boolean {
  try {
    database.prepare(`SELECT rowid FROM ${quoteIdentifier(name)} LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the full schema of one table, including the deterministic ordering key
 * used by reconciliation.
 */
export function readTableSchema(database: SqliteDatabase, name: string): TableSchema {
  const master = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string | null } | undefined;
  if (!master || typeof master.sql !== "string") {
    throw new ImportError("SOURCE_SCHEMA_INCOMPLETE", `Table ${name} does not exist or has no CREATE statement`, {
      table: name
    });
  }

  const columns: ColumnInfo[] = pragmaRows(database, `table_info(${quoteIdentifier(name)})`).map((row) => ({
    cid: toNumber(row.cid),
    name: normalizeText(row.name),
    declaredType: normalizeText(row.type),
    notNull: toNumber(row.notnull) !== 0,
    defaultValue: row.dflt_value === null || row.dflt_value === undefined ? null : normalizeText(row.dflt_value),
    pkPosition: toNumber(row.pk)
  }));

  if (columns.length === 0) {
    throw new ImportError("SOURCE_SCHEMA_INCOMPLETE", `Table ${name} reports no columns`, { table: name });
  }

  const primaryKeyColumns = columns
    .filter((column) => column.pkPosition > 0)
    .sort((a, b) => a.pkPosition - b.pkPosition)
    .map((column) => column.name);

  const hasRowid = detectRowid(database, name);
  const singlePrimaryKey = primaryKeyColumns.length === 1 ? primaryKeyColumns[0] : undefined;
  const singlePrimaryKeyType = columns.find((column) => column.name === singlePrimaryKey)?.declaredType ?? "";
  const rowidAlias =
    hasRowid && singlePrimaryKey !== undefined && /^integer$/i.test(singlePrimaryKeyType.trim())
      ? singlePrimaryKey
      : null;

  const indexes: IndexInfo[] = pragmaRows(database, `index_list(${quoteIdentifier(name)})`)
    .map((row) => {
      const indexName = normalizeText(row.name);
      const indexColumns = pragmaRows(database, `index_info(${quoteIdentifier(indexName)})`)
        .sort((a, b) => toNumber(a.seqno) - toNumber(b.seqno))
        .map((info) => (info.name === null || info.name === undefined ? null : normalizeText(info.name)));
      const sqlRow = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(indexName) as { sql: string | null } | undefined;
      return {
        name: indexName,
        unique: toNumber(row.unique) !== 0,
        origin: toIndexOrigin(normalizeText(row.origin)),
        partial: toNumber(row.partial) !== 0,
        columns: indexColumns,
        sql: sqlRow?.sql ?? null
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const uniqueKeys = indexes
    .filter((index) => index.unique && !index.partial && index.columns.every((column) => column !== null))
    .map((index) => index.columns as readonly string[]);

  const foreignKeys: ForeignKeyInfo[] = pragmaRows(database, `foreign_key_list(${quoteIdentifier(name)})`)
    .map((row) => ({
      id: toNumber(row.id),
      seq: toNumber(row.seq),
      table: normalizeText(row.table),
      from: normalizeText(row.from),
      to: row.to === null || row.to === undefined ? null : normalizeText(row.to),
      onUpdate: normalizeText(row.on_update),
      onDelete: normalizeText(row.on_delete),
      match: normalizeText(row.match)
    }))
    .sort((a, b) => a.id - b.id || a.seq - b.seq);

  let orderingColumns: string[];
  let orderingSource: TableSchema["orderingSource"];
  let businessKey: readonly string[] | null = null;

  if (rowidAlias !== null) {
    orderingColumns = [rowidAlias];
    orderingSource = "integer-primary-key";
    businessKey = uniqueKeys.find((key) => key.join("\u0000") !== rowidAlias) ?? null;
  } else if (primaryKeyColumns.length > 0) {
    orderingColumns = [...primaryKeyColumns];
    orderingSource = "primary-key";
    businessKey = [...primaryKeyColumns];
  } else if (uniqueKeys.length > 0) {
    const [chosen = []] = [...uniqueKeys].sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
    orderingColumns = [...chosen];
    orderingSource = "unique-index";
    businessKey = [...chosen];
  } else {
    orderingColumns = columns.map((column) => column.name);
    orderingSource = "all-columns";
  }

  // `rowid` is appended as the final tiebreaker so ordering is total even when a
  // unique index permits NULLs. The importer preserves rowids exactly.
  if (hasRowid && rowidAlias === null) {
    orderingColumns = [...orderingColumns, "rowid"];
  }

  const blobColumns = columns
    .filter((column) => /blob/i.test(column.declaredType) || column.declaredType.trim() === "")
    .map((column) => column.name);

  return Object.freeze({
    name,
    sql: master.sql,
    columns: Object.freeze(columns),
    columnNames: Object.freeze(columns.map((column) => column.name)),
    primaryKeyColumns: Object.freeze(primaryKeyColumns),
    rowidAlias,
    hasRowid,
    uniqueKeys: Object.freeze(uniqueKeys.map((key) => Object.freeze([...key]))),
    businessKey: businessKey ? Object.freeze([...businessKey]) : null,
    orderingColumns: Object.freeze(orderingColumns),
    orderingSource,
    blobColumns: Object.freeze(blobColumns),
    indexes: Object.freeze(indexes),
    foreignKeys: Object.freeze(foreignKeys),
    hasAutoincrement: /\bAUTOINCREMENT\b/i.test(master.sql)
  });
}

/** Explicit (CREATE-statement backed) indexes and triggers owned by `tables`. */
export function readOwnedSchemaObjects(
  database: SqliteDatabase,
  tables: readonly string[]
): { indexes: SchemaObject[]; triggers: SchemaObject[] } {
  const owned = new Set(tables);
  const rows = database
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view')")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

  const indexes: SchemaObject[] = [];
  const triggers: SchemaObject[] = [];
  for (const row of rows) {
    if (!owned.has(row.tbl_name)) continue;
    // Indexes without SQL are implicit (UNIQUE / PRIMARY KEY constraints) and
    // are recreated by the table DDL itself.
    if (row.sql === null) continue;
    const entry: SchemaObject = {
      type: row.type as SchemaObject["type"],
      name: row.name,
      tableName: row.tbl_name,
      sql: row.sql
    };
    if (row.type === "index") indexes.push(entry);
    else if (row.type === "trigger") triggers.push(entry);
  }

  const byName = (a: SchemaObject, b: SchemaObject): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { indexes: indexes.sort(byName), triggers: triggers.sort(byName) };
}

export interface SchemaIdentity {
  readonly tableCount: number;
  readonly indexCount: number;
  readonly triggerCount: number;
  readonly missingTables: readonly string[];
  readonly digest: string;
  readonly objects: readonly { type: string; name: string; tableName: string; sqlSha256: string }[];
}

/**
 * A stable identity for the owned portion of a schema: exact CREATE statements
 * for the owned tables plus every explicit index/trigger attached to them.
 *
 * Tables that are absent are reported rather than thrown, so reconciliation can
 * finish and report every difference at once.
 */
export function computeSchemaIdentity(
  database: SqliteDatabase,
  tables: readonly string[]
): SchemaIdentity {
  const owned = [...tables].sort();
  const objects: { type: string; name: string; tableName: string; sqlSha256: string }[] = [];
  const missingTables: string[] = [];
  const presentTables: string[] = [];

  for (const table of owned) {
    if (!tableExists(database, table)) {
      missingTables.push(table);
      continue;
    }
    presentTables.push(table);
    const schema = readTableSchema(database, table);
    objects.push({
      type: "table",
      name: table,
      tableName: table,
      sqlSha256: stableJsonDigest(schema.sql)
    });
  }

  const { indexes, triggers } = readOwnedSchemaObjects(database, presentTables);
  for (const object of [...indexes, ...triggers]) {
    objects.push({
      type: object.type,
      name: object.name,
      tableName: object.tableName,
      sqlSha256: stableJsonDigest(object.sql)
    });
  }

  objects.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  return Object.freeze({
    tableCount: presentTables.length,
    indexCount: indexes.length,
    triggerCount: triggers.length,
    missingTables: Object.freeze(missingTables),
    digest: stableJsonDigest({ objects, missingTables }),
    objects: Object.freeze(objects)
  });
}

/** `sqlite_sequence` values for the owned tables, sorted by table name. */
export function readSequences(
  database: SqliteDatabase,
  tables: readonly string[]
): Record<string, string> {
  if (!tableExists(database, "sqlite_sequence")) return {};
  const owned = new Set(tables);
  const rows = database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() as {
    name: string;
    seq: bigint | number;
  }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (!owned.has(row.name)) continue;
    result[row.name] = typeof row.seq === "bigint" ? row.seq.toString(10) : String(row.seq);
  }
  return result;
}

/** Builds the deterministic `ORDER BY` clause for a table. */
export function orderByClause(schema: TableSchema): string {
  return schema.orderingColumns
    .map((column) => (column === "rowid" ? "rowid" : quoteIdentifier(column)))
    .join(", ");
}

/** Column list to select for full-fidelity row reads (user columns only). */
export function selectColumnsClause(schema: TableSchema): string {
  return schema.columnNames.map((column) => quoteIdentifier(column)).join(", ");
}
