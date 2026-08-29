#!/usr/bin/env node
/**
 * Watchtower legacy import.
 *
 * Reads a supplied immutable Hearth backup read-only and materialises the 54
 * Watchtower-owned tables plus app-local identity/authorization/audit state into
 * an empty target database.
 *
 * The target is a multi-gigabyte throwaway artefact: point `--target` at an
 * artifact/scratch directory outside the repository. The importer refuses any
 * target inside a Git working tree. Optionally runs reconciliation in the same process
 * and writes the versioned evidence manifest.
 *
 * Example:
 *   node scripts/legacy-import.ts \
 *     --manifest ./decomposition-manifest.json \
 *     --source ./hearth-production-20260828.sqlite3 \
 *     --target "$ARTIFACTS/watchtower.db" \
 *     --tenant-id 00000000-0000-0000-0000-000000000000 \
 *     --evidence ./evidence/import.json
 *
 * Exits non-zero on any failure, any unapproved disposition, or (when
 * `--reconcile` is on) any reconciliation difference.
 */

import { openSourceReadonly } from "../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../lib/db/import/target.js";
import { loadOwnershipContract } from "../lib/db/import/ownership.js";
import { loadOracle } from "../lib/db/import/oracle.js";
import { assertOracleRequiredForProduct } from "../lib/db/import/baselineGate.js";
import { runExternalSourceOracle } from "../lib/db/import/externalOracle.js";
import { runImport, type ImportProgressEvent } from "../lib/db/import/importer.js";
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
  stringList,
  type OptionSpec
} from "../lib/db/import/cli.js";

const SPECS: readonly OptionSpec[] = [
  { name: "manifest", kind: "string", required: true, description: "Path to decomposition-manifest.json" },
  { name: "source", kind: "string", required: true, description: "Path to the immutable Hearth backup" },
  { name: "target", kind: "string", required: true, description: "Path to the empty target database" },
  { name: "tenant-id", kind: "string", required: true, description: "Entra tenant GUID for app-local identities" },
  { name: "admin-oid", kind: "string-list", description: "Grant the admin role to this OID (repeatable)" },
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
  { name: "allow-disposition", kind: "string-list", description: "Acknowledge an unapproved disposition code" },
  { name: "busy-timeout-ms", kind: "number", defaultValue: 5000, description: "Bounded SQLite busy timeout" },
  { name: "batch-rows", kind: "number", description: "Rows per INSERT batch (auto-sized when omitted)" },
  {
    name: "load-synchronous",
    kind: "string",
    choices: ["off", "normal", "full"],
    defaultValue: "off",
    description: "synchronous pragma during load; always restored to FULL"
  },
  {
    name: "app-local-schema",
    kind: "string",
    choices: ["migrate", "require"],
    defaultValue: "migrate",
    description: "Run the app's core migrations on the target, or require them to be applied already"
  },
  { name: "reconcile", kind: "boolean", defaultValue: true, description: "Reconcile source and target after loading" },
  {
    name: "imported-at-utc",
    kind: "string",
    description: "ISO 8601 UTC instant stamped on derived app-local rows; pin it for a byte-reproducible run"
  },
  { name: "verify-source-after", kind: "boolean", defaultValue: true, description: "Re-hash the source after the run" },
  {
    name: "allow-target-in-git",
    kind: "boolean",
    description: "Permit a target inside a Git worktree (tests only)"
  },
  { name: "quiet", kind: "boolean", description: "Suppress per-table progress output" },
  { name: "help", kind: "boolean", description: "Show usage" }
];

