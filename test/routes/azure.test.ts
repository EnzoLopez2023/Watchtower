import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AppConfig } from "../../server/config.js";
import type { AzureArmClients, AzureCache } from "../../server/clients/azure.js";
import { createAzureCache } from "../../server/clients/azure.js";
import { createAzureRouter } from "../../server/routes/features/azure.js";
import { errorHandler } from "../../server/http/errors.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppRole } from "../../lib/db/repositories/identityRepository.js";

// ── Minimal config helpers ───────────────────────────────────────────────────

function makeConfig(enabled = true): AppConfig {
  return {
    environment: "test",
    port: 3000,
    database: { path: ":memory:", busyTimeoutMs: 5000 },
    entra: { tenantId: "t", clientId: "c", audience: "a", configured: false },
    corsOrigins: [],
    serviceTokens: {},
    azure: {
      subscriptionId: enabled ? "00000000-0000-0000-0000-000000000001" : "",
      tenantId: "00000000-0000-0000-0000-000000000002",
      defaultResourceGroup: "rg-test",
      requestTimeoutMs: 5000,
      enabled,
    },
    monitoringArchive: { container: "c", settleHours: 0, intervalHours: 1, maxDaysPerRun: 1, leaseMs: 60000, enabled: false },
    alerts: { pollSeconds: 60, enabled: false },
    outagePostmortems: { enabled: false },
    marquee: { timeoutMs: 5000 },
    apns: { environment: "development", criticalAlerts: false, alertTtlSeconds: 3600 },
  } as unknown as AppConfig;
}

// ── Fake ARM clients ─────────────────────────────────────────────────────────

