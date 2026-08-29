/**
 * Source-vs-target reconciliation.
 *
 * Coverage per owned table:
 *   - exact row counts
 *   - primary/business key set digest (ordered, so ordering is verified too)
 *   - canonical type-aware SHA-256 over every row, in deterministic key order
 *   - per-column BLOB payload digests
 *   - foreign key definitions and `foreign_key_check` results
 *   - `sqlite_sequence` values
 *   - schema/index/trigger identity
 *
 * Any difference is collected and reported; the caller exits non-zero.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  BlobColumnDigest,
  CanonicalDigest,
  describeValue,
  hashRow,
  stableJsonDigest,
  type SqliteValue
} from "./canonical.js";
import {
  computeSchemaIdentity,
  orderByClause,
  quoteIdentifier,
  readSequences,
  readTableSchema,
  selectColumnsClause,
  type SchemaIdentity,
  type TableSchema
} from "./schema.js";
import { verifyAgainstOracle, type OracleDocument, type OracleVerification } from "./oracle.js";

export interface BlobColumnResult {
  readonly column: string;
  readonly blobCount: number;
  readonly blobBytes: number;
  readonly sha256: string;
}

export interface TableFingerprint {
  readonly table: string;
  readonly rows: number;
  readonly rowDigest: string;
  readonly keyDigest: string;
  readonly keyColumns: readonly string[];
  readonly orderingSource: TableSchema["orderingSource"];
  readonly blobColumns: readonly BlobColumnResult[];
  readonly schemaSqlSha256: string;
  readonly foreignKeysSha256: string;
  readonly durationMs: number;
}

export interface TableDifference {
  readonly table: string;
  readonly kind:
    | "row-count"
    | "row-digest"
    | "key-digest"
    | "blob-digest"
    | "schema-sql"
    | "foreign-keys"
    | "missing-table";
  readonly source: unknown;
  readonly target: unknown;
  readonly samples?: readonly unknown[];
}

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly foreignKeyIndex: number;
}

export interface ReconciliationResult {
  readonly ok: boolean;
  readonly tables: readonly {
    readonly table: string;
    readonly source: TableFingerprint;
    readonly target: TableFingerprint;
    readonly matched: boolean;
  }[];
  readonly totals: {
    readonly sourceRows: number;
    readonly targetRows: number;
    readonly expectedRows: number;
    readonly rowsMatchExpected: boolean;
  };
  readonly sequences: {
    readonly matched: boolean;
    readonly source: Readonly<Record<string, string>>;
    readonly target: Readonly<Record<string, string>>;
    readonly differences: readonly { table: string; source: string | null; target: string | null }[];
  };
  readonly schema: {
    readonly matched: boolean;
    readonly source: SchemaIdentity;
    readonly target: SchemaIdentity;
  };
  readonly foreignKeys: {
    readonly enforced: boolean;
    readonly violations: readonly ForeignKeyViolation[];
  };
  /**
   * Independent corroboration from the coordinator's canonical-hash oracle.
   *
   * The published document is the *source-side authority*: when it was produced
   * by executing `hash-sqlite-tables.mjs`, its digests come from a program this
   * repository did not write. The target side is verified by our own
   * mapping-aware code, because the imported database deliberately has a
   * different schema. `sourceCrossCheck` is optional corroboration that our
   * reader agrees with theirs on the same source bytes; it never substitutes for
   * the published document.
   */
  readonly oracle: {
    readonly matched: boolean;
    readonly oraclePath: string;
    readonly expectedAggregateSha256: string;
    readonly publishedAggregateSha256: string | null;
    readonly publishedTableCount: number | null;
    readonly publishedRowCount: number | null;
    readonly publishedMatchesExpected: boolean;
    readonly target: OracleVerification;
    readonly targetMatchesPublished: boolean;
    readonly sourceCrossCheck: OracleVerification | null;
    readonly sourceCrossCheckAgrees: boolean | null;
  } | null;
  readonly differences: readonly TableDifference[];
  readonly durationMs: number;
}

const DEFAULT_MAX_DIFF_SAMPLES = 25;

function foreignKeysDigest(schema: TableSchema): string {
  return stableJsonDigest(
    schema.foreignKeys.map((fk) => ({
      table: fk.table,
      from: fk.from,
      to: fk.to,
      onUpdate: fk.onUpdate,
      onDelete: fk.onDelete,
      match: fk.match,
      seq: fk.seq
    }))
  );
}

