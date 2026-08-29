import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runImport } from "../../lib/db/import/importer.js";
import {
  assertOid,
  assertTenantId,
  parseLegacyUtcTimestamp
} from "../../lib/db/import/transform.js";
import { DISPOSITIONS, DispositionLedger, getDisposition } from "../../lib/db/import/dispositions.js";
import { ImportError } from "../../lib/db/import/errors.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OID_A,
  FIXTURE_OID_B,
  FIXTURE_TENANT_ID,
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

async function importedTarget(prefix: string): Promise<{ targetPath: string; result: Awaited<ReturnType<typeof runImport>> }> {
  const directory = scratch(prefix);
  const source = buildSourceFixture(directory);
  const result = await runImport({
    ownership: fixtureOwnership(source),
    sourcePath: source.path,
    targetPath: join(directory, "target.sqlite3"),
    tenantId: FIXTURE_TENANT_ID,
    adminOids: [FIXTURE_OID_A],
    allowInsideGitWorktree: true,
    importedAtMs: 1_700_000_999_000,
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });
  return { targetPath: result.targetPath, result };
}

test("tenant id and OID inputs must be GUID shaped", () => {
  assert.equal(assertTenantId(" 52188F12-DB6B-46C6-88FF-08C802F0ED3B "), "52188f12-db6b-46c6-88ff-08c802f0ed3b");
  assert.equal(assertOid(FIXTURE_OID_A.toUpperCase()), FIXTURE_OID_A);
  for (const bad of ["", "not-a-guid", "52188f12db6b46c688ff08c802f0ed3b", "enzo@nintek.com"]) {
    assert.throws(
      () => assertTenantId(bad),
      (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
    );
  }
});

test("legacy datetime('now') text parses as UTC milliseconds", () => {
  assert.equal(parseLegacyUtcTimestamp("2026-06-01 23:14:48"), Date.UTC(2026, 5, 1, 23, 14, 48));
  assert.equal(parseLegacyUtcTimestamp("2026-06-01T23:14:48Z"), Date.UTC(2026, 5, 1, 23, 14, 48));
  assert.equal(parseLegacyUtcTimestamp("2026-06-01 23:14:48.500"), Date.UTC(2026, 5, 1, 23, 14, 48, 500));
  assert.equal(parseLegacyUtcTimestamp(null), null);
  assert.equal(parseLegacyUtcTimestamp("not a timestamp"), null);
});

test("identities are keyed by (tenant_id, oid) and never by email", async () => {
  const { targetPath } = await importedTarget("transform-identity");
  const database = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare("SELECT tenant_id, oid, email_snapshot, display_name_snapshot, first_seen_at, last_seen_at FROM app_identities ORDER BY oid")
      .all() as {
      tenant_id: string;
      oid: string;
      email_snapshot: string | null;
      display_name_snapshot: string | null;
      first_seen_at: number;
      last_seen_at: number;
    }[];

    // The legacy user with a NULL azure_oid is rejected, not invented.
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.oid),
      [FIXTURE_OID_B, FIXTURE_OID_A].sort()
    );
    assert.ok(rows.every((row) => row.tenant_id === FIXTURE_TENANT_ID));

    const owner = rows.find((row) => row.oid === FIXTURE_OID_A);
    assert.ok(owner);
    assert.equal(owner.email_snapshot, "owner@example.test");
    assert.equal(owner.first_seen_at, Date.UTC(2026, 5, 1, 23, 14, 48));
    // last_seen_at advances to the most recent owned audit row for that OID.
    assert.equal(owner.last_seen_at, 1_790_000_201_100);

    const primaryKey = database.pragma("index_list(app_identities)") as { origin: string }[];
    assert.ok(primaryKey.some((index) => index.origin === "pk"));
  } finally {
    database.close();
  }
});

test("only Watchtower feature permissions are migrated", async () => {
  const { targetPath, result } = await importedTarget("transform-permissions");
  const database = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare("SELECT oid, feature, can_edit, is_hidden FROM app_feature_permissions ORDER BY oid, feature")
      .all() as { oid: string; feature: string; can_edit: number; is_hidden: number }[];

    assert.deepEqual(
      rows.map((row) => `${row.oid}:${row.feature}`),
      [`${FIXTURE_OID_A}:synology`, `${FIXTURE_OID_B}:protect`, `${FIXTURE_OID_B}:unifi-network`].sort()
    );
    const protect = rows.find((row) => row.feature === "protect");
    assert.equal(protect?.is_hidden, 1);
    assert.equal(protect?.can_edit, 0);

    // `recipe-manager` belongs to another product.
    assert.ok(!rows.some((row) => row.feature === "recipe-manager"));
    const skipped = result.dispositions.find((row) => row.code === "permission_not_watchtower_feature");
    assert.equal(skipped?.rows, 1);
    assert.equal(skipped?.kind, "skip");
  } finally {
    database.close();
  }
});

