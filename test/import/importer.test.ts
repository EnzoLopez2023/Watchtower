import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runImport } from "../../lib/db/import/importer.js";
import { reconcile } from "../../lib/db/import/reconcile.js";
import { openSourceReadonly } from "../../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../../lib/db/import/target.js";
import { readTableSchema, readSequences } from "../../lib/db/import/schema.js";
import {
  coreMigrationIdentities,
  expectedCoreSchema
} from "../../lib/db/import/appLocalSchema.js";
import { migrateDatabase } from "../../lib/db/migrate.js";
import { ImportError } from "../../lib/db/import/errors.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OID_A,
  FIXTURE_OWNED_TABLES,
  FIXTURE_TENANT_ID,
  makeScratchDir,
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

async function importFixture(
  directory: string,
  source: FixtureSource,
  overrides: Partial<Parameters<typeof runImport>[0]> = {}
): ReturnType<typeof runImport> {
  return runImport({
    ownership: fixtureOwnership(source),
    sourcePath: source.path,
    targetPath: join(directory, "target.sqlite3"),
    tenantId: FIXTURE_TENANT_ID,
    allowInsideGitWorktree: true,
    importedAtMs: 1_700_000_999_000,
    // The fixture deliberately contains one legacy user without an azure_oid.
    allowDispositions: ["identity_missing_oid"],
    // Synthetic fixtures are not the approved production baseline.
    __unsafeSkipApprovedBaselineGateForTests: true,
    ...overrides
  });
}

