import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runImport } from "../../lib/db/import/importer.js";
import { fingerprintTable, reconcile } from "../../lib/db/import/reconcile.js";
import { openSourceReadonly } from "../../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../../lib/db/import/target.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OWNED_TABLES,
  FIXTURE_TENANT_ID,
  makeScratchDir,
  openWritable,
  removeScratchDir,
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

async function prepare(prefix: string): Promise<{ source: FixtureSource; targetPath: string }> {
  const directory = scratch(prefix);
  const source = buildSourceFixture(directory);
  const result = await runImport({
    ownership: fixtureOwnership(source),
    sourcePath: source.path,
    targetPath: join(directory, "target.sqlite3"),
    tenantId: FIXTURE_TENANT_ID,
    allowInsideGitWorktree: true,
    importedAtMs: 1_700_000_999_000,
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });
  return { source, targetPath: result.targetPath };
}

function compare(
  sourcePath: string,
  targetPath: string,
  expectedRowTotal: number
): ReturnType<typeof reconcile> {
  const source = openSourceReadonly(sourcePath, 5000);
  const target = openTargetReadonly(targetPath, 5000);
  try {
    target.pragma("foreign_keys = ON");
    return reconcile({
      source,
      target,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal
    });
  } finally {
    target.close();
    source.close();
  }
}

test("a clean import reconciles with zero differences", async () => {
  const { source, targetPath } = await prepare("reconcile-clean");
  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(result.ok);
  assert.deepEqual(result.differences, []);
  assert.equal(result.tables.length, FIXTURE_OWNED_TABLES.length);
  assert.ok(result.tables.every((table) => table.matched));
  assert.ok(result.totals.rowsMatchExpected);
});

test("an expected-row-total mismatch fails the run", async () => {
  const { source, targetPath } = await prepare("reconcile-total");
  const result = compare(source.path, targetPath, source.ownedRowTotal + 1);
  assert.ok(!result.ok);
  assert.ok(!result.totals.rowsMatchExpected);
});

test("a deleted target row is detected as a row-count and key difference", async () => {
  const { source, targetPath } = await prepare("reconcile-delete");
  const database = openWritable(targetPath);
  database.prepare("DELETE FROM wt_keyed_events WHERE event_id = ?").run("evt-002");
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  const kinds = new Set(
    result.differences.filter((difference) => difference.table === "wt_keyed_events").map((d) => d.kind)
  );
  assert.ok(kinds.has("row-count"));
  assert.ok(kinds.has("key-digest"));
  assert.ok(kinds.has("row-digest"));
});

test("an edited text value is detected with a bounded column-level sample", async () => {
  const { source, targetPath } = await prepare("reconcile-edit");
  const database = openWritable(targetPath);
  database.prepare("UPDATE wt_readings SET note = ? WHERE id = 1").run("tampered");
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  const difference = result.differences.find(
    (entry) => entry.table === "wt_readings" && entry.kind === "row-digest"
  );
  assert.ok(difference);
  assert.ok(Array.isArray(difference.samples) && difference.samples.length > 0);

  const sample = difference.samples[0] as {
    side: string;
    columns: { column: string; source: unknown; target: unknown }[];
  };
  assert.equal(sample.side, "mismatch");
  assert.deepEqual(
    sample.columns.map((column) => column.column),
    ["note"]
  );
});

test("an integer silently retyped as real is detected", async () => {
  const { source, targetPath } = await prepare("reconcile-retype");
  const database = openWritable(targetPath);
  database.prepare("UPDATE wt_readings SET raw_value = ? WHERE id = 1").run(1);
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok, "integer 1 replaced by real 1.0 must be a difference");
  assert.ok(
    result.differences.some((entry) => entry.table === "wt_readings" && entry.kind === "row-digest")
  );
});

