import assert from "node:assert/strict";
import test from "node:test";
import { SqliteAuditRepository } from "../../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import { SqliteSettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { withTestDatabase } from "../helpers/database.js";

const TENANT_ID = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
const ADMIN_OID = "d6c36f6e-054c-45b8-9468-16c208628814";

test("persists identities by tenant and OID with app-local roles", async () => {
  await withTestDatabase(async (database) => {
    const repository = new SqliteIdentityRepository(database);
    const first = await repository.upsertIdentity({
      tenantId: TENANT_ID,
      oid: ADMIN_OID,
      email: "old@example.invalid"
    });
    assert.deepEqual(first.roles, []);

    const updated = await repository.upsertIdentity({
      tenantId: TENANT_ID,
      oid: ADMIN_OID,
      email: "new@example.invalid"
    });
    assert.equal(updated.email, "new@example.invalid");
    assert.equal(updated.firstSeenAt, first.firstSeenAt);

    const granted = await repository.replaceRoles(
      TENANT_ID,
      ADMIN_OID,
      ["viewer", "operator", "admin"],
      { tenantId: TENANT_ID, oid: ADMIN_OID }
    );
    assert.deepEqual(granted.roles, ["admin", "operator", "viewer"]);
    const permitted = await repository.setFeaturePermission(
      TENANT_ID,
      ADMIN_OID,
      "protect",
      { canEdit: false, isHidden: true }
    );
    assert.deepEqual(permitted.featurePermissions, {
      protect: { canEdit: false, isHidden: true }
    });
  });
});

test("app-local audit rows cannot be updated or deleted", async () => {
  await withTestDatabase(async (database) => {
    const repository = new SqliteAuditRepository(database);
    const id = await repository.append({
      occurredAt: Date.now(),
      tenantId: TENANT_ID,
      userOid: ADMIN_OID,
      verified: true,
      category: "admin",
      action: "Changed role"
    });
    assert.throws(() =>
      database.prepare("UPDATE app_audit_log SET action = 'rewritten' WHERE id = ?").run(id)
    );
    assert.throws(() => database.prepare("DELETE FROM app_audit_log WHERE id = ?").run(id));
    assert.equal((await repository.list(10))[0]?.action, "Changed role");
  });
});

test("settings are OID scoped and bounded to supported keys", async () => {
  await withTestDatabase(async (database) => {
    const identities = new SqliteIdentityRepository(database);
    await identities.upsertIdentity({ tenantId: TENANT_ID, oid: ADMIN_OID });
    const settings = new SqliteSettingsRepository(database);
    await settings.set(TENANT_ID, ADMIN_OID, "appearance", { mode: "dark" });
    assert.deepEqual(await settings.getAll(TENANT_ID, ADMIN_OID), {
      appearance: { mode: "dark" }
    });
    await assert.rejects(settings.set(TENANT_ID, ADMIN_OID, "secret", "value"));
  });
});
