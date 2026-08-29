/**
 * Finding 2 regressions: approved-baseline admission control.
 *
 * The importer must not trust operator-supplied lineage, manifest, oracle or
 * backup identity. Every value it acts on is pinned in `approvedBaseline.ts`, so
 * these tests mutate each supplied input in turn and prove the run is rejected —
 * including the case where a forged manifest, forged backup and forged oracle all
 * agree with each other.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  APPROVED_AGGREGATE_SHA256,
  APPROVED_LINEAGE,
  APPROVED_OWNED_ROW_TOTAL,
  APPROVED_OWNED_TABLES,
  APPROVED_OWNED_TABLE_COUNT,
  APPROVED_SEQUENCES,
  APPROVED_SOURCE_SCHEMA_COUNTS,
  APPROVED_TABLES
} from "../../lib/db/import/approvedBaseline.js";
import {
  assertBackupIdentityMatchesApprovedBaseline,
  assertManifestMatchesApprovedBaseline,
  assertOracleMatchesApprovedBaseline,
  assertSourceMatchesApprovedBaseline,
  readSourceSchemaFacts
} from "../../lib/db/import/baselineGate.js";
import { EXPECTED_OWNED_TABLES, OWNED_VIEW_IDS } from "../../lib/db/import/ownership.js";
import { loadOracle } from "../../lib/db/import/oracle.js";
import { runImport } from "../../lib/db/import/importer.js";
import { ImportError } from "../../lib/db/import/errors.js";
import { buildSourceFixture, makeScratchDir, removeScratchDir } from "./fixtures.js";
import type { OwnershipContract } from "../../lib/db/import/ownership.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

/** A manifest that is exactly the approved baseline. */
function approvedOwnership(overrides: Partial<OwnershipContract> = {}): OwnershipContract {
  return {
    manifestPath: "<test>",
    manifestVersion: 1,
    product: "Watchtower",
    ownedTables: [...APPROVED_OWNED_TABLES],
    ownedViewIds: [...OWNED_VIEW_IDS],
    ownedApiPathPrefixes: [],
    expectedOwnedRowTotal: APPROVED_OWNED_ROW_TOTAL,
    sourceBaseline: {
      repository: APPROVED_LINEAGE.repository,
      version: APPROVED_LINEAGE.version,
      build: APPROVED_LINEAGE.build,
      commit: APPROVED_LINEAGE.commit,
      tree: APPROVED_LINEAGE.tree,
      imageDigest: APPROVED_LINEAGE.imageDigest,
      backupBytes: APPROVED_LINEAGE.backupBytes,
      backupSha256: APPROVED_LINEAGE.backupSha256,
      backupCreatedUtc: APPROVED_LINEAGE.backupCreatedUtc
    },
    sharedTableDispositions: {},
    ...overrides
  };
}

function rejects(run: () => void): ImportError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportError, "expected an ImportError");
    assert.equal(error.code, "BASELINE_REJECTED");
    return error;
  }
  throw new Error("expected the baseline gate to reject this input");
}

test("the approved baseline pins the exact reviewed lineage", () => {
  assert.equal(APPROVED_LINEAGE.repository, "EnzoLopez2023/Hearth");
  assert.equal(APPROVED_LINEAGE.version, "2.13.2");
  assert.equal(APPROVED_LINEAGE.build, 172);
  assert.equal(APPROVED_LINEAGE.commit, "f0b05fc1dbf53e8aa26c215d8e858894a2793871");
  assert.equal(APPROVED_LINEAGE.tree, "62cbd35861c511f7c17187c875d19ee6e353b80d");
  assert.equal(
    APPROVED_LINEAGE.imageDigest,
    "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140"
  );
  assert.equal(APPROVED_LINEAGE.backupCreatedUtc, "2026-08-28T05:36:25.317Z");
  assert.equal(APPROVED_LINEAGE.backupBytes, 950947840);
  assert.equal(
    APPROVED_LINEAGE.backupSha256,
    "dc9fb47d269b339a3dcae37279dc3116f37a0635728a2d2b2ac2c511811a5807"
  );
  assert.deepEqual(APPROVED_SOURCE_SCHEMA_COUNTS, { tables: 101, explicitIndexes: 137, triggers: 8, views: 0 });
  assert.equal(APPROVED_OWNED_TABLE_COUNT, 54);
  assert.equal(APPROVED_OWNED_ROW_TOTAL, 2_723_313);
  assert.equal(
    APPROVED_AGGREGATE_SHA256,
    "f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322"
  );
});

