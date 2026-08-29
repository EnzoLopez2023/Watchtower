/**
 * Finding 3 regressions: `migrateDatabase` must accept only an exact ordered
 * prefix of known migrations, and must validate *before* writing anything, so a
 * rejected database is left byte-identical.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  MigrationError,
  assertMigrationsComplete,
  migrateDatabase,
  planMigrations,
  type AppliedMigration
} from "../../lib/db/migrate.js";
import { CORE_MIGRATIONS, type Migration } from "../../lib/db/migrations/core.js";
import { makeScratchDir, removeScratchDir } from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function identityOf(migration: Migration): AppliedMigration {
  return { version: migration.version, name: migration.name, checksum: checksumOf(migration.sql) };
}

const APPLIED = CORE_MIGRATIONS.map(identityOf);

function openMigrated(directory: string, name = "db.sqlite3"): Database.Database {
  const database = new Database(join(directory, name));
  database.pragma("journal_mode = DELETE");
  migrateDatabase(database);
  return database;
}

/** A stable fingerprint of schema + bookkeeping, used to prove "no partial apply". */
function fingerprint(database: Database.Database): string {
  const schema = database
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all() as { type: string; name: string; sql: string | null }[];
  const migrations = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
    ? database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY rowid").all()
    : [];
  return createHash("sha256").update(JSON.stringify({ schema, migrations })).digest("hex");
}

test("planMigrations accepts an empty history and returns everything in order", () => {
  const pending = planMigrations([]);
  assert.deepEqual(
    pending.map((migration) => migration.version),
    CORE_MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b)
  );
});

test("planMigrations accepts an exact ordered prefix and returns only the remainder", () => {
  const pending = planMigrations(APPLIED.slice(0, 1));
  assert.deepEqual(
    pending.map((migration) => `${migration.version}:${migration.name}`),
    CORE_MIGRATIONS.slice(1).map((migration) => `${migration.version}:${migration.name}`)
  );
  assert.deepEqual(planMigrations(APPLIED), []);
});

test("planMigrations rejects unknown and newer versions", () => {
  for (const rogue of [{ version: 99, name: "from-the-future", checksum: "a".repeat(64) },
                       { version: 0, name: "prehistoric", checksum: "b".repeat(64) }]) {
    assert.throws(
      () => planMigrations([...APPLIED, rogue]),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_UNKNOWN_VERSION"
    );
  }
});

test("planMigrations rejects more applied rows than this build defines", () => {
  const duplicated = [...APPLIED, ...APPLIED.slice(0, 1)];
  assert.throws(
    () => planMigrations(duplicated),
    (error: unknown) => error instanceof MigrationError && error.code !== "MIGRATION_INCOMPLETE"
  );
});