function progressReporter(quiet: boolean): (event: ImportProgressEvent) => void {
  let lastLoggedRows = 0;
  return (event) => {
    if (quiet) return;
    switch (event.phase) {
      case "source-verified":
        process.stderr.write(`source verified: ${event.bytes} bytes, sha256 ${event.sha256}\n`);
        break;
      case "schema-created":
        process.stderr.write(`created ${event.tables} owned tables\n`);
        break;
      case "table-started":
        lastLoggedRows = 0;
        process.stderr.write(`[${event.index + 1}/${event.total}] ${event.table} …\n`);
        break;
      case "table-rows":
        if (event.rows - lastLoggedRows >= 250_000) {
          lastLoggedRows = event.rows;
          process.stderr.write(`    ${event.table}: ${event.rows} rows\n`);
        }
        break;
      case "table-finished":
        if (event.rows > 0) {
          process.stderr.write(`    ${event.table}: ${event.rows} rows in ${event.durationMs.toFixed(0)} ms\n`);
        }
        break;
      case "indexes-created":
        process.stderr.write(`created ${event.indexes} indexes and ${event.triggers} triggers\n`);
        break;
      case "transform-finished":
        process.stderr.write(
          `transformed ${event.identities} identities and ${event.auditRows} owned audit rows\n`
        );
        break;
      case "finalized":
        process.stderr.write("target finalized (journal DELETE, foreign_keys ON, synchronous FULL)\n");
        break;
    }
  };
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(renderUsage("scripts/legacy-import.ts", SPECS));
    return 0;
  }

  const options = parseArguments(argv, SPECS);
  const quiet = booleanOption(options, "quiet");
  const ownership = loadOwnershipContract(requireString(options, "manifest"));
  const busyTimeoutMs = numberOrNull(options, "busy-timeout-ms") ?? 5000;

  const oracleGeneratorPath = optionalString(options, "oracle-generator");
  const oraclePath = optionalString(options, "oracle");

  // An approved oracle is mandatory for Watchtower; refuse before any file work.
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

  const importedAtIso = optionalString(options, "imported-at-utc");
  let importedAtMs: number | undefined;
  if (importedAtIso !== null) {
    importedAtMs = Date.parse(importedAtIso);
    if (!Number.isFinite(importedAtMs)) {
      throw new ImportError("ARGUMENT_INVALID", "--imported-at-utc must be an ISO 8601 instant");
    }
  }

  const result = await runImport({
    ownership,
    sourcePath: requireString(options, "source"),
    targetPath: requireString(options, "target"),
    tenantId: requireString(options, "tenant-id"),
    adminOids: stringList(options, "admin-oid"),
    busyTimeoutMs,
    batchRows: numberOrNull(options, "batch-rows"),
    loadSynchronous: (optionalString(options, "load-synchronous") ?? "off") as "off" | "normal" | "full",
    appLocalSchema: (optionalString(options, "app-local-schema") ?? "migrate") as "migrate" | "require",
    allowDispositions: stringList(options, "allow-disposition"),
    allowInsideGitWorktree: booleanOption(options, "allow-target-in-git"),
    verifySourceAfter: booleanOption(options, "verify-source-after", true),
    importedAtMs,
    oracle,
    onProgress: progressReporter(quiet)
  });

  let reconciliation = null;
  if (booleanOption(options, "reconcile", true)) {
    const source = openSourceReadonly(result.sourceIdentity.path, busyTimeoutMs);
    const target = openTargetReadonly(result.targetPath, busyTimeoutMs);
    try {
      target.pragma("foreign_keys = ON");
      reconciliation = reconcile({
        source,
        target,
        tables: ownership.ownedTables,
        expectedRowTotal: ownership.expectedOwnedRowTotal,
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
  }

  const evidencePath = optionalString(options, "evidence");
  if (evidencePath !== null) {
    const manifest = buildEvidenceManifest({
      ownership,
      sourceIdentity: result.sourceIdentity,
      sourceVerifiedAfterRun: result.sourceVerifiedAfterRun,
      sqliteVersion: result.sqliteVersion,
      target: {
        path: result.targetPath,
        bytes: result.targetBytes,
        sha256: result.targetSha256,
        journalMode: "delete",
        foreignKeys: true,
        busyTimeoutMs
      },
      importSummary: result.summary,
      dispositions: result.dispositions,
      reconciliation,
      oracle,
      oracleExecution,
      approvedBaseline: result.summary.approvedBaseline,
      failures: []
    });
    const written = writeEvidence(evidencePath, manifest);
    process.stderr.write(`evidence written to ${written}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: reconciliation === null ? "imported" : reconciliation.ok ? "pass" : "fail",
        targetPath: result.targetPath,
        targetBytes: result.targetBytes,
        targetSha256: result.targetSha256,
        tablesImported: result.summary.tables.length,
        totalRowsCopied: result.summary.totalRowsCopied,
        expectedRowTotal: result.summary.expectedRowTotal,
        rowTotalMatchesBaseline: result.summary.rowTotalMatchesBaseline,
        approvedBaseline: {
          gateEnforced: result.summary.approvedBaseline.gateEnforced,
          manifestAdmitted: result.summary.approvedBaseline.manifestAdmitted,
          oracleAdmitted: result.summary.approvedBaseline.oracleAdmitted,
          backupAdmitted: result.summary.approvedBaseline.backupAdmitted,
          sourceAdmitted: result.summary.approvedBaseline.sourceAdmitted
        },
        appLocalSchemaMode: result.summary.appLocalSchema.mode,
        coreMigrations: result.summary.appLocalSchema.migrations.map(
          (migration) => `${migration.version}:${migration.name}`
        ),
        identities: result.summary.transform.identities,
        featurePermissions: result.summary.transform.featurePermissions,
        auditRowsImported: result.summary.transform.auditRowsImported,
        durationMs: Math.round(result.summary.durationMs),
        reconciliation:
          reconciliation === null
            ? null
            : {
                ok: reconciliation.ok,
                differences: reconciliation.differences.length,
                oracleMatched: reconciliation.oracle?.matched ?? null,
                oracleMode: oracleExecution === null ? "supplied" : "executed",
                oracleAggregateSha256: reconciliation.oracle?.target.aggregateSha256 ?? null
              }
      },
      null,
      2
    )}\n`
  );

  if (!result.summary.rowTotalMatchesBaseline) return 1;
  if (reconciliation !== null && !reconciliation.ok) return 1;
  return 0;
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