test("roles are derived conservatively from can_edit plus explicit admin input", async () => {
  const { targetPath } = await importedTarget("transform-roles");
  const database = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare("SELECT oid, role FROM app_role_grants ORDER BY oid, role").all() as {
      oid: string;
      role: string;
    }[];
    const byOid = new Map<string, string[]>();
    for (const row of rows) byOid.set(row.oid, [...(byOid.get(row.oid) ?? []), row.role]);

    // OID A has only can_edit = 0 permissions but is an explicit admin.
    assert.deepEqual(byOid.get(FIXTURE_OID_A), ["admin", "viewer"]);
    // OID B has a Watchtower feature with can_edit = 1.
    assert.deepEqual(byOid.get(FIXTURE_OID_B), ["operator", "viewer"]);
  } finally {
    database.close();
  }
});

test("audit rows are partitioned by owned view and owned API path", async () => {
  const { targetPath, result } = await importedTarget("transform-audit");
  const database = new Database(targetPath, { readonly: true, fileMustExist: true });
  try {
    const rows = database
      .prepare("SELECT legacy_id, view, path, category, user_oid, verified, tenant_id FROM app_audit_log ORDER BY legacy_id")
      .all() as {
      legacy_id: number;
      view: string | null;
      path: string | null;
      category: string;
      user_oid: string | null;
      verified: number;
      tenant_id: string;
    }[];

    // 1 (owned view), 2 (owned path on a shared view), 4 (owned view), 6 (owned view).
    assert.deepEqual(
      rows.map((row) => row.legacy_id),
      [1, 2, 4, 6]
    );
    assert.ok(rows.every((row) => row.tenant_id === FIXTURE_TENANT_ID));

    // Global sign-in stays with the monolith.
    assert.ok(!rows.some((row) => row.category === "auth"));
    // Another product's change row is not migrated.
    assert.ok(!rows.some((row) => row.path === "/api/recipes"));

    // An unmapped actor keeps its OID verbatim as historical evidence; there is
    // no app-local identity row to link it to.
    const unmapped = rows.find((row) => row.legacy_id === 4);
    assert.ok(unmapped);
    assert.equal(unmapped.user_oid, "99999999-9999-4999-8999-999999999999");
    const identityOids = new Set(
      (database.prepare("SELECT oid FROM app_identities").all() as { oid: string }[]).map((row) => row.oid)
    );
    assert.ok(unmapped.user_oid !== null && !identityOids.has(unmapped.user_oid));

    // verified is normalised into the 0/1 CHECK domain.
    const normalised = rows.find((row) => row.legacy_id === 6);
    assert.equal(normalised?.verified, 1);

    const dispositions = new Map(result.dispositions.map((row) => [row.code, row]));
    assert.equal(dispositions.get("audit_global_auth_event")?.rows, 1);
    assert.equal(dispositions.get("audit_not_watchtower_scope")?.rows, 1);
    assert.equal(dispositions.get("audit_unmapped_actor")?.rows, 1);
    assert.equal(dispositions.get("audit_verified_flag_normalised")?.rows, 1);
    assert.equal(dispositions.get("hearth_index_not_migrated")?.rows, 1);
    assert.equal(result.summary.transform.auditRowsImported, 4);
    assert.equal(result.summary.transform.auditRowsConsidered, 6);
  } finally {
    database.close();
  }
});

test("app_audit_log preserves legacy ids uniquely", async () => {
  const { targetPath } = await importedTarget("transform-audit-ids");
  const database = new Database(targetPath, { fileMustExist: true });
  try {
    const row = database.prepare("SELECT COUNT(DISTINCT legacy_id) AS d, COUNT(*) AS c FROM app_audit_log").get() as {
      d: number;
      c: number;
    };
    assert.equal(row.d, row.c);
    assert.throws(() => {
      database
        .prepare(
          "INSERT INTO app_audit_log (occurred_at, received_at, tenant_id, verified, category, action, legacy_id) VALUES (1, 1, 't', 0, 'change', 'dup', 1)"
        )
        .run();
    });
  } finally {
    database.close();
  }
});

test("every disposition is registered with a rationale", () => {
  assert.ok(DISPOSITIONS.length >= 8);
  for (const disposition of DISPOSITIONS) {
    assert.match(disposition.code, /^[a-z0-9_]+$/);
    assert.ok(disposition.rationale.length > 40, `${disposition.code} needs a rationale`);
    assert.ok(["skip", "retain", "reject"].includes(disposition.kind));
    assert.equal(getDisposition(disposition.code).code, disposition.code);
  }
  assert.throws(
    () => getDisposition("nope"),
    (error: unknown) => error instanceof ImportError && error.code === "DISPOSITION_UNKNOWN"
  );
});

test("DispositionLedger blocks unapproved codes and summarises counts", () => {
  const ledger = new DispositionLedger();
  ledger.record("permission_not_watchtower_feature", { feature: "recipes" });
  ledger.assertAllApproved();

  ledger.record("identity_missing_oid", { legacyUserId: 7 });
  assert.throws(
    () => ledger.assertAllApproved(),
    (error: unknown) => error instanceof ImportError && error.code === "DISPOSITION_NOT_APPROVED"
  );

  const acknowledged = new DispositionLedger(["identity_missing_oid"]);
  acknowledged.record("identity_missing_oid");
  acknowledged.assertAllApproved();
  const summary = acknowledged.summary();
  assert.equal(summary.length, 1);
  assert.equal(summary.at(0)?.rows, 1);
  assert.ok(summary.at(0)?.approved);
  assert.deepEqual(acknowledged.acknowledged, ["identity_missing_oid"]);
});
