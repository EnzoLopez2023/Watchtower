import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  computeSchemaIdentity,
  orderByClause,
  quoteIdentifier,
  readOwnedSchemaObjects,
  readSequences,
  readTableSchema,
  selectColumnsClause,
  tableExists
} from "../../lib/db/import/schema.js";
import { ImportError } from "../../lib/db/import/errors.js";
import {
  buildSourceFixture,
  FIXTURE_OWNED_TABLES,
  makeScratchDir,
  removeScratchDir
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

function openFixture(prefix: string): { database: Database.Database; close: () => void } {
  const directory = scratch(prefix);
  const source = buildSourceFixture(directory);
  const database = new Database(source.path, { readonly: true, fileMustExist: true });
  database.defaultSafeIntegers(true);
  return { database, close: () => database.close() };
}

test("quoteIdentifier escapes embedded double quotes", () => {
  assert.equal(quoteIdentifier("plain"), '"plain"');
  assert.equal(quoteIdentifier('we"ird'), '"we""ird"');
});

test("readTableSchema exposes columns, keys and the exact CREATE statement", () => {
  const { database, close } = openFixture("schema-basic");
  try {
    const schema = readTableSchema(database, "wt_readings");
    assert.equal(schema.name, "wt_readings");
    assert.match(schema.sql, /^CREATE TABLE wt_readings/);
    assert.ok(schema.hasAutoincrement);
    assert.equal(schema.rowidAlias, "id");
    assert.deepEqual(schema.primaryKeyColumns, ["id"]);
    assert.deepEqual(schema.columnNames, [
      "id",
      "received_at",
      "label",
      "ratio",
      "payload",
      "note",
      "raw_value"
    ]);
    assert.equal(schema.columns.at(1)?.notNull, true);
    assert.equal(schema.columns.at(2)?.notNull, false);
    assert.deepEqual(schema.blobColumns, ["payload", "raw_value"]);
    assert.equal(schema.orderingSource, "integer-primary-key");
    assert.equal(orderByClause(schema), '"id"');
    assert.equal(selectColumnsClause(schema), '"id", "received_at", "label", "ratio", "payload", "note", "raw_value"');
  } finally {
    close();
  }
});

test("ordering falls back through primary key, unique index and all columns", () => {
  const { database, close } = openFixture("schema-ordering");
  try {
    const keyed = readTableSchema(database, "wt_keyed_events");
    assert.equal(keyed.rowidAlias, null);
    assert.equal(keyed.orderingSource, "primary-key");
    assert.deepEqual(keyed.orderingColumns, ["event_id", "rowid"]);
    assert.equal(orderByClause(keyed), '"event_id", rowid');

    const unique = readTableSchema(database, "wt_unique_only");
    assert.equal(unique.orderingSource, "unique-index");
    assert.deepEqual(unique.businessKey, ["stream", "day_start"]);
    assert.deepEqual(unique.orderingColumns, ["stream", "day_start", "rowid"]);
  } finally {
    close();
  }
});

test("foreign key metadata is read in a stable order", () => {
  const { database, close } = openFixture("schema-fk");
  try {
    const child = readTableSchema(database, "wt_child_rows");
    assert.equal(child.foreignKeys.length, 1);
    assert.equal(child.foreignKeys.at(0)?.table, "wt_readings");
    assert.equal(child.foreignKeys.at(0)?.from, "reading_id");
    assert.equal(child.foreignKeys.at(0)?.to, "id");
    assert.equal(child.foreignKeys.at(0)?.onDelete, "CASCADE");
  } finally {
    close();
  }
});

test("only explicit indexes and triggers on owned tables are collected", () => {
  const { database, close } = openFixture("schema-objects");
  try {
    const { indexes, triggers } = readOwnedSchemaObjects(database, FIXTURE_OWNED_TABLES);
    assert.deepEqual(
      indexes.map((index) => index.name),
      ["idx_wt_child_reading", "idx_wt_readings_received"]
    );
    assert.deepEqual(
      triggers.map((trigger) => trigger.name),
      ["trg_wt_readings_guard"]
    );
    // Implicit UNIQUE / PRIMARY KEY indexes carry no CREATE statement and are
    // recreated by the table DDL itself.
    assert.ok(indexes.every((index) => index.sql !== null));

    const foreign = readOwnedSchemaObjects(database, ["hearth_users"]);
    assert.deepEqual(foreign.indexes, []);
  } finally {
    close();
  }
});

test("schema identity is stable, ordered and content bound", () => {
  const { database, close } = openFixture("schema-identity");
  try {
    const first = computeSchemaIdentity(database, FIXTURE_OWNED_TABLES);
    const second = computeSchemaIdentity(database, [...FIXTURE_OWNED_TABLES].reverse());
    assert.equal(first.digest, second.digest, "table ordering must not change the digest");
    assert.equal(first.tableCount, FIXTURE_OWNED_TABLES.length);
    assert.equal(first.indexCount, 2);
    assert.equal(first.triggerCount, 1);

    const subset = computeSchemaIdentity(database, FIXTURE_OWNED_TABLES.slice(0, 2));
    assert.notEqual(subset.digest, first.digest);
  } finally {
    close();
  }
});

test("readSequences reports only owned AUTOINCREMENT tables", () => {
  const { database, close } = openFixture("schema-sequences");
  try {
    const sequences = readSequences(database, FIXTURE_OWNED_TABLES);
    assert.equal(sequences.wt_readings, "9007199254");
    assert.equal(sequences.wt_child_rows, "3");
    assert.ok(!("hearth_users" in sequences));
    assert.ok(!("wt_keyed_events" in sequences));
  } finally {
    close();
  }
});

test("tableExists and readTableSchema fail closed on unknown tables", () => {
  const { database, close } = openFixture("schema-missing");
  try {
    assert.ok(tableExists(database, "wt_readings"));
    assert.ok(!tableExists(database, "does_not_exist"));
    assert.throws(
      () => readTableSchema(database, "does_not_exist"),
      (error: unknown) => error instanceof ImportError && error.code === "SOURCE_SCHEMA_INCOMPLETE"
    );
  } finally {
    close();
  }
});

test("WITHOUT ROWID tables are detected and ordered by their primary key", () => {
  const directory = scratch("schema-without-rowid");
  const database = new Database(join(directory, "wr.sqlite3"));
  try {
    database.exec("CREATE TABLE wr (a TEXT NOT NULL, b INTEGER NOT NULL, c TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID");
    const schema = readTableSchema(database, "wr");
    assert.equal(schema.hasRowid, false);
    assert.equal(schema.rowidAlias, null);
    assert.equal(schema.orderingSource, "primary-key");
    assert.deepEqual(schema.orderingColumns, ["a", "b"]);
    assert.equal(orderByClause(schema), '"a", "b"');
  } finally {
    database.close();
  }
});
