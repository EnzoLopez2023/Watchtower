import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runImport } from "../../lib/db/import/importer.js";
import { reconcile } from "../../lib/db/import/reconcile.js";
import { openSourceReadonly } from "../../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../../lib/db/import/target.js";
import {
  EVIDENCE_CONTRACT,
  EVIDENCE_CONTRACT_VERSION,
  buildEvidenceManifest,
  serializeEvidence,
  writeEvidence
} from "../../lib/db/import/evidence.js";
import { ORACLE_CONTRACT, loadOracle } from "../../lib/db/import/oracle.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OWNED_TABLES,
  FIXTURE_TENANT_ID,
  makeScratchDir,
  removeScratchDir,
  writeFixtureOracle,
  type FixtureSource
} from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

async function run(prefix: string): Promise<{
  manifestInput: Parameters<typeof buildEvidenceManifest>[0];
  targetPath: string;
  directory: string;
  source: FixtureSource;
}> {
  const directory = scratch(prefix);
  const source = buildSourceFixture(directory);
  const ownership = fixtureOwnership(source, join(directory, "manifest.json"));
  const result = await runImport({
    ownership,
    sourcePath: source.path,
    targetPath: join(directory, "target.sqlite3"),
    tenantId: FIXTURE_TENANT_ID,
    allowInsideGitWorktree: true,
    importedAtMs: 1_700_000_999_000,
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });

  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(result.targetPath, 5000);
  let reconciliation;
  try {
    targetDb.pragma("foreign_keys = ON");
    reconciliation = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal
    });
  } finally {
    targetDb.close();
    sourceDb.close();
  }

  return {
    directory,
    source,
    targetPath: result.targetPath,
    manifestInput: {
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
        busyTimeoutMs: 5000
      },
      importSummary: result.summary,
      dispositions: result.dispositions,
      reconciliation,
      approvedBaseline: {
        gateEnforced: true,
        manifestAdmitted: true,
        oracleAdmitted: true,
        backupAdmitted: true,
        sourceAdmitted: true,
        source: { schema: { tables: 101, explicitIndexes: 137, triggers: 8, views: 0 }, ownedSchemaDigest: "a".repeat(64), ownedRowTotal: source.ownedRowTotal }
      },
      failures: [],
      generatedUtc: "2026-08-28T00:00:00.000Z"
    }
  };
}

test("a clean run produces a versioned pass manifest with full source identity", async () => {
  const { manifestInput, directory, source } = await run("evidence-pass");
  const oracle = writeFixtureOracle(directory, source);
  const manifest = buildEvidenceManifest({
    ...manifestInput,
    oracle: loadOracle(oracle.path),
    reconciliation: {
      ...manifestInput.reconciliation!,
      oracle: {
        matched: true,
        oraclePath: oracle.path,
        expectedAggregateSha256: oracle.aggregate,
        publishedAggregateSha256: oracle.aggregate,
        publishedTableCount: FIXTURE_OWNED_TABLES.length,
        publishedRowCount: source.ownedRowTotal,
        publishedMatchesExpected: true,
        target: manifestInput.reconciliation!.oracle?.target ?? ({} as never),
        targetMatchesPublished: true,
        sourceCrossCheck: null,
        sourceCrossCheckAgrees: null
      }
    }
  });

  assert.equal(manifest.contract, EVIDENCE_CONTRACT);
  assert.equal(manifest.contractVersion, EVIDENCE_CONTRACT_VERSION);
  assert.equal(manifest.outcome, "pass");
  assert.equal(manifest.product, "Watchtower");

  assert.equal(manifest.source.commit, "f0b05fc1dbf53e8aa26c215d8e858894a2793871");
  assert.equal(manifest.source.tree, "62cbd35861c511f7c17187c875d19ee6e353b80d");
  assert.equal(manifest.source.version, "2.13.2");
  assert.equal(manifest.source.build, 172);
  assert.equal(
    manifest.source.imageDigest,
    "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140"
  );
  assert.match(manifest.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.source.verifiedAfterRun?.sha256, manifest.source.sha256);

  assert.equal(manifest.ownership.ownedTableCount, FIXTURE_OWNED_TABLES.length);
  assert.equal(manifest.ownership.expectedOwnedRowTotal, manifest.import?.expectedRowTotal);
  assert.deepEqual(manifest.ownership.neverCopiedSharedTables, [
    "audit_log",
    "hearth_index",
    "hearth_permissions",
    "hearth_users"
  ]);

  assert.ok(manifest.reconciliation?.ok);
  assert.equal(manifest.failures.length, 0);
  assert.match(manifest.evidenceDigest, /^[0-9a-f]{64}$/);

  // The admission block is always present and gates the outcome.
  assert.ok(manifest.approvedBaseline.gateEnforced);
  assert.ok(manifest.approvedBaseline.manifestAdmitted);
  assert.ok(manifest.approvedBaseline.oracleAdmitted);
  assert.ok(manifest.approvedBaseline.backupAdmitted);
  assert.ok(manifest.approvedBaseline.sourceAdmitted);
});