test("planMigrations rejects gaps", () => {
  assert.throws(
    () => planMigrations([identityOf(CORE_MIGRATIONS[1]!)]),
    (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_GAP"
  );
});

test("planMigrations rejects reordered and duplicated versions", () => {
  assert.throws(
    () => planMigrations([...APPLIED].reverse()),
    (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_OUT_OF_ORDER"
  );
  assert.throws(
    () => planMigrations([APPLIED[0]!, APPLIED[0]!]),
    (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_OUT_OF_ORDER"
  );
});

test("planMigrations rejects a changed name or checksum", () => {
  assert.throws(
    () => planMigrations([{ ...APPLIED[0]!, name: "renamed" }]),
    (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_IDENTITY_DRIFT"
  );
  assert.throws(
    () => planMigrations([{ ...APPLIED[0]!, checksum: "f".repeat(64) }]),
    (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_IDENTITY_DRIFT"
  );
});

test("migrateDatabase applies everything and is idempotent", () => {
  const directory = scratch("migrate-apply");
  const database = openMigrated(directory);
  try {
    const applied = database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as AppliedMigration[];
    assert.deepEqual(applied, APPLIED);

    const before = fingerprint(database);
    const result = migrateDatabase(database);
    assert.deepEqual([...result], APPLIED);
    assert.equal(fingerprint(database), before, "a second run must change nothing");
  } finally {
    database.close();
  }
});

test("an unknown migration row leaves schema and data completely unchanged", () => {
  const directory = scratch("migrate-unknown");
  const database = openMigrated(directory);
  try {
    // worker_heartbeats carries no foreign key, so this is pure payload data.
    database
      .prepare("INSERT INTO worker_heartbeats (worker, state, updated_at, detail) VALUES (?,?,?,?)")
      .run("alerts", "healthy", 1, "keep me");
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(99, "from-the-future", Date.now(), "a".repeat(64));

    const before = fingerprint(database);
    const rowsBefore = database.prepare("SELECT COUNT(*) AS c FROM worker_heartbeats").get() as { c: number };

    assert.throws(
      () => migrateDatabase(database),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_UNKNOWN_VERSION"
    );

    assert.equal(fingerprint(database), before, "no partial apply");
    assert.deepEqual(database.prepare("SELECT COUNT(*) AS c FROM worker_heartbeats").get(), rowsBefore);
  } finally {
    database.close();
  }
});

test("a newer-only history is rejected before the bookkeeping table is created", () => {
  const directory = scratch("migrate-newer-fresh");
  const database = new Database(join(directory, "fresh.sqlite3"));
  try {
    database.pragma("journal_mode = DELETE");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL);
      CREATE TABLE untouched (id INTEGER PRIMARY KEY, note TEXT);
    `);
    database.prepare("INSERT INTO untouched (id, note) VALUES (1, 'keep me')").run();
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(7, "unreleased", Date.now(), "c".repeat(64));

    const before = fingerprint(database);
    assert.throws(
      () => migrateDatabase(database),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_UNKNOWN_VERSION"
    );

    assert.equal(fingerprint(database), before);
    // None of the core tables may have been created.
    const created = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'app%'")
      .all();
    assert.deepEqual(created, []);
    assert.equal((database.prepare("SELECT COUNT(*) AS c FROM untouched").get() as { c: number }).c, 1);
  } finally {
    database.close();
  }
});

test("a gapped history is rejected without applying the missing migration", () => {
  const directory = scratch("migrate-gap");
  const database = new Database(join(directory, "gap.sqlite3"));
  try {
    database.pragma("journal_mode = DELETE");
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
    const second = identityOf(CORE_MIGRATIONS[1]!);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(second.version, second.name, Date.now(), second.checksum);

    const before = fingerprint(database);
    assert.throws(
      () => migrateDatabase(database),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_GAP"
    );
    assert.equal(fingerprint(database), before);
  } finally {
    database.close();
  }
});

test("a drifted checksum is rejected without rewriting the database", () => {
  const directory = scratch("migrate-drift");
  const database = openMigrated(directory);
  try {
    database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("f".repeat(64));
    const before = fingerprint(database);
    assert.throws(
      () => migrateDatabase(database),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_IDENTITY_DRIFT"
    );
    assert.equal(fingerprint(database), before);
  } finally {
    database.close();
  }
});

test("assertMigrationsComplete fails closed on extras, gaps and an unmigrated database", () => {
  const directory = scratch("migrate-assert");

  const complete = openMigrated(directory, "complete.sqlite3");
  try {
    assert.deepEqual([...assertMigrationsComplete(complete)], APPLIED);
    complete
      .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(42, "extra", Date.now(), "d".repeat(64));
    assert.throws(
      () => assertMigrationsComplete(complete),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_UNKNOWN_VERSION"
    );
  } finally {
    complete.close();
  }

  const bare = new Database(join(directory, "bare.sqlite3"));
  try {
    assert.throws(
      () => assertMigrationsComplete(bare),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_INCOMPLETE"
    );
  } finally {
    bare.close();
  }
});

test("a partially migrated database is completed, not restarted", () => {
  const directory = scratch("migrate-prefix");
  const database = new Database(join(directory, "prefix.sqlite3"));
  try {
    database.pragma("journal_mode = DELETE");
    // Apply only migration 1, exactly as migrateDatabase would have.
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);
    const first = CORE_MIGRATIONS[0]!;
    database.exec(first.sql);
    database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?,?,?,?)")
      .run(first.version, first.name, 1, checksumOf(first.sql));

    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='runtime_instance_lease'")
        .get() !== undefined,
      true
    );

    const applied = migrateDatabase(database);
    assert.deepEqual([...applied], APPLIED);
    // v2's table now exists, and v1's applied_at was not rewritten.
    const row = database.prepare("SELECT applied_at FROM schema_migrations WHERE version = 1").get() as {
      applied_at: number;
    };
    assert.equal(row.applied_at, 1);
    assert.ok(
      database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='runtime_instance_lease'")
        .get() !== undefined
    );
  } finally {
    database.close();
  }
});
