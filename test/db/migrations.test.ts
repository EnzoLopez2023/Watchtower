import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateDatabase,
  migrationIdentities,
  migrationIdentityDigest
} from "../../lib/db/migrate.js";
import { withTestDatabase } from "../helpers/database.js";

test("app-owned migrations are deterministic and idempotent", async () => {
  await withTestDatabase(async (database) => {
    migrateDatabase(database);
    migrateDatabase(database);
    const rows = database
      .prepare("SELECT version, name, length(checksum) AS checksum_length FROM schema_migrations")
      .all() as Array<{ version: number; name: string; checksum_length: number }>;
    assert.deepEqual(rows, [
      { version: 1, name: "app-local-identity-audit-settings", checksum_length: 64 },
      { version: 2, name: "single-instance-lease", checksum_length: 64 }
    ]);
  });
});

test("migration identity drift fails closed", async () => {
  await withTestDatabase(async (database) => {
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    assert.throws(() => migrateDatabase(database), /identity does not match/);
  });
});

test("the migration identity digest covers version, name, and SQL checksum", () => {
  const identities = migrationIdentities();
  const digest = migrationIdentityDigest(identities);
  assert.match(digest, /^[0-9a-f]{64}$/);

  const first = identities[0];
  assert.ok(first);
  assert.notEqual(
    migrationIdentityDigest([
      { ...first, name: `${first.name}-renamed` },
      ...identities.slice(1)
    ]),
    digest
  );
  assert.notEqual(
    migrationIdentityDigest([
      { ...first, checksum: "0".repeat(64) },
      ...identities.slice(1)
    ]),
    digest
  );
});
