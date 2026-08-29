/**
 * Import orchestrator: immutable source -> empty target, deterministic and
 * rerunnable.
 *
 * Order of operations:
 *   1. verify source bytes/SHA-256 against the reviewed baseline
 *   2. open source read-only, assert every owned table is present
 *   3. open/prepare an empty, non-aliasing, non-Git target
 *   4. recreate exact owned table SQL
 *   5. stream rows in bounded batches, preserving storage classes and rowids
 *   6. recreate explicit indexes and triggers
 *   7. copy sqlite_sequence for owned AUTOINCREMENT tables
 *   8. transform shared identity/authorization/audit into app-local tables
 *   9. foreign_keys ON, foreign_key_check, journal DELETE, synchronous FULL
 *  10. re-verify the source was not mutated
 */

import { statSync } from "node:fs";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { hashFile } from "./sourceIdentity.js";
import {
  assertOwnedTablesPresent,
  assertSourceUnchanged,
  openSourceReadonly,
  verifySourceFile,
  type SourceFileIdentity
} from "./sourceIdentity.js";
import { finalizeTarget, openEmptyTarget, type LoadSynchronous } from "./target.js";
import {
  copySequences,
  copyTableRows,
  countRows,
  createOwnedIndexesAndTriggers,
  createOwnedTables,
  type CopyTableResult
} from "./copy.js";
import {
  ensureAppLocalSchema,
  type AppLocalSchemaMode,
  type AppLocalSchemaResult
} from "./appLocalSchema.js";
import { DispositionLedger, type DispositionCount } from "./dispositions.js";
import { assertTenantId, transformSharedTables, type IdentityTransformResult } from "./transform.js";
import type { OwnershipContract } from "./ownership.js";
import type { OracleDocument } from "./oracle.js";
import {
  assertBackupIdentityMatchesApprovedBaseline,
  assertManifestMatchesApprovedBaseline,
  assertOracleMatchesApprovedBaseline,
  assertSourceMatchesApprovedBaseline,
  type BaselineAdmission
} from "./baselineGate.js";
import { APPROVED_LINEAGE } from "./approvedBaseline.js";
import { computeSchemaIdentity, type SchemaIdentity } from "./schema.js";

export interface ImportOptions {
  readonly ownership: OwnershipContract;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly tenantId: string;
  readonly adminOids?: readonly string[];
  readonly busyTimeoutMs?: number;
  readonly batchRows?: number | null;
  readonly loadSynchronous?: LoadSynchronous;
  readonly appLocalSchema?: AppLocalSchemaMode;
  readonly allowDispositions?: readonly string[];
  readonly allowInsideGitWorktree?: boolean;
  readonly verifySourceAfter?: boolean;
  /**
   * Epoch milliseconds stamped on derived app-local rows (`granted_at`, and the
   * fallback for `first_seen_at`). Pin it to make a run byte-reproducible.
   */
  readonly importedAtMs?: number;
  /**
   * Canonical-hash oracle to admit against the approved baseline before the
   * target is created. Supplying it here makes the gate reject a forged oracle
   * up front rather than at reconciliation time.
   */
  readonly oracle?: OracleDocument | null;
  /**
   * Test-only seam that bypasses approved-baseline admission so the suite can
   * import synthetic fixtures. There is deliberately **no** CLI flag for it:
   * `scripts/legacy-import.ts` never sets it, and a test asserts that, so an
   * operator has no way to disable admission control.
   */
  readonly __unsafeSkipApprovedBaselineGateForTests?: boolean;
  readonly onProgress?: (event: ImportProgressEvent) => void;
}

export type ImportProgressEvent =
  | { readonly phase: "baseline-admitted"; readonly stage: string }
  | { readonly phase: "source-verified"; readonly bytes: number; readonly sha256: string }
  | { readonly phase: "schema-created"; readonly tables: number }
  | { readonly phase: "table-started"; readonly table: string; readonly index: number; readonly total: number }
  | { readonly phase: "table-rows"; readonly table: string; readonly rows: number }
  | { readonly phase: "table-finished"; readonly table: string; readonly rows: number; readonly durationMs: number }
  | { readonly phase: "indexes-created"; readonly indexes: number; readonly triggers: number }
  | { readonly phase: "transform-finished"; readonly identities: number; readonly auditRows: number }
  | { readonly phase: "finalized" };

