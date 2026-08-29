/**
 * Synthetic fixtures for the import tests.
 *
 * Nothing here touches production data: every fixture database is generated in a
 * throwaway scratch directory and removed by the test that created it.
 */

import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import {
  ORACLE_CONTRACT,
  ORACLE_PRODUCT_DOMAIN,
  ORACLE_TABLE_DOMAIN
} from "../../lib/db/import/oracle.js";
import type { OwnershipContract } from "../../lib/db/import/ownership.js";

/**
 * Scratch root. Overridable with `WATCHTOWER_TEST_TMPDIR`; defaults to
 * `node_modules/.cache/watchtower-tests`, which is already Git-ignored, so test
 * databases never land anywhere the repository can see them.
 */
export function scratchRoot(): string {
  const configured = process.env.WATCHTOWER_TEST_TMPDIR;
  const root =
    configured && configured.trim() !== ""
      ? resolve(configured)
      : resolve(import.meta.dirname, "../../node_modules/.cache/watchtower-tests");
  mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

export function makeScratchDir(prefix: string): string {
  return mkdtempSync(join(scratchRoot(), `${prefix}-`));
}

export function removeScratchDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export const FIXTURE_OWNED_TABLES: readonly string[] = Object.freeze([
  "wt_child_rows",
  "wt_keyed_events",
  "wt_readings",
  "wt_unique_only"
]);

export const FIXTURE_TENANT_ID = "11111111-2222-3333-4444-555555555555";
export const FIXTURE_OID_A = "d6c36f6e-054c-45b8-9468-16c208628814";
export const FIXTURE_OID_B = "5190215f-1612-473e-974f-e4a46ff81d3e";

const SOURCE_SCHEMA_SQL = `
  CREATE TABLE wt_readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    label       TEXT,
    ratio       REAL,
    payload     BLOB,
    note        TEXT,
    raw_value
  );

  CREATE TABLE wt_child_rows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reading_id INTEGER NOT NULL REFERENCES wt_readings(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL
  );

  CREATE TABLE wt_keyed_events (
    event_id   TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    detail     TEXT
  );

  CREATE TABLE wt_unique_only (
    stream     TEXT NOT NULL,
    day_start  INTEGER NOT NULL,
    value      REAL,
    UNIQUE (stream, day_start)
  );

  CREATE INDEX idx_wt_readings_received ON wt_readings(received_at DESC);
  CREATE INDEX idx_wt_child_reading ON wt_child_rows(reading_id);

  CREATE TRIGGER trg_wt_readings_guard
  BEFORE DELETE ON wt_readings
  WHEN OLD.label = 'protected'
  BEGIN
    SELECT RAISE(ABORT, 'protected reading');
  END;

  CREATE TABLE hearth_users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE,
    name       TEXT,
    azure_oid  TEXT    UNIQUE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE hearth_permissions (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL REFERENCES hearth_users(id) ON DELETE CASCADE,
    feature  TEXT    NOT NULL,
    can_edit INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, feature)
  );

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    user_email  TEXT,
    user_name   TEXT,
    user_oid    TEXT,
    verified    INTEGER NOT NULL DEFAULT 0,
    category    TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    view        TEXT,
    method      TEXT,
    path        TEXT,
    status      INTEGER,
    detail      TEXT,
    ip          TEXT
  );

  CREATE TABLE hearth_index (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    area       TEXT NOT NULL,
    source     TEXT NOT NULL,
    title      TEXT NOT NULL,
    chunk      TEXT NOT NULL,
    embedding  BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE other_product_table (
    id    INTEGER PRIMARY KEY,
    value TEXT
  );
`;

export interface FixtureSource {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly ownedRowTotal: number;
}

/**
 * Builds a synthetic Hearth-shaped source database covering every storage class,
 * unicode text, empty and non-empty BLOBs, NULLs, foreign keys, an explicit
 * trigger, a TEXT primary key table and a unique-index-only table.
 */
export function buildSourceFixture(directory: string, fileName = "source.sqlite3"): FixtureSource {
  const path = join(directory, fileName);
  const database = new Database(path);
  database.pragma("journal_mode = DELETE");
  database.pragma("foreign_keys = ON");
  database.exec(SOURCE_SCHEMA_SQL);

  const insertReading = database.prepare(
    "INSERT INTO wt_readings (id, received_at, label, ratio, payload, note, raw_value) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // `raw_value` has no declared type, so it keeps whatever storage class is bound
  // (including -0.0, which a REAL-affinity column would normalise to +0.0).
  insertReading.run(1, 1_700_000_000_000, "protected", 1.5, Buffer.from([0x00, 0xff, 0x10]), "ascii", 1n);
  insertReading.run(2, 1_700_000_001_000, "日本語 ✅ emoji 🎯", 0.0, Buffer.alloc(0), null, "1");
  insertReading.run(3, 1_700_000_002_000, null, null, null, "line\nbreak\ttab", null);
  insertReading.run(4, 1_700_000_003_000, "negative-zero", -0, Buffer.from("binary\u0000bytes", "utf8"), "", -0);
  insertReading.run(5, 1_700_000_004_000, "integral-real", 2, null, "real 2.0 must not become integer 2", 2);
  // Force a large rowid gap so sqlite_sequence differs from MAX(id).
  insertReading.run(9_007_199_254, 1_700_000_005_000, "big-rowid", 3.25, null, null, Buffer.from([9]));
  database.prepare("DELETE FROM wt_readings WHERE id = ?").run(9_007_199_254);

  const insertChild = database.prepare("INSERT INTO wt_child_rows (reading_id, kind) VALUES (?, ?)");
  insertChild.run(1, "alpha");
  insertChild.run(1, "beta");
  insertChild.run(3, "gamma");

  const insertEvent = database.prepare(
    "INSERT INTO wt_keyed_events (event_id, started_at, detail) VALUES (?, ?, ?)"
  );
  insertEvent.run("evt-002", 1_700_000_100_000, "second");
  insertEvent.run("evt-001", 1_700_000_101_000, null);
  insertEvent.run("evt-003", 1_700_000_102_000, "ünïcödé détail");

  const insertUnique = database.prepare(
    "INSERT INTO wt_unique_only (stream, day_start, value) VALUES (?, ?, ?)"
  );
  insertUnique.run("flows", 1_700_000_000_000, 12.5);
  insertUnique.run("flows", 1_700_086_400_000, null);
  insertUnique.run("probes", 1_700_000_000_000, 0.125);

  const insertUser = database.prepare(
    "INSERT INTO hearth_users (id, email, name, azure_oid, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  insertUser.run(1, "owner@example.test", "Owner", FIXTURE_OID_A, "2026-06-01 23:14:48");
  insertUser.run(3, "member@example.test", "Member", FIXTURE_OID_B, "2026-06-01 23:16:10");
  insertUser.run(7, "legacy@example.test", "No OID", null, "2026-06-02 00:00:00");

  const insertPermission = database.prepare(
    "INSERT INTO hearth_permissions (id, user_id, feature, can_edit, is_hidden) VALUES (?, ?, ?, ?, ?)"
  );
  insertPermission.run(1, 3, "protect", 0, 1);
  insertPermission.run(2, 3, "unifi-network", 1, 0);
  insertPermission.run(3, 3, "recipe-manager", 1, 0);
  insertPermission.run(4, 1, "synology", 0, 0);

  const insertAudit = database.prepare(
    `INSERT INTO audit_log
      (id, ts, received_at, user_email, user_name, user_oid, verified, category, action, view, method, path, status, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertAudit.run(1, 1_790_000_200_000, 1_790_000_200_100, "owner@example.test", "Owner", FIXTURE_OID_A, 1, "navigation", "Viewed", "unifi-network", null, null, null, null, "10.0.0.1");
  insertAudit.run(2, 1_790_000_201_000, 1_790_000_201_100, "owner@example.test", "Owner", FIXTURE_OID_A, 1, "change", "Updated power item", "dashboard", "PUT", "/api/power/items/34", 200, "renamed", "10.0.0.1");
  insertAudit.run(3, 1_790_000_202_000, 1_790_000_202_100, "owner@example.test", "Owner", FIXTURE_OID_A, 1, "auth", "Signed in", null, null, null, null, null, "10.0.0.1");
  insertAudit.run(4, 1_790_000_203_000, 1_790_000_203_100, "other@example.test", "Other", "99999999-9999-4999-8999-999999999999", 1, "navigation", "Viewed", "protect", null, null, null, null, null);
  insertAudit.run(5, 1_790_000_204_000, 1_790_000_204_100, "member@example.test", "Member", FIXTURE_OID_B, 3, "change", "Recipe", "recipe-manager", "POST", "/api/recipes", 201, null, null);
  insertAudit.run(6, 1_790_000_205_000, 1_790_000_205_100, "member@example.test", "Member", FIXTURE_OID_B, 2, "navigation", "Viewed", "synology", null, null, null, null, null);

  database
    .prepare("INSERT INTO hearth_index (area, source, title, chunk, embedding) VALUES (?, ?, ?, ?, ?)")
    .run("knowledge", "guide.md", "Title", "chunk", Buffer.from([1, 2, 3, 4]));

  database.prepare("INSERT INTO other_product_table (id, value) VALUES (?, ?)").run(1, "not watchtower");

  let ownedRowTotal = 0;
  for (const table of FIXTURE_OWNED_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    ownedRowTotal += Number(row.c);
  }

  database.close();

  const bytes = statSync(path).size;
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, bytes, sha256, ownedRowTotal };
}

/** Builds an in-memory ownership contract for the synthetic fixture. */
export function fixtureOwnership(source: FixtureSource, manifestPath = "<synthetic>"): OwnershipContract {
  return Object.freeze({
    manifestPath,
    manifestVersion: 1,
    product: "Watchtower",
    ownedTables: FIXTURE_OWNED_TABLES,
    ownedViewIds: Object.freeze([
      "azure-command-center",
      "system-status",
      "observability",
      "power-monitor",
      "power-topology",
      "unifi-network",
      "unifi-topology",
      "unifi-config",
      "synology",
      "ip-migration",
      "protect"
    ]),
    ownedApiPathPrefixes: Object.freeze(["/api/power/", "/api/unifi", "/api/synology"]),
    expectedOwnedRowTotal: source.ownedRowTotal,
    sourceBaseline: Object.freeze({
      repository: "EnzoLopez2023/Hearth",
      version: "2.13.2",
      build: 172,
      commit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871",
      tree: "62cbd35861c511f7c17187c875d19ee6e353b80d",
      imageDigest: "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140",
      backupBytes: source.bytes,
      backupSha256: source.sha256,
      backupCreatedUtc: "2026-08-28T05:36:25.317Z"
    }),
    sharedTableDispositions: Object.freeze({
      hearth_users: "transform into app-local OID-keyed identities or memberships",
      hearth_permissions: "transform into app-local authorization; never share at runtime",
      audit_log: "partition by owning app and migrate into app-local audit tables",
      hearth_index: "do not migrate as authority; rebuild app-local indexes and use APIs for cross-app search"
    })
  });
}

/** Opens a database read-write for corruption/mutation scenarios in tests. */
export function openWritable(path: string): SqliteDatabase {
  const database = new Database(path);
  database.pragma("journal_mode = DELETE");
  database.defaultSafeIntegers(true);
  return database;
}

// ---------------------------------------------------------------------------
// Independent third implementation of the oracle encoding, transcribed from
// hash-sqlite-tables.mjs. Deliberately uses object-mode rows and its own
// buffer handling so it shares no code path with lib/db/import/oracle.ts.
// ---------------------------------------------------------------------------

type Reference = { update(chunk: Buffer | string): void };

export function referenceWriteLength(hash: Reference, length: number): void {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(length));
  hash.update(encoded);
}

export function referenceWriteValue(hash: Reference, value: unknown): void {
  if (value === null) {
    hash.update("N");
    referenceWriteLength(hash, 0);
    return;
  }
  if (Buffer.isBuffer(value)) {
    hash.update("B");
    referenceWriteLength(hash, value.length);
    hash.update(value);
    return;
  }
  if (typeof value === "bigint") {
    const encoded = Buffer.from(value.toString(10), "utf8");
    hash.update("I");
    referenceWriteLength(hash, encoded.length);
    hash.update(encoded);
    return;
  }
  if (typeof value === "number") {
    const encoded = Buffer.from(
      Number.isNaN(value)
        ? "NaN"
        : Object.is(value, -0)
          ? "-0"
          : value === Infinity
            ? "Infinity"
            : value === -Infinity
              ? "-Infinity"
              : value.toString(),
      "utf8"
    );
    hash.update("F");
    referenceWriteLength(hash, encoded.length);
    hash.update(encoded);
    return;
  }
  if (typeof value === "string") {
    const encoded = Buffer.from(value, "utf8");
    hash.update("T");
    referenceWriteLength(hash, encoded.length);
    hash.update(encoded);
    return;
  }
  throw new TypeError(`Unsupported SQLite value type: ${typeof value}`);
}

export function referenceQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function referenceTableHash(
  database: Database.Database,
  table: string
): { rowCount: number; canonicalSha256: string; primaryKey: string[] } {
  const columns = (database.prepare(`PRAGMA table_info(${referenceQuote(table)})`).all() as Record<
    string,
    unknown
  >[]).sort((left, right) => Number(left.cid) - Number(right.cid));
  if (columns.length === 0) throw new Error(`no columns for ${table}`);

  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => String(column.name));

  const orderBy = primaryKey.length > 0 ? primaryKey.map(referenceQuote).join(", ") : "rowid";

  const hash = createHash("sha256");
  hash.update(ORACLE_TABLE_DOMAIN);
  referenceWriteValue(hash, table);
  referenceWriteValue(hash, columns.length);
  for (const column of columns) {
    referenceWriteValue(hash, String(column.name));
    referenceWriteValue(hash, String(column.type ?? ""));
  }

  let rowCount = 0;
  const statement = database.prepare(
    `SELECT ${columns.map((column) => referenceQuote(String(column.name))).join(", ")}
       FROM ${referenceQuote(table)}
      ORDER BY ${orderBy}`
  );
  for (const row of statement.iterate() as IterableIterator<Record<string, unknown>>) {
    hash.update("R");
    for (const column of columns) referenceWriteValue(hash, row[String(column.name)]);
    rowCount += 1;
  }

  return { rowCount, canonicalSha256: hash.digest("hex"), primaryKey };
}

export function referenceProductHash(
  product: string,
  tables: { name: string; rowCount: number; canonicalSha256: string }[]
): string {
  const hash = createHash("sha256");
  hash.update(ORACLE_PRODUCT_DOMAIN);
  referenceWriteValue(hash, product);
  for (const table of [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    referenceWriteValue(hash, table.name);
    referenceWriteValue(hash, table.canonicalSha256);
    referenceWriteValue(hash, table.rowCount);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------

export function openOracleReader(path: string): Database.Database {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.defaultSafeIntegers(true);
  database.pragma("query_only = 1");
  return database;
}

/** Builds an oracle document over the synthetic fixture, on disk. */
export function writeFixtureOracle(
  directory: string,
  source: FixtureSource,
  mutate: (document: Record<string, unknown>) => void = () => {}
): { path: string; aggregate: string } {
  const database = openOracleReader(source.path);
  const tables: Record<string, unknown>[] = [];
  const forAggregate: { name: string; rowCount: number; canonicalSha256: string }[] = [];
  try {
    for (const table of [...FIXTURE_OWNED_TABLES].sort()) {
      const reference = referenceTableHash(database, table);
      const columns = (database.prepare(`PRAGMA table_info(${referenceQuote(table)})`).all() as Record<
        string,
        unknown
      >[]).map((column) => ({
        name: String(column.name),
        type: String(column.type ?? ""),
        notNull: Number(column.notnull) === 1,
        primaryKeyOrder: Number(column.pk)
      }));
      tables.push({
        name: table,
        rowCount: reference.rowCount,
        primaryKey: reference.primaryKey,
        columns,
        canonicalSha256: reference.canonicalSha256
      });
      forAggregate.push({
        name: table,
        rowCount: reference.rowCount,
        canonicalSha256: reference.canonicalSha256
      });
    }
  } finally {
    database.close();
  }

  const aggregate = referenceProductHash("Watchtower", forAggregate);
  const document: Record<string, unknown> = {
    contract: ORACLE_CONTRACT,
    database: { path: source.path, bytes: source.bytes },
    tableCount: tables.length,
    tables,
    products: [
      {
        name: "Watchtower",
        tableCount: tables.length,
        rowCount: source.ownedRowTotal,
        canonicalSha256: aggregate
      }
    ]
  };
  mutate(document);

  const path = join(directory, `oracle-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return { path, aggregate };
}
