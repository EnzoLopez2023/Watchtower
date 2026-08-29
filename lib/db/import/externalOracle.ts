/**
 * Executable source-side oracle.
 *
 * The coordinator ships `hash-sqlite-tables.mjs`, a standalone program that
 * hashes every table of a SQLite file. This module *runs that program* against
 * the immutable source and preserves its output verbatim as separate evidence.
 *
 * That distinction matters. `oracle.ts` re-derives the same digests inside this
 * repository, which is useful corroboration but is still our code. Executing the
 * coordinator's program makes the source-side digests genuinely foreign: they
 * are produced by a binary we did not write, from a file we opened read-only,
 * and its output file is retained rather than being folded into ours.
 *
 * The division of labour is therefore:
 *
 *   - source side  -> the coordinator's executable is the authority
 *   - target side  -> our mapping-aware reconciliation, because the imported
 *                     database has a *different* schema (54 owned tables plus
 *                     app-local identity/authorization/audit tables, and none of
 *                     the shared Hearth tables). A whole-file hasher cannot
 *                     express that mapping; `reconcile.ts` can.
 *
 * Nothing here mutates the source: the generator is invoked with a read-only
 * database argument, and this module verifies the source's size and SHA-256
 * before and after the run.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { ImportError } from "./errors.js";
import { hashFile } from "./sourceIdentity.js";
import { loadOracle, type OracleDocument } from "./oracle.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDERR_BYTES = 1024 * 1024;
const STDERR_TAIL_LINES = 20;

export interface ExternalOracleProvenance {
  readonly generatorPath: string;
  readonly generatorSha256: string;
  readonly generatorBytes: number;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderrTail: readonly string[];
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly sourcePath: string;
  readonly sourceBytesBefore: number;
  readonly sourceBytesAfter: number;
  readonly sourceSha256Before: string;
  readonly sourceSha256After: string | null;
  readonly sourceUnmutated: boolean;
}

export interface ExternalOracleRun {
  readonly provenance: ExternalOracleProvenance;
  readonly document: OracleDocument;
}

function tailLines(text: string, lines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-lines);
}

/**
 * Executes the coordinator's canonical-hash generator against a read-only
 * source and loads the document it produced.
 *
 * `workingDirectory` must be a directory from which the generator can resolve
 * `better-sqlite3` — it calls `createRequire(resolve(process.cwd(), 'package.json'))`.
 * It defaults to this repository's root.
 */
export async function runExternalSourceOracle(options: {
  readonly generatorPath: string;
  readonly sourcePath: string;
  readonly ownershipManifestPath: string;
  readonly outputPath: string;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  /** Re-hash the source after the run to prove the generator did not write. */
  readonly verifySourceAfter?: boolean;
  readonly onProgress?: (message: string) => void;
}): Promise<ExternalOracleRun> {
  const generatorPath = resolve(options.generatorPath);
  const sourcePath = resolve(options.sourcePath);
  const ownershipManifestPath = resolve(options.ownershipManifestPath);
  const outputPath = resolve(options.outputPath);

  let generatorStats;
  try {
    generatorStats = statSync(generatorPath);
  } catch (cause) {
    throw new ImportError("ORACLE_GENERATOR_MISSING", `Oracle generator not found at ${generatorPath}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
  if (!generatorStats.isFile()) {
    throw new ImportError("ORACLE_GENERATOR_MISSING", `Oracle generator is not a regular file: ${generatorPath}`);
  }

  if (resolve(outputPath) === sourcePath || resolve(outputPath) === generatorPath) {
    throw new ImportError("ARGUMENT_INVALID", "Oracle output path must not overwrite the source or the generator");
  }

  const generatorSha256 = createHash("sha256")
    .update(await readFile(generatorPath))
    .digest("hex");

  const sourceStatsBefore = statSync(sourcePath);
  const sourceSha256Before = await hashFile(sourcePath);

  const workingDirectory = resolve(options.workingDirectory ?? dirname(dirname(dirname(import.meta.dirname))));
  const args = [generatorPath, sourcePath, ownershipManifestPath, outputPath];

  options.onProgress?.(`executing source oracle: ${generatorPath}`);
  const startedAt = process.hrtime.bigint();

  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: workingDirectory,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_STDERR_BYTES,
      windowsHide: true
    });
    stderr = result.stderr;
  } catch (cause) {
    const failure = cause as { code?: number | string; stderr?: string; killed?: boolean; message?: string };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    throw new ImportError("ORACLE_GENERATOR_FAILED", `Oracle generator exited with status ${exitCode}`, {
      generatorPath,
      exitCode,
      killed: failure.killed === true,
      stderrTail: tailLines(String(failure.stderr ?? failure.message ?? ""), STDERR_TAIL_LINES)
    });
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const sourceStatsAfter = statSync(sourcePath);
  let sourceSha256After: string | null = null;
  if (options.verifySourceAfter !== false) {
    sourceSha256After = await hashFile(sourcePath);
  }
  const sourceUnmutated =
    sourceStatsAfter.size === sourceStatsBefore.size &&
    (sourceSha256After === null || sourceSha256After === sourceSha256Before);
  if (!sourceUnmutated) {
    throw new ImportError("SOURCE_MUTATED", "Source database changed while the oracle generator ran", {
      bytesBefore: sourceStatsBefore.size,
      bytesAfter: sourceStatsAfter.size,
      sha256Before: sourceSha256Before,
      sha256After: sourceSha256After
    });
  }

  let outputStats;
  try {
    outputStats = statSync(outputPath);
  } catch (cause) {
    throw new ImportError("ORACLE_GENERATOR_FAILED", `Oracle generator produced no output at ${outputPath}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
  const outputSha256 = await hashFile(outputPath);

  // Parsed with the same validator used for a supplied document, so a generator
  // that emits a different contract fails closed.
  const document = loadOracle(outputPath);

  options.onProgress?.(
    `source oracle finished in ${(durationMs / 1000).toFixed(1)}s -> ${outputPath}`
  );

  return {
    provenance: {
      generatorPath,
      generatorSha256,
      generatorBytes: generatorStats.size,
      nodeExecutable: process.execPath,
      nodeVersion: process.version,
      workingDirectory,
      arguments: Object.freeze(args),
      exitCode,
      durationMs,
      stderrTail: Object.freeze(tailLines(stderr, STDERR_TAIL_LINES)),
      outputPath,
      outputBytes: outputStats.size,
      outputSha256,
      sourcePath,
      sourceBytesBefore: sourceStatsBefore.size,
      sourceBytesAfter: sourceStatsAfter.size,
      sourceSha256Before,
      sourceSha256After,
      sourceUnmutated
    },
    document
  };
}
