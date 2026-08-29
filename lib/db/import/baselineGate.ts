/**
 * Approved-baseline admission control.
 *
 * Every operator-supplied input is checked against `approvedBaseline.ts` — which
 * lives in source control — **before** a target database is created, opened or
 * written. The checks are ordered so nothing on disk is touched until the whole
 * lineage has been admitted:
 *
 *   1. manifest lineage + owned table set        (no file I/O)
 *   2. oracle document, if supplied              (no file I/O)
 *   3. backup file bytes + SHA-256               (read-only)
 *   4. source schema counts, per-table row counts, owned schema digest,
 *      sqlite_sequence                           (read-only)
 *   ---- only now may a target be created ----
 *
 * A forged manifest that agrees with a forged backup and a forged oracle still
 * fails, because none of the approved values come from those inputs.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { quoteIdentifier } from "./schema.js";
import { computeSchemaIdentity } from "./schema.js";
import {
  APPROVED_AGGREGATE_SHA256,
  APPROVED_LINEAGE,
  APPROVED_OWNED_EXPLICIT_INDEX_COUNT,
  APPROVED_OWNED_ROW_TOTAL,
  APPROVED_OWNED_SCHEMA_DIGEST,
  APPROVED_OWNED_TABLE_COUNT,
  APPROVED_OWNED_TABLES,
  APPROVED_OWNED_TRIGGER_COUNT,
  APPROVED_SEQUENCES,
  APPROVED_SOURCE_SCHEMA_COUNTS,
  APPROVED_TABLES
} from "./approvedBaseline.js";
import type { OwnershipContract } from "./ownership.js";
import type { OracleDocument } from "./oracle.js";

export interface BaselineFinding {
  readonly field: string;
  readonly approved: unknown;
  readonly supplied: unknown;
}

function reject(stage: string, findings: readonly BaselineFinding[]): never {
  throw new ImportError("BASELINE_REJECTED", `Supplied ${stage} does not match the approved Watchtower baseline`, {
    stage,
    findings: [...findings].slice(0, 40),
    findingCount: findings.length
  });
}

function compare(
  findings: BaselineFinding[],
  field: string,
  approved: unknown,
  supplied: unknown
): void {
  if (approved !== supplied) findings.push({ field, approved, supplied });
}

/** Stage 1: the decomposition manifest's lineage and owned table set. */
export function assertManifestMatchesApprovedBaseline(ownership: OwnershipContract): void {
  const findings: BaselineFinding[] = [];
  const baseline = ownership.sourceBaseline;

  compare(findings, "repository", APPROVED_LINEAGE.repository, baseline.repository);
  compare(findings, "version", APPROVED_LINEAGE.version, baseline.version);
  compare(findings, "build", APPROVED_LINEAGE.build, baseline.build);
  compare(findings, "commit", APPROVED_LINEAGE.commit, baseline.commit);
  compare(findings, "tree", APPROVED_LINEAGE.tree, baseline.tree);
  compare(findings, "imageDigest", APPROVED_LINEAGE.imageDigest, baseline.imageDigest);
  compare(findings, "backupCreatedUtc", APPROVED_LINEAGE.backupCreatedUtc, baseline.backupCreatedUtc);
  compare(findings, "backupBytes", APPROVED_LINEAGE.backupBytes, baseline.backupBytes);
  compare(findings, "backupSha256", APPROVED_LINEAGE.backupSha256, baseline.backupSha256);
  compare(findings, "expectedOwnedRowTotal", APPROVED_OWNED_ROW_TOTAL, ownership.expectedOwnedRowTotal);
  compare(findings, "ownedTableCount", APPROVED_OWNED_TABLE_COUNT, ownership.ownedTables.length);

  const supplied = new Set(ownership.ownedTables);
  for (const table of APPROVED_OWNED_TABLES) {
    if (!supplied.has(table)) findings.push({ field: `ownedTables.missing`, approved: table, supplied: null });
  }
  for (const table of ownership.ownedTables) {
    if (!APPROVED_TABLES.has(table)) {
      findings.push({ field: `ownedTables.unexpected`, approved: null, supplied: table });
    }
  }

  if (findings.length > 0) reject("decomposition manifest", findings);
}

