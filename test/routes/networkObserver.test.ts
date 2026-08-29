import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteNetworkObserverRepository } from "../../lib/db/repositories/watchtower/networkObserverRepository.js";
import { SqliteAgentIngestReceiptRepository, deliveryIdFrom } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { createNetworkObserverServiceRouter, createNetworkObserverRouter } from "../../server/routes/features/networkObserver.js";
import type { NetworkObserverRepository } from "../../lib/db/repositories/watchtower/networkObserverRepository.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppConfig } from "../../server/config.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";

const TMP_DIR = join(import.meta.dirname, "..", "..", ".scratch", "wt", "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = join(TMP_DIR, `network-observer-test-${Date.now()}.db`);

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof openDatabase>;

const config = {
  serviceTokens: { networkObserver: "observer-test-token", unifi: "unifi-token" },
} as unknown as AppConfig;

function stubViewer(): express.RequestHandler {
  return (_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); };
}

before(() => {
  db = openDatabase({ path: DB_PATH, busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repo = new SqliteNetworkObserverRepository(db, receipts);

  const app = express();
  const svcRouter = createNetworkObserverServiceRouter({ config, repository: repo });
  svcRouter.post("/api/network-observer/ingest", express.json({ limit: "50mb" }), (_req, _res, next) => next());
  app.post("/api/network-observer/ingest", express.json({ limit: "50mb" }));
  app.use(svcRouter);
  app.use(stubViewer());
  app.use(express.json({ limit: "2mb" }));
  app.use(createNetworkObserverRouter({ config, repository: repo }));

  return new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  }).then(() => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM agent_ingest_receipts;
    DELETE FROM network_observer_latest;
    DELETE FROM network_probe_samples;
    DELETE FROM network_isp_samples;
    DELETE FROM network_snmp_device_samples;
    DELETE FROM network_snmp_interface_samples;
    DELETE FROM network_snmp_interface_events;
  `);
});

const basePayload = () => ({
  ts: Date.now(),
  observer_id: "hpz4g4",
  agent_build: 1,
  probes: [{
    kind: "lan", id: "gateway", label: "UDM Gateway", ok: true, latency_ms: 1.25,
    detail: { address: "192.0.2.1" },
  }],
  isp_metrics: [{
    host_id: "unifi-host", site_id: "default-site",
    metric_time: new Date().toISOString(), metric_type: "5m",
    wan: { ispName: "Example ISP", ispAsn: "64500", avgLatency: 14, maxLatency: 20, packetLoss: 0.2, download_kbps: 900000, upload_kbps: 40000, uptime: 100, downtime: 0 },
  }],
  snmp_devices: [{
    id: "core-switch", label: "Core Switch", host: "192.0.2.10", ok: true,
    system: { uptime_s: 1234, cpu_pct: 12, mem_pct: 34, temp_c: 42 },
    interfaces: [{
      if_index: 1, name: "eth1", admin_up: true, oper_up: true, speed_bps: 1000000000,
      in_octets: 100, out_octets: 200, in_bps: 1000, out_bps: 2000,
      in_errors: 1, out_errors: 2, in_discards: 3, out_discards: 4,
    }],
  }],
  diagnostics: { errors: {} },
});

async function post(path: string, body: unknown, token = "observer-test-token"): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

// ── Auth matrix ───────────────────────────────────────────────────────────────

test("ingest returns 503 when token is not configured", async () => {
  const noTokenConfig = { serviceTokens: {} } as unknown as AppConfig;
  const db2 = openDatabase({ path: join(TMP_DIR, `no-token-${Date.now()}.db`), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db2);
  const receipts2 = new SqliteAgentIngestReceiptRepository(db2);
  const repo2 = new SqliteNetworkObserverRepository(db2, receipts2);
  const app2 = express();
  app2.use(express.json());
  app2.use(createNetworkObserverServiceRouter({ config: noTokenConfig, repository: repo2 }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const url = `http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/network-observer/ingest`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer any" }, body: JSON.stringify(basePayload()) });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("not configured"));
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
    db2.close();
    rmSync(join(TMP_DIR, `no-token-${Date.now() - 1}.db`), { force: true });
  }
});

test("ingest returns 401 with bad token", async () => {
  const res = await post("/api/network-observer/ingest", basePayload(), "wrong-token");
  assert.equal(res.status, 401);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "Invalid or missing ingest token");
});

test("ingest returns 200 with correct token", async () => {
  const res = await post("/api/network-observer/ingest", basePayload());
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; probesStored: number };
  assert.equal(body.ok, true);
  assert.equal(body.probesStored, 1);
});

// ── Delivery-id idempotency ────────────────────────────────────────────────────

test("second ingest with same delivery-id returns duplicate=true and stores nothing", async () => {
  const payload = basePayload();
  const deliveryId = "test-delivery-001";
  const r1 = await fetch(`${baseUrl}/api/network-observer/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer observer-test-token", "x-hearth-delivery-id": deliveryId },
    body: JSON.stringify(payload),
  });
  assert.equal(r1.status, 200);
  const b1 = await r1.json() as { probesStored: number; duplicate: boolean };
  assert.equal(b1.duplicate, false);
  assert.equal(b1.probesStored, 1);

  const r2 = await fetch(`${baseUrl}/api/network-observer/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer observer-test-token", "x-hearth-delivery-id": deliveryId },
    body: JSON.stringify(payload),
  });
  assert.equal(r2.status, 200);
  const b2 = await r2.json() as { duplicate: boolean; probesStored: number };
  assert.equal(b2.duplicate, true);
  assert.equal(b2.probesStored, 0);
});

// ── Basic ingest and reads ─────────────────────────────────────────────────────

test("ingest stores probe + ISP + SNMP and latest observer reflects payload", async () => {
  await post("/api/network-observer/ingest", basePayload());

  const r = await get("/api/network-observer");
  const body = await r.json() as { ok: boolean; observers: Array<{ observer_id: string; payload: { probes: unknown[]; isp_metrics: unknown[]; snmp_devices: unknown[] } }> };
  assert.equal(body.ok, true);
  assert.equal(body.observers.length, 1);
  const obs = body.observers[0]!;
  assert.equal(obs.observer_id, "hpz4g4");
  assert.equal(obs.payload.probes.length, 1);
  assert.equal(obs.payload.isp_metrics.length, 1);
  assert.equal(obs.payload.snmp_devices.length, 1);
});

test("GET /api/network-observer/history returns probe points", async () => {
  await post("/api/network-observer/ingest", basePayload());
  const r = await get("/api/network-observer/history?range=24h");
  const body = await r.json() as { ok: boolean; points: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(body.points.length >= 1);
});

test("GET /api/network-observer/isp returns isp samples", async () => {
  await post("/api/network-observer/ingest", basePayload());
  const r = await get("/api/network-observer/isp?range=24h");
  const body = await r.json() as { ok: boolean; points: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(body.points.length >= 1);
});

test("GET /api/network-observer/snmp returns device and interface samples", async () => {
  await post("/api/network-observer/ingest", basePayload());
  const r = await get("/api/network-observer/snmp?range=24h");
  const body = await r.json() as { ok: boolean; devices: unknown[]; interfaces: unknown[] };
  assert.equal(body.ok, true);
  assert.equal(body.devices.length, 1);
  assert.equal(body.interfaces.length, 1);
});

test("SNMP events are emitted on interface state change", async () => {
  const p1 = basePayload();
  await post("/api/network-observer/ingest", p1);

  const p2 = { ...p1, ts: Date.now() + 1000, snmp_devices: [{ ...p1.snmp_devices[0]!, interfaces: [{ ...p1.snmp_devices[0]!.interfaces[0]!, oper_up: false }] }] };
  await post("/api/network-observer/ingest", p2);

  const r = await get("/api/network-observer/snmp-events?range=24h");
  const body = await r.json() as { ok: boolean; events: Array<{ previous_oper_up: number; oper_up: number }> };
  assert.equal(body.ok, true);
  assert.ok(body.events.length >= 1);
  const ev = body.events[0]!;
  assert.equal(ev.previous_oper_up, 1);
  assert.equal(ev.oper_up, 0);
});

test("ingest 400 on missing observer_id", async () => {
  const res = await post("/api/network-observer/ingest", { ts: Date.now(), probes: [] });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "observer_id is required");
});

test("isp upsert deduplicates on (observer_id, unifi_host_id, site_id, metric_time)", async () => {
  const p = basePayload();
  await post("/api/network-observer/ingest", p);
  await post("/api/network-observer/ingest", p);
  const r = await get("/api/network-observer/isp?range=24h");
  const body = await r.json() as { points: unknown[] };
  assert.equal(body.points.length, 1);
});

test("deliveryIdFrom extracts id from header", () => {
  const id = deliveryIdFrom("test-123", {});
  assert.equal(id, "test-123");
});

test("deliveryIdFrom extracts id from body", () => {
  const id = deliveryIdFrom(undefined, { delivery_id: "body-456" });
  assert.equal(id, "body-456");
});

test("invalid PROBE_KINDS are skipped", async () => {
  const p = { ...basePayload(), probes: [{ kind: "invalid", id: "x", ok: true }] };
  const res = await post("/api/network-observer/ingest", p);
  assert.equal(res.status, 200);
  const body = await res.json() as { probesStored: number };
  assert.equal(body.probesStored, 0);
});

test("unexpected ingest failures return a secret-safe 500", async () => {
  const app = express();
  const repository = {
    async ingest(): Promise<never> {
      throw new Error("SQLITE_ERROR: no such column: network_probe_samples.secret_col");
    }
  } as unknown as NetworkObserverRepository;
  app.use(createNetworkObserverServiceRouter({ config, repository }));

  await withAppServer(app, async (base) => {
    const response = await fetch(new URL("/api/network-observer/ingest", base), {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.serviceTokens.networkObserver,
        "content-type": "application/json"
      },
      body: JSON.stringify({ observer_id: "test-observer" })
    });
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.match(raw, /The request failed/);
    assert.doesNotMatch(raw, /secret_col|SQLITE_ERROR|network_probe_samples/);
  });
});