test("import reproduces the owned tables exactly and reconciles clean", async () => {
  const directory = scratch("import-happy");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  assert.equal(result.summary.tables.length, FIXTURE_OWNED_TABLES.length);
  assert.equal(result.summary.totalRowsCopied, source.ownedRowTotal);
  assert.ok(result.summary.rowTotalMatchesBaseline);
  assert.deepEqual(result.summary.indexesCreated, ["idx_wt_child_reading", "idx_wt_readings_received"]);
  assert.deepEqual(result.summary.triggersCreated, ["trg_wt_readings_guard"]);
  assert.equal(result.sourceVerifiedAfterRun?.sha256, source.sha256);

  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(result.targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const reconciliation = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.deepEqual(reconciliation.differences, []);
    assert.ok(reconciliation.ok);
    assert.ok(reconciliation.schema.matched);
    assert.ok(reconciliation.sequences.matched);
    assert.ok(reconciliation.foreignKeys.enforced);
    assert.equal(reconciliation.foreignKeys.violations.length, 0);
    assert.equal(reconciliation.totals.sourceRows, reconciliation.totals.targetRows);
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("storage classes, NULLs, unicode and BLOB bytes survive the copy", async () => {
  const directory = scratch("import-types");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  const targetDb = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  targetDb.defaultSafeIntegers(true);
  try {
    const typed = targetDb
      .prepare(
        "SELECT id, typeof(ratio) AS ratio_type, typeof(payload) AS payload_type, typeof(note) AS note_type, typeof(raw_value) AS raw_type, ratio, payload, label, raw_value FROM wt_readings ORDER BY id"
      )
      .all() as {
      id: bigint;
      ratio_type: string;
      payload_type: string;
      note_type: string;
      raw_type: string;
      ratio: number | null;
      payload: Buffer | null;
      label: string | null;
      raw_value: bigint | number | string | Buffer | null;
    }[];

    assert.equal(typed.length, 5);
    const [first, second, third, fourth, fifth] = typed as [
      (typeof typed)[number],
      (typeof typed)[number],
      (typeof typed)[number],
      (typeof typed)[number],
      (typeof typed)[number]
    ];
    assert.equal(first.ratio_type, "real");
    assert.equal(first.payload_type, "blob");
    assert.deepEqual(first.payload, Buffer.from([0x00, 0xff, 0x10]));

    assert.equal(second.label, "日本語 ✅ emoji 🎯");
    assert.equal(second.payload_type, "blob");
    assert.equal(second.payload?.byteLength, 0);
    assert.equal(second.note_type, "null");

    assert.equal(third.ratio_type, "null");
    assert.equal(third.payload_type, "null");
    assert.equal(third.raw_type, "null");

    assert.ok(Object.is(fourth.raw_value, -0), "negative zero must not become positive zero");
    assert.deepEqual(fourth.payload, Buffer.from("binary\u0000bytes", "utf8"));

    // REAL 2.0 must not be stored as INTEGER 2.
    assert.equal(fifth.ratio_type, "real");
    assert.equal(fifth.raw_type, "real");

    // A no-affinity column keeps every storage class exactly as bound.
    assert.deepEqual(
      typed.map((row) => row.raw_type),
      ["integer", "text", "null", "real", "real"]
    );

    const events = targetDb.prepare("SELECT event_id, detail FROM wt_keyed_events ORDER BY event_id").all() as {
      event_id: string;
      detail: string | null;
    }[];
    assert.deepEqual(
      events.map((row) => row.event_id),
      ["evt-001", "evt-002", "evt-003"]
    );
    assert.equal(events.at(2)?.detail, "ünïcödé détail");
  } finally {
    targetDb.close();
  }
});

test("implicit rowids are preserved for tables without an INTEGER primary key", async () => {
  const directory = scratch("import-rowid");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  const sourceDb = new Database(source.path, { readonly: true, fileMustExist: true });
  const targetDb = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  try {
    for (const table of ["wt_keyed_events", "wt_unique_only"]) {
      const schema = readTableSchema(sourceDb, table);
      assert.equal(schema.rowidAlias, null);
      assert.ok(schema.hasRowid);
      assert.ok(schema.orderingColumns.includes("rowid"));

      const before = sourceDb.prepare(`SELECT rowid FROM "${table}" ORDER BY rowid`).all();
      const after = targetDb.prepare(`SELECT rowid FROM "${table}" ORDER BY rowid`).all();
      assert.deepEqual(after, before);
    }
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("sqlite_sequence values are copied, not merely regenerated", async () => {
  const directory = scratch("import-seq");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  const sourceDb = new Database(source.path, { readonly: true, fileMustExist: true });
  const targetDb = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  try {
    const expected = readSequences(sourceDb, FIXTURE_OWNED_TABLES);
    const actual = readSequences(targetDb, FIXTURE_OWNED_TABLES);
    assert.deepEqual(actual, expected);
    // The fixture deletes the highest rowid, so the sequence exceeds MAX(id).
    assert.equal(expected.wt_readings, "9007199254");
    assert.equal(result.summary.sequences.wt_readings, "9007199254");
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("import is deterministic: two runs produce identical fingerprints", async () => {
  const directory = scratch("import-determinism");
  const source = buildSourceFixture(directory);

  const first = await importFixture(directory, source, { targetPath: join(directory, "a.sqlite3") });
  const second = await importFixture(directory, source, { targetPath: join(directory, "b.sqlite3") });

  const a = openTargetReadonly(first.targetPath, 5000);
  const b = openTargetReadonly(second.targetPath, 5000);
  try {
    const reconciliation = reconcile({
      source: a,
      target: b,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.deepEqual(reconciliation.differences, []);
    assert.ok(reconciliation.schema.matched);
  } finally {
    b.close();
    a.close();
  }
  assert.equal(
    first.summary.targetSchemaIdentity.digest,
    second.summary.targetSchemaIdentity.digest
  );
});

test("a pinned --imported-at-utc makes the whole target byte-reproducible", async () => {
  const directory = scratch("import-reproducible");
  const source = buildSourceFixture(directory);

  const first = await importFixture(directory, source, {
    targetPath: join(directory, "pin-a.sqlite3"),
    importedAtMs: 1_790_000_500_000
  });
  const second = await importFixture(directory, source, {
    targetPath: join(directory, "pin-b.sqlite3"),
    importedAtMs: 1_790_000_500_000
  });

  assert.equal(first.targetBytes, second.targetBytes);
  assert.equal(first.targetSha256, second.targetSha256);
  assert.equal(first.summary.importedAtUtc, "2026-09-21T14:21:40.000Z");
  assert.equal(first.summary.importedAtUtc, second.summary.importedAtUtc);

  const drifted = await importFixture(directory, source, {
    targetPath: join(directory, "pin-c.sqlite3"),
    importedAtMs: 1_790_000_600_000
  });
  assert.notEqual(drifted.targetSha256, first.targetSha256);
});

test("a source whose bytes or hash drifted is refused", async () => {
  const directory = scratch("import-source-drift");
  const source = buildSourceFixture(directory);
  const ownership = fixtureOwnership(source);

  await assert.rejects(
    runImport({
      ownership: { ...ownership, sourceBaseline: { ...ownership.sourceBaseline, backupBytes: source.bytes + 1 } },
      sourcePath: source.path,
      targetPath: join(directory, "bytes.sqlite3"),
      tenantId: FIXTURE_TENANT_ID,
      allowInsideGitWorktree: true,
      __unsafeSkipApprovedBaselineGateForTests: true
    }),
    (error: unknown) => error instanceof ImportError && error.code === "SOURCE_IDENTITY_MISMATCH"
  );

  await assert.rejects(
    runImport({
      ownership: {
        ...ownership,
        sourceBaseline: { ...ownership.sourceBaseline, backupSha256: "0".repeat(64) }
      },
      sourcePath: source.path,
      targetPath: join(directory, "sha.sqlite3"),
      tenantId: FIXTURE_TENANT_ID,
      allowInsideGitWorktree: true,
      __unsafeSkipApprovedBaselineGateForTests: true
    }),
    (error: unknown) => error instanceof ImportError && error.code === "SOURCE_IDENTITY_MISMATCH"
  );
});

test("a missing source is refused before anything is written", async () => {
  const directory = scratch("import-source-missing");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "never-created.sqlite3");

  await assert.rejects(
    importFixture(directory, source, { sourcePath: join(directory, "absent.sqlite3"), targetPath }),
    (error: unknown) => error instanceof ImportError && error.code === "SOURCE_MISSING"
  );
  assert.ok(!existsSync(targetPath));
});

test("a non-empty target is refused (rerun without cleaning)", async () => {
  const directory = scratch("import-nonempty");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "target.sqlite3");

  await importFixture(directory, source, { targetPath });
  await assert.rejects(
    importFixture(directory, source, { targetPath }),
    (error: unknown) => error instanceof ImportError && error.code === "TARGET_NOT_EMPTY"
  );
});

test("a target holding unrelated rows is refused", async () => {
  const directory = scratch("import-dirty");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "dirty.sqlite3");

  const seeded = new Database(targetPath);
  seeded.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  seeded.prepare("INSERT INTO unrelated (id) VALUES (1)").run();
  seeded.close();

  await assert.rejects(
    importFixture(directory, source, { targetPath }),
    (error: unknown) => error instanceof ImportError && error.code === "TARGET_NOT_EMPTY"
  );
});

test("the importer applies the app's own core migrations by default", async () => {
  const directory = scratch("import-migrate");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  assert.equal(result.summary.appLocalSchema.mode, "migrate");
  assert.deepEqual(
    result.summary.appLocalSchema.migrations.map((migration) => `${migration.version}:${migration.name}`),
    coreMigrationIdentities().map((migration) => `${migration.version}:${migration.name}`)
  );

  const database = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  try {
    // Every table the core migrations create must exist with the exact columns.
    for (const [table, expectedColumns] of expectedCoreSchema()) {
      const actual = (database.pragma(`table_info("${table}")`) as { name: unknown }[])
        .map((row) => String(row.name))
        .sort();
      assert.deepEqual(actual, expectedColumns, `column drift in ${table}`);
    }
    // v2 must be present, not just v1.
    assert.ok(expectedCoreSchema().has("runtime_instance_lease"));

    const recorded = database
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string; checksum: string }[];
    assert.deepEqual(recorded, coreMigrationIdentities());
  } finally {
    database.close();
  }
});

test("an empty migrated target is accepted with --app-local-schema=require", async () => {
  const directory = scratch("import-premigrated");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "migrated.sqlite3");

  const migrated = new Database(targetPath);
  migrated.pragma("journal_mode = DELETE");
  migrateDatabase(migrated);
  migrated.close();

  const result = await importFixture(directory, source, { targetPath, appLocalSchema: "require" });
  assert.equal(result.summary.appLocalSchema.mode, "require");
  assert.deepEqual(result.summary.appLocalSchema.migrations, coreMigrationIdentities());
});

test("--app-local-schema=require fails closed when migrations have not run", async () => {
  const directory = scratch("import-require-missing");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, {
      targetPath: join(directory, "bare.sqlite3"),
      appLocalSchema: "require"
    }),
    (error: unknown) => error instanceof ImportError && error.code === "APP_LOCAL_SCHEMA_MISSING"
  );
});

test("a target with a drifted migration checksum is refused", async () => {
  const directory = scratch("import-drifted-migration");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "drifted.sqlite3");

  const drifted = new Database(targetPath);
  drifted.pragma("journal_mode = DELETE");
  migrateDatabase(drifted);
  drifted
    .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
    .run("f".repeat(64));
  drifted.close();

  await assert.rejects(
    importFixture(directory, source, { targetPath, appLocalSchema: "require" }),
    (error: unknown) => error instanceof ImportError && error.code === "APP_LOCAL_SCHEMA_INCOMPATIBLE"
  );
});

test("a target carrying an unknown migration version is refused", async () => {
  const directory = scratch("import-unknown-migration");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "future.sqlite3");

  const future = new Database(targetPath);
  future.pragma("journal_mode = DELETE");
  migrateDatabase(future);
  future
    .prepare("INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
    .run(99, "from-the-future", Date.now(), "a".repeat(64));
  future.close();

  await assert.rejects(
    importFixture(directory, source, { targetPath, appLocalSchema: "require" }),
    (error: unknown) => error instanceof ImportError && error.code === "APP_LOCAL_SCHEMA_INCOMPATIBLE"
  );
});

test("a target with drifted app-local columns is refused", async () => {
  const directory = scratch("import-drifted-columns");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "columns.sqlite3");

  const drifted = new Database(targetPath);
  drifted.pragma("journal_mode = DELETE");
  migrateDatabase(drifted);
  drifted.exec("ALTER TABLE app_identities ADD COLUMN rogue_column TEXT");
  drifted.close();

  await assert.rejects(
    importFixture(directory, source, { targetPath, appLocalSchema: "require" }),
    (error: unknown) => error instanceof ImportError && error.code === "APP_LOCAL_SCHEMA_INCOMPATIBLE"
  );
});

test("a target that aliases the source is refused", async () => {
  const directory = scratch("import-alias");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, { targetPath: source.path }),
    (error: unknown) => error instanceof ImportError && error.code === "TARGET_ALIASES_SOURCE"
  );
});