/**
 * Stage 2: the canonical-hash oracle. Supplied or executed, it is corroboration
 * only — its values must agree with the approved constants, never replace them.
 */
export function assertOracleMatchesApprovedBaseline(oracle: OracleDocument, product = "Watchtower"): void {
  const findings: BaselineFinding[] = [];

  compare(findings, "oracle.database.bytes", APPROVED_LINEAGE.backupBytes, oracle.databaseBytes);

  const published = oracle.products.get(product) ?? null;
  if (published === null) {
    findings.push({ field: `oracle.products.${product}`, approved: "present", supplied: "absent" });
  } else {
    compare(findings, "oracle.aggregateSha256", APPROVED_AGGREGATE_SHA256, published.canonicalSha256);
    compare(findings, "oracle.tableCount", APPROVED_OWNED_TABLE_COUNT, published.tableCount);
    compare(findings, "oracle.rowCount", APPROVED_OWNED_ROW_TOTAL, published.rowCount);
  }

  for (const [table, approved] of APPROVED_TABLES) {
    const entry = oracle.tables.get(table);
    if (!entry) {
      findings.push({ field: `oracle.tables.${table}`, approved: "present", supplied: "absent" });
      continue;
    }
    compare(findings, `oracle.tables.${table}.rowCount`, approved.rowCount, entry.rowCount);
    compare(findings, `oracle.tables.${table}.canonicalSha256`, approved.canonicalSha256, entry.canonicalSha256);
  }

  if (findings.length > 0) reject("canonical-hash oracle", findings);
}

/** Stage 3: the backup file's measured size and digest. */
export function assertBackupIdentityMatchesApprovedBaseline(identity: {
  readonly bytes: number;
  readonly sha256: string;
}): void {
  const findings: BaselineFinding[] = [];
  compare(findings, "backup.bytes", APPROVED_LINEAGE.backupBytes, identity.bytes);
  compare(findings, "backup.sha256", APPROVED_LINEAGE.backupSha256, identity.sha256);
  if (findings.length > 0) reject("backup file identity", findings);
}

export interface SourceSchemaFacts {
  readonly tables: number;
  readonly explicitIndexes: number;
  readonly triggers: number;
  readonly views: number;
}

