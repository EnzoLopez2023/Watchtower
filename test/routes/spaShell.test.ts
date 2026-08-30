import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import type { RequestHandler } from "express";
import { migrateDatabase } from "../../lib/db/migrate.js";
import { SqliteAuditRepository } from "../../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import type { AppRole } from "../../lib/db/repositories/identityRepository.js";
import { EXPECTED_OWNED_TABLES } from "../../lib/db/import/ownership.js";
import { SqliteReadinessRepository } from "../../lib/db/repositories/readinessRepository.js";
import { SqliteSettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { createApp } from "../../server/app.js";
import { HttpError } from "../../server/http/errors.js";
import { createWatchtowerContainer } from "../../server/domain/container.js";
import { createFeatureRouters } from "../../server/routes/index.js";
import { withAppServer } from "../helpers/appTestServer.js";
import {
  identity,
  openTestDatabase,
  removeDatabase,
  stubApns,
  stubMediaHealth,
  testConfig
} from "../fixtures/monitoring/harness.js";

const INDEX_HTML = "<!doctype html><html><head><title>Watchtower</title></head><body></body></html>";
const APP_JS = "export const boot = () => undefined;\n";

let clientCounter = 0;

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  authCalls(): number;
  close(): void;
}

function createHarness(
  roles: readonly AppRole[] | null,
  options: {
    readonly withClient?: boolean;
    readonly entra?: Partial<ReturnType<typeof testConfig>["entra"]>;
  } = {}
): Harness {
  const { database, path } = openTestDatabase("spa-shell");
  migrateDatabase(database);
  const config = testConfig({
    entra: options.entra,
    serviceTokens: { ups: "ups-secret", mobile: "mobile-secret", unifi: "unifi-secret" }
  });
  const container = createWatchtowerContainer(database, config, {
    mediaHealth: stubMediaHealth(),
    apns: stubApns()
  });
  const routers = createFeatureRouters(container);

  let calls = 0;
  const current = roles ? identity(...roles) : null;
  const authenticate: RequestHandler = (_request, response, next) => {
    calls += 1;
    if (!current) {
      next(new HttpError(401, "missing_access_token", "A bearer access token is required"));
      return;
    }
    response.locals.identity = current;
    next();
  };

  // Always pass an explicit path: the repository may hold a real `dist/client`
  // from a concurrent build, and these assertions must not depend on it.
  const built = options.withClient !== false;
  const clientPath = join(
    resolve("./.scratch/wt/tmp"),
    `${built ? "client" : "absent-client"}-${process.pid}-${Date.now()}-${++clientCounter}`
  );
  if (built) {
    mkdirSync(join(clientPath, "assets"), { recursive: true });
    writeFileSync(join(clientPath, "index.html"), INDEX_HTML, "utf8");
    writeFileSync(join(clientPath, "assets", "app.js"), APP_JS, "utf8");
  }

  const app = createApp({
    config,
    core: {
      startedAt: Date.now(),
      databasePath: path,
      lifecycle: () => ({ state: "ready" }),
      readiness: new SqliteReadinessRepository(database),
      workers: { status: () => ({}) },
      identities: new SqliteIdentityRepository(database),
      audit: new SqliteAuditRepository(database),
      settings: new SqliteSettingsRepository(database)
    },
    authenticate,
    service: routers.service,
    features: routers.interactive,
    clientPath
  });

  return {
    app,
    authCalls: () => calls,
    close(): void {
      database.close();
      removeDatabase(path);
      rmSync(clientPath, { recursive: true, force: true });
    }
  };
}

test("the SPA shell and its assets load without a bearer token", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      // Deep links are client-side routes; the shell must answer all of them so
      // MSAL can run and acquire a token.
      for (const route of ["/", "/azure", "/unifi/devices", "/power"]) {
        const response = await fetch(new URL(route, base));
        assert.equal(response.status, 200, `${route} must serve the shell`);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.equal(await response.text(), INDEX_HTML);
      }

      const asset = await fetch(new URL("/assets/app.js", base));
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), APP_JS);
    });
    assert.equal(harness.authCalls(), 0, "no document or asset request may reach the Entra gate");
  } finally {
    harness.close();
  }
});