export interface ImportSummary {
  readonly startedUtc: string;
  readonly finishedUtc: string;
  readonly importedAtUtc: string;
  readonly durationMs: number;
  readonly tables: readonly CopyTableResult[];
  readonly totalRowsCopied: number;
  readonly expectedRowTotal: number;
  readonly rowTotalMatchesBaseline: boolean;
  readonly indexesCreated: readonly string[];
  readonly triggersCreated: readonly string[];
  readonly sequences: Readonly<Record<string, string>>;
  readonly appLocalSchema: AppLocalSchemaResult;
  readonly transform: IdentityTransformResult;
  readonly targetSchemaIdentity: SchemaIdentity;
  readonly batchRows: number | null;
  readonly loadSynchronous: LoadSynchronous;
  /** Facts measured from the source while admitting it against the baseline. */
  readonly approvedBaseline: BaselineAdmission;
}

export interface ImportRunResult {
  readonly summary: ImportSummary;
  readonly dispositions: readonly DispositionCount[];
  readonly sourceIdentity: SourceFileIdentity;
  readonly sourceVerifiedAfterRun: { bytes: number; sha256: string | null } | null;
  readonly targetPath: string;
  readonly targetBytes: number;
  readonly targetSha256: string;
  readonly sqliteVersion: string;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function sqliteVersionOf(database: SqliteDatabase): string {
  const row = database.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  return row.v;
}

export async function runImport(options: ImportOptions): Promise<ImportRunResult> {
  const startedAt = process.hrtime.bigint();
  const startedUtc = new Date().toISOString();

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 120_000) {
    throw new ImportError("ARGUMENT_INVALID", "--busy-timeout-ms must be a positive integer no greater than 120000");
  }

  const tenantId = assertTenantId(options.tenantId);
  const importedAtMs = options.importedAtMs ?? Date.now();
  if (!Number.isInteger(importedAtMs) || importedAtMs <= 0) {
    throw new ImportError("ARGUMENT_INVALID", "--imported-at-utc must resolve to a positive epoch millisecond value");
  }
  const ownership = options.ownership;
  const loadSynchronous = options.loadSynchronous ?? "off";
  const appLocalSchemaMode: AppLocalSchemaMode = options.appLocalSchema ?? "migrate";

  // ---- Approved-baseline admission control. Nothing is created or written
  // ---- until every supplied input has been admitted.
  const gateEnabled = options.__unsafeSkipApprovedBaselineGateForTests !== true;
  const suppliedOracle = options.oracle ?? null;
  if (gateEnabled) {
    assertManifestMatchesApprovedBaseline(ownership);
    options.onProgress?.({ phase: "baseline-admitted", stage: "manifest" });

    if (suppliedOracle !== null) {
      assertOracleMatchesApprovedBaseline(suppliedOracle, ownership.product);
      options.onProgress?.({ phase: "baseline-admitted", stage: "oracle" });
    }
  }

  const sourceIdentity = await verifySourceFile({
    path: options.sourcePath,
    // Measured against the pinned lineage when the gate is on, so a forged
    // manifest cannot lower the bar it is checked against.
    expectedBytes: gateEnabled ? APPROVED_LINEAGE.backupBytes : ownership.sourceBaseline.backupBytes,
    expectedSha256: gateEnabled ? APPROVED_LINEAGE.backupSha256 : ownership.sourceBaseline.backupSha256
  });
  if (gateEnabled) {
    assertBackupIdentityMatchesApprovedBaseline({
      bytes: sourceIdentity.bytes,
      sha256: sourceIdentity.sha256
    });
    options.onProgress?.({ phase: "baseline-admitted", stage: "backup" });
  }
  options.onProgress?.({
    phase: "source-verified",
    bytes: sourceIdentity.bytes,
    sha256: sourceIdentity.sha256
  });

  const source = openSourceReadonly(sourceIdentity.path, busyTimeoutMs);
  let target: SqliteDatabase | null = null;

