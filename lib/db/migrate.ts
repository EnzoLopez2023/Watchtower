import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./connection.js";
import { CORE_MIGRATIONS, type Migration } from "./migrations/core.js";

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    checksum   TEXT NOT NULL
  )
`;

export type MigrationRejectionCode =
  | "MIGRATION_UNKNOWN_VERSION"
  | "MIGRATION_GAP"
  | "MIGRATION_OUT_OF_ORDER"
  | "MIGRATION_IDENTITY_DRIFT"
  | "MIGRATION_INCOMPLETE";

export class MigrationError extends Error {
  public readonly code: MigrationRejectionCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: MigrationRejectionCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function hasMigrationTable(database: SqliteDatabase): boolean {
  return (
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() !== undefined
  );
}

function readApplied(database: SqliteDatabase): AppliedMigration[] {
  // Read in stored order so a reordered or duplicated history stays visible
  // instead of being silently normalised by an ORDER BY.
  return (
    database.prepare("SELECT version, name, checksum FROM schema_migrations").all() as Array<{
      version: bigint | number;
      name: string;
      checksum: string;
    }>
  ).map((row) => ({ version: toNumber(row.version), name: row.name, checksum: row.checksum }));
}

/**
 * Validates that the recorded history is an exact ordered prefix of `migrations`
 * and returns the migrations still to apply, in order.
 *
 * Rejects, before anything is written:
 *   - versions this build does not know (unknown or newer)
 *   - more applied rows than this build defines
 *   - gaps in the applied sequence
 *   - rows that are not in strictly ascending version order
 *   - a name or checksum that differs from the known migration
 */
export function planMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[] = CORE_MIGRATIONS
): readonly Migration[] {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const known = new Map(ordered.map((migration) => [migration.version, migration]));

  const unknown = applied.filter((row) => !known.has(row.version)).map((row) => row.version);
  if (unknown.length > 0) {
    throw new MigrationError(
      "MIGRATION_UNKNOWN_VERSION",
      `Database carries migration version(s) this build does not know: ${unknown.join(", ")}`,
      { unknown, knownVersions: [...known.keys()] }
    );
  }

  if (applied.length > ordered.length) {
    throw new MigrationError("MIGRATION_UNKNOWN_VERSION", "More migrations applied than this build defines", {
      appliedCount: applied.length,
      knownCount: ordered.length
    });
  }

  for (let index = 1; index < applied.length; index += 1) {
    const previous = applied[index - 1];
    const current = applied[index];
    if (previous === undefined || current === undefined) continue;
    if (current.version <= previous.version) {
      throw new MigrationError(
        "MIGRATION_OUT_OF_ORDER",
        `schema_migrations is not in ascending version order at ${previous.version} -> ${current.version}`,
        { previous: previous.version, current: current.version }
      );
    }
  }

  for (const [index, row] of applied.entries()) {
    const expected = ordered[index];
    if (expected === undefined) continue;
    if (row.version !== expected.version) {
      throw new MigrationError(
        "MIGRATION_GAP",
        `Applied migrations must be a contiguous prefix; position ${index} is ${row.version}, expected ${expected.version}`,
        { position: index, applied: row.version, expected: expected.version }
      );
    }
    const expectedChecksum = checksum(expected.sql);
    if (row.name !== expected.name || row.checksum !== expectedChecksum) {
      throw new MigrationError(
        "MIGRATION_IDENTITY_DRIFT",
        `Migration ${expected.version} identity does not match the database`,
        {
          version: expected.version,
          expectedName: expected.name,
          actualName: row.name,
          expectedChecksum,
          actualChecksum: row.checksum
        }
      );
    }
  }

  return ordered.slice(applied.length);
}

/**
 * Asserts the database carries the exact, complete, ordered migration history.
 * Used by startup and by import `require` mode, which must fail closed on extras.
 */
export function assertMigrationsComplete(
  database: SqliteDatabase,
  migrations: readonly Migration[] = CORE_MIGRATIONS
): readonly AppliedMigration[] {
  const applied = hasMigrationTable(database) ? readApplied(database) : [];
  const pending = planMigrations(applied, migrations);
  if (pending.length > 0) {
    throw new MigrationError("MIGRATION_INCOMPLETE", "Database is missing required migrations", {
      missing: pending.map((migration) => `${migration.version}:${migration.name}`)
    });
  }
  return applied;
}

/**
 * Applies any missing migrations, after proving the recorded history is an exact
 * ordered prefix of this build\u2019s list. Validation happens before the first
 * write, so a database carrying an unknown, newer, gapped, reordered or drifted
 * migration is left completely untouched \u2014 no partial apply.
 */
export function migrateDatabase(
  database: SqliteDatabase,
  migrations: readonly Migration[] = CORE_MIGRATIONS
): readonly AppliedMigration[] {
  const tablePresent = hasMigrationTable(database);
  const applied = tablePresent ? readApplied(database) : [];

  // Validate before creating the bookkeeping table, so a rejected database keeps
  // its schema exactly as it was.
  const pending = planMigrations(applied, migrations);

  if (!tablePresent) database.exec(MIGRATION_TABLE_SQL);

  for (const migration of pending) {
    const expectedChecksum = checksum(migration.sql);
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, Date.now(), expectedChecksum);
    })();
  }

  return assertMigrationsComplete(database, migrations);
}