/**
 * Computes the full fingerprint of one table with O(1) memory: rows are read in
 * deterministic key order and folded into streaming digests.
 */
export function fingerprintTable(database: SqliteDatabase, table: string): TableFingerprint {
  const startedAt = process.hrtime.bigint();
  const schema = readTableSchema(database, table);

  const rowDigest = new CanonicalDigest(`row:${table}`);
  const keyDigest = new CanonicalDigest(`key:${table}`);
  const blobDigests = schema.blobColumns.map((column) => new BlobColumnDigest(column));
  const blobIndexes = schema.blobColumns.map((column) => schema.columnNames.indexOf(column));

  const keyColumns = schema.orderingColumns;
  const keyIndexes = keyColumns.map((column) => (column === "rowid" ? -1 : schema.columnNames.indexOf(column)));

  const selectList = keyColumns.includes("rowid")
    ? `${selectColumnsClause(schema)}, rowid`
    : selectColumnsClause(schema);
  const rowidPosition = keyColumns.includes("rowid") ? schema.columnNames.length : -1;

  const statement = database
    .prepare(`SELECT ${selectList} FROM ${quoteIdentifier(table)} ORDER BY ${orderByClause(schema)}`)
    .raw(true);

  let rows = 0;
  for (const record of statement.iterate() as IterableIterator<SqliteValue[]>) {
    const values = rowidPosition === -1 ? record : record.slice(0, schema.columnNames.length);
    rowDigest.updateRow(values);

    const keyValues: SqliteValue[] = keyIndexes.map((index) =>
      index === -1 ? (record[rowidPosition] as SqliteValue) : (values[index] as SqliteValue)
    );
    keyDigest.updateRow(keyValues);

    for (const [index, digest] of blobDigests.entries()) {
      const columnIndex = blobIndexes[index];
      if (columnIndex === undefined || columnIndex < 0) continue;
      digest.update(values[columnIndex] as SqliteValue);
    }
    rows += 1;
  }

  return {
    table,
    rows,
    rowDigest: rowDigest.digest(),
    keyDigest: keyDigest.digest(),
    keyColumns: Object.freeze([...keyColumns]),
    orderingSource: schema.orderingSource,
    blobColumns: Object.freeze(blobDigests.map((digest) => digest.result())),
    schemaSqlSha256: stableJsonDigest(schema.sql),
    foreignKeysSha256: foreignKeysDigest(schema),
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
  };
}

/**
 * Second pass, only run when a table's digest differs: collects a bounded set of
 * key tuples whose row hashes disagree.
 */
function sampleRowDifferences(
  source: SqliteDatabase,
  target: SqliteDatabase,
  table: string,
  limit: number
): unknown[] {
  const schema = readTableSchema(source, table);
  const keyColumns = schema.orderingColumns;
  const selectList = keyColumns.includes("rowid")
    ? `${selectColumnsClause(schema)}, rowid`
    : selectColumnsClause(schema);
  const order = orderByClause(schema);

  const read = (database: SqliteDatabase): IterableIterator<SqliteValue[]> =>
    database
      .prepare(`SELECT ${selectList} FROM ${quoteIdentifier(table)} ORDER BY ${order}`)
      .raw(true)
      .iterate() as IterableIterator<SqliteValue[]>;

  const rowidPosition = keyColumns.includes("rowid") ? schema.columnNames.length : -1;
  const describeKey = (record: SqliteValue[]): unknown =>
    keyColumns.map((column, index) => ({
      column,
      value: describeValue(
        column === "rowid"
          ? (record[rowidPosition] as SqliteValue)
          : (record[schema.columnNames.indexOf(column)] as SqliteValue)
      ),
      position: index
    }));

  const samples: unknown[] = [];
  const sourceIterator = read(source);
  const targetIterator = read(target);

  for (;;) {
    if (samples.length >= limit) break;
    const sourceNext: IteratorResult<SqliteValue[], undefined> = sourceIterator.next();
    const targetNext: IteratorResult<SqliteValue[], undefined> = targetIterator.next();
    const sourceRow = sourceNext.done === true ? null : sourceNext.value;
    const targetRow = targetNext.done === true ? null : targetNext.value;
    if (sourceRow === null && targetRow === null) break;

    if (sourceRow === null) {
      if (targetRow !== null) {
        samples.push({ position: samples.length, side: "target-only", key: describeKey(targetRow) });
      }
      continue;
    }
    if (targetRow === null) {
      samples.push({ position: samples.length, side: "source-only", key: describeKey(sourceRow) });
      continue;
    }

    const sourceValues = rowidPosition === -1 ? sourceRow : sourceRow.slice(0, schema.columnNames.length);
    const targetValues = rowidPosition === -1 ? targetRow : targetRow.slice(0, schema.columnNames.length);
    const sourceHash = hashRow(sourceValues);
    const targetHash = hashRow(targetValues);
    if (sourceHash !== targetHash) {
      samples.push({
        side: "mismatch",
        key: describeKey(sourceRow),
        sourceRowSha256: sourceHash,
        targetRowSha256: targetHash,
        columns: schema.columnNames
          .map((column, index) => ({
            column,
            source: describeValue(sourceValues[index] as SqliteValue),
            target: describeValue(targetValues[index] as SqliteValue)
          }))
          .filter((entry) => stableJsonDigest(entry.source) !== stableJsonDigest(entry.target))
      });
    }
  }

  sourceIterator.return?.(undefined);
  targetIterator.return?.(undefined);
  return samples;
}

