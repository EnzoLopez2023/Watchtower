#!/usr/bin/env node
/**
 * Watchtower recovery commands.
 *
 *   backup   --database <path> --backup-root <dir> [--app-version v --build-id b --source-commit sha]
 *   verify   --bundle <dir>
 *   upload   --bundle <dir> --account <name> --container <name> [--prefix p]
 *   restore  --bundle <dir> --destination <path> --allowed-root <dir> [--protected-path <path>…]
 *
 * Every command is explicit. Nothing here is invoked from startup or a request
 * path, and the live database is never byte-copied — `backup` uses SQLite's
 * online backup API.
 */

import { createBackup, verifyBackup } from "../lib/recovery/backup.js";
import { restoreBundle, uploadBundleWithReadback } from "../lib/recovery/offhost.js";
import { runRecoveryDrill, writeDrillEvidence } from "../lib/recovery/drill.js";
import { assertManagedIdentityOnlyEnvironment } from "../lib/recovery/managedIdentityBlob.js";
import { describeRecoveryError, RecoveryError } from "../lib/recovery/errors.js";
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

const COMMANDS = ["backup", "verify", "upload", "restore", "drill"] as const;
type Command = (typeof COMMANDS)[number];

const COMMON: readonly OptionSpec[] = [
  { name: "busy-timeout-ms", kind: "number", defaultValue: 5000, description: "Bounded SQLite busy timeout" },
  { name: "allow-inside-git", kind: "boolean", description: "Permit writes inside a Git worktree (tests only)" },
  { name: "help", kind: "boolean", description: "Show usage" }
];

const SPECS: Readonly<Record<Command, readonly OptionSpec[]>> = {
  backup: [
    { name: "database", kind: "string", required: true, description: "Path to the SQLite authority" },
    { name: "backup-root", kind: "string", required: true, description: "Directory that receives the bundle" },
    { name: "app-version", kind: "string", description: "Application version recorded in the manifest" },
    { name: "build-id", kind: "string", description: "Build id recorded in the manifest" },
    { name: "source-commit", kind: "string", description: "Source commit recorded in the manifest" },
    ...COMMON
  ],
  verify: [{ name: "bundle", kind: "string", required: true, description: "Bundle directory" }, ...COMMON],
  upload: [
    { name: "bundle", kind: "string", required: true, description: "Bundle directory" },
    { name: "account", kind: "string", required: true, description: "Azure Storage account name" },
    { name: "container", kind: "string", required: true, description: "Azure Blob container name" },
    { name: "prefix", kind: "string", description: "Blob name prefix" },
    { name: "request-timeout-ms", kind: "number", description: "Per-request timeout" },
    ...COMMON
  ],
  drill: [
    { name: "database", kind: "string", required: true, description: "Path to the SQLite authority to drill" },
    { name: "backup-root", kind: "string", required: true, description: "Directory that receives the bundle" },
    { name: "restore-root", kind: "string", required: true, description: "Root the disposable restore lands under" },
    { name: "evidence", kind: "string", description: "Write the drill evidence artefact to this path" },
    { name: "app-version", kind: "string", description: "Application version recorded in the manifest" },
    { name: "build-id", kind: "string", description: "Build id recorded in the manifest" },
    { name: "source-commit", kind: "string", description: "Source commit recorded in the manifest" },
    {
      name: "keep-artifacts",
      kind: "boolean",
      description: "Keep the snapshot bundle and restored copy (they are removed by default)"
    },
    ...COMMON
  ],
  restore: [
    { name: "bundle", kind: "string", required: true, description: "Bundle directory" },
    { name: "destination", kind: "string", required: true, description: "Disposable destination file" },
    { name: "allowed-root", kind: "string", required: true, description: "Root the destination must live under" },
    { name: "protected-path", kind: "string-list", description: "Path that must never be written (repeatable)" },
    ...COMMON
  ]
};

