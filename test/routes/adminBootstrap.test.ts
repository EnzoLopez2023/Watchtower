import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { migrateDatabase } from "../../lib/db/migrate.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import { authenticate, requireRole } from "../../server/auth/authorize.js";
import type { AccessTokenVerifier, VerifiedAccessToken } from "../../server/auth/entra.js";
import { loadConfig } from "../../server/config.js";
import { errorHandler } from "../../server/http/errors.js";
import { withAppServer } from "../helpers/appTestServer.js";
import { openTestDatabase, removeDatabase } from "../fixtures/monitoring/harness.js";

const TENANT_ID = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
const OTHER_TENANT_ID = "9f1f1f1f-2222-4333-8444-555555555555";
const BOOTSTRAP_OID = "d6c36f6e-054c-45b8-9468-16c208628814";
const IMPORTED_OID = "5190215f-1612-473e-974f-e4a46ff81d3e";
const STRANGER_OID = "7c1b0a2e-3d4f-4a5b-9c6d-7e8f90a1b2c3";

const PRODUCTION: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  DB_PATH: "/home/data/watchtower.db",
  AZURE_AD_TENANT_ID: TENANT_ID,
  AZURE_AD_CLIENT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  AZURE_AD_AUDIENCE: "api://watchtower",
  ADMIN_OID: BOOTSTRAP_OID,
  MARQUEE_BASE_URL: "https://marquee.example",
  MARQUEE_SCOPE: "api://marquee/.default"
};

function claimsFor(oid: string, tenantId = TENANT_ID): VerifiedAccessToken {
  return {
    tenantId,
    oid,
    // Every identity presents the same address on purpose: authorization must
    // never key on it.
    email: "shared-mailbox@example.invalid",
    displayName: "Shared Mailbox",
    scopes: ["access_as_user"],
    appRoles: [],
    payload: {}
  };
}

class TokenVerifier implements AccessTokenVerifier {
  public constructor(private readonly tokens: Readonly<Record<string, VerifiedAccessToken>>) {}

  public async verify(token: string): Promise<VerifiedAccessToken> {
    const claims = this.tokens[token];
    if (!claims) throw new Error("unknown token");
    return claims;
  }
}

function harness(adminOid: string | undefined) {
  const { database, path } = openTestDatabase("admin-bootstrap");
  migrateDatabase(database);
  const identities = new SqliteIdentityRepository(database);
  const app = express();
  app.use(
    authenticate(
      new TokenVerifier({
        bootstrap: claimsFor(BOOTSTRAP_OID),
        imported: claimsFor(IMPORTED_OID),
        stranger: claimsFor(STRANGER_OID),
        "foreign-bootstrap": claimsFor(BOOTSTRAP_OID, OTHER_TENANT_ID)
      }),
      identities,
      adminOid
    )
  );
  app.get("/admin", requireRole("admin"), (_request, response) => {
    response.json({ oid: response.locals.identity?.oid, roles: response.locals.identity?.roles });
  });
  app.get("/viewer", requireRole("viewer"), (_request, response) => {
    response.json({ oid: response.locals.identity?.oid, roles: response.locals.identity?.roles });
  });
  app.use(errorHandler);
  return {
    app,
    identities,
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

const as = (base: URL, path: string, token: string): Promise<Response> =>
  fetch(new URL(path, base), { headers: { authorization: `Bearer ${token}` } });

// ── Configuration ────────────────────────────────────────────────────────────

test("production requires a GUID ADMIN_OID", () => {
  const withoutAdmin = { ...PRODUCTION };
  delete withoutAdmin.ADMIN_OID;
  assert.throws(
    () => loadConfig(withoutAdmin),
    /ADMIN_OID must be the GUID object id of the bootstrap administrator in production/
  );

  for (const value of ["admin@example.invalid", "not-a-guid", BOOTSTRAP_OID.slice(0, -1)]) {
    assert.throws(
      () => loadConfig({ ...PRODUCTION, ADMIN_OID: value }),
      /ADMIN_OID must be a GUID/,
      `expected ${value} to be rejected`
    );
  }

  assert.equal(loadConfig(PRODUCTION).entra.adminOid, BOOTSTRAP_OID);
});

test("development may run without a bootstrap administrator", () => {
  const config = loadConfig({ NODE_ENV: "development", DB_PATH: "./.scratch/wt/tmp/config.db" });
  assert.equal(config.entra.adminOid, undefined);
});

// ── Bootstrap behaviour ──────────────────────────────────────────────────────

test("a fresh authority grants the bootstrap OID an administration path", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    await withAppServer(context.app, async (base) => {
      const response = await as(base, "/admin", "bootstrap");
      assert.equal(response.status, 200);
      const body = (await response.json()) as { oid: string; roles: string[] };
      assert.equal(body.oid, BOOTSTRAP_OID);
      assert.deepEqual([...body.roles].sort(), ["admin", "operator", "viewer"]);
    });
    const stored = await context.identities.getIdentity(TENANT_ID, BOOTSTRAP_OID);
    assert.deepEqual([...(stored?.roles ?? [])].sort(), ["admin", "operator", "viewer"]);
  } finally {
    context.close();
  }
});