function makeClients(overrides: Partial<AzureArmClients> = {}): AzureArmClients {
  function list<T>(items: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const item of items) yield item;
      },
    };
  }

  const defaultClients: AzureArmClients = {
    resources: () => ({
      resourceGroups: { list: () => list([{ name: "rg-test", location: "eastus", tags: {} }]) },
      resources: {
        list: () => list([{ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/sites/myapp", name: "myapp", type: "Microsoft.Web/sites", location: "eastus" }]),
        getById: async (_id: string, _ver: string) => ({ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/sites/myapp", name: "myapp", type: "Microsoft.Web/sites", location: "eastus", tags: {}, sku: null, properties: null }),
      },
    } as unknown as ReturnType<AzureArmClients["resources"]>),
    webApps: () => ({
      webApps: {
        list: () => list([{ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/sites/myapp", name: "myapp", state: "Running", location: "eastus" }]),
        get: async (_rg: string, _name: string) => ({
          id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/sites/myapp",
          name: "myapp", state: "Running", location: "eastus",
          siteConfig: { linuxFxVersion: "NODE|18-lts", numberOfWorkers: 1, alwaysOn: true },
          enabledHostNames: ["myapp.azurewebsites.net"],
          tags: {},
        }),
        listApplicationSettings: async () => ({ properties: { WEBSITE_NODE_DEFAULT_VERSION: "18", MY_DEPLOYMENT: "gpt-4" } }),
        listHostNameBindings: () => list([]),
        listSlots: () => list([]),
      },
      appServicePlans: {
        list: () => list([{ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/serverfarms/plan1", name: "plan1", location: "eastus", sku: { name: "B1", tier: "Basic" }, reserved: true }]),
        listWebApps: (_rg: string, _n: string) => list([]),
      },
    } as unknown as ReturnType<AzureArmClients["webApps"]>),
    acr: () => ({
      registries: {
        list: () => list([{ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.ContainerRegistry/registries/myreg", name: "myreg", location: "eastus", sku: { name: "Basic" }, loginServer: "myreg.azurecr.io" }]),
        get: async (_rg: string, _name: string) => ({ loginServer: "myreg.azurecr.io", name: "myreg" }),
      },
    } as unknown as ReturnType<AzureArmClients["acr"]>),
    cognitive: () => ({
      accounts: { list: () => list([{ id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.CognitiveServices/accounts/ai1", name: "ai1", location: "eastus", kind: "OpenAI", sku: { name: "S0" }, properties: { endpoint: "https://ai1.cognitiveservices.azure.com/", provisioningState: "Succeeded" } }]) },
      deployments: {
        list: () => list([{ name: "gpt-4", properties: { model: { name: "gpt-4", version: "0613", format: "OpenAI" }, provisioningState: "Succeeded" }, sku: { name: "Standard", capacity: 10 } }]),
        get: async (_rg: string, _acct: string, _name: string) => ({ name: "gpt-4", id: "/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.CognitiveServices/accounts/ai1/deployments/gpt-4", properties: { model: { name: "gpt-4", version: "0613", format: "OpenAI" }, provisioningState: "Succeeded" } }),
      },
    } as unknown as ReturnType<AzureArmClients["cognitive"]>),
    monitor: () => ({
      metrics: {
        list: async (_id: string, _opts: unknown) => ({
          value: [{ timeseries: [{ data: [{ timeStamp: "2026-08-01T00:00:00Z", average: 50, maximum: 80, total: 100 }] }] }],
        }),
      },
    } as unknown as ReturnType<AzureArmClients["monitor"]>),
    health: () => ({} as unknown as ReturnType<AzureArmClients["health"]>),
    cost: () => ({
      query: {
        usage: async (_scope: string, _body: unknown) => ({
          columns: [{ name: "PreTaxCost" }, { name: "UsageDate" }, { name: "ServiceName" }, { name: "Currency" }],
          rows: [[5.0, "20260801", "App Service", "USD"]],
        }),
      },
    } as unknown as ReturnType<AzureArmClients["cost"]>),
    ...overrides,
  };
  return defaultClients;
}

// ── App builder ──────────────────────────────────────────────────────────────

function makeApp(opts: { role?: AppRole | null; enabled?: boolean; clients?: Partial<AzureArmClients>; cache?: AzureCache } = {}) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (opts.role != null) {
      res.locals.identity = {
        tenantId: "t", oid: "o", email: "x@x", displayName: "X",
        roles: [opts.role] as AppRole[],
        featurePermissions: {}, firstSeenAt: 0, lastSeenAt: 0,
      };
    }
    next();
  });
  const router = createAzureRouter({
    config: makeConfig(opts.enabled !== false),
    clients: makeClients(opts.clients),
    cache: opts.cache ?? createAzureCache(),
  });
  app.use(router);
  app.use(errorHandler);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("GET /api/azure/overview returns 503 when azure.enabled is false", async () => {
  await withAppServer(makeApp({ role: "viewer", enabled: false }), async (base) => {
    const res = await fetch(new URL("/api/azure/overview", base));
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(typeof body.error === "string");
  });
});

test("GET /api/azure/overview returns 403 without viewer role", async () => {
  await withAppServer(makeApp({ role: null }), async (base) => {
    const res = await fetch(new URL("/api/azure/overview", base));
    assert.equal(res.status, 403);
  });
});

test("GET /api/azure/overview returns expected shape with viewer role", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/overview", base));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.ok("subscription" in body);
    assert.ok("counts" in body);
    assert.ok("resourceGroups" in body);
    assert.ok("webAppsByState" in body);
    assert.ok("aggregates" in body);
    const counts = body.counts as Record<string, number>;
    assert.equal(counts.resourceGroups, 1);
    assert.equal(counts.webApps, 1);
  });
});

test("GET /api/azure/resources returns flat list with resourceGroup derived from id", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/resources", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { total: number; data: Array<Record<string, unknown>> };
    assert.equal(body.total, 1);
    assert.equal(body.data[0]?.resourceGroup, "rg-test");
  });
});

test("GET /api/azure/resources filters by ?rg=", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res1 = await fetch(new URL("/api/azure/resources?rg=rg-test", base));
    const b1 = await res1.json() as { total: number };
    assert.equal(b1.total, 1);

    const res2 = await fetch(new URL("/api/azure/resources?rg=nonexistent", base));
    const b2 = await res2.json() as { total: number };
    assert.equal(b2.total, 0);
  });
});

test("GET /api/azure/resource returns 400 when id is missing", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/resource", base));
    assert.equal(res.status, 400);
  });
});

test("GET /api/azure/resource returns shape for a valid id", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/resource?id=/subscriptions/x/resourceGroups/rg-test/providers/Microsoft.Web/sites/myapp", base));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.name, "myapp");
    assert.ok("type" in body);
    assert.ok("location" in body);
  });
});

test("GET /api/azure/webapps returns list with correct shape", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/webapps", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.name, "myapp");
    assert.ok("state" in (body.data[0] ?? {}));
    assert.ok("resourceGroup" in (body.data[0] ?? {}));
  });
});

test("GET /api/azure/webapps/:rg/:name returns detail shape", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/webapps/rg-test/myapp", base));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.name, "myapp");
    assert.ok("appSettings" in body);
    assert.ok("hostnameBindings" in body);
    assert.ok("memory24h" in body);
    assert.ok("series" in body);
  });
});

test("GET /api/azure/webapps/:rg/:name/metrics returns points array", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/webapps/rg-test/myapp/metrics", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { metric: string; points: unknown[] };
    assert.ok(Array.isArray(body.points));
    assert.ok("metric" in body);
  });
});

test("GET /api/azure/plans returns data with sites and metrics", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/plans", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 1);
    assert.ok("cpu24h" in (body.data[0] ?? {}));
    assert.ok("series" in (body.data[0] ?? {}));
  });
});

test("GET /api/azure/acr returns registries list", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/acr", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.name, "myreg");
    assert.ok("loginServer" in (body.data[0] ?? {}));
  });
});