function usage(): string {
  return [
    "Usage: node scripts/recovery.ts <command> [options]",
    "",
    `Commands: ${COMMANDS.join(", ")}`,
    "",
    ...COMMANDS.map((command) => renderUsage(`scripts/recovery.ts ${command}`, SPECS[command])),
    ""
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] as Command | undefined;
  if (command === undefined || argv.includes("--help") || !COMMANDS.includes(command)) {
    process.stdout.write(usage());
    return command === undefined || argv.includes("--help") ? 0 : 1;
  }

  const options = parseArguments(argv.slice(1), SPECS[command]);
  const busyTimeoutMs = numberOrNull(options, "busy-timeout-ms") ?? 5000;
  const allowInsideGitWorktree = booleanOption(options, "allow-inside-git");

  if (command === "backup") {
    const result = await createBackup({
      sourcePath: requireString(options, "database"),
      backupRoot: requireString(options, "backup-root"),
      appVersion: optionalString(options, "app-version"),
      buildId: optionalString(options, "build-id"),
      sourceCommit: optionalString(options, "source-commit"),
      busyTimeoutMs,
      allowInsideGitWorktree
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: "ok",
          bundleDir: result.bundleDir,
          bundleId: result.manifest.bundleId,
          bytes: result.manifest.database.bytes,
          sha256: result.manifest.database.sha256,
          schemaSha256: result.manifest.database.identity.schemaSha256,
          tables: result.manifest.database.tables.length,
          checks: {
            quickCheck: result.manifest.database.checks.quickCheck.ok,
            integrityCheck: result.manifest.database.checks.integrityCheck.ok,
            foreignKeyCheck: result.manifest.database.checks.foreignKeyCheck.ok
          },
          durationMs: Math.round(result.durationMs)
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (command === "verify") {
    const result = await verifyBackup({ bundleDir: requireString(options, "bundle"), busyTimeoutMs });
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: "ok",
          bundleDir: result.bundleDir,
          bytes: result.bytes,
          sha256: result.sha256,
          identityMatches: result.identityMatches,
          tableCountsMatch: result.tableCountsMatch,
          checks: {
            quickCheck: result.checks.quickCheck.ok,
            integrityCheck: result.checks.integrityCheck.ok,
            foreignKeyCheck: result.checks.foreignKeyCheck.ok
          }
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (command === "upload") {
    assertManagedIdentityOnlyEnvironment();
    const result = await uploadBundleWithReadback({
      bundleDir: requireString(options, "bundle"),
      account: requireString(options, "account"),
      container: requireString(options, "container"),
      prefix: optionalString(options, "prefix") ?? undefined,
      requestTimeoutMs: numberOrNull(options, "request-timeout-ms") ?? undefined
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: "ok",
          bundleId: result.bundleId,
          snapshotUrl: result.snapshot.upload.url,
          snapshotBytes: result.snapshot.upload.bytes,
          snapshotSha256: result.snapshot.upload.sha256,
          readbackVerified: result.verified
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (command === "drill") {
    const drill = await runRecoveryDrill({
      databasePath: requireString(options, "database"),
      backupRoot: requireString(options, "backup-root"),
      restoreRoot: requireString(options, "restore-root"),
      appVersion: optionalString(options, "app-version"),
      buildId: optionalString(options, "build-id"),
      sourceCommit: optionalString(options, "source-commit"),
      busyTimeoutMs,
      allowInsideGitWorktree,
      removeArtifacts: !booleanOption(options, "keep-artifacts"),
      onProgress: (message) => process.stderr.write(`${message}\n`)
    });

    const evidencePath = optionalString(options, "evidence");
    if (evidencePath !== null) {
      const written = writeDrillEvidence(evidencePath, drill.evidence);
      process.stderr.write(`drill evidence written to ${written}\n`);
    }

    const evidence = drill.evidence;
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: evidence.ok ? "ok" : "fail",
          bundleId: evidence.bundle.id,
          snapshotBytes: evidence.bundle.snapshotBytes,
          snapshotSha256: evidence.bundle.snapshotSha256,
          schemaSha256: evidence.bundle.schemaSha256,
          schemaObjectCounts: evidence.bundle.schemaObjectCounts,
          migrations: (evidence.bundle.migrations ?? []).map(
            (migration) => `${migration.version}:${migration.name}`
          ),
          tableCount: evidence.bundle.tableCount,
          totalRows: evidence.bundle.totalRows,
          digestsAgree: evidence.digestsAgree,
          checks: {
            quickCheck: evidence.bundle.checks.quickCheck.ok,
            integrityCheck: evidence.bundle.checks.integrityCheck.ok,
            foreignKeyCheck: evidence.bundle.checks.foreignKeyCheck.ok
          },
          timings: evidence.timings.map((timing) => `${timing.step}=${Math.round(timing.durationMs)}ms`),
          totalDurationMs: Math.round(evidence.totalDurationMs),
          artifactsRemoved: evidence.artifactsRemoved,
          offhostContacted: evidence.offhostContacted
        },
        null,
        2
      )}\n`
    );
    return evidence.ok ? 0 : 1;
  }

  const result = await restoreBundle({
    bundleDir: requireString(options, "bundle"),
    destination: requireString(options, "destination"),
    allowedRoot: requireString(options, "allowed-root"),
    protectedPaths: stringList(options, "protected-path"),
    busyTimeoutMs,
    allowInsideGitWorktree
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        outcome: "ok",
        destination: result.destination,
        bytes: result.bytes,
        sha256: result.sha256,
        identityMatches: result.identityMatches,
        tableCountsMatch: result.tableCountsMatch,
        checks: {
          quickCheck: result.checks.quickCheck.ok,
          integrityCheck: result.checks.integrityCheck.ok,
          foreignKeyCheck: result.checks.foreignKeyCheck.ok
        },
        durationMs: Math.round(result.durationMs)
      },
      null,
      2
    )}\n`
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const described = describeRecoveryError(error);
    process.stderr.write(`${described.code}: ${described.message}\n`);
    if (error instanceof RecoveryError && Object.keys(error.details).length > 0) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
    process.exitCode = 1;
  });
