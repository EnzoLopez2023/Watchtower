import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import { authenticate, requireRole } from "../../server/auth/authorize.js";
import type {
  AccessTokenVerifier,
  VerifiedAccessToken
} from "../../server/auth/entra.js";
import { errorHandler } from "../../server/http/errors.js";
import { withAppServer } from "../helpers/appTestServer.js";
import { withTestDatabase } from "../helpers/database.js";

const TENANT_ID = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
const ADMIN_OID = "d6c36f6e-054c-45b8-9468-16c208628814";
const USER_OID = "5190215f-1612-473e-974f-e4a46ff81d3e";

function claims(oid: string): VerifiedAccessToken {
  return {
    tenantId: TENANT_ID,
    oid,
    email: "same-email@example.invalid",
    scopes: ["access_as_user"],
    appRoles: [],
    payload: {}
  };
}

class FakeVerifier implements AccessTokenVerifier {
  public async verify(token: string): Promise<VerifiedAccessToken> {
    return claims(token === "admin-token" ? ADMIN_OID : USER_OID);
  }
}

test("interactive authorization bootstraps only the configured OID", async () => {
  await withTestDatabase(async (database) => {
    const identities = new SqliteIdentityRepository(database);
    const app = express();
    app.use(authenticate(new FakeVerifier(), identities, ADMIN_OID));
    app.get("/viewer", requireRole("viewer"), (_request, response) => {
      response.json({ oid: response.locals.identity?.oid });
    });
    app.use(errorHandler);

    await withAppServer(app, async (baseUrl) => {
      const missing = await fetch(new URL("/viewer", baseUrl));
      assert.equal(missing.status, 401);

      const sameEmailWrongOid = await fetch(new URL("/viewer", baseUrl), {
        headers: { authorization: "Bearer user-token" }
      });
      assert.equal(sameEmailWrongOid.status, 403);

      const administrator = await fetch(new URL("/viewer", baseUrl), {
        headers: { authorization: "Bearer admin-token" }
      });
      assert.equal(administrator.status, 200);
      assert.deepEqual(await administrator.json(), { oid: ADMIN_OID });
      assert.deepEqual(
        (await identities.getIdentity(TENANT_ID, ADMIN_OID))?.roles,
        ["admin", "operator", "viewer"]
      );
      assert.deepEqual((await identities.getIdentity(TENANT_ID, USER_OID))?.roles, []);
    });
  });
});
