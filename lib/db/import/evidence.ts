/**
 * Versioned JSON evidence manifest for import + reconciliation runs.
 *
 * The manifest is the durable artefact reviewers read. It always carries the
 * immutable source identity, the reviewed ownership boundary, the expected owned
 * row total, every per-table fingerprint and every difference found.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ImportError } from "./errors.js";
import { stableJsonDigest, stableStringify } from "./canonical.js";
import type { OwnershipContract } from "./ownership.js";
import type { SourceFileIdentity } from "./sourceIdentity.js";
import type { ReconciliationResult } from "./reconcile.js";
import type { DispositionCount } from "./dispositions.js";
import { WATCHTOWER_ORACLE_AGGREGATE_SHA256, type OracleDocument } from "./oracle.js";
import type { ExternalOracleProvenance } from "./externalOracle.js";
import { isFullyAdmitted, UNADMITTED, type BaselineAdmission } from "./baselineGate.js";
import type { ImportSummary } from "./importer.js";

export const EVIDENCE_CONTRACT = "watchtower.import-reconciliation";
export const EVIDENCE_CONTRACT_VERSION = 1;

export interface EvidenceManifest {
  readonly contract: string;
  readonly contractVersion: number;
  readonly generatedUtc: string;
  readonly product: string;
  readonly outcome: "pass" | "fail";
  readonly runner: {
    readonly node: string;
    readonly platform: string;
    readonly sqliteVersion: string;
  };
  readonly source: {
    readonly repository: string;
    readonly version: string;
    readonly build: number;
    readonly commit: string;
    readonly tree: string;
    readonly imageDigest: string;
    readonly backupCreatedUtc: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly verifiedAfterRun: { readonly bytes: number; readonly sha256: string | null } | null;
  };
  readonly ownership: {
    readonly manifestPath: string;
    readonly manifestVersion: number;
    readonly ownedTableCount: number;
    readonly ownedTables: readonly string[];
    readonly ownedViewIds: readonly string[];
    readonly ownedApiPathPrefixes: readonly string[];
    readonly expectedOwnedRowTotal: number;
    readonly neverCopiedSharedTables: readonly string[];
  };
  readonly target: {
    readonly path: string;
    readonly bytes: number | null;
    readonly sha256: string | null;
    readonly journalMode: string;
    readonly foreignKeys: boolean;
    readonly busyTimeoutMs: number;
  } | null;
  /**
   * Approved-baseline admission for this run. Always present, including for
   * reconcile-only artefacts, so an ungated run cannot look like a gated one.
   */
  readonly approvedBaseline: BaselineAdmission;
  readonly import: ImportSummary | null;
  readonly dispositions: readonly DispositionCount[];
  readonly reconciliation: ReconciliationResult | null;
  /**
   * Independent canonical-hash oracle used to corroborate the run, if any.
   *
   * `mode` records whether the document was produced here by executing the
   * coordinator's generator against the read-only source (`executed`) or was
   * supplied pre-generated (`supplied`). When executed, `execution` preserves
   * the generator's identity, arguments and its own output file — that file is
   * retained as separate evidence and is never rewritten by this repository.
   */
  readonly sourceOracle: {
    readonly mode: "executed" | "supplied";
    readonly contract: string;
    readonly documentPath: string;
    readonly databaseBytes: number;
    readonly product: string;
    readonly expectedAggregateSha256: string;
    readonly publishedAggregateSha256: string | null;
    readonly publishedTableCount: number | null;
    readonly publishedRowCount: number | null;
    readonly publishedMatchesExpected: boolean;
    readonly targetMatchesPublished: boolean | null;
    readonly sourceCrossCheckAgrees: boolean | null;
    readonly matched: boolean;
    readonly execution: ExternalOracleProvenance | null;
  } | null;
  readonly failures: readonly { readonly code: string; readonly message: string }[];
  readonly evidenceDigest: string;
}

export interface BuildEvidenceInput {
  readonly ownership: OwnershipContract;
  readonly sourceIdentity: SourceFileIdentity;
  readonly sourceVerifiedAfterRun: { bytes: number; sha256: string | null } | null;
  readonly sqliteVersion: string;
  readonly target: EvidenceManifest["target"];
  readonly importSummary: ImportSummary | null;
  readonly dispositions: readonly DispositionCount[];
  readonly reconciliation: ReconciliationResult | null;
  readonly oracle?: OracleDocument | null;
  /** Provenance when the oracle document was produced by running the generator. */
  readonly oracleExecution?: ExternalOracleProvenance | null;
  /** Admission record from the gate. Omitted means "not admitted". */
  readonly approvedBaseline?: BaselineAdmission | null;
  readonly failures: readonly { code: string; message: string }[];
  readonly generatedUtc?: string;
}