  try {
    assertOwnedTablesPresent(source, ownership.ownedTables);
    const baselineFacts = gateEnabled ? assertSourceMatchesApprovedBaseline(source) : null;
    if (gateEnabled) options.onProgress?.({ phase: "baseline-admitted", stage: "source" });
    const sqliteVersion = sqliteVersionOf(source);

    // Only now may a target be created.
    const opened = openEmptyTarget({
      targetPath: options.targetPath,
      sourceRealPath: sourceIdentity.realPath,
      busyTimeoutMs,
      loadSynchronous,
      ownedTables: ownership.ownedTables,
      allowInsideGitWorktree: options.allowInsideGitWorktree
    });
    target = opened.database;

    const schemas = createOwnedTables(source, target, ownership.ownedTables);
    options.onProgress?.({ phase: "schema-created", tables: schemas.size });

    const tables: CopyTableResult[] = [];
    let totalRowsCopied = 0;
    const orderedTables = [...ownership.ownedTables].sort();

    for (const [index, table] of orderedTables.entries()) {
      const schema = schemas.get(table);
      if (!schema) throw new ImportError("SOURCE_SCHEMA_INCOMPLETE", `Missing schema for ${table}`, { table });

      options.onProgress?.({ phase: "table-started", table, index, total: orderedTables.length });
      const result = copyTableRows({
        source,
        target,
        schema,
        batchRows: options.batchRows ?? null,
        onProgress: (name, rows) => options.onProgress?.({ phase: "table-rows", table: name, rows })
      });

      const sourceCount = countRows(source, table);
      const targetCount = countRows(target, table);
      if (sourceCount !== result.rows || targetCount !== result.rows) {
        throw new ImportError("COPY_ROW_COUNT_MISMATCH", `Row count mismatch while copying ${table}`, {
          table,
          copied: result.rows,
          sourceCount,
          targetCount
        });
      }

      tables.push(result);
      totalRowsCopied += result.rows;
      options.onProgress?.({
        phase: "table-finished",
        table,
        rows: result.rows,
        durationMs: result.durationMs
      });
    }

    const schemaObjects = createOwnedIndexesAndTriggers(source, target, ownership.ownedTables);
    options.onProgress?.({
      phase: "indexes-created",
      indexes: schemaObjects.indexes.length,
      triggers: schemaObjects.triggers.length
    });

    const sequences = copySequences(source, target, ownership.ownedTables);

    const appLocal = ensureAppLocalSchema(
      target,
      appLocalSchemaMode,
      options.importedAtMs === undefined ? {} : { appliedAtMs: importedAtMs }
    );
    const ledger = new DispositionLedger(options.allowDispositions ?? []);
    const transform = transformSharedTables({
      source,
      target,
      transform: {
        tenantId,
        adminOids: options.adminOids ?? [],
        importedAtMs,
        ledger
      }
    });
    options.onProgress?.({
      phase: "transform-finished",
      identities: transform.identities,
      auditRows: transform.auditRowsImported
    });

    finalizeTarget(target, busyTimeoutMs);

    const violations = target.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new ImportError("RECONCILE_DIFFERENCES", "Target failed foreign_key_check after load", {
        violations: violations.slice(0, 20)
      });
    }

    const targetSchemaIdentity = computeSchemaIdentity(target, ownership.ownedTables);

    target.close();
    target = null;
    source.close();

    const sourceVerifiedAfterRun = await assertSourceUnchanged(sourceIdentity, {
      rehash: options.verifySourceAfter ?? true
    });

    const targetBytes = statSync(opened.targetPath).size;
    const targetSha256 = await hashFile(opened.targetPath);

    options.onProgress?.({ phase: "finalized" });

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const summary: ImportSummary = {
      startedUtc,
      finishedUtc: new Date().toISOString(),
      importedAtUtc: new Date(importedAtMs).toISOString(),
      durationMs,
      tables: Object.freeze(tables),
      totalRowsCopied,
      expectedRowTotal: ownership.expectedOwnedRowTotal,
      rowTotalMatchesBaseline: totalRowsCopied === ownership.expectedOwnedRowTotal,
      indexesCreated: schemaObjects.indexes,
      triggersCreated: schemaObjects.triggers,
      sequences: Object.freeze(sequences),
      appLocalSchema: appLocal,
      transform,
      targetSchemaIdentity,
      batchRows: options.batchRows ?? null,
      loadSynchronous,
      approvedBaseline: {
        gateEnforced: gateEnabled,
        manifestAdmitted: gateEnabled,
        oracleAdmitted: gateEnabled && suppliedOracle !== null,
        backupAdmitted: gateEnabled,
        sourceAdmitted: gateEnabled && baselineFacts !== null,
        source: baselineFacts
      }
    };

    return {
      summary,
      dispositions: ledger.summary(),
      sourceIdentity,
      sourceVerifiedAfterRun: {
        bytes: sourceVerifiedAfterRun.bytes,
        sha256: sourceVerifiedAfterRun.sha256
      },
      targetPath: opened.targetPath,
      targetBytes,
      targetSha256,
      sqliteVersion
    };
  } finally {
    if (target !== null) {
      try {
        target.close();
      } catch {
        /* already closed */
      }
    }
    if (source.open) source.close();
  }
}