test("the evidence digest is stable and content bound", async () => {
  const { manifestInput } = await run("evidence-digest");
  const first = buildEvidenceManifest(manifestInput);
  const second = buildEvidenceManifest(manifestInput);
  assert.equal(first.evidenceDigest, second.evidenceDigest);

  const mutated = buildEvidenceManifest({
    ...manifestInput,
    failures: [{ code: "RECONCILE_DIFFERENCES", message: "example" }]
  });
  assert.notEqual(mutated.evidenceDigest, first.evidenceDigest);
  assert.equal(mutated.outcome, "fail");
});

test("a failed reconciliation or a missing reconciliation is never reported as pass", async () => {
  const { manifestInput } = await run("evidence-fail");
  const withoutReconciliation = buildEvidenceManifest({ ...manifestInput, reconciliation: null });
  assert.equal(withoutReconciliation.outcome, "fail");

  const failed = buildEvidenceManifest({
    ...manifestInput,
    reconciliation: { ...manifestInput.reconciliation!, ok: false }
  });
  assert.equal(failed.outcome, "fail");
});

test("evidence records the independent oracle and refuses to pass without it", async () => {
  const { manifestInput, directory, source } = await run("evidence-oracle");

  // No oracle at all can never be green, even when reconciliation passed.
  const withoutOracle = buildEvidenceManifest(manifestInput);
  assert.equal(withoutOracle.sourceOracle, null);
  assert.equal(withoutOracle.outcome, "fail");

  const oracle = writeFixtureOracle(directory, source);
  const loaded = loadOracle(oracle.path);

  // An oracle that was supplied but did not corroborate must fail the run.
  const notCorroborated = buildEvidenceManifest({ ...manifestInput, oracle: loaded });
  assert.ok(notCorroborated.sourceOracle);
  assert.equal(notCorroborated.sourceOracle.mode, "supplied");
  assert.equal(notCorroborated.sourceOracle.contract, ORACLE_CONTRACT);
  assert.equal(notCorroborated.sourceOracle.documentPath, oracle.path);
  assert.equal(notCorroborated.sourceOracle.product, "Watchtower");
  assert.equal(notCorroborated.sourceOracle.publishedAggregateSha256, oracle.aggregate);
  assert.equal(notCorroborated.sourceOracle.publishedTableCount, FIXTURE_OWNED_TABLES.length);
  assert.equal(notCorroborated.sourceOracle.execution, null);
  assert.equal(notCorroborated.sourceOracle.matched, false);
  assert.equal(notCorroborated.outcome, "fail");

  // A reconciliation that carried the oracle and matched it passes and records it.
  const corroborated = buildEvidenceManifest({
    ...manifestInput,
    oracle: loaded,
    reconciliation: {
      ...manifestInput.reconciliation!,
      oracle: {
        matched: true,
        oraclePath: oracle.path,
        expectedAggregateSha256: oracle.aggregate,
        publishedAggregateSha256: oracle.aggregate,
        publishedTableCount: FIXTURE_OWNED_TABLES.length,
        publishedRowCount: source.ownedRowTotal,
        publishedMatchesExpected: true,
        target: manifestInput.reconciliation!.oracle?.target ?? ({} as never),
        targetMatchesPublished: true,
        sourceCrossCheck: null,
        sourceCrossCheckAgrees: null
      }
    }
  });
  assert.equal(corroborated.sourceOracle?.matched, true);
  assert.equal(corroborated.sourceOracle?.expectedAggregateSha256, oracle.aggregate);
  assert.equal(corroborated.sourceOracle?.targetMatchesPublished, true);
  assert.equal(corroborated.outcome, "pass");
  assert.notEqual(corroborated.evidenceDigest, withoutOracle.evidenceDigest);

  // Strip the admission block and the same content is no longer a pass.
  const ungated = buildEvidenceManifest({
    ...manifestInput,
    oracle: loaded,
    approvedBaseline: null,
    reconciliation: corroborated.reconciliation
  });
  assert.equal(ungated.outcome, "fail");
  assert.equal(ungated.approvedBaseline.gateEnforced, false);
});