export function reconcile(options: {
  readonly source: SqliteDatabase;
  readonly target: SqliteDatabase;
  readonly tables: readonly string[];
  readonly expectedRowTotal: number;
  readonly maxDiffSamples?: number;
  /** Optional independent canonical-hash oracle for corroboration. */
  readonly oracle?: OracleDocument | null;
  readonly oracleProduct?: string;
  readonly expectedOracleAggregateSha256?: string;
  /**
   * Also recompute the source side with our own reader to corroborate the
   * published digests. Defaults to true; disable to save a full source pass when
   * the published document already came from executing the generator.
   */
  readonly crossCheckSource?: boolean;
  readonly onTable?: (table: string, index: number, total: number) => void;
  readonly onOracleTable?: (side: string, table: string, index: number, total: number) => void;
}): ReconciliationResult {
  const startedAt = process.hrtime.bigint();
  const { source, target } = options;
  const tables = [...options.tables].sort();
  const maxSamples = options.maxDiffSamples ?? DEFAULT_MAX_DIFF_SAMPLES;

  const differences: TableDifference[] = [];
  const tableResults: ReconciliationResult["tables"][number][] = [];
  let sourceRows = 0;
  let targetRows = 0;

  const targetTables = new Set(
    (target.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name
    )
  );

  for (const [index, table] of tables.entries()) {
    options.onTable?.(table, index, tables.length);

    if (!targetTables.has(table)) {
      differences.push({ table, kind: "missing-table", source: "present", target: "absent" });
      continue;
    }

    const sourceFingerprint = fingerprintTable(source, table);
    const targetFingerprint = fingerprintTable(target, table);
    sourceRows += sourceFingerprint.rows;
    targetRows += targetFingerprint.rows;

    let matched = true;

    if (sourceFingerprint.rows !== targetFingerprint.rows) {
      matched = false;
      differences.push({
        table,
        kind: "row-count",
        source: sourceFingerprint.rows,
        target: targetFingerprint.rows
      });
    }
    if (sourceFingerprint.keyDigest !== targetFingerprint.keyDigest) {
      matched = false;
      differences.push({
        table,
        kind: "key-digest",
        source: sourceFingerprint.keyDigest,
        target: targetFingerprint.keyDigest
      });
    }
    if (sourceFingerprint.rowDigest !== targetFingerprint.rowDigest) {
      matched = false;
      differences.push({
        table,
        kind: "row-digest",
        source: sourceFingerprint.rowDigest,
        target: targetFingerprint.rowDigest,
        samples: sampleRowDifferences(source, target, table, maxSamples)
      });
    }
    if (stableJsonDigest(sourceFingerprint.blobColumns) !== stableJsonDigest(targetFingerprint.blobColumns)) {
      matched = false;
      differences.push({
        table,
        kind: "blob-digest",
        source: sourceFingerprint.blobColumns,
        target: targetFingerprint.blobColumns
      });
    }
    if (sourceFingerprint.schemaSqlSha256 !== targetFingerprint.schemaSqlSha256) {
      matched = false;
      differences.push({
        table,
        kind: "schema-sql",
        source: sourceFingerprint.schemaSqlSha256,
        target: targetFingerprint.schemaSqlSha256
      });
    }
    if (sourceFingerprint.foreignKeysSha256 !== targetFingerprint.foreignKeysSha256) {
      matched = false;
      differences.push({
        table,
        kind: "foreign-keys",
        source: sourceFingerprint.foreignKeysSha256,
        target: targetFingerprint.foreignKeysSha256
      });
    }

    tableResults.push({ table, source: sourceFingerprint, target: targetFingerprint, matched });
  }

  const sourceSequences = readSequences(source, tables);
  const targetSequences = readSequences(target, tables);
  const sequenceDifferences: { table: string; source: string | null; target: string | null }[] = [];
  for (const name of new Set([...Object.keys(sourceSequences), ...Object.keys(targetSequences)])) {
    const sourceValue = sourceSequences[name] ?? null;
    const targetValue = targetSequences[name] ?? null;
    if (sourceValue !== targetValue) {
      sequenceDifferences.push({ table: name, source: sourceValue, target: targetValue });
    }
  }
  sequenceDifferences.sort((a, b) => a.table.localeCompare(b.table));

  const sourceSchema = computeSchemaIdentity(source, tables);
  const targetSchema = computeSchemaIdentity(target, tables);

  const foreignKeysEnforced = Number(target.pragma("foreign_keys", { simple: true })) === 1;
  const violations: ForeignKeyViolation[] = (target.pragma("foreign_key_check") as Record<string, unknown>[])
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

  const schemaMatched = sourceSchema.digest === targetSchema.digest;
  const sequencesMatched = sequenceDifferences.length === 0;
  const rowsMatchExpected = sourceRows === options.expectedRowTotal && targetRows === options.expectedRowTotal;

  let oracle: ReconciliationResult["oracle"] = null;
  if (options.oracle) {
    const oracleDocument = options.oracle;
    const product = options.oracleProduct ?? "Watchtower";
    const verifySide = (database: SqliteDatabase, side: string): OracleVerification =>
      verifyAgainstOracle({
        database,
        oracle: oracleDocument,
        tables,
        side,
        product,
        ...(options.expectedOracleAggregateSha256 === undefined
          ? {}
          : { expectedAggregateSha256: options.expectedOracleAggregateSha256 }),
        expectedTableCount: tables.length,
        expectedRowTotal: options.expectedRowTotal,
        onTable: (table, index, total) => options.onOracleTable?.(side, table, index, total)
      });

    // The target is verified by our mapping-aware code against the published
    // source-side digests. This is the check that proves the import.
    const targetOracle = verifySide(target, "target");

    // Optional corroboration that our reader reproduces their digests on the
    // same source bytes. Never a substitute for the published document.
    const sourceCrossCheck = options.crossCheckSource === false ? null : verifySide(source, "source-cross-check");

    const published = oracleDocument.products.get(product) ?? null;
    const expectedAggregate = targetOracle.expectedAggregateSha256;
    const publishedMatchesExpected = published !== null && published.canonicalSha256 === expectedAggregate;
    const targetMatchesPublished =
      published !== null && targetOracle.aggregateSha256 === published.canonicalSha256;
    const sourceCrossCheckAgrees =
      sourceCrossCheck === null ? null : sourceCrossCheck.aggregateSha256 === targetOracle.aggregateSha256;

    oracle = {
      matched:
        targetOracle.ok &&
        publishedMatchesExpected &&
        targetMatchesPublished &&
        (sourceCrossCheck === null || (sourceCrossCheck.ok && sourceCrossCheckAgrees === true)),
      oraclePath: oracleDocument.path,
      expectedAggregateSha256: expectedAggregate,
      publishedAggregateSha256: published?.canonicalSha256 ?? null,
      publishedTableCount: published?.tableCount ?? null,
      publishedRowCount: published?.rowCount ?? null,
      publishedMatchesExpected,
      target: targetOracle,
      targetMatchesPublished,
      sourceCrossCheck,
      sourceCrossCheckAgrees
    };
  }

  const ok =
    differences.length === 0 &&
    sequencesMatched &&
    schemaMatched &&
    foreignKeysEnforced &&
    violations.length === 0 &&
    rowsMatchExpected &&
    (oracle === null || oracle.matched);

  return {
    ok,
    tables: Object.freeze(tableResults),
    totals: { sourceRows, targetRows, expectedRows: options.expectedRowTotal, rowsMatchExpected },
    sequences: {
      matched: sequencesMatched,
      source: Object.freeze(sourceSequences),
      target: Object.freeze(targetSequences),
      differences: Object.freeze(sequenceDifferences)
    },
    schema: { matched: schemaMatched, source: sourceSchema, target: targetSchema },
    foreignKeys: { enforced: foreignKeysEnforced, violations: Object.freeze(violations) },
    oracle,
    differences: Object.freeze(differences),
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6
  };
}
