/**
 * Independent canonical-hash oracle.
 *
 * The coordinator publishes `production-canonical-hashes.json`
 * (`hearth.sqlite-canonical-table-hashes.v1`), produced by
 * `hash-sqlite-tables.mjs` against the immutable production backup. That file is
 * a *second, independently written* implementation of table hashing, so making
 * the import prove itself against it catches a whole class of failure that a
 * self-consistent reconciliation cannot: a bug shared between the reader and the
 * writer in this repository.
 *
 * This module re-derives the oracle's digests from a live database handle. It is
 * a deliberate, byte-faithful re-implementation of the oracle's encoding, which
 * is intentionally *different* from `canonical.ts`:
 *
 *   null    -> 'N' | uint64be(0)
 *   blob    -> 'B' | uint64be(len)  | raw bytes
 *   integer -> 'I' | uint64be(len)  | UTF-8 base-10 int64
 *   real    -> 'F' | uint64be(len)  | UTF-8 Number#toString, with explicit
 *                                     'NaN' / '-0' / 'Infinity' / '-Infinity'
 *   text    -> 'T' | uint64be(len)  | UTF-8 bytes
 *
 * Table digest = sha256 over
 *   'hearth.sqlite-table-canonical.v1\0'
 *   | value(tableName) | value(columnCount as a JS number)
 *   | value(columnName) | value(declaredType)  per column, in `cid` order
 *   | ('R' | value(column) per column)         per row
 * with rows ordered by the declared primary key, or by `rowid` when a table has
 * none.
 *
 * Product digest = sha256 over
 *   'hearth.sqlite-product-canonical.v1\0'
 *   | value(productName)
 *   | value(tableName) | value(tableSha256) | value(rowCount as a JS number)
 * for each owned table in ascending name order.
 *
 * The two encodings agreeing on the same 2.7 M rows is meaningful corroboration
 * precisely because neither shares code with the other.
 */

import { createHash, type Hash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { quoteIdentifier, readTableSchema } from "./schema.js";
import type { SqliteValue } from "./canonical.js";

export const ORACLE_CONTRACT = "hearth.sqlite-canonical-table-hashes.v1";
export const ORACLE_TABLE_DOMAIN = "hearth.sqlite-table-canonical.v1\u0000";
export const ORACLE_PRODUCT_DOMAIN = "hearth.sqlite-product-canonical.v1\u0000";

/** Reviewed Watchtower aggregate from the coordinator's oracle. */
export const WATCHTOWER_ORACLE_AGGREGATE_SHA256 =
  "f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322";
export const WATCHTOWER_ORACLE_TABLE_COUNT = 54;
export const WATCHTOWER_ORACLE_ROW_TOTAL = 2_723_313;

export interface OracleColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKeyOrder: number;
}

export interface OracleTableEntry {
  readonly name: string;
  readonly rowCount: number;
  readonly primaryKey: readonly string[];
  readonly columns: readonly OracleColumn[];
  readonly canonicalSha256: string;
}

export interface OracleProductEntry {
  readonly name: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly canonicalSha256: string;
}

export interface OracleDocument {
  readonly path: string;
  readonly contract: string;
  readonly databasePath: string;
  readonly databaseBytes: number;
  readonly tableCount: number;
  readonly tables: ReadonlyMap<string, OracleTableEntry>;
  readonly products: ReadonlyMap<string, OracleProductEntry>;
}

const ROW_MARKER = Buffer.from("R", "ascii");

function writeLength(hash: Hash, length: number): void {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(length));
  hash.update(encoded);
}

function writeTagged(hash: Hash, tag: string, payload: Buffer): void {
  hash.update(tag);
  writeLength(hash, payload.length);
  hash.update(payload);
}

/** Number encoding, matching the oracle's explicit special cases exactly. */
function encodeOracleNumber(value: number): Buffer {
  const text = Number.isNaN(value)
    ? "NaN"
    : Object.is(value, -0)
      ? "-0"
      : value === Infinity
        ? "Infinity"
        : value === -Infinity
          ? "-Infinity"
          : value.toString();
  return Buffer.from(text, "utf8");
}