test("a target inside a Git worktree is refused by default", async () => {
  const directory = scratch("import-git");
  const source = buildSourceFixture(directory);
  writeFileSync(join(directory, ".git"), "gitdir: /nowhere\n");
  await assert.rejects(
    importFixture(directory, source, {
      targetPath: join(directory, "in-git.sqlite3"),
      allowInsideGitWorktree: false
    }),
    (error: unknown) => error instanceof ImportError && error.code === "TARGET_IN_GIT_WORKTREE"
  );
});

test("a stale SQLite sidecar next to the target is refused", async () => {
  const directory = scratch("import-sidecar");
  const source = buildSourceFixture(directory);
  const targetPath = join(directory, "sidecar.sqlite3");
  writeFileSync(`${targetPath}-wal`, "");
  await assert.rejects(
    importFixture(directory, source, { targetPath }),
    (error: unknown) => error instanceof ImportError && error.code === "TARGET_SIDECAR_PRESENT"
  );
});

test("a non-GUID tenant id is refused", async () => {
  const directory = scratch("import-tenant");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, { tenantId: "not-a-guid" }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );
});

test("an admin OID with no imported identity is refused", async () => {
  const directory = scratch("import-admin");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, { adminOids: ["00000000-0000-4000-8000-000000000000"] }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );
});