test("the approved table set holds 54 tables with per-table counts and hashes summing to the aggregate", () => {
  assert.equal(APPROVED_TABLES.size, 54);
  assert.equal(APPROVED_OWNED_TABLES.length, 54);
  assert.deepEqual([...APPROVED_OWNED_TABLES].sort(), [...EXPECTED_OWNED_TABLES].sort());

  let total = 0;
  for (const [table, approved] of APPROVED_TABLES) {
    assert.match(approved.canonicalSha256, /^[0-9a-f]{64}$/, `${table} hash`);
    assert.ok(Number.isInteger(approved.rowCount) && approved.rowCount >= 0, `${table} rowCount`);
    total += approved.rowCount;
  }
  assert.equal(total, APPROVED_OWNED_ROW_TOTAL);
  assert.equal(new Set([...APPROVED_TABLES.values()].map((t) => t.canonicalSha256)).size, 54);
  assert.equal(APPROVED_SEQUENCES.size, 25);
});

test("every manifest lineage field is checked individually", () => {
  assertManifestMatchesApprovedBaseline(approvedOwnership());

  const mutations: [string, Record<string, unknown>][] = [
    ["repository", { repository: "attacker/Hearth" }],
    ["version", { version: "2.13.3" }],
    ["build", { build: 173 }],
    ["commit", { commit: "0".repeat(40) }],
    ["tree", { tree: "1".repeat(40) }],
    ["imageDigest", { imageDigest: "sha256:" + "0".repeat(64) }],
    ["backupCreatedUtc", { backupCreatedUtc: "2026-08-28T05:36:25.318Z" }],
    ["backupBytes", { backupBytes: 950947841 }],
    ["backupSha256", { backupSha256: "0".repeat(64) }]
  ];

  for (const [field, patch] of mutations) {
    const contract = approvedOwnership();
    const error = rejects(() =>
      assertManifestMatchesApprovedBaseline({
        ...contract,
        sourceBaseline: { ...contract.sourceBaseline, ...patch }
      })
    );
    const findings = error.details.findings as { field: string }[];
    assert.ok(
      findings.some((finding) => finding.field === field),
      `${field} drift must be reported`
    );
  }
});

test("manifest table-set and row-total drift is rejected", () => {
  rejects(() =>
    assertManifestMatchesApprovedBaseline(
      approvedOwnership({ expectedOwnedRowTotal: APPROVED_OWNED_ROW_TOTAL + 1 })
    )
  );
  rejects(() =>
    assertManifestMatchesApprovedBaseline(
      approvedOwnership({ ownedTables: APPROVED_OWNED_TABLES.slice(0, 53) })
    )
  );
  rejects(() =>
    assertManifestMatchesApprovedBaseline(
      approvedOwnership({ ownedTables: [...APPROVED_OWNED_TABLES.slice(0, 53), "recipes"] })
    )
  );
  rejects(() =>
    assertManifestMatchesApprovedBaseline(
      approvedOwnership({ ownedTables: [...APPROVED_OWNED_TABLES, "recipes"] })
    )
  );
});

test("backup size and digest are checked against the pinned values", () => {
  assertBackupIdentityMatchesApprovedBaseline({
    bytes: APPROVED_LINEAGE.backupBytes,
    sha256: APPROVED_LINEAGE.backupSha256
  });
  rejects(() =>
    assertBackupIdentityMatchesApprovedBaseline({
      bytes: APPROVED_LINEAGE.backupBytes - 1,
      sha256: APPROVED_LINEAGE.backupSha256
    })
  );
  rejects(() =>
    assertBackupIdentityMatchesApprovedBaseline({
      bytes: APPROVED_LINEAGE.backupBytes,
      sha256: "0".repeat(64)
    })
  );
});

