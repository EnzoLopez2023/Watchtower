/**
 * App-local schema gate for the import target.
 *
 * The importer does **not** carry its own copy of the app-local DDL. The target
 * has to be runtime-compatible with `lib/db/migrations/core.ts` and the
 * repositories that read it, so this module either runs the app's own
 * `migrateDatabase` or requires that it has already been run, and then verifies
 * the result against the migrations themselves.
 *
 * Verification is derived, never hand-maintained: `CORE_MIGRATIONS` is applied to
 * a throwaway in-memory database and the resulting table/column sets are compared
 * against the target. If a migration gains a column or a table, this check
 * follows it automatically instead of drifting.
 *
 * `schema_migrations` identities (version, name and SQL checksum) are asserted in
 * both modes, so a target carrying a *different* migration history than the code
 * in this worktree fails closed rather than being written to.
 */

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import { quoteIdentifier, tableExists } from "./schema.js";
import {
  assertMigrationsComplete,
  migrateDatabase,
  migrationIdentities,
  MigrationError
} from "../migrate.js";
import { CORE_MIGRATIONS } from "../migrations/core.js";

export type AppLocalSchemaMode = "migrate" | "require";

export const APP_IDENTITIES_TABLE = "app_identities";
export const APP_ROLE_GRANTS_TABLE = "app_role_grants";
export const APP_FEATURE_PERMISSIONS_TABLE = "app_feature_permissions";
export const APP_AUDIT_LOG_TABLE = "app_audit_log";
export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

/** The app-local tables this importer writes transformed rows into. */
export const APP_LOCAL_TABLES: readonly string[] = Object.freeze([
  APP_IDENTITIES_TABLE,
  APP_ROLE_GRANTS_TABLE,
  APP_FEATURE_PERMISSIONS_TABLE,
  APP_AUDIT_LOG_TABLE
]);