test("browser Entra configuration comes from the unauthenticated runtime contract", async () => {
  const tenantId = "52188f12-db6b-46c6-88ff-08c802f0ed3b";
  const clientId = "55bf92db-2cec-4e65-ab0d-71bee90d7494";
  const harness = createHarness(null, {
    entra: {
      tenantId,
      clientId,
      audience: `api://${clientId}`,
      configured: true
    }
  });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/runtime-config.js", base));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/javascript/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        await response.text(),
        `window.__WATCHTOWER_RUNTIME_CONFIG__={"entra":{"tenantId":"${tenantId}","clientId":"${clientId}","apiScope":"api://${clientId}/access_as_user"}};\n`
      );
    });
    assert.equal(harness.authCalls(), 0, "runtime config must load before the browser has a token");
  } finally {
    harness.close();
  }
});

test("the source shell loads runtime configuration before the application module", () => {
  const sourceShell = readFileSync(resolve("index.html"), "utf8");
  const runtimeConfig = sourceShell.indexOf('src="/runtime-config.js"');
  const applicationModule = sourceShell.indexOf('src="/src/main.tsx"');
  assert.ok(runtimeConfig >= 0, "the runtime configuration script must be present");
  assert.ok(applicationModule >= 0, "the application module must be present");
  assert.ok(runtimeConfig < applicationModule, "runtime configuration must execute before MSAL loads");
});

test("a missing asset is a 404, not the SPA shell", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/assets/missing.js", base));
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "not_found");
    });
  } finally {
    harness.close();
  }
});

test("public health and version stay open and never reach the Entra gate", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      for (const route of ["/api/live", "/api/ready", "/api/version", "/version.json"]) {
        const response = await fetch(new URL(route, base));
        assert.equal(response.status, 200, `${route} must stay public`);
      }
    });
    assert.equal(harness.authCalls(), 0);
  } finally {
    harness.close();
  }
});

/**
 * These fixtures deliberately keep the production readiness policy rather than
 * opting out with an empty table list: passing it proves the owned schema this
 * agent generates is exactly the set the data layer's ownership manifest
 * requires. A drift between the two fails here with a countable difference.
 */
test("readiness reports the complete owned schema, not an opted-out subset", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/ready", base));
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        ok: boolean;
        authority: { ownedTableCount: number; requiredOwnedTableCount: number };
      };
      assert.equal(body.ok, true);
      assert.equal(body.authority.requiredOwnedTableCount, EXPECTED_OWNED_TABLES.length);
      assert.equal(body.authority.ownedTableCount, EXPECTED_OWNED_TABLES.length);
    });
  } finally {
    harness.close();
  }
});

test("service ingest still authenticates by its own secret, ahead of Entra", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer ups-secret" },
        body: JSON.stringify({ ts: Date.now(), vars: { "ups.status": "OL" } })
      });
      assert.equal(response.status, 200);
    });
    assert.equal(harness.authCalls(), 0, "a collector must never be asked for a user token");
  } finally {
    harness.close();
  }
});

test("interactive API routes still require Entra", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      for (const route of ["/api/status", "/api/ups", "/api/me"]) {
        const response = await fetch(new URL(route, base));
        assert.equal(response.status, 401, `${route} must require a token`);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "missing_access_token");
      }
    });
    assert.ok(harness.authCalls() >= 3);
  } finally {
    harness.close();
  }
});

test("an unknown API path returns a typed 404, never the SPA shell", async () => {
  const harness = createHarness(["viewer", "operator", "admin"]);
  try {
    await withAppServer(harness.app, async (base) => {
      for (const route of ["/api/does-not-exist", "/api/unifi/nope", "/api/azure/"]) {
        const response = await fetch(new URL(route, base));
        assert.equal(response.status, 404, `${route} must not fall through to the shell`);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "not_found");
      }
    });
  } finally {
    harness.close();
  }
});

test("an unknown API path is refused before its existence is disclosed", async () => {
  const harness = createHarness(null);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/does-not-exist", base));
      assert.equal(response.status, 401, "authentication precedes existence disclosure");
    });
  } finally {
    harness.close();
  }
});

test("without a built client every unmatched route is a typed 404", async () => {
  const harness = createHarness(null, { withClient: false });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/azure", base));
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "not_found");
    });
  } finally {
    harness.close();
  }
});

test("an authenticated interactive read succeeds through the scoped gate", async () => {
  const harness = createHarness(["viewer"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/status", base));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { schema: number };
      assert.equal(body.schema, 1);
    });
  } finally {
    harness.close();
  }
});
