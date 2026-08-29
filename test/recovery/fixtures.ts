/**
 * Synthetic fixtures for the recovery tests. Every database is generated in a
 * throwaway scratch directory that the owning test removes.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

/**
 * Scratch root. Overridable with `WATCHTOWER_TEST_TMPDIR`; defaults to
 * `node_modules/.cache/watchtower-tests`, which is already Git-ignored.
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

export interface AuthorityFixture {
  readonly path: string;
  readonly rowCounts: Readonly<Record<string, number>>;
}

/**
 * Builds a small Watchtower-shaped authority database with foreign keys, a
 * trigger, unicode text, BLOBs, NULLs and every storage class.
 */
export function buildAuthorityFixture(directory: string, fileName = "watchtower.db"): AuthorityFixture {
  const path = join(directory, fileName);
  const database = new Database(path);
  database.pragma("journal_mode = DELETE");
  database.pragma("foreign_keys = ON");

  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );

    CREATE TABLE ups_readings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at INTEGER NOT NULL,
      ups_status  TEXT,
      battery_charge REAL,
      raw         BLOB
    );

    CREATE TABLE outage_incidents (
      id         TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      summary    TEXT
    );

    CREATE TABLE outage_incident_evidence (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL REFERENCES outage_incidents(id) ON DELETE CASCADE,
      received_at INTEGER NOT NULL,
      raw         BLOB
    );

    CREATE INDEX idx_evidence_incident ON outage_incident_evidence(incident_id);

    CREATE TRIGGER trg_outage_incidents_immutable_id
    BEFORE UPDATE OF id ON outage_incidents
    BEGIN
      SELECT RAISE(ABORT, 'incident id is immutable');
    END;
  `);

  database
    .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
    .run(1, "app-local-identity-audit-settings", 1_790_000_000_000, "a".repeat(64));

  const insertReading = database.prepare(
    "INSERT INTO ups_readings (received_at, ups_status, battery_charge, raw) VALUES (?, ?, ?, ?)"
  );
  insertReading.run(1_790_000_001_000, "OL", 100.0, Buffer.from([0x00, 0x01, 0xff]));
  insertReading.run(1_790_000_002_000, "OB LB", 12.5, null);
  insertReading.run(1_790_000_003_000, null, null, Buffer.alloc(0));
  insertReading.run(1_790_000_004_000, "ünïcödé ✅", 0.0, Buffer.from("日本語", "utf8"));

  database
    .prepare("INSERT INTO outage_incidents (id, updated_at, summary) VALUES (?, ?, ?)")
    .run("incident-1", 1_790_000_005_000, "WAN flap");
  database
    .prepare("INSERT INTO outage_incidents (id, updated_at, summary) VALUES (?, ?, ?)")
    .run("incident-2", 1_790_000_006_000, null);

  const insertEvidence = database.prepare(
    "INSERT INTO outage_incident_evidence (incident_id, received_at, raw) VALUES (?, ?, ?)"
  );
  insertEvidence.run("incident-1", 1_790_000_005_500, Buffer.from("evidence", "utf8"));
  insertEvidence.run("incident-2", 1_790_000_006_500, null);

  const rowCounts: Record<string, number> = {};
  for (const table of ["schema_migrations", "ups_readings", "outage_incidents", "outage_incident_evidence"]) {
    const row = database.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    rowCounts[table] = Number(row.c);
  }

  database.close();
  return { path, rowCounts };
}