export interface MigrationIdentity {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/** The migration identities `migrateDatabase` records, from the app's own list. */
export function coreMigrationIdentities(): MigrationIdentity[] {
  return [...migrationIdentities(CORE_MIGRATIONS)];
}

function columnNames(database: SqliteDatabase, table: string): string[] {
  const rows = database.pragma(`table_info(${quoteIdentifier(table)})`) as { name: unknown }[];
  return rows.map((row) => String(row.name)).sort();
}

/**
 * Applies `CORE_MIGRATIONS` to a throwaway in-memory database and reports the
 * table/column shape the runtime expects. This is the reference the target is
 * checked against, so the check can never disagree with the migrations.
 */
export function expectedCoreSchema(): Map<string, string[]> {
  const reference = new Database(":memory:");
  try {
    for (const migration of CORE_MIGRATIONS) reference.exec(migration.sql);
    const tables = (
      reference
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    return new Map(tables.map((table) => [table, columnNames(reference, table)]));
  } finally {
    reference.close();
  }
}

/**
 * Runs `migrateDatabase` with safe-integer reads disabled.
 *
 * The importer's handle uses `defaultSafeIntegers(true)` so SQLite INTEGER and
 * REAL stay distinguishable during the copy. `migrateDatabase` keys applied
 * migrations by `version` in a `Map`, and a BigInt `1n` key never matches a
 * number `1` lookup — it would conclude every migration is unapplied and then
 * fail on the `schema_migrations` primary key. The flag is restored afterwards.
 */
function migrateWithNumericReads(database: SqliteDatabase): void {
  database.defaultSafeIntegers(false);
  try {
    migrateDatabase(database);
  } catch (cause) {
    throw new ImportError("APP_LOCAL_MIGRATION_FAILED", "Applying the app's core migrations to the target failed", {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  } finally {
    database.defaultSafeIntegers(true);
  }
}

function readAppliedMigrations(database: SqliteDatabase): MigrationIdentity[] {
  if (!tableExists(database, SCHEMA_MIGRATIONS_TABLE)) return [];
  const rows = database
    .prepare(`SELECT version, name, checksum FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`)
    .all() as { version: bigint | number; name: string; checksum: string }[];
  return rows.map((row) => ({
    version: typeof row.version === "bigint" ? Number(row.version) : row.version,
    name: row.name,
    checksum: row.checksum
  }));
}

/**
 * Asserts the target's recorded migration history equals this worktree's exactly.
 *
 * Delegates to `assertMigrationsComplete`, so unknown/newer versions, extra rows,
 * gaps, reordering and identity drift all fail closed here too - `require` mode
 * never writes into a database whose history this build does not fully own.
 */
export function assertMigrationIdentities(database: SqliteDatabase): MigrationIdentity[] {
  try {
    assertMigrationsComplete(database);
  } catch (cause) {
    if (cause instanceof MigrationError) {
      const code =
        cause.code === "MIGRATION_INCOMPLETE" ? "APP_LOCAL_SCHEMA_MISSING" : "APP_LOCAL_SCHEMA_INCOMPATIBLE";
      throw new ImportError(code, cause.message, { migrationCode: cause.code, ...cause.details });
    }
    throw cause;
  }

  const expected = coreMigrationIdentities();
  const applied = readAppliedMigrations(database);
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  const missing = expected.filter((migration) => !appliedByVersion.has(migration.version));
  if (missing.length > 0) {
    throw new ImportError(
      "APP_LOCAL_SCHEMA_MISSING",
      "Target is missing core migrations; run the app migrations first or use --app-local-schema=migrate",
      { missing: missing.map((migration) => `${migration.version}:${migration.name}`) }
    );
  }

  const drifted: { version: number; expectedName: string; actualName: string; expectedChecksum: string; actualChecksum: string }[] = [];
  for (const migration of expected) {
    const actual = appliedByVersion.get(migration.version);
    if (!actual) continue;
    if (actual.name !== migration.name || actual.checksum !== migration.checksum) {
      drifted.push({
        version: migration.version,
        expectedName: migration.name,
        actualName: actual.name,
        expectedChecksum: migration.checksum,
        actualChecksum: actual.checksum
      });
    }
  }

  const unexpected = applied.filter((row) => !expected.some((migration) => migration.version === row.version));

  if (drifted.length > 0 || unexpected.length > 0) {
    throw new ImportError(
      "APP_LOCAL_SCHEMA_INCOMPATIBLE",
      "Target migration history does not match this worktree's core migrations",
      { drifted, unexpected: unexpected.map((row) => `${row.version}:${row.name}`) }
    );
  }

  return applied.sort((a, b) => a.version - b.version);
}

export interface AppLocalSchemaResult {
  readonly mode: AppLocalSchemaMode;
  readonly migrations: readonly MigrationIdentity[];
  readonly migratedTables: readonly string[];
  readonly writeTables: readonly string[];
}

/**
 * Ensures the target carries the app's core schema, verifies it against the
 * migrations, and confirms the tables this importer writes are empty.
 */
export function ensureAppLocalSchema(
  database: SqliteDatabase,
  mode: AppLocalSchemaMode,
  options: { readonly appliedAtMs?: number } = {}
): AppLocalSchemaResult {
  if (mode === "migrate") {
    migrateWithNumericReads(database);
    if (options.appliedAtMs !== undefined) {
      // `migrateDatabase` stamps `applied_at` with wall-clock time, which would
      // make an otherwise deterministic target unreproducible. When the caller
      // pins the import instant, pin the bookkeeping timestamp to it too.
      // Migration *identity* (version, name, checksum) is never touched, so a
      // later `migrateDatabase` run still validates cleanly.
      database.prepare(`UPDATE ${SCHEMA_MIGRATIONS_TABLE} SET applied_at = ?`).run(options.appliedAtMs);
    }
  }

  const migrations = assertMigrationIdentities(database);

  const expected = expectedCoreSchema();
  const missingTables: string[] = [];
  const drifted: { table: string; missingColumns: string[]; unexpectedColumns: string[] }[] = [];

  for (const [table, expectedColumns] of expected) {
    if (!tableExists(database, table)) {
      missingTables.push(table);
      continue;
    }
    const actualColumns = columnNames(database, table);
    const missingColumns = expectedColumns.filter((column) => !actualColumns.includes(column));
    const unexpectedColumns = actualColumns.filter((column) => !expectedColumns.includes(column));
    if (missingColumns.length > 0 || unexpectedColumns.length > 0) {
      drifted.push({ table, missingColumns, unexpectedColumns });
    }
  }

  if (missingTables.length > 0) {
    throw new ImportError("APP_LOCAL_SCHEMA_MISSING", "Target is missing app-local tables from the core migrations", {
      missingTables: missingTables.sort()
    });
  }
  if (drifted.length > 0) {
    throw new ImportError(
      "APP_LOCAL_SCHEMA_INCOMPATIBLE",
      "Target app-local columns do not match the core migrations",
      { drifted }
    );
  }

  for (const table of APP_LOCAL_TABLES) {
    const row = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(table)}`).get() as {
      c: bigint | number;
    };
    const count = typeof row.c === "bigint" ? Number(row.c) : row.c;
    if (count > 0) {
      throw new ImportError("TARGET_NOT_EMPTY", `App-local table ${table} already contains ${count} row(s)`, {
        table,
        rows: count
      });
    }
  }

  return {
    mode,
    migrations: Object.freeze(migrations),
    migratedTables: Object.freeze([...expected.keys()].sort()),
    writeTables: APP_LOCAL_TABLES
  };
}
