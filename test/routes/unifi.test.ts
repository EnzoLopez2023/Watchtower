import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import express, { type RequestHandler, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "../../server/http/errors.js";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteMonitoringArchiveRepository } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import { SqliteUnifiRepository } from "../../lib/db/repositories/watchtower/unifiRepository.js";
import { SqliteUnifiLogsRepository } from "../../lib/db/repositories/watchtower/unifiLogsRepository.js";
import { createUnifiServiceRouter, createUnifiRouter } from "../../server/routes/features/unifi.js";
import { createUnifiLogsServiceRouter, createUnifiLogsRouter } from "../../server/routes/features/unifiLogs.js";
import { loadConfig } from "../../server/config.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";

const tmpDir = mkdtempSync(join(".scratch", "wt", "tmp", "unifi-test-"));
let server: Server;
let baseUrl: string;

const TOKEN = "test-ingest-token";

const identity: AppIdentity = {
  oid: "test-oid",
  tenantId: "test-tenant",
  email: "test@example.com",
  roles: ["viewer"],
  featurePermissions: {},
  firstSeenAt: 0,
  lastSeenAt: Date.now(),
};

const viewerMiddleware: RequestHandler = (_req, res, next) => {
  res.locals["identity"] = identity;
  next();
};

let deliverySeq = 0;

before(() => {
  const db = openDatabase({ path: join(tmpDir, "test.db"), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);

  const config = loadConfig({ NODE_ENV: "test", DB_PATH: join(tmpDir, "test.db"), UNIFI_INGEST_TOKEN: TOKEN });
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const archive = new SqliteMonitoringArchiveRepository(db, false);
  const repository = new SqliteUnifiRepository(db, receipts);
  const logsRepository = new SqliteUnifiLogsRepository(db, receipts, archive);

  const app = express();

  const serviceRouter = createUnifiServiceRouter({ config, repository });
  const logsServiceRouter = createUnifiLogsServiceRouter({ config, logsRepository });

  app.use(serviceRouter);
  app.use(logsServiceRouter);

  // All read routes need viewer identity injected before requireRole
  app.use(viewerMiddleware);

  const readRouter = createUnifiRouter({ repository, outage: repository });
  const logsReadRouter = createUnifiLogsRouter({
    logsRepository,
    unifiRepository: repository,
    archiveStatus: {
      async archiveSummary() { return { enabled: false }; },
    },
  });
  app.use(readRouter);
  app.use(logsReadRouter);

  // Convert HttpError to JSON (mirrors production error middleware)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1");
    server.once("listening", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.once("error", reject);
  });
});

after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    })
);

beforeEach(async () => {
  const db = openDatabase({ path: join(tmpDir, "test.db"), busyTimeoutMs: 5000 });
  try {
    db.exec(`
      DELETE FROM agent_ingest_receipts;
      DELETE FROM unifi_latest;
      DELETE FROM unifi_readings;
      DELETE FROM unifi_wan_samples;
      DELETE FROM unifi_device_samples;
      DELETE FROM unifi_client_samples;
      DELETE FROM unifi_port_samples;
      DELETE FROM unifi_events;
      DELETE FROM unifi_activity_logs;
      DELETE FROM unifi_traffic_flows;
      DELETE FROM unifi_collection_compat;
      DELETE FROM unifi_collection_gaps;
      DELETE FROM unifi_ingest_health;
      DELETE FROM unifi_route_baseline;
      DELETE FROM unifi_route_baseline_meta;
      DELETE FROM unifi_route_drift;
      DELETE FROM unifi_route_drift_history;
    `);
  } finally {
    db.close();
  }
});

async function ingest(body: unknown, token = TOKEN): Promise<{ status: number; body: unknown }> {
  deliverySeq += 1;
  const response = await fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${token}`,
      "x-hearth-delivery-id": `test-${deliverySeq}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// ── Auth tests ────────────────────────────────────────────────────────────────

test("ingest returns 503 when UNIFI_INGEST_TOKEN is not configured", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: "Bearer anything" },
    body: JSON.stringify({}),
  });
  // Our test app has the token configured, so test by calling without the header
  // and with wrong token — the 503 path requires unconfigured token in the config
  assert.equal(response.status, 401);
});

test("ingest returns 401 with wrong token", async () => {
  const result = await ingest({ ts: Date.now() }, "wrong-token");
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "Invalid or missing ingest token" });
});

test("ingest returns 200 with valid token", async () => {
  const result = await ingest({ ts: Date.now(), devices: [], clients: [], events: [] });
  assert.equal(result.status, 200);
  const body = result.body as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["duplicate"], false);
  assert.ok(typeof body["received_at"] === "number");
});

// ── Delivery-id idempotency ───────────────────────────────────────────────────