test("GET /api/azure/cognitive returns accounts with deployments", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cognitive", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { data: Array<{ deployments: unknown[] }> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.deployments.length, 1);
  });
});

test("GET /api/azure/cognitive/:rg/:account/deployments/:name returns detail", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cognitive/rg-test/ai1/deployments/gpt-4", base));
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.name, "gpt-4");
    assert.ok("model" in body);
    assert.ok("raw" in body);
  });
});

test("GET /api/azure/cost returns daily + services breakdown", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cost", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { daily: unknown[]; services: unknown[]; total: number };
    assert.ok(Array.isArray(body.daily));
    assert.ok(Array.isArray(body.services));
    assert.ok(typeof body.total === "number");
  });
});

test("GET /api/azure/cost/service returns 400 when service is missing", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cost/service", base));
    assert.equal(res.status, 400);
  });
});

test("GET /api/azure/cost/service returns service breakdown", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cost/service?service=App+Service", base));
    assert.equal(res.status, 200);
    const body = await res.json() as { service: string; daily: unknown[]; resources: unknown[] };
    assert.equal(body.service, "App Service");
    assert.ok(Array.isArray(body.daily));
    assert.ok(Array.isArray(body.resources));
  });
});

test("POST /api/azure/cache/bust requires operator role", async () => {
  await withAppServer(makeApp({ role: "viewer" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cache/bust", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: "webapps" }),
    });
    assert.equal(res.status, 403);
  });
});

test("POST /api/azure/cache/bust returns 400 when prefix is missing", async () => {
  await withAppServer(makeApp({ role: "operator" }), async (base) => {
    const res = await fetch(new URL("/api/azure/cache/bust", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/azure/cache/bust clears only the matching prefix", async () => {
  const cache = createAzureCache();
  await cache.get("webapps-list", 300, async () => "webapps-data");
  await cache.get("acr-list",     300, async () => "acr-data");
  assert.equal(cache.size(), 2);

  await withAppServer(makeApp({ role: "operator", cache }), async (base) => {
    const res = await fetch(new URL("/api/azure/cache/bust", base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix: "webapps" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { busted: string };
    assert.equal(body.busted, "webapps");
  });

  assert.equal(cache.size(), 1);
  // acr-list should still be present
  let supplierCalled = false;
  await cache.get("acr-list", 300, async () => { supplierCalled = true; return "new"; });
  assert.equal(supplierCalled, false, "acr-list should still be cached after webapps bust");
});

test("cache: supplier is called once, second call is a cache hit", async () => {
  const cache = createAzureCache();
  let calls = 0;
  await cache.get("mykey", 300, async () => { calls++; return "val"; });
  await cache.get("mykey", 300, async () => { calls++; return "val2"; });
  assert.equal(calls, 1);
});

test("cache: evicts past cap of 500 entries without throwing", async () => {
  const cache = createAzureCache();
  for (let i = 0; i < 510; i++) {
    await cache.get(`key-${i}`, 300, async () => i);
  }
  assert.ok(cache.size() <= 500, `expected size <= 500, got ${cache.size()}`);
});

test("cache: expired entries are not returned", async () => {
  const cache = createAzureCache();
  let calls = 0;
  await cache.get("expkey", 0, async () => { calls++; return "old"; });
  // TTL=0 means it expires immediately — next call should invoke supplier again
  await new Promise<void>((r) => setTimeout(r, 10));
  await cache.get("expkey", 300, async () => { calls++; return "new"; });
  assert.equal(calls, 2);
});

test("timeout: ARM call timing out surfaces an error rather than hanging", async () => {
  // The fake resource list accepts abortSignal options and throws if the signal fires.
  const slowClients = makeClients({
    resources: () => ({
      resourceGroups: {
        list: (_opts?: { abortSignal?: AbortSignal }) => ({
          [Symbol.asyncIterator]: async function* () {
            const sig = (_opts)?.abortSignal;
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 10000);
              sig?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); });
            });
            yield { name: "rg", location: "eastus" };
          },
        }),
      },
      resources: { list: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    } as unknown as ReturnType<AzureArmClients["resources"]>),
  });
  const tightConfig = { ...makeConfig(), azure: { ...makeConfig().azure, requestTimeoutMs: 10 } };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.identity = { tenantId: "t", oid: "o", email: "x@x", displayName: "X", roles: ["viewer"] as AppRole[], featurePermissions: {}, firstSeenAt: 0, lastSeenAt: 0 };
    next();
  });
  app.use(createAzureRouter({ config: tightConfig, clients: slowClients, cache: createAzureCache() }));
  app.use(errorHandler);

  await withAppServer(app, async (base) => {
    const res = await fetch(new URL("/api/azure/overview", base));
    assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
  });
});
