import assert from "node:assert/strict";
import test from "node:test";
import type { Express, RequestHandler } from "express";
import { migrateDatabase } from "../../lib/db/migrate.js";
import { SqliteAuditRepository } from "../../lib/db/repositories/auditRepository.js";
import type { StoredAuditEvent } from "../../lib/db/repositories/auditRepository.js";
import { SqliteIdentityRepository } from "../../lib/db/repositories/identityRepository.js";
import type { AppIdentity, AppRole } from "../../lib/db/repositories/identityRepository.js";
import { SqliteReadinessRepository } from "../../lib/db/repositories/readinessRepository.js";
import { SqliteSettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { createApp } from "../../server/app.js";
import { createWatchtowerContainer } from "../../server/domain/container.js";
import { auditInteractiveMutations } from "../../server/domain/auditTrail.js";
import { createFeatureRouters } from "../../server/routes/index.js";
import { withAppServer } from "../helpers/appTestServer.js";
import {
  canEditFeatures,
  identityWithFeatures,
  openTestDatabase,
  removeDatabase,
  stubApns,
  stubMediaHealth,
  testConfig
} from "../fixtures/monitoring/harness.js";

interface Harness {
  readonly app: Express;
  readonly audit: SqliteAuditRepository;
  events(): Promise<readonly StoredAuditEvent[]>;
  close(): void;
}

function createHarness(
  roles: readonly AppRole[] | null,
  featurePermissions: AppIdentity["featurePermissions"] = canEditFeatures("power-topology")
): Harness {
  const { database, path } = openTestDatabase("audit-trail");
  migrateDatabase(database);
  const config = testConfig({
    serviceTokens: { ups: "ups-secret", mobile: "mobile-secret", unifi: "unifi-secret" }
  });
  const container = createWatchtowerContainer(database, config, {
    mediaHealth: stubMediaHealth(),
    apns: stubApns()
  });
  const routers = createFeatureRouters(container);
  const audit = new SqliteAuditRepository(database);

  const current: AppIdentity | null = roles
    ? identityWithFeatures({ roles, featurePermissions })
    : null;
  const authenticate: RequestHandler = (_request, response, next) => {
    if (current) response.locals.identity = current;
    next();
  };

  const app = createApp({
    config,
    core: {
      startedAt: Date.now(),
      databasePath: path,
      lifecycle: () => ({ state: "ready" }),
      readiness: new SqliteReadinessRepository(database),
      workers: { status: () => ({}) },
      identities: new SqliteIdentityRepository(database),
      audit,
      settings: new SqliteSettingsRepository(database)
    },
    authenticate,
    service: routers.service,
    auditTrail: auditInteractiveMutations({ audit }),
    features: routers.interactive
  });

  return {
    app,
    audit,
    async events() {
      return audit.list(200);
    },
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

/** The audit row is written on `finish`, so give the listener a turn to run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("an authenticated mutation is recorded with method, path, status and identity", async () => {
  const harness = createHarness(["viewer", "operator"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/power/diagrams", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rack" })
      });
      assert.ok(response.status === 200 || response.status === 201);
      await settle();
    });

    const events = await harness.events();
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event);
    assert.equal(event.method, "POST");
    assert.equal(event.path, "/api/power/diagrams");
    assert.equal(event.action, "POST /api/power/diagrams");
    assert.equal(event.category, "change");
    assert.equal(event.verified, true);
    assert.equal(event.tenantId, "00000000-0000-0000-0000-000000000001");
    assert.equal(event.userOid, "00000000-0000-0000-0000-000000000002");
    assert.ok(event.status === 200 || event.status === 201);
    // No request or response body, and no per-user snapshot beyond the identity.
    assert.equal(event.detail, undefined);
    assert.equal(event.view, undefined);
    assert.equal(event.emailSnapshot, undefined);
    assert.equal(event.nameSnapshot, undefined);
  } finally {
    harness.close();
  }
});

test("a mutation denied by a role guard is still recorded", async () => {
  const harness = createHarness(["viewer"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/power/diagrams", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rack" })
      });
      assert.equal(response.status, 403);
      await settle();
    });

    const events = await harness.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 403);
    assert.equal(events[0]?.action, "POST /api/power/diagrams");
  } finally {
    harness.close();
  }
});

test("reads are not recorded", async () => {
  const harness = createHarness(["viewer"]);
  try {
    await withAppServer(harness.app, async (base) => {
      for (const path of ["/api/status", "/api/ups", "/api/power/diagrams", "/api/live"]) {
        await fetch(new URL(path, base));
      }
      await settle();
    });
    assert.equal((await harness.events()).length, 0);
  } finally {
    harness.close();
  }
});

test("agent ingest is never attributed to a user", async () => {
  const harness = createHarness(["viewer", "operator", "admin"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer ups-secret" },
        body: JSON.stringify({ ts: Date.now(), vars: { "ups.status": "OL" } })
      });
      assert.equal(response.status, 200);
      await settle();
    });
    assert.equal(
      (await harness.events()).length,
      0,
      "a collector push carries no user and must not appear as one"
    );
  } finally {
    harness.close();
  }
});

test("mobile device registration is never attributed to a user", async () => {
  const harness = createHarness(["viewer", "operator", "admin"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/mobile/register-device", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mobile-secret" },
        body: JSON.stringify({ token: "d".repeat(64) })
      });
      assert.equal(response.status, 200);
      await settle();
    });
    assert.equal((await harness.events()).length, 0);
  } finally {
    harness.close();
  }
});

test("the recorded path never carries a query string", async () => {
  const harness = createHarness(["viewer", "operator"]);
  try {
    await withAppServer(harness.app, async (base) => {
      await fetch(new URL("/api/power/diagrams?token=super-secret&trace=1", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rack" })
      });
      await settle();
    });
    const events = await harness.events();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.path, "/api/power/diagrams");
    assert.equal(events[0]?.action, "POST /api/power/diagrams");
    for (const value of Object.values(events[0] ?? {})) {
      assert.ok(!String(value).includes("super-secret"), "no query value may reach the audit row");
    }
  } finally {
    harness.close();
  }
});

test("admin-scoped mutations are categorised as admin", async () => {
  const harness = createHarness(["viewer", "operator", "admin"]);
  try {
    await withAppServer(harness.app, async (base) => {
      await fetch(new URL("/api/admin/users/t/o/roles", base), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles: ["viewer"] })
      });
      await settle();
    });
    const events = await harness.events();
    const transport = events.filter((event) => event.action.startsWith("PUT /api/admin/users"));
    assert.equal(transport.length, 1);
    assert.equal(transport[0]?.category, "admin");
  } finally {
    harness.close();
  }
});

test("the audit ingestion endpoint is not double-recorded", async () => {
  const harness = createHarness(["viewer"]);
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/audit/events", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "navigation", action: "Opened dashboard" })
      });
      assert.equal(response.status, 201);
      await settle();
    });
    const events = await harness.events();
    assert.equal(events.length, 1, "only the client-submitted event is stored");
    assert.equal(events[0]?.action, "Opened dashboard");
  } finally {
    harness.close();
  }
});

test("a failing handler returns a secret-safe body", async () => {
  const harness = createHarness(["viewer", "operator"]);
  try {
    await withAppServer(harness.app, async (base) => {
      // A malformed graph payload drives the write path into a failure.
      const response = await fetch(new URL("/api/power/diagrams/99999/graph", base), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: "not-an-array" })
      });
      assert.ok(response.status >= 400);
      const body = (await response.json()) as { error?: unknown };
      const text = JSON.stringify(body);
      assert.ok(!/SQLITE|SQL|constraint|\/Users\//i.test(text), `leaky error body: ${text}`);
      await settle();
    });
  } finally {
    harness.close();
  }
});