function summariseOracle(
  oracle: OracleDocument | null | undefined,
  execution: ExternalOracleProvenance | null | undefined,
  reconciliation: ReconciliationResult | null,
  product: string
): EvidenceManifest["sourceOracle"] {
  if (!oracle) return null;
  const published = oracle.products.get(product) ?? null;
  const fromReconciliation = reconciliation?.oracle ?? null;
  return {
    mode: execution ? "executed" : "supplied",
    contract: oracle.contract,
    documentPath: oracle.path,
    databaseBytes: oracle.databaseBytes,
    product,
    expectedAggregateSha256:
      fromReconciliation?.expectedAggregateSha256 ??
      published?.canonicalSha256 ??
      WATCHTOWER_ORACLE_AGGREGATE_SHA256,
    publishedAggregateSha256: published?.canonicalSha256 ?? null,
    publishedTableCount: published?.tableCount ?? null,
    publishedRowCount: published?.rowCount ?? null,
    publishedMatchesExpected: fromReconciliation?.publishedMatchesExpected ?? false,
    targetMatchesPublished: fromReconciliation?.targetMatchesPublished ?? null,
    sourceCrossCheckAgrees: fromReconciliation?.sourceCrossCheckAgrees ?? null,
    matched: fromReconciliation?.matched ?? false,
    execution: execution ?? null
  };
}

export function buildEvidenceManifest(input: BuildEvidenceInput): EvidenceManifest {
  const baseline = input.ownership.sourceBaseline;
  const reconciliation = input.reconciliation;
  const sourceOracle = summariseOracle(
    input.oracle,
    input.oracleExecution,
    reconciliation,
    input.ownership.product
  );

  const approvedBaseline = input.approvedBaseline ?? UNADMITTED;

  // A run is only a pass when the approved-baseline gate ran and admitted every
  // stage, reconciliation ran and passed, and the independent oracle corroborated
  // it. Any missing piece is a fail, so a reconcile-only artefact cannot be green
  // without having been fully gated.
  const outcome: "pass" | "fail" =
    input.failures.length === 0 &&
    isFullyAdmitted(approvedBaseline) &&
    reconciliation !== null &&
    reconciliation.ok &&
    sourceOracle !== null &&
    sourceOracle.matched
      ? "pass"
      : "fail";

  const body = {
    contract: EVIDENCE_CONTRACT,
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    generatedUtc: input.generatedUtc ?? new Date().toISOString(),
    product: input.ownership.product,
    outcome,
    runner: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      sqliteVersion: input.sqliteVersion
    },
    source: {
      repository: baseline.repository,
      version: baseline.version,
      build: baseline.build,
      commit: baseline.commit,
      tree: baseline.tree,
      imageDigest: baseline.imageDigest,
      backupCreatedUtc: baseline.backupCreatedUtc,
      path: input.sourceIdentity.path,
      bytes: input.sourceIdentity.bytes,
      sha256: input.sourceIdentity.sha256,
      verifiedAfterRun: input.sourceVerifiedAfterRun
    },
    ownership: {
      manifestPath: input.ownership.manifestPath,
      manifestVersion: input.ownership.manifestVersion,
      ownedTableCount: input.ownership.ownedTables.length,
      ownedTables: [...input.ownership.ownedTables].sort(),
      ownedViewIds: [...input.ownership.ownedViewIds],
      ownedApiPathPrefixes: [...input.ownership.ownedApiPathPrefixes],
      expectedOwnedRowTotal: input.ownership.expectedOwnedRowTotal,
      neverCopiedSharedTables: Object.keys(input.ownership.sharedTableDispositions).sort()
    },
    target: input.target,
    approvedBaseline,
    import: input.importSummary,
    dispositions: [...input.dispositions],
    reconciliation,
    sourceOracle,
    failures: [...input.failures]
  };

  return Object.freeze({ ...body, evidenceDigest: stableJsonDigest(body) });
}

/** Serialises the manifest deterministically (sorted keys, trailing newline). */
export function serializeEvidence(manifest: EvidenceManifest): string {
  return `${JSON.stringify(JSON.parse(stableStringify(manifest)), null, 2)}\n`;
}

export function writeEvidence(path: string, manifest: EvidenceManifest): string {
  const target = resolve(path);
  try {
    writeFileSync(target, serializeEvidence(manifest), { encoding: "utf8", mode: 0o640 });
  } catch (cause) {
    throw new ImportError("EVIDENCE_INVALID", `Cannot write evidence manifest to ${target}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
  return target;
}