test("a mutated BLOB byte is detected by the blob column digest", async () => {
  const { source, targetPath } = await prepare("reconcile-blob");
  const database = openWritable(targetPath);
  database.prepare("UPDATE wt_readings SET payload = ? WHERE id = 1").run(Buffer.from([0x00, 0xff, 0x11]));
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  const kinds = new Set(
    result.differences.filter((difference) => difference.table === "wt_readings").map((d) => d.kind)
  );
  assert.ok(kinds.has("blob-digest"));
  assert.ok(kinds.has("row-digest"));
});

test("a drifted sqlite_sequence value is detected", async () => {
  const { source, targetPath } = await prepare("reconcile-seq");
  const database = openWritable(targetPath);
  database.prepare("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'wt_readings'").run();
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  assert.ok(!result.sequences.matched);
  assert.equal(result.sequences.differences.at(0)?.table, "wt_readings");
});

test("a dropped index is detected as a schema difference", async () => {
  const { source, targetPath } = await prepare("reconcile-index");
  const database = openWritable(targetPath);
  database.exec("DROP INDEX idx_wt_readings_received");
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  assert.ok(!result.schema.matched);
  assert.equal(result.schema.source.indexCount, 2);
  assert.equal(result.schema.target.indexCount, 1);
});

test("a missing target table is detected without aborting the run", async () => {
  const { source, targetPath } = await prepare("reconcile-missing");
  const database = openWritable(targetPath);
  database.exec("PRAGMA foreign_keys = OFF; DROP TABLE wt_unique_only;");
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  assert.ok(
    result.differences.some(
      (difference) => difference.table === "wt_unique_only" && difference.kind === "missing-table"
    )
  );
});

test("an orphaned child row is detected by foreign_key_check", async () => {
  const { source, targetPath } = await prepare("reconcile-fk");
  const database = openWritable(targetPath);
  database.pragma("foreign_keys = OFF");
  database.prepare("INSERT INTO wt_child_rows (reading_id, kind) VALUES (?, ?)").run(4242, "orphan");
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  assert.ok(result.foreignKeys.enforced);
  assert.equal(result.foreignKeys.violations.length, 1);
  assert.equal(result.foreignKeys.violations.at(0)?.table, "wt_child_rows");
  assert.equal(result.foreignKeys.violations.at(0)?.parent, "wt_readings");
});

test("fingerprintTable picks a deterministic ordering key per table shape", async () => {
  const { source } = await prepare("reconcile-ordering");
  const database = new Database(source.path, { readonly: true, fileMustExist: true });
  database.defaultSafeIntegers(true);
  try {
    const readings = fingerprintTable(database, "wt_readings");
    assert.equal(readings.orderingSource, "integer-primary-key");
    assert.deepEqual(readings.keyColumns, ["id"]);
    assert.equal(readings.rows, 5);
    assert.deepEqual(
      readings.blobColumns.map((column) => column.column),
      ["payload", "raw_value"]
    );

    const events = fingerprintTable(database, "wt_keyed_events");
    assert.equal(events.orderingSource, "primary-key");
    assert.deepEqual(events.keyColumns, ["event_id", "rowid"]);

    const unique = fingerprintTable(database, "wt_unique_only");
    assert.equal(unique.orderingSource, "unique-index");
    assert.deepEqual(unique.keyColumns, ["stream", "day_start", "rowid"]);
  } finally {
    database.close();
  }
});

test("row order is part of the digest even when the row set is identical", async () => {
  const { source, targetPath } = await prepare("reconcile-order");
  const database = openWritable(targetPath);
  // Swap two rowids so the same rows come back in a different order.
  database.exec(`
    PRAGMA foreign_keys = OFF;
    UPDATE wt_unique_only SET rowid = 999 WHERE rowid = 1;
    UPDATE wt_unique_only SET rowid = 1 WHERE rowid = 2;
    UPDATE wt_unique_only SET rowid = 2 WHERE rowid = 999;
  `);
  database.close();

  const result = compare(source.path, targetPath, source.ownedRowTotal);
  assert.ok(!result.ok);
  assert.ok(
    result.differences.some(
      (difference) => difference.table === "wt_unique_only" && difference.kind === "key-digest"
    )
  );
});