test("every admission stage is required for a pass", async () => {
  const { manifestInput, directory, source } = await run("evidence-admission");
  const oracle = writeFixtureOracle(directory, source);
  const loaded = loadOracle(oracle.path);
  const reconciliation = {
    ...manifestInput.reconciliation!,
    oracle: {
      matched: true,
      oraclePath: oracle.path,
      expectedAggregateSha256: oracle.aggregate,
      publishedAggregateSha256: oracle.aggregate,
      publishedTableCount: FIXTURE_OWNED_TABLES.length,
      publishedRowCount: source.ownedRowTotal,
      publishedMatchesExpected: true,
      target: manifestInput.reconciliation!.oracle?.target ?? ({} as never),
      targetMatchesPublished: true,
      sourceCrossCheck: null,
      sourceCrossCheckAgrees: null
    }
  };
  const full = {
    gateEnforced: true,
    manifestAdmitted: true,
    oracleAdmitted: true,
    backupAdmitted: true,
    sourceAdmitted: true,
    source: manifestInput.approvedBaseline?.source ?? null
  };

  assert.equal(
    buildEvidenceManifest({ ...manifestInput, oracle: loaded, reconciliation, approvedBaseline: full }).outcome,
    "pass"
  );

  for (const stage of [
    "gateEnforced",
    "manifestAdmitted",
    "oracleAdmitted",
    "backupAdmitted",
    "sourceAdmitted"
  ] as const) {
    const manifest = buildEvidenceManifest({
      ...manifestInput,
      oracle: loaded,
      reconciliation,
      approvedBaseline: { ...full, [stage]: false }
    });
    assert.equal(manifest.outcome, "fail", `${stage} must be required for a pass`);
  }

  // A missing source-facts record is also disqualifying.
  assert.equal(
    buildEvidenceManifest({
      ...manifestInput,
      oracle: loaded,
      reconciliation,
      approvedBaseline: { ...full, source: null }
    }).outcome,
    "fail"
  );
});

test("serialized evidence is deterministic, key-sorted JSON", async () => {
  const { manifestInput, directory } = await run("evidence-write");
  const manifest = buildEvidenceManifest(manifestInput);

  const serialized = serializeEvidence(manifest);
  assert.equal(serialized, serializeEvidence(buildEvidenceManifest(manifestInput)));
  assert.ok(serialized.endsWith("\n"));

  const path = writeEvidence(join(directory, "evidence.json"), manifest);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.contract, EVIDENCE_CONTRACT);
  assert.equal(parsed.evidenceDigest, manifest.evidenceDigest);

  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort());
});

test("dispositions are carried into the evidence with rationale and counts", async () => {
  const { manifestInput } = await run("evidence-dispositions");
  const manifest = buildEvidenceManifest(manifestInput);

  const rejected = manifest.dispositions.find((row) => row.code === "identity_missing_oid");
  assert.ok(rejected);
  assert.equal(rejected.rows, 1);
  assert.equal(rejected.kind, "reject");
  assert.ok(rejected.rationale.length > 40);
  assert.ok(rejected.samples.length > 0);
});