/** Byte-faithful re-implementation of the oracle's `writeValue`. */
export function writeOracleValue(hash: Hash, value: SqliteValue): void {
  if (value === null || value === undefined) {
    hash.update("N");
    writeLength(hash, 0);
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update("B");
    writeLength(hash, value.byteLength);
    hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return;
  }
  if (typeof value === "bigint") {
    writeTagged(hash, "I", Buffer.from(value.toString(10), "utf8"));
    return;
  }
  if (typeof value === "number") {
    writeTagged(hash, "F", encodeOracleNumber(value));
    return;
  }
  if (typeof value === "string") {
    writeTagged(hash, "T", Buffer.from(value, "utf8"));
    return;
  }
  throw new ImportError("ORACLE_VALUE_UNSUPPORTED", `Unsupported SQLite value type: ${typeof value}`);
}

export interface OracleTableResult {
  readonly name: string;
  readonly rowCount: number;
  readonly primaryKey: readonly string[];
  readonly columns: readonly { name: string; type: string }[];
  readonly canonicalSha256: string;
  readonly durationMs: number;
}

/**
 * Recomputes one table's oracle digest from a live database handle.
 *
 * The handle must have `defaultSafeIntegers(true)` set so SQLite INTEGER arrives
 * as `bigint` and REAL as `number`; otherwise the `I`/`F` tags cannot be told
 * apart and the digest is meaningless.
 */
export function computeOracleTableHash(database: SqliteDatabase, table: string): OracleTableResult {
  const startedAt = process.hrtime.bigint();
  const schema = readTableSchema(database, table);

  const hash = createHash("sha256");
  hash.update(ORACLE_TABLE_DOMAIN);
  writeOracleValue(hash, table);
  // The oracle writes the column count as a JavaScript number, so it carries the
  // 'F' tag rather than 'I'.
  writeOracleValue(hash, schema.columns.length);
  for (const column of schema.columns) {
    writeOracleValue(hash, column.name);
    writeOracleValue(hash, column.declaredType);
  }

  const orderBy =
    schema.primaryKeyColumns.length > 0
      ? schema.primaryKeyColumns.map((column) => quoteIdentifier(column)).join(", ")
      : "rowid";
  const selectList = schema.columnNames.map((column) => quoteIdentifier(column)).join(", ");

  const statement = database
    .prepare(`SELECT ${selectList} FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`)
    .raw(true);

  let rowCount = 0;
  for (const row of statement.iterate() as IterableIterator<SqliteValue[]>) {
    hash.update(ROW_MARKER);
    for (const value of row) writeOracleValue(hash, value);
    rowCount += 1;
  }

  return {
    name: table,
    rowCount,
    primaryKey: schema.primaryKeyColumns,
    columns: schema.columns.map((column) => ({ name: column.name, type: column.declaredType })),
    canonicalSha256: hash.digest("hex"),
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
  };
}

