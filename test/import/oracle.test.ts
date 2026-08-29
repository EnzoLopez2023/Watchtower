/**
 * Tests for the independent canonical-hash oracle.
 *
 * The critical property is that this repository's re-implementation of the
 * oracle encoding reproduces digests produced by a *separate* program
 * (`hash-sqlite-tables.mjs`). To prove that without depending on the production
 * database, these tests re-implement the oracle algorithm a third time, inline
 * and naively (object-mode rows, string concatenation of the same framing), and
 * assert the two agree on synthetic data covering every storage class.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORACLE_CONTRACT,
  ORACLE_PRODUCT_DOMAIN,
  ORACLE_TABLE_DOMAIN,
  WATCHTOWER_ORACLE_AGGREGATE_SHA256,
  WATCHTOWER_ORACLE_ROW_TOTAL,
  WATCHTOWER_ORACLE_TABLE_COUNT,
  assertOraclePublishesWatchtowerBaseline,
  computeOracleProductHash,
  computeOracleTableHash,
  loadOracle,
  verifyAgainstOracle,
  writeOracleValue
} from "../../lib/db/import/oracle.js";
import { runImport } from "../../lib/db/import/importer.js";
import { reconcile } from "../../lib/db/import/reconcile.js";
import { openSourceReadonly } from "../../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../../lib/db/import/target.js";
import { ImportError } from "../../lib/db/import/errors.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OWNED_TABLES,
  FIXTURE_TENANT_ID,
  makeScratchDir,
  openOracleReader,
  openWritable,
  referenceProductHash,
  referenceTableHash,
  referenceWriteValue,
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

async function importFixture(
  directory: string,
  source: FixtureSource,
  targetName = "target.sqlite3"
): Promise<string> {
  const result = await runImport({
    ownership: fixtureOwnership(source),
    sourcePath: source.path,
    targetPath: join(directory, targetName),
    tenantId: FIXTURE_TENANT_ID,
    allowInsideGitWorktree: true,
    importedAtMs: 1_790_000_500_000,
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });
  return result.targetPath;
}

test("the reviewed Watchtower oracle baseline is pinned", () => {
  assert.match(WATCHTOWER_ORACLE_AGGREGATE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(
    WATCHTOWER_ORACLE_AGGREGATE_SHA256,
    "f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322"
  );
  assert.equal(WATCHTOWER_ORACLE_TABLE_COUNT, 54);
  assert.equal(WATCHTOWER_ORACLE_ROW_TOTAL, 2_723_313);
  assert.equal(ORACLE_CONTRACT, "hearth.sqlite-canonical-table-hashes.v1");
  assert.equal(ORACLE_TABLE_DOMAIN, "hearth.sqlite-table-canonical.v1\u0000");
  assert.equal(ORACLE_PRODUCT_DOMAIN, "hearth.sqlite-product-canonical.v1\u0000");
});

test("writeOracleValue matches the reference encoder for every storage class", () => {
  const cases: unknown[] = [
    null,
    0n,
    -1n,
    9_007_199_254_740_993n,
    0,
    -0,
    1.5,
    2,
    Infinity,
    -Infinity,
    NaN,
    "",
    "plain",
    "日本語 ✅ emoji 🎯",
    "quote\"and\\backslash",
    Buffer.alloc(0),
    Buffer.from([0x00, 0xff, 0x10]),
    Buffer.from("binary\u0000bytes", "utf8")
  ];

  for (const value of cases) {
    const mine = createHash("sha256");
    writeOracleValue(mine, value as never);
    const theirs = createHash("sha256");
    referenceWriteValue(theirs, value);
    assert.equal(mine.digest("hex"), theirs.digest("hex"), `encoding differs for ${String(value)}`);
  }
});

test("the oracle encoding separates integer, real and text forms of the same number", () => {
  const digest = (value: unknown): string => {
    const hash = createHash("sha256");
    writeOracleValue(hash, value as never);
    return hash.digest("hex");
  };
  assert.equal(new Set([digest(1n), digest(1), digest("1"), digest(Buffer.from("1"))]).size, 4);
  assert.notEqual(digest(-0), digest(0));
  assert.notEqual(digest(2n), digest(2));
});

test("computeOracleTableHash reproduces the reference implementation exactly", () => {
  const directory = scratch("oracle-table");
  const source = buildSourceFixture(directory);
  const database = openOracleReader(source.path);
  try {
    for (const table of FIXTURE_OWNED_TABLES) {
      const reference = referenceTableHash(database, table);
      const computed = computeOracleTableHash(database, table);
      assert.equal(computed.canonicalSha256, reference.canonicalSha256, `hash differs for ${table}`);
      assert.equal(computed.rowCount, reference.rowCount, `row count differs for ${table}`);
      assert.deepEqual([...computed.primaryKey], reference.primaryKey);
    }
  } finally {
    database.close();
  }
});

test("computeOracleProductHash reproduces the reference aggregate", () => {
  const tables = [
    { name: "b_table", rowCount: 2, canonicalSha256: "b".repeat(64) },
    { name: "a_table", rowCount: 1, canonicalSha256: "a".repeat(64) }
  ];
  const computed = computeOracleProductHash("Watchtower", tables);
  assert.equal(computed.canonicalSha256, referenceProductHash("Watchtower", tables));
  assert.equal(computed.tableCount, 2);
  assert.equal(computed.rowCount, 3);

  // Input order must not matter; table names are sorted.
  assert.equal(
    computeOracleProductHash("Watchtower", [...tables].reverse()).canonicalSha256,
    computed.canonicalSha256
  );
  // Product name is part of the domain.
  assert.notEqual(computeOracleProductHash("Marquee", tables).canonicalSha256, computed.canonicalSha256);
});

test("an imported target reproduces the source's oracle hashes", async () => {
  const directory = scratch("oracle-import");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const targetPath = await importFixture(directory, source);

  const loaded = loadOracle(oracle.path);
  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    const sourceResult = verifyAgainstOracle({
      database: sourceDb,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "source",
      expectedAggregateSha256: oracle.aggregate,
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });
    const targetResult = verifyAgainstOracle({
      database: targetDb,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "target",
      expectedAggregateSha256: oracle.aggregate,
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });

    assert.ok(sourceResult.ok, JSON.stringify(sourceResult.differences));
    assert.ok(targetResult.ok, JSON.stringify(targetResult.differences));
    assert.equal(sourceResult.aggregateSha256, targetResult.aggregateSha256);
    assert.equal(sourceResult.aggregateSha256, oracle.aggregate);
    assert.equal(sourceResult.tables.length, FIXTURE_OWNED_TABLES.length);
    assert.ok(sourceResult.tables.every((table) => table.matched));
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("reconcile carries the oracle and requires it to corroborate", async () => {
  const directory = scratch("oracle-reconcile");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const targetPath = await importFixture(directory, source);
  const loaded = loadOracle(oracle.path);

  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const result = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal,
      oracle: loaded,
      expectedOracleAggregateSha256: oracle.aggregate
    });

    assert.ok(result.ok);
    assert.deepEqual(result.differences, []);
    assert.ok(result.oracle);
    assert.ok(result.oracle.matched);
    assert.equal(result.oracle.expectedAggregateSha256, oracle.aggregate);
    assert.equal(result.oracle.publishedAggregateSha256, oracle.aggregate);
    assert.ok(result.oracle.publishedMatchesExpected);
    assert.equal(result.oracle.target.aggregateSha256, oracle.aggregate);
    assert.ok(result.oracle.targetMatchesPublished);
    assert.equal(result.oracle.sourceCrossCheck?.aggregateSha256, oracle.aggregate);
    assert.equal(result.oracle.sourceCrossCheckAgrees, true);
    assert.equal(result.oracle.oraclePath, oracle.path);
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("reconcile without an oracle reports null and still passes", async () => {
  const directory = scratch("oracle-absent");
  const source = buildSourceFixture(directory);
  const targetPath = await importFixture(directory, source);

  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const result = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.equal(result.oracle, null);
    assert.ok(result.ok);
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("a tampered target fails the oracle even though the row count is unchanged", async () => {
  const directory = scratch("oracle-tamper");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const targetPath = await importFixture(directory, source);

  const writable = openWritable(targetPath);
  writable.prepare("UPDATE wt_keyed_events SET detail = ? WHERE event_id = ?").run("tampered", "evt-001");
  writable.close();

  const loaded = loadOracle(oracle.path);
  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const result = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal,
      oracle: loaded,
      expectedOracleAggregateSha256: oracle.aggregate
    });

    assert.ok(!result.ok);
    assert.ok(result.oracle);
    assert.ok(!result.oracle.matched);
    assert.ok(!result.oracle.targetMatchesPublished);
    assert.equal(result.oracle.sourceCrossCheckAgrees, false);
    assert.ok(
      result.oracle.sourceCrossCheck?.ok,
      "the untouched source must still reproduce the published digests"
    );
    assert.ok(!result.oracle.target.ok);

    const kinds = result.oracle.target.differences.map((difference) => difference.kind);
    assert.ok(kinds.includes("table-hash"));
    assert.ok(kinds.includes("aggregate-hash"));
    const mismatch = result.oracle.target.differences.find((difference) => difference.kind === "table-hash");
    assert.equal(mismatch?.table, "wt_keyed_events");
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("an integer silently retyped as real is caught by the oracle", async () => {
  const directory = scratch("oracle-retype");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const targetPath = await importFixture(directory, source);

  const writable = openWritable(targetPath);
  // raw_value has no affinity, so this really does change the storage class.
  writable.prepare("UPDATE wt_readings SET raw_value = ? WHERE id = 1").run(1);
  writable.close();

  const loaded = loadOracle(oracle.path);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    const result = verifyAgainstOracle({
      database: targetDb,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "target",
      expectedAggregateSha256: oracle.aggregate,
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.ok(!result.ok);
    assert.ok(
      result.differences.some(
        (difference) => difference.kind === "table-hash" && difference.table === "wt_readings"
      )
    );
    assert.ok(!result.aggregateMatches);
  } finally {
    targetDb.close();
  }
});

test("a deleted row is reported as both a row-count and a hash difference", async () => {
  const directory = scratch("oracle-delete");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const targetPath = await importFixture(directory, source);

  const writable = openWritable(targetPath);
  writable.prepare("DELETE FROM wt_unique_only WHERE stream = ?").run("probes");
  writable.close();

  const loaded = loadOracle(oracle.path);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    const result = verifyAgainstOracle({
      database: targetDb,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "target",
      expectedAggregateSha256: oracle.aggregate,
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });
    const kinds = result.differences
      .filter((difference) => difference.table === "wt_unique_only")
      .map((difference) => difference.kind);
    assert.ok(kinds.includes("row-count"));
    assert.ok(kinds.includes("table-hash"));
    assert.ok(result.differences.some((difference) => difference.kind === "row-total"));
  } finally {
    targetDb.close();
  }
});

test("a table missing from the oracle is a difference, not a crash", async () => {
  const directory = scratch("oracle-missing-table");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source, (document) => {
    const tables = document.tables as { name: string }[];
    document.tables = tables.filter((table) => table.name !== "wt_readings");
  });
  const loaded = loadOracle(oracle.path);

  const database = openSourceReadonly(source.path, 5000);
  try {
    const result = verifyAgainstOracle({
      database,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "source",
      expectedAggregateSha256: oracle.aggregate,
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.ok(!result.ok);
    assert.ok(
      result.differences.some(
        (difference) => difference.kind === "missing-in-oracle" && difference.table === "wt_readings"
      )
    );
    // The aggregate is computed from recomputed hashes, so it still matches.
    assert.ok(result.aggregateMatches);
  } finally {
    database.close();
  }
});

test("an aggregate that disagrees with the reviewed value fails", async () => {
  const directory = scratch("oracle-aggregate");
  const source = buildSourceFixture(directory);
  const oracle = writeFixtureOracle(directory, source);
  const loaded = loadOracle(oracle.path);

  const database = openSourceReadonly(source.path, 5000);
  try {
    const result = verifyAgainstOracle({
      database,
      oracle: loaded,
      tables: FIXTURE_OWNED_TABLES,
      side: "source",
      expectedAggregateSha256: "0".repeat(64),
      expectedTableCount: FIXTURE_OWNED_TABLES.length,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.ok(!result.ok);
    assert.ok(!result.aggregateMatches);
    assert.ok(result.differences.some((difference) => difference.kind === "aggregate-hash"));
  } finally {
    database.close();
  }
});

test("loadOracle validates the contract and rejects malformed documents", () => {
  const directory = scratch("oracle-load");
  const source = buildSourceFixture(directory);

  assert.throws(
    () => loadOracle(join(directory, "absent.json")),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );

  const broken = join(directory, "broken.json");
  writeFileSync(broken, "{not json");
  assert.throws(
    () => loadOracle(broken),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );

  const wrongContract = writeFixtureOracle(directory, source, (document) => {
    document.contract = "something.else.v1";
  });
  assert.throws(
    () => loadOracle(wrongContract.path),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );

  const badHash = writeFixtureOracle(directory, source, (document) => {
    const tables = document.tables as Record<string, unknown>[];
    tables[0]!.canonicalSha256 = "NOTAHASH";
  });
  assert.throws(
    () => loadOracle(badHash.path),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );

  const good = writeFixtureOracle(directory, source);
  const loaded = loadOracle(good.path);
  assert.equal(loaded.contract, ORACLE_CONTRACT);
  assert.equal(loaded.databaseBytes, source.bytes);
  assert.equal(loaded.tables.size, FIXTURE_OWNED_TABLES.length);
  assert.equal(loaded.products.get("Watchtower")?.canonicalSha256, good.aggregate);
});

test("assertOraclePublishesWatchtowerBaseline gates on the reviewed constants", () => {
  const directory = scratch("oracle-baseline");
  const source = buildSourceFixture(directory);

  // The synthetic oracle publishes a fixture aggregate, not the production one.
  const fixtureOracle = loadOracle(writeFixtureOracle(directory, source).path);
  assert.throws(
    () => assertOraclePublishesWatchtowerBaseline(fixtureOracle),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_MISMATCH"
  );

  const noProduct = loadOracle(
    writeFixtureOracle(directory, source, (document) => {
      document.products = [];
    }).path
  );
  assert.throws(
    () => assertOraclePublishesWatchtowerBaseline(noProduct),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );

  const pinned = loadOracle(
    writeFixtureOracle(directory, source, (document) => {
      document.products = [
        {
          name: "Watchtower",
          tableCount: WATCHTOWER_ORACLE_TABLE_COUNT,
          rowCount: WATCHTOWER_ORACLE_ROW_TOTAL,
          canonicalSha256: WATCHTOWER_ORACLE_AGGREGATE_SHA256
        }
      ];
    }).path
  );
  const entry = assertOraclePublishesWatchtowerBaseline(pinned);
  assert.equal(entry.canonicalSha256, WATCHTOWER_ORACLE_AGGREGATE_SHA256);
  assert.equal(entry.tableCount, 54);
  assert.equal(entry.rowCount, 2_723_313);

  const wrongTotals = loadOracle(
    writeFixtureOracle(directory, source, (document) => {
      document.products = [
        {
          name: "Watchtower",
          tableCount: 53,
          rowCount: WATCHTOWER_ORACLE_ROW_TOTAL,
          canonicalSha256: WATCHTOWER_ORACLE_AGGREGATE_SHA256
        }
      ];
    }).path
  );
  assert.throws(
    () => assertOraclePublishesWatchtowerBaseline(wrongTotals),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_MISMATCH"
  );
});