/** Builds an oracle document that matches the approved baseline exactly. */
function approvedOracleDocument(directory: string, mutate: (document: Record<string, unknown>) => void = () => {}): string {
  const tables = [...APPROVED_TABLES].map(([name, approved]) => ({
    name,
    rowCount: approved.rowCount,
    primaryKey: ["id"],
    columns: [],
    canonicalSha256: approved.canonicalSha256
  }));
  const document: Record<string, unknown> = {
    contract: "hearth.sqlite-canonical-table-hashes.v1",
    database: { path: "/approved", bytes: APPROVED_LINEAGE.backupBytes },
    tableCount: tables.length,
    tables,
    products: [
      {
        name: "Watchtower",
        tableCount: APPROVED_OWNED_TABLE_COUNT,
        rowCount: APPROVED_OWNED_ROW_TOTAL,
        canonicalSha256: APPROVED_AGGREGATE_SHA256
      }
    ]
  };
  mutate(document);
  const path = join(directory, `oracle-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

test("an oracle is corroboration only: every drifted field is rejected", () => {
  const directory = scratch("baseline-oracle");

  assertOracleMatchesApprovedBaseline(loadOracle(approvedOracleDocument(directory)));

  // Aggregate drift.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.products as { canonicalSha256: string }[])[0]!.canonicalSha256 = "0".repeat(64);
        })
      )
    )
  );
  // Declared database size drift.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.database as { bytes: number }).bytes = 1;
        })
      )
    )
  );
  // Table count / row count drift.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.products as { tableCount: number }[])[0]!.tableCount = 53;
        })
      )
    )
  );
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.products as { rowCount: number }[])[0]!.rowCount = 1;
        })
      )
    )
  );
  // A single per-table hash flipped.
  const error = rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.tables as { name: string; canonicalSha256: string }[])[0]!.canonicalSha256 = "f".repeat(64);
        })
      )
    )
  );
  assert.ok(
    (error.details.findings as { field: string }[]).some((finding) =>
      finding.field.endsWith(".canonicalSha256")
    )
  );
  // A single per-table row count flipped.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          (document.tables as { rowCount: number }[])[0]!.rowCount += 1;
        })
      )
    )
  );
  // A table missing entirely.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          document.tables = (document.tables as { name: string }[]).slice(1);
        })
      )
    )
  );
  // No Watchtower product at all.
  rejects(() =>
    assertOracleMatchesApprovedBaseline(
      loadOracle(
        approvedOracleDocument(directory, (document) => {
          document.products = [];
        })
      )
    )
  );
});

test("source schema counts and owned facts are checked against the pinned values", () => {
  const directory = scratch("baseline-source");
  const source = buildSourceFixture(directory);
  const database = new Database(source.path, { readonly: true, fileMustExist: true });
  try {
    const facts = readSourceSchemaFacts(database);
    // The synthetic fixture is deliberately nothing like the approved source.
    assert.notEqual(facts.tables, APPROVED_SOURCE_SCHEMA_COUNTS.tables);
    rejects(() => assertSourceMatchesApprovedBaseline(database));
  } finally {
    database.close();
  }
});

test("a self-consistent forged manifest, backup and oracle is still refused, and no target is created", async () => {
  const directory = scratch("baseline-forgery");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "forged-target.sqlite3");

  // The forgery is internally consistent: the manifest describes the forged
  // backup exactly, and the oracle is generated from that same backup.
  const forgedManifest = approvedOwnership({
    ownedTables: [...APPROVED_OWNED_TABLES],
    sourceBaseline: {
      repository: APPROVED_LINEAGE.repository,
      version: APPROVED_LINEAGE.version,
      build: APPROVED_LINEAGE.build,
      commit: APPROVED_LINEAGE.commit,
      tree: APPROVED_LINEAGE.tree,
      imageDigest: APPROVED_LINEAGE.imageDigest,
      backupCreatedUtc: APPROVED_LINEAGE.backupCreatedUtc,
      backupBytes: source.bytes,
      backupSha256: source.sha256
    }
  });

  await assert.rejects(
    runImport({
      ownership: forgedManifest,
      sourcePath: source.path,
      targetPath,
      tenantId: "11111111-2222-3333-4444-555555555555",
      allowInsideGitWorktree: true
    }),
    (error: unknown) => error instanceof ImportError && error.code === "BASELINE_REJECTED"
  );

  assert.ok(!existsSync(targetPath), "no target may be created when admission fails");
  assert.ok(!existsSync(`${targetPath}-journal`));
  assert.ok(!existsSync(`${targetPath}-wal`));
});

test("rejection happens before the target exists for every gate stage", async () => {
  const directory = scratch("baseline-no-target");
  const source = buildSourceFixture(directory);

  for (const [label, contract] of [
    ["lineage", approvedOwnership({ sourceBaseline: { ...approvedOwnership().sourceBaseline, build: 999 } })],
    ["table-set", approvedOwnership({ ownedTables: APPROVED_OWNED_TABLES.slice(0, 10) })],
    ["row-total", approvedOwnership({ expectedOwnedRowTotal: 1 })]
  ] as [string, OwnershipContract][]) {
    const targetPath = join(directory, `no-target-${label}.sqlite3`);
    await assert.rejects(
      runImport({
        ownership: contract,
        sourcePath: source.path,
        targetPath,
        tenantId: "11111111-2222-3333-4444-555555555555",
        allowInsideGitWorktree: true
      }),
      (error: unknown) => error instanceof ImportError && error.code === "BASELINE_REJECTED"
    );
    assert.ok(!existsSync(targetPath), `${label}: target must not exist`);
  }
});

test("the CLI exposes no way to disable approved-baseline admission", () => {
  const script = readFileSync(new URL("../../scripts/legacy-import.ts", import.meta.url), "utf8");
  assert.ok(
    !script.includes("__unsafeSkipApprovedBaselineGateForTests"),
    "legacy-import.ts must never set the test-only gate seam"
  );
  assert.ok(!script.toLowerCase().includes("skip-baseline"));
  assert.ok(!script.toLowerCase().includes("--no-baseline"));

  const reconcileScript = readFileSync(new URL("../../scripts/reconcile.ts", import.meta.url), "utf8");
  assert.ok(!reconcileScript.includes("__unsafeSkipApprovedBaselineGateForTests"));
});
