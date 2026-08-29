import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { SqliteAuditRepository } from "../../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import { SqliteReadinessRepository } from "../../lib/db/repositories/readinessRepository.js";
import { SqliteSettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { errorHandler } from "../../server/http/errors.js";
import { createAuthenticatedCoreRouter } from "../../server/routes/core.js";
import { withAppServer } from "../helpers/appTestServer.js";
import { withTestDatabase } from "../helpers/database.js";

const TENANT_ID = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
const ADMIN_OID = "d6c36f6e-054c-45b8-9468-16c208628814";
const USER_OID = "5190215f-1612-473e-974f-e4a46ff81d3e";

test("admin routes manage app-local roles and feature permissions with immutable audit", async () => {
  await withTestDatabase(async (database, directory) => {
    const identities = new SqliteIdentityRepository(database);
    const audit = new SqliteAuditRepository(database);
    const settings = new SqliteSettingsRepository(database);
    await identities.upsertIdentity({ tenantId: TENANT_ID, oid: ADMIN_OID });
    const admin = await identities.replaceRoles(
      TENANT_ID,
      ADMIN_OID,
      ["viewer", "operator", "admin"],
      { tenantId: TENANT_ID, oid: ADMIN_OID }
    );
    await identities.upsertIdentity({ tenantId: TENANT_ID, oid: USER_OID });

    const app = express();
    app.use(express.json());
    app.use((_request, response, next) => {
      response.locals.identity = admin;
      next();
    });
    app.use(
      createAuthenticatedCoreRouter({
        startedAt: Date.now(),
        databasePath: `${directory}/watchtower.db`,
        lifecycle: () => ({ state: "ready" }),
        readiness: new SqliteReadinessRepository(database, []),
        workers: { status: () => ({}) },
        identities,
        audit,
        settings
      })
    );
    app.use(errorHandler);

    await withAppServer(app, async (baseUrl) => {
      const roleResponse = await fetch(
        new URL(`/api/admin/users/${TENANT_ID}/${USER_OID}/roles`, baseUrl),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roles: ["viewer", "operator"] })
        }
      );
      assert.equal(roleResponse.status, 200);

      const featureResponse = await fetch(
        new URL(
          `/api/admin/users/${TENANT_ID}/${USER_OID}/features/unifi-config`,
          baseUrl
        ),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ canEdit: false, isHidden: true })
        }
      );
      assert.equal(featureResponse.status, 200);
      const user = await identities.getIdentity(TENANT_ID, USER_OID);
      assert.deepEqual(user?.roles, ["operator", "viewer"]);
      assert.deepEqual(user?.featurePermissions, {
        "unifi-config": { canEdit: false, isHidden: true }
      });

      const invalidFeature = await fetch(
        new URL(`/api/admin/users/${TENANT_ID}/${USER_OID}/features/plex`, baseUrl),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ canEdit: true, isHidden: false })
        }
      );
      assert.equal(invalidFeature.status, 400);

      const events = await audit.list(10);
      assert.deepEqual(
        events.map((event) => event.action),
        ["Updated app-local feature permission", "Updated app-local roles"]
      );
    });
  });
});