/** Recomputes a product aggregate from per-table oracle digests. */
export function computeOracleProductHash(
  product: string,
  tables: readonly { name: string; rowCount: number; canonicalSha256: string }[]
): { canonicalSha256: string; tableCount: number; rowCount: number } {
  const hash = createHash("sha256");
  hash.update(ORACLE_PRODUCT_DOMAIN);
  writeOracleValue(hash, product);

  let rowCount = 0;
  for (const table of [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    writeOracleValue(hash, table.name);
    writeOracleValue(hash, table.canonicalSha256);
    writeOracleValue(hash, table.rowCount);
    rowCount += table.rowCount;
  }

  return { canonicalSha256: hash.digest("hex"), tableCount: tables.length, rowCount };
}

/** Stringifies an untrusted JSON value without ever producing "[object Object]". */
function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportError("ORACLE_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Loads and validates the coordinator's oracle document. */
export function loadOracle(path: string): OracleDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new ImportError("ORACLE_INVALID", `Cannot read canonical-hash oracle at ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  const document = asRecord(parsed, "oracle");
  if (document.contract !== ORACLE_CONTRACT) {
    throw new ImportError("ORACLE_INVALID", `Oracle contract must be ${ORACLE_CONTRACT}`, {
      contract: document.contract
    });
  }

  const database = asRecord(document.database, "oracle.database");
  const databaseBytes = database.bytes;
  if (typeof databaseBytes !== "number" || !Number.isInteger(databaseBytes)) {
    throw new ImportError("ORACLE_INVALID", "oracle.database.bytes must be an integer");
  }

  const rawTables = document.tables;
  if (!Array.isArray(rawTables)) {
    throw new ImportError("ORACLE_INVALID", "oracle.tables must be an array");
  }

  const tables = new Map<string, OracleTableEntry>();
  for (const entry of rawTables) {
    const record = asRecord(entry, "oracle.tables[]");
    const name = record.name;
    const rowCount = record.rowCount;
    const canonicalSha256 = record.canonicalSha256;
    if (typeof name !== "string" || typeof rowCount !== "number" || typeof canonicalSha256 !== "string") {
      throw new ImportError("ORACLE_INVALID", "oracle.tables[] entries need name, rowCount and canonicalSha256");
    }
    if (!/^[0-9a-f]{64}$/.test(canonicalSha256)) {
      throw new ImportError("ORACLE_INVALID", `oracle table ${name} has a malformed canonicalSha256`);
    }
    const columns = Array.isArray(record.columns)
      ? record.columns.map((column) => {
          const columnRecord = asRecord(column, "oracle.tables[].columns[]");
          return {
            name: asText(columnRecord.name),
            type: asText(columnRecord.type),
            notNull: columnRecord.notNull === true,
            primaryKeyOrder: Number(columnRecord.primaryKeyOrder ?? 0)
          };
        })
      : [];
    tables.set(name, {
      name,
      rowCount,
      primaryKey: Array.isArray(record.primaryKey) ? record.primaryKey.map((value) => String(value)) : [],
      columns,
      canonicalSha256
    });
  }

  const products = new Map<string, OracleProductEntry>();
  if (Array.isArray(document.products)) {
    for (const entry of document.products) {
      const record = asRecord(entry, "oracle.products[]");
      const name = record.name;
      const canonicalSha256 = record.canonicalSha256;
      if (typeof name !== "string" || typeof canonicalSha256 !== "string") continue;
      products.set(name, {
        name,
        tableCount: Number(record.tableCount ?? 0),
        rowCount: Number(record.rowCount ?? 0),
        canonicalSha256
      });
    }
  }

  return Object.freeze({
    path,
    contract: ORACLE_CONTRACT,
    databasePath: asText(database.path),
    databaseBytes,
    tableCount: Number(document.tableCount ?? tables.size),
    tables,
    products
  });
}

export interface OracleTableComparison {
  readonly table: string;
  readonly computedSha256: string;
  readonly oracleSha256: string | null;
  readonly computedRowCount: number;
  readonly oracleRowCount: number | null;
  readonly matched: boolean;
}

export interface OracleDifference {
  readonly table: string | null;
  readonly kind: "missing-in-oracle" | "row-count" | "table-hash" | "aggregate-hash" | "table-count" | "row-total";
  readonly oracle: unknown;
  readonly computed: unknown;
}

export interface OracleVerification {
  readonly ok: boolean;
  readonly side: string;
  readonly oraclePath: string;
  readonly oracleContract: string;
  readonly oracleDatabaseBytes: number;
  readonly product: string;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly aggregateSha256: string;
  readonly expectedAggregateSha256: string;
  readonly aggregateMatches: boolean;
  readonly expectedTableCount: number;
  readonly expectedRowTotal: number;
  readonly tables: readonly OracleTableComparison[];
  readonly differences: readonly OracleDifference[];
  readonly durationMs: number;
}

/**
 * Recomputes every owned table's oracle digest from `database` and compares it,
 * plus the product aggregate, against the published oracle.
 */
export function verifyAgainstOracle(options: {
  readonly database: SqliteDatabase;
  readonly oracle: OracleDocument;
  readonly tables: readonly string[];
  readonly side: string;
  readonly product?: string;
  readonly expectedAggregateSha256?: string;
  readonly expectedTableCount?: number;
  readonly expectedRowTotal?: number;
  readonly onTable?: (table: string, index: number, total: number) => void;
}): OracleVerification {
  const startedAt = process.hrtime.bigint();
  const product = options.product ?? "Watchtower";
  const expectedAggregate = options.expectedAggregateSha256 ?? WATCHTOWER_ORACLE_AGGREGATE_SHA256;
  const expectedTableCount = options.expectedTableCount ?? WATCHTOWER_ORACLE_TABLE_COUNT;
  const expectedRowTotal = options.expectedRowTotal ?? WATCHTOWER_ORACLE_ROW_TOTAL;

  const ordered = [...options.tables].sort();
  const comparisons: OracleTableComparison[] = [];
  const differences: OracleDifference[] = [];
  const forAggregate: { name: string; rowCount: number; canonicalSha256: string }[] = [];

  for (const [index, table] of ordered.entries()) {
    options.onTable?.(table, index, ordered.length);
    const computed = computeOracleTableHash(options.database, table);
    const entry = options.oracle.tables.get(table) ?? null;

    forAggregate.push({
      name: table,
      rowCount: computed.rowCount,
      canonicalSha256: computed.canonicalSha256
    });

    if (entry === null) {
      differences.push({ table, kind: "missing-in-oracle", oracle: null, computed: computed.canonicalSha256 });
      comparisons.push({
        table,
        computedSha256: computed.canonicalSha256,
        oracleSha256: null,
        computedRowCount: computed.rowCount,
        oracleRowCount: null,
        matched: false
      });
      continue;
    }

    let matched = true;
    if (computed.rowCount !== entry.rowCount) {
      matched = false;
      differences.push({ table, kind: "row-count", oracle: entry.rowCount, computed: computed.rowCount });
    }
    if (computed.canonicalSha256 !== entry.canonicalSha256) {
      matched = false;
      differences.push({
        table,
        kind: "table-hash",
        oracle: entry.canonicalSha256,
        computed: computed.canonicalSha256
      });
    }

    comparisons.push({
      table,
      computedSha256: computed.canonicalSha256,
      oracleSha256: entry.canonicalSha256,
      computedRowCount: computed.rowCount,
      oracleRowCount: entry.rowCount,
      matched
    });
  }

  const aggregate = computeOracleProductHash(product, forAggregate);

  if (aggregate.tableCount !== expectedTableCount) {
    differences.push({
      table: null,
      kind: "table-count",
      oracle: expectedTableCount,
      computed: aggregate.tableCount
    });
  }
  if (aggregate.rowCount !== expectedRowTotal) {
    differences.push({ table: null, kind: "row-total", oracle: expectedRowTotal, computed: aggregate.rowCount });
  }

  const aggregateMatches = aggregate.canonicalSha256 === expectedAggregate;
  if (!aggregateMatches) {
    differences.push({
      table: null,
      kind: "aggregate-hash",
      oracle: expectedAggregate,
      computed: aggregate.canonicalSha256
    });
  }

  return {
    ok: differences.length === 0,
    side: options.side,
    oraclePath: options.oracle.path,
    oracleContract: options.oracle.contract,
    oracleDatabaseBytes: options.oracle.databaseBytes,
    product,
    tableCount: aggregate.tableCount,
    rowCount: aggregate.rowCount,
    aggregateSha256: aggregate.canonicalSha256,
    expectedAggregateSha256: expectedAggregate,
    aggregateMatches,
    expectedTableCount,
    expectedRowTotal,
    tables: Object.freeze(comparisons),
    differences: Object.freeze(differences),
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
  };
}

/**
 * Cross-checks the published oracle document itself against the reviewed
 * Watchtower constants, before any database work happens.
 */
export function assertOraclePublishesWatchtowerBaseline(oracle: OracleDocument): OracleProductEntry {
  const entry = oracle.products.get("Watchtower");
  if (!entry) {
    throw new ImportError("ORACLE_INVALID", "Oracle does not publish a Watchtower product aggregate");
  }
  if (entry.canonicalSha256 !== WATCHTOWER_ORACLE_AGGREGATE_SHA256) {
    throw new ImportError("ORACLE_MISMATCH", "Oracle Watchtower aggregate does not match the reviewed value", {
      expected: WATCHTOWER_ORACLE_AGGREGATE_SHA256,
      actual: entry.canonicalSha256
    });
  }
  if (entry.tableCount !== WATCHTOWER_ORACLE_TABLE_COUNT || entry.rowCount !== WATCHTOWER_ORACLE_ROW_TOTAL) {
    throw new ImportError("ORACLE_MISMATCH", "Oracle Watchtower table/row totals do not match the reviewed values", {
      expectedTableCount: WATCHTOWER_ORACLE_TABLE_COUNT,
      actualTableCount: entry.tableCount,
      expectedRowTotal: WATCHTOWER_ORACLE_ROW_TOTAL,
      actualRowTotal: entry.rowCount
    });
  }
  return entry;
}