export function readSourceSchemaFacts(database: SqliteDatabase): SourceSchemaFacts {
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL) AS explicitIndexes,
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger') AS triggers,
         (SELECT COUNT(*) FROM sqlite_master WHERE type = 'view') AS views`
    )
    .get() as { tables: bigint | number; explicitIndexes: bigint | number; triggers: bigint | number; views: bigint | number };
  const toNumber = (value: bigint | number): number => (typeof value === "bigint" ? Number(value) : value);
  return {
    tables: toNumber(row.tables),
    explicitIndexes: toNumber(row.explicitIndexes),
    triggers: toNumber(row.triggers),
    views: toNumber(row.views)
  };
}

export interface SourceBaselineFacts {
  readonly schema: SourceSchemaFacts;
  readonly ownedSchemaDigest: string;
  readonly ownedRowTotal: number;
}

/**
 * Stage 4: the opened source itself — whole-schema counts, owned schema identity,
 * every owned table's row count, and `sqlite_sequence`.
 */
export function assertSourceMatchesApprovedBaseline(database: SqliteDatabase): SourceBaselineFacts {
  const findings: BaselineFinding[] = [];

  const schema = readSourceSchemaFacts(database);
  compare(findings, "source.schema.tables", APPROVED_SOURCE_SCHEMA_COUNTS.tables, schema.tables);
  compare(
    findings,
    "source.schema.explicitIndexes",
    APPROVED_SOURCE_SCHEMA_COUNTS.explicitIndexes,
    schema.explicitIndexes
  );
  compare(findings, "source.schema.triggers", APPROVED_SOURCE_SCHEMA_COUNTS.triggers, schema.triggers);
  compare(findings, "source.schema.views", APPROVED_SOURCE_SCHEMA_COUNTS.views, schema.views);

  const present = new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name
    )
  );
  const missing = APPROVED_OWNED_TABLES.filter((table) => !present.has(table));
  for (const table of missing) {
    findings.push({ field: `source.tables.${table}`, approved: "present", supplied: "absent" });
  }
  if (findings.length > 0) reject("source database", findings);

  let ownedRowTotal = 0;
  for (const [table, approved] of APPROVED_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get() as {
      c: bigint | number;
    };
    const count = typeof row.c === "bigint" ? Number(row.c) : row.c;
    ownedRowTotal += count;
    compare(findings, `source.rowCount.${table}`, approved.rowCount, count);
  }
  compare(findings, "source.ownedRowTotal", APPROVED_OWNED_ROW_TOTAL, ownedRowTotal);

  const ownedSchema = computeSchemaIdentity(database, APPROVED_OWNED_TABLES);
  compare(findings, "source.ownedSchemaDigest", APPROVED_OWNED_SCHEMA_DIGEST, ownedSchema.digest);
  compare(
    findings,
    "source.ownedExplicitIndexCount",
    APPROVED_OWNED_EXPLICIT_INDEX_COUNT,
    ownedSchema.indexCount
  );
  compare(findings, "source.ownedTriggerCount", APPROVED_OWNED_TRIGGER_COUNT, ownedSchema.triggerCount);

  const sequences = database.prepare("SELECT name, seq FROM sqlite_sequence").all() as {
    name: string;
    seq: bigint | number;
  }[];
  const sequenceByName = new Map(
    sequences.map((row) => [row.name, typeof row.seq === "bigint" ? row.seq.toString(10) : String(row.seq)])
  );
  for (const [table, approvedSeq] of APPROVED_SEQUENCES) {
    compare(findings, `source.sqlite_sequence.${table}`, approvedSeq, sequenceByName.get(table) ?? null);
  }

  if (findings.length > 0) reject("source database", findings);

  return { schema, ownedSchemaDigest: ownedSchema.digest, ownedRowTotal };
}

/**
 * The admission record every produced artefact must carry.
 *
 * Evidence can only be a pass when the gate ran and every stage was admitted, so
 * a reconcile-only artefact can never be mistaken for an ungated one.
 */
export interface BaselineAdmission {
  readonly gateEnforced: boolean;
  readonly manifestAdmitted: boolean;
  readonly oracleAdmitted: boolean;
  readonly backupAdmitted: boolean;
  readonly sourceAdmitted: boolean;
  readonly source: SourceBaselineFacts | null;
}

export const UNADMITTED: BaselineAdmission = Object.freeze({
  gateEnforced: false,
  manifestAdmitted: false,
  oracleAdmitted: false,
  backupAdmitted: false,
  sourceAdmitted: false,
  source: null
});

/** True only when the gate ran and admitted the manifest, oracle, backup and source. */
export function isFullyAdmitted(admission: BaselineAdmission | null | undefined): boolean {
  return (
    admission !== null &&
    admission !== undefined &&
    admission.gateEnforced &&
    admission.manifestAdmitted &&
    admission.oracleAdmitted &&
    admission.backupAdmitted &&
    admission.sourceAdmitted &&
    admission.source !== null
  );
}

/**
 * Watchtower may only produce a green artefact with an approved oracle behind it.
 * Absence of an oracle is a refusal, not a quietly weaker run.
 */
export function assertOracleRequiredForProduct(product: string, oraclePresent: boolean): void {
  if (product === "Watchtower" && !oraclePresent) {
    throw new ImportError(
      "BASELINE_REJECTED",
      "Watchtower requires an approved canonical-hash oracle: pass --oracle-generator (preferred) or --oracle",
      { stage: "oracle", findings: [{ field: "oracle", approved: "present", supplied: "absent" }] }
    );
  }
}
