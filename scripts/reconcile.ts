#!/usr/bin/env node
/**
 * Watchtower import reconciliation.
 *
 * Compares an immutable Hearth backup against an imported target database and
 * writes a versioned JSON evidence manifest. Exits non-zero on any difference.
 *
 * Example:
 *   node scripts/reconcile.ts \
 *     --manifest ./decomposition-manifest.json \
 *     --source ./hearth-production-20260828.sqlite3 \
 *     --target "$ARTIFACTS/watchtower.db" \
 *     --evidence ./evidence/reconcile.json
 */

import { statSync } from "node:fs";
import { hashFile, openSourceReadonly, verifySourceFile } from "../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../lib/db/import/target.js";
import { loadOwnershipContract } from "../lib/db/import/ownership.js";
import { loadOracle } from "../lib/db/import/oracle.js";
import { APPROVED_LINEAGE } from "../lib/db/import/approvedBaseline.js";
import {
  assertBackupIdentityMatchesApprovedBaseline,
  assertManifestMatchesApprovedBaseline,
  assertOracleMatchesApprovedBaseline,
  assertOracleRequiredForProduct,
  assertSourceMatchesApprovedBaseline,
  type BaselineAdmission
} from "../lib/db/import/baselineGate.js";
import { runExternalSourceOracle } from "../lib/db/import/externalOracle.js";
import { reconcile } from "../lib/db/import/reconcile.js";
import { buildEvidenceManifest, writeEvidence } from "../lib/db/import/evidence.js";
import { describeError, ImportError } from "../lib/db/import/errors.js";
import {
  booleanOption,
  numberOrNull,
  optionalString,
  parseArguments,
  renderUsage,
  requireString,
  type OptionSpec
} from "../lib/db/import/cli.js";