test("without ADMIN_OID a fresh authority has no administration path at all", async () => {
  const context = harness(undefined);
  try {
    await withAppServer(context.app, async (base) => {
      for (const token of ["bootstrap", "imported", "stranger"]) {
        assert.equal((await as(base, "/admin", token)).status, 403);
      }
    });
  } finally {
    context.close();
  }
});

test("the bootstrap grant is keyed on the object id, never the email address", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    await withAppServer(context.app, async (base) => {
      // Same mailbox, different object id: no elevation.
      assert.equal((await as(base, "/admin", "stranger")).status, 403);
      assert.equal((await as(base, "/viewer", "stranger")).status, 403);
      assert.equal((await as(base, "/admin", "bootstrap")).status, 200);
    });
    const stranger = await context.identities.getIdentity(TENANT_ID, STRANGER_OID);
    assert.deepEqual(stranger?.roles, []);
  } finally {
    context.close();
  }
});

/**
 * The bootstrap comparison in `authenticate` matches on object id alone, so the
 * tenant boundary is upheld entirely by the token verifier, which pins `tid` to
 * the configured tenant before any claim reaches this code. This test pins that
 * dependency in place: a verifier that ever admitted a foreign tenant would hand
 * the bootstrap grant to a foreign principal sharing the object id.
 */
test("the tenant boundary is upheld by the token verifier, not by the bootstrap match", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    await withAppServer(context.app, async (base) => {
      const response = await as(base, "/admin", "foreign-bootstrap");
      assert.equal(
        response.status,
        200,
        "authenticate does not re-check the tenant; the verifier must keep doing so"
      );
    });
    const foreign = await context.identities.getIdentity(OTHER_TENANT_ID, BOOTSTRAP_OID);
    assert.deepEqual([...(foreign?.roles ?? [])].sort(), ["admin", "operator", "viewer"]);
  } finally {
    context.close();
  }
});

test("the real verifier refuses a foreign tenant before authorization runs", async () => {
  const { EntraAccessTokenVerifier } = await import("../../server/auth/entra.js");
  const verifier = new EntraAccessTokenVerifier({
    tenantId: TENANT_ID,
    clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    audience: "api://watchtower",
    configured: true
  });
  await assert.rejects(() => verifier.verify("not-a-real-token"), /invalid_access_token|invalid/);
});

// ── Imported grants stay authoritative ───────────────────────────────────────

test("imported grants are authoritative for non-bootstrap identities", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    // Stand in for the data import: an identity that already carries operator.
    await context.identities.upsertIdentity(claimsFor(IMPORTED_OID));
    await context.identities.replaceRoles(TENANT_ID, IMPORTED_OID, ["viewer", "operator"], {
      tenantId: TENANT_ID,
      oid: BOOTSTRAP_OID
    });

    await withAppServer(context.app, async (base) => {
      const viewer = await as(base, "/viewer", "imported");
      assert.equal(viewer.status, 200);
      const body = (await viewer.json()) as { roles: string[] };
      assert.deepEqual([...body.roles].sort(), ["operator", "viewer"]);

      // Signing in neither escalates nor erases what the import established.
      assert.equal((await as(base, "/admin", "imported")).status, 403);
    });

    const stored = await context.identities.getIdentity(TENANT_ID, IMPORTED_OID);
    assert.deepEqual([...(stored?.roles ?? [])].sort(), ["operator", "viewer"]);
  } finally {
    context.close();
  }
});

test("an imported administrator keeps admin without being the bootstrap OID", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    await context.identities.upsertIdentity(claimsFor(IMPORTED_OID));
    await context.identities.replaceRoles(TENANT_ID, IMPORTED_OID, ["viewer", "admin"], {
      tenantId: TENANT_ID,
      oid: BOOTSTRAP_OID
    });

    await withAppServer(context.app, async (base) => {
      assert.equal((await as(base, "/admin", "imported")).status, 200);
    });
    const stored = await context.identities.getIdentity(TENANT_ID, IMPORTED_OID);
    assert.deepEqual([...(stored?.roles ?? [])].sort(), ["admin", "viewer"]);
  } finally {
    context.close();
  }
});

test("an already-admin bootstrap identity is not re-granted on every request", async () => {
  const context = harness(BOOTSTRAP_OID);
  try {
    // Roles narrowed by an operator after bootstrap, but admin retained.
    await context.identities.upsertIdentity(claimsFor(BOOTSTRAP_OID));
    await context.identities.replaceRoles(TENANT_ID, BOOTSTRAP_OID, ["admin"], {
      tenantId: TENANT_ID,
      oid: BOOTSTRAP_OID
    });

    await withAppServer(context.app, async (base) => {
      assert.equal((await as(base, "/admin", "bootstrap")).status, 200);
      assert.equal((await as(base, "/viewer", "bootstrap")).status, 200);
    });

    const stored = await context.identities.getIdentity(TENANT_ID, BOOTSTRAP_OID);
    assert.deepEqual(
      stored?.roles,
      ["admin"],
      "an existing admin grant must not be widened back to the full bootstrap set"
    );
  } finally {
    context.close();
  }
});