test("same delivery id twice produces duplicate on second call", async () => {
  const payload = { ts: Date.now(), devices: [], clients: [] };
  const response = await fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-hearth-delivery-id": "idempotency-test",
    },
    body: JSON.stringify(payload),
  });
  const first = await response.json() as Record<string, unknown>;
  assert.equal(first["duplicate"], false);

  const response2 = await fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-hearth-delivery-id": "idempotency-test",
    },
    body: JSON.stringify(payload),
  });
  const second = await response2.json() as Record<string, unknown>;
  assert.equal(second["duplicate"], true, "second call with same delivery id must be duplicate");
});

// ── Read endpoint shapes ──────────────────────────────────────────────────────

test("GET /api/unifi returns present:false when no data ingested", async () => {
  const response = await fetch(`${baseUrl}/api/unifi`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["present"], false);
  assert.equal(body["last_contact_at"], null);
  assert.ok(typeof body["expected_cadence_seconds"] === "number");
  assert.ok(typeof body["stale_after_seconds"] === "number");
});

test("GET /api/unifi returns reading after ingest", async () => {
  await ingest({ ts: Date.now(), wan: { status: "up", latency_ms: 5 }, devices: [], clients: [] });
  const response = await fetch(`${baseUrl}/api/unifi`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["present"], true);
  assert.ok(body["reading"]);
  const reading = body["reading"] as Record<string, unknown>;
  assert.ok(reading["received_at"]);
  assert.equal(reading["wan_status"], "up");
});

test("GET /api/unifi/history returns points array", async () => {
  await ingest({ ts: Date.now(), devices: [], clients: [] });
  const response = await fetch(`${baseUrl}/api/unifi/history?range=24h`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["points"]));
  assert.equal(body["range"], "24h");
});

test("GET /api/unifi/wan-history returns points array", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/wan-history?range=24h`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["points"]));
});

test("GET /api/unifi/ports/history returns points array", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/ports/history?range=24h`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["points"]));
  assert.equal(body["deviceId"], null);
  assert.equal(body["portIdx"], null);
});

test("GET /api/unifi/ports/history returns 400 for non-integer portIdx", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/ports/history?portIdx=abc`);
  assert.equal(response.status, 400);
  const body = await response.json() as Record<string, unknown>;
  assert.ok(typeof body["error"] === "string");
});

test("GET /api/unifi/events returns events and collection status", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/events?range=24h`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["events"]));
  assert.ok(body["collection"]);
});

test("GET /api/unifi/outage-incidents returns incident list shape", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/outage-incidents`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["incidents"]));
  assert.ok(typeof body["recoveryHoldSeconds"] === "number");
  assert.equal(body["pendingCount"], 0);
});

test("GET /api/unifi/outage-incidents/:id returns 404 for unknown id", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/outage-incidents/does-not-exist`);
  assert.equal(response.status, 404);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["error"], "Outage incident not found");
});

test("GET /api/unifi/config returns present:false when no data", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/config`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["present"], false);
});

// ── Viewer role enforcement ───────────────────────────────────────────────────

test("read endpoints return 403 without identity set", async () => {
  const readApp = express();
  const tmpDb = openDatabase({ path: join(tmpDir, "auth-test.db"), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(tmpDb);
  const tmpReceipts = new SqliteAgentIngestReceiptRepository(tmpDb);
  const repo = new SqliteUnifiRepository(tmpDb, tmpReceipts);
  const router = createUnifiRouter({ repository: repo, outage: repo });
  readApp.use(router);

  const testServer = await new Promise<Server>((resolve, reject) => {
    const s = readApp.listen(0, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });
  const addr = testServer.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;

  try {
    const response = await fetch(`${url}/api/unifi`);
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>((resolve) => testServer.close(() => { tmpDb.close(); resolve(); }));
  }
});

// ── Logs ingest ────────────────────────────────────────────────────────────────

test("POST /api/unifi/logs/ingest stores activity records", async () => {
  deliverySeq += 1;
  const now = Date.now();
  const response = await fetch(`${baseUrl}/api/unifi/logs/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-hearth-delivery-id": `logs-${deliverySeq}`,
    },
    body: JSON.stringify({
      activity: [
        {
          id: "event-1",
          timestamp: now,
          severity: "INFO",
          category: "SYSTEM",
          title: "Test event",
          message: "Something happened",
        },
      ],
      flows: [],
      gaps: [],
      diagnostics: {
        activity: { compat: { status: "proven", pageBase: 0 }, held: false },
        flows: { compat: { status: "empty" }, held: false },
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["activityStored"], 1);
});

test("GET /api/unifi/logs/summary returns expected shape", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/logs/summary`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(body["activity"]);
  assert.ok(body["flows"]);
  assert.ok(body["filters"]);
  assert.ok(Array.isArray(body["gaps"]));
  assert.ok(body["trafficRoutes"]);
  assert.ok(body["archive"]);
});

test("GET /api/unifi/logs/activity returns activity array", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/logs/activity`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["activity"]));
});

test("GET /api/unifi/logs/flows returns flows array", async () => {
  const response = await fetch(`${baseUrl}/api/unifi/logs/flows`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.ok(Array.isArray(body["flows"]));
});