const SPECS: readonly OptionSpec[] = [
  { name: "manifest", kind: "string", required: true, description: "Path to decomposition-manifest.json" },
  { name: "source", kind: "string", required: true, description: "Path to the immutable Hearth backup" },
  { name: "target", kind: "string", required: true, description: "Path to the imported target database" },
  { name: "evidence", kind: "string", description: "Write the evidence manifest to this path" },
  {
    name: "oracle",
    kind: "string",
    description: "Pre-generated canonical-hash oracle JSON (hearth.sqlite-canonical-table-hashes.v1)"
  },
  {
    name: "oracle-generator",
    kind: "string",
    description: "Execute this canonical-hash generator against the read-only source as the source oracle"
  },
  {
    name: "oracle-out",
    kind: "string",
    description: "Where the executed generator writes its own evidence (required with --oracle-generator)"
  },
  {
    name: "oracle-generator-cwd",
    kind: "string",
    description: "Working directory for the generator; must resolve better-sqlite3 (default: repo root)"
  },
  {
    name: "oracle-cross-check",
    kind: "boolean",
    defaultValue: true,
    description: "Also recompute the source digests with our own reader as corroboration"
  },
  { name: "busy-timeout-ms", kind: "number", defaultValue: 5000, description: "Bounded SQLite busy timeout" },
  { name: "max-diff-samples", kind: "number", defaultValue: 25, description: "Bounded per-table difference samples" },
  { name: "target-sha256", kind: "boolean", defaultValue: true, description: "Hash the target file for evidence" },
  { name: "quiet", kind: "boolean", description: "Suppress per-table progress output" },
  { name: "help", kind: "boolean", description: "Show usage" }
];

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(renderUsage("scripts/reconcile.ts", SPECS));
    return 0;
  }

  const options = parseArguments(argv, SPECS);
  const quiet = booleanOption(options, "quiet");
  const ownership = loadOwnershipContract(requireString(options, "manifest"));
  const busyTimeoutMs = numberOrNull(options, "busy-timeout-ms") ?? 5000;
  const targetPath = requireString(options, "target");

  // ---- Stage 1: the manifest, against the source-controlled approved baseline.
  // ---- Nothing is opened or measured until this passes.
  assertManifestMatchesApprovedBaseline(ownership);
  if (!quiet) process.stderr.write("baseline: manifest admitted\n");

  const oracleGeneratorPath = optionalString(options, "oracle-generator");
  const oraclePath = optionalString(options, "oracle");

  // ---- Stage 2: an approved oracle is mandatory for Watchtower.
  assertOracleRequiredForProduct(ownership.product, oracleGeneratorPath !== null || oraclePath !== null);

  let oracle = null;
  let oracleExecution = null;
  if (oracleGeneratorPath !== null) {
    const oracleOut = optionalString(options, "oracle-out");
    if (oracleOut === null) {
      throw new ImportError("ARGUMENT_MISSING", "--oracle-out is required with --oracle-generator");
    }
    const executed = await runExternalSourceOracle({
      generatorPath: oracleGeneratorPath,
      sourcePath: requireString(options, "source"),
      ownershipManifestPath: requireString(options, "manifest"),
      outputPath: oracleOut,
      ...(optionalString(options, "oracle-generator-cwd") === null
        ? {}
        : { workingDirectory: optionalString(options, "oracle-generator-cwd") as string }),
      onProgress: (message) => {
        if (!quiet) process.stderr.write(`${message}\n`);
      }
    });
    oracle = executed.document;
    oracleExecution = executed.provenance;
  } else if (oraclePath !== null) {
    oracle = loadOracle(oraclePath);
  }

  // Whenever an oracle exists it is checked against every pinned per-table and
  // aggregate value. There is no operator override for these.
  if (oracle !== null) {
    assertOracleMatchesApprovedBaseline(oracle, ownership.product);
    if (!quiet) process.stderr.write("baseline: oracle admitted\n");
  }

  // ---- Stage 3: the backup file's measured bytes and digest, against the
  // ---- approved lineage rather than anything the manifest claims.
  const sourceIdentity = await verifySourceFile({
    path: requireString(options, "source"),
    expectedBytes: APPROVED_LINEAGE.backupBytes,
    expectedSha256: APPROVED_LINEAGE.backupSha256
  });
  assertBackupIdentityMatchesApprovedBaseline({
    bytes: sourceIdentity.bytes,
    sha256: sourceIdentity.sha256
  });
  if (!quiet) process.stderr.write("baseline: backup admitted\n");

  const source = openSourceReadonly(sourceIdentity.path, busyTimeoutMs);
  const target = openTargetReadonly(targetPath, busyTimeoutMs);

  let result;
  let sqliteVersion: string;
  let admission: BaselineAdmission;
  try {
    // ---- Stage 4: the opened source itself - schema counts, owned schema
    // ---- digest, every owned table's row count and sqlite_sequence.
    const sourceFacts = assertSourceMatchesApprovedBaseline(source);
    if (!quiet) process.stderr.write("baseline: source admitted\n");
    admission = {
      gateEnforced: true,
      manifestAdmitted: true,
      oracleAdmitted: oracle !== null,
      backupAdmitted: true,
      sourceAdmitted: true,
      source: sourceFacts
    };

    sqliteVersion = (source.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    target.pragma("foreign_keys = ON");
    result = reconcile({
      source,
      target,
      tables: ownership.ownedTables,
      expectedRowTotal: ownership.expectedOwnedRowTotal,
      maxDiffSamples: numberOrNull(options, "max-diff-samples") ?? 25,
      oracle,
      oracleProduct: ownership.product,
      crossCheckSource: booleanOption(options, "oracle-cross-check", true),
      onTable: (table, index, total) => {
        if (!quiet) process.stderr.write(`reconcile [${index + 1}/${total}] ${table}\n`);
      },
      onOracleTable: (side, table, index, total) => {
        if (!quiet) process.stderr.write(`oracle ${side} [${index + 1}/${total}] ${table}\n`);
      }
    });
  } finally {
    target.close();
    source.close();
  }

  const targetBytes = statSync(targetPath).size;
  const targetSha256 = booleanOption(options, "target-sha256", true) ? await hashFile(targetPath) : null;

  const evidencePath = optionalString(options, "evidence");
  if (evidencePath !== null) {
    const manifest = buildEvidenceManifest({
      ownership,
      sourceIdentity,
      sourceVerifiedAfterRun: null,
      sqliteVersion,
      target: {
        path: targetPath,
        bytes: targetBytes,
        sha256: targetSha256,
        journalMode: "delete",
        foreignKeys: true,
        busyTimeoutMs
      },
      importSummary: null,
      dispositions: [],
      reconciliation: result,
      oracle,
      oracleExecution,
      approvedBaseline: admission,
      failures: []
    });
    const written = writeEvidence(evidencePath, manifest);
    process.stderr.write(`evidence written to ${written}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: result.ok ? "pass" : "fail",
        tables: result.tables.length,
        sourceRows: result.totals.sourceRows,
        targetRows: result.totals.targetRows,
        expectedRows: result.totals.expectedRows,
        rowsMatchExpected: result.totals.rowsMatchExpected,
        schemaMatched: result.schema.matched,
        sequencesMatched: result.sequences.matched,
        foreignKeysEnforced: result.foreignKeys.enforced,
        foreignKeyViolations: result.foreignKeys.violations.length,
        approvedBaseline: {
          gateEnforced: admission.gateEnforced,
          manifestAdmitted: admission.manifestAdmitted,
          oracleAdmitted: admission.oracleAdmitted,
          backupAdmitted: admission.backupAdmitted,
          sourceAdmitted: admission.sourceAdmitted
        },
        sourceOracle:
          result.oracle === null
            ? null
            : {
                mode: oracleExecution === null ? "supplied" : "executed",
                matched: result.oracle.matched,
                documentPath: result.oracle.oraclePath,
                expectedAggregateSha256: result.oracle.expectedAggregateSha256,
                publishedAggregateSha256: result.oracle.publishedAggregateSha256,
                publishedMatchesExpected: result.oracle.publishedMatchesExpected,
                targetAggregateSha256: result.oracle.target.aggregateSha256,
                targetMatchesPublished: result.oracle.targetMatchesPublished,
                sourceCrossCheckAgrees: result.oracle.sourceCrossCheckAgrees,
                targetTableMismatches: result.oracle.target.differences.length,
                generatorSha256: oracleExecution?.generatorSha256 ?? null,
                generatorOutputPath: oracleExecution?.outputPath ?? null,
                generatorOutputSha256: oracleExecution?.outputSha256 ?? null,
                sourceUnmutated: oracleExecution?.sourceUnmutated ?? null
              },
        differences: result.differences.map((difference) => ({
          table: difference.table,
          kind: difference.kind
        })),
        durationMs: Math.round(result.durationMs)
      },
      null,
      2
    )}\n`
  );

  return result.ok && admission.sourceAdmitted && oracle !== null ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const described = describeError(error);
    process.stderr.write(`${described.code}: ${described.message}\n`);
    process.exitCode = 1;
  });