test("an unapproved disposition blocks the import until acknowledged", async () => {
  const directory = scratch("import-disposition");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, {
      targetPath: join(directory, "blocked.sqlite3"),
      allowDispositions: []
    }),
    (error: unknown) => error instanceof ImportError && error.code === "DISPOSITION_NOT_APPROVED"
  );

  const acknowledged = await importFixture(directory, source, {
    targetPath: join(directory, "acknowledged.sqlite3"),
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });
  const rejected = acknowledged.dispositions.find(
    (disposition) => disposition.code === "identity_missing_oid"
  );
  assert.ok(rejected);
  assert.equal(rejected.rows, 1);
  assert.equal(rejected.kind, "reject");
  assert.ok(rejected.approved);
});

test("an unknown disposition code is refused outright", async () => {
  const directory = scratch("import-unknown-disposition");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, {
      targetPath: join(directory, "unknown.sqlite3"),
      allowDispositions: ["not_a_real_disposition"]
    }),
    (error: unknown) => error instanceof ImportError && error.code === "DISPOSITION_UNKNOWN"
  );
});

test("an out-of-range busy timeout is refused", async () => {
  const directory = scratch("import-busy");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    importFixture(directory, source, { busyTimeoutMs: 0 }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );
  await assert.rejects(
    importFixture(directory, source, { busyTimeoutMs: 999_999 }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );
});

test("the finished target runs journal DELETE with foreign keys enforced", async () => {
  const directory = scratch("import-pragmas");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  const database = new Database(result.targetPath, { fileMustExist: true });
  try {
    assert.equal(String(database.pragma("journal_mode", { simple: true })).toLowerCase(), "delete");
    database.pragma("foreign_keys = ON");
    assert.equal(Number(database.pragma("foreign_keys", { simple: true })), 1);
    assert.equal((database.pragma("foreign_key_check") as unknown[]).length, 0);

    assert.throws(() => {
      database.prepare("INSERT INTO wt_child_rows (reading_id, kind) VALUES (?, ?)").run(9999, "orphan");
    });
  } finally {
    database.close();
  }
});

test("batch sizing is respected and produces identical output", async () => {
  const directory = scratch("import-batch");
  const source = buildSourceFixture(directory);
  const small = await importFixture(directory, source, {
    targetPath: join(directory, "small.sqlite3"),
    batchRows: 1
  });
  const large = await importFixture(directory, source, {
    targetPath: join(directory, "large.sqlite3"),
    batchRows: 5000
  });

  assert.equal(small.summary.totalRowsCopied, large.summary.totalRowsCopied);
  const a = openTargetReadonly(small.targetPath, 5000);
  const b = openTargetReadonly(large.targetPath, 5000);
  try {
    const reconciliation = reconcile({
      source: a,
      target: b,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal
    });
    assert.deepEqual(reconciliation.differences, []);
  } finally {
    b.close();
    a.close();
  }
});

test("shared Hearth tables are never copied into the target", async () => {
  const directory = scratch("import-no-shared");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source);

  const database = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  try {
    const names = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name
      )
    );
    for (const shared of ["hearth_users", "hearth_permissions", "audit_log", "hearth_index", "other_product_table"]) {
      assert.ok(!names.has(shared), `${shared} must not exist in the target`);
    }
    assert.ok(names.has("app_identities"));
    assert.ok(names.has("app_audit_log"));
  } finally {
    database.close();
  }
});

test("admin role is granted only from explicit input", async () => {
  const directory = scratch("import-admin-ok");
  const source = buildSourceFixture(directory);
  const result = await importFixture(directory, source, { adminOids: [FIXTURE_OID_A] });

  const database = new Database(result.targetPath, { readonly: true, fileMustExist: true });
  try {
    const roles = database.prepare("SELECT oid, role FROM app_role_grants ORDER BY oid, role").all() as {
      oid: string;
      role: string;
    }[];
    const adminRoles = roles.filter((row) => row.role === "admin");
    assert.equal(adminRoles.length, 1);
    assert.equal(adminRoles.at(0)?.oid, FIXTURE_OID_A);
  } finally {
    database.close();
  }
});
