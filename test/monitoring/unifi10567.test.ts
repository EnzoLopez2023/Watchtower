// UniFi Network 10.5.67 payload-shape tests — port of routes/unifi10567.test.js.
// Synthetic fixtures only; no network calls.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { openDatabase, type SqliteDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteUnifiRepository } from "../../lib/db/repositories/watchtower/unifiRepository.js";import { createUnifiServiceRouter, createUnifiRouter } from "../../server/routes/features/unifi.js";
import { loadConfig } from "../../server/config.js";
import { portStateFingerprint, shouldRecordPortSample } from "../../lib/monitoring/unifiTelemetry.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";
import type { RequestHandler } from "express";

const tmpDir = mkdtempSync(join(".scratch", "wt", "tmp", "unifi-10567-"));
const TOKEN = "shape-test-token";

let db: SqliteDatabase;
let server: Server;
let baseUrl: string;
let repository: SqliteUnifiRepository;

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

before(() => {
  db = openDatabase({ path: join(tmpDir, "test.db"), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);

  const config = loadConfig({
    NODE_ENV: "test",
    DB_PATH: join(tmpDir, "test.db"),
    UNIFI_INGEST_TOKEN: TOKEN,
  });
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  repository = new SqliteUnifiRepository(db, receipts);

  const app = express();
  app.use(createUnifiServiceRouter({ config, repository }));
  app.use(viewerMiddleware);
  app.use(createUnifiRouter({ repository, outage: repository }));

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
        db.close();
        rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    })
);

beforeEach(() => {
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
    DELETE FROM unifi_collection_compat;
    DELETE FROM unifi_route_baseline;
    DELETE FROM unifi_route_baseline_meta;
    DELETE FROM unifi_route_drift;
    DELETE FROM unifi_route_drift_history;
  `);
});

let deliverySeq = 0;

async function ingest(snapshot: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  deliverySeq += 1;
  const response = await fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-hearth-delivery-id": `shape-${deliverySeq}`,
    },
    body: JSON.stringify(snapshot),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const config1057 = (): Record<string, unknown> => ({
  controller_version: "10.5.67",
  networks: [],
  wifi: [],
  firewall: { zones: [], policies: [] },
  acls: [],
  dns_policies: [],
  vpn: { servers: [], tunnels: [] },
  switching: { lags: [], stacks: [], mc_lag_domains: [] },
  pending_devices: [],
  device_tags: [],
  radius_profiles: [],
  wans: [
    { id: "wan-id-1", name: "Fiber" },
    { id: "wan-id-2", name: "Cable" },
    { id: "wan-id-3", name: "Cellular" },
  ],
  traffic_lists: [],
  voucher_count: 0,
  voucher_active: 0,
  port_forwards: [
    {
      id: "pf-1",
      name: "Console",
      enabled: true,
      proto: "tcp",
      src: "any",
      dst_port: "32400",
      fwd_ip: "10.0.0.20",
      fwd_port: "32400",
      interface: "wan",
      log: false,
    },
  ],
  wan_health: { subsystem: "wan", status: "ok" },
});

const uptimeStats = ({ active = "WAN" }: { active?: string } = {}): Record<string, unknown> => ({
  WAN:
    active === "WAN"
      ? {
          alerting_monitors: [],
          availability: 100,
          latency_average: 11,
          monitors: [],
          time_period: 86400,
          uptime: 864000,
        }
      : { alerting_monitors: [], downtime: 900, monitors: [] },
  WAN2:
    active === "WAN2"
      ? {
          alerting_monitors: [],
          availability: 99.1,
          latency_average: 38,
          monitors: [],
          time_period: 86400,
          uptime: 900,
        }
      : { alerting_monitors: [], downtime: 3600, monitors: [] },
  WAN3:
    active === "WAN3"
      ? {
          alerting_monitors: [],
          availability: 100,
          latency_average: 52,
          time_period: 86400,
          uptime: 300,
        }
      : { alerting_monitors: [], downtime: 7200 },
});

const device1057 = (): Record<string, unknown> => ({
  id: "switch-1",
  name: "Core Switch",
  model: "USW",
  online: true,
  uptime: 12345,
  cpu: 12.5,
  mem: 41.2,
  temperature: 39.5,
  rx_bps: 1000,
  tx_bps: 2000,
  poe_power: 7.4,
  ports: [
    {
      idx: 1,
      name: "AP uplink",
      connected: "Office AP",
      up: true,
      speed: 1000,
      max_speed: 2500,
      full_duplex: true,
      poe_enabled: true,
      poe_active: true,
      poe_power: 7.4,
      rx_errors: 1,
      tx_errors: 2,
      rx_dropped: 3,
      tx_dropped: 4,
      stp_state: "forwarding",
    },
  ],
});

const snapshot1057 = ({
  active = "WAN",
  www = "ok",
  config = config1057(),
}: {
  active?: string;
  www?: string;
  config?: Record<string, unknown>;
} = {}): Record<string, unknown> => ({
  ts: Date.now(),
  wan: {
    status: "up",
    latency_ms: 11,
    uptime: 864000,
    rx_bps: 1200000,
    tx_bps: 340000,
    _health: {
      wan: { uptime_stats: uptimeStats({ active }) },
      www: { status: www },
    },
  },
  devices: [device1057()],
  clients: [],
  config,
  diagnostics: {
    errors: {
      "rest/alarm": { error: "/rest/alarm?archived=false HTTP 400", at: Date.now() },
      "stat/event": {
        error: "no events endpoint on this controller (re-probing in 30m)",
        at: Date.now(),
      },
    },
    agent_build: 49,
  },
});

test("a real-shaped 10.5.67 snapshot ingests and derives all three uplinks", async () => {
  const response = await ingest(snapshot1057());
  assert.equal(response.status, 200);
  assert.equal(response.body["duplicate"], false);

  const reading = db
    .prepare(
      "SELECT internet_reachable, active_wan, active_wan_name FROM unifi_readings ORDER BY id DESC LIMIT 1"
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(reading, {
    internet_reachable: 1,
    active_wan: "WAN",
    active_wan_name: "Fiber",
  });

  const uplinks = db
    .prepare(
      "SELECT wan_key, name, primary_uplink, active, latency_ms, availability FROM unifi_wan_samples ORDER BY wan_key"
    )
    .all() as Record<string, unknown>[];
  assert.equal(uplinks.length, 3);
  assert.deepEqual(uplinks.find((u) => u["wan_key"] === "WAN"), {
    wan_key: "WAN",
    name: "Fiber",
    primary_uplink: 1,
    active: 1,
    latency_ms: 11,
    availability: 100,
  });

  assert.deepEqual(
    db
      .prepare(
        "SELECT online, uptime, cpu, mem, temperature FROM unifi_device_samples WHERE device_id = 'switch-1'"
      )
      .get(),
    { online: 1, uptime: 12345, cpu: 12.5, mem: 41.2, temperature: 39.5 }
  );

  assert.deepEqual(
    db
      .prepare(
        `SELECT up, speed, poe_active, poe_power, rx_errors, tx_errors,
                rx_dropped, tx_dropped, stp_state
           FROM unifi_port_samples WHERE device_id = 'switch-1' AND port_idx = 1`
      )
      .get(),
    {
      up: 1,
      speed: 1000,
      poe_active: 1,
      poe_power: 7.4,
      rx_errors: 1,
      tx_errors: 2,
      rx_dropped: 3,
      tx_dropped: 4,
      stp_state: "forwarding",
    }
  );

  const portHistory = await fetch(`${baseUrl}/api/unifi/ports/history?range=24h`);
  assert.equal(portHistory.status, 200);
  const portHistoryBody = (await portHistory.json()) as Record<string, unknown>;
  assert.equal(portHistoryBody["deviceId"], null);
  assert.equal((portHistoryBody["points"] as unknown[]).length, 1);
});

test("failover to backup uplink reflects correct active WAN in DB", async () => {
  await ingest(snapshot1057({ active: "WAN2" }));

  const reading = db
    .prepare("SELECT active_wan, active_wan_name FROM unifi_readings ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  assert.equal(reading["active_wan"], "WAN2");
  assert.equal(reading["active_wan_name"], "Cable");

  const uplinks = db
    .prepare("SELECT wan_key, active FROM unifi_wan_samples ORDER BY wan_key")
    .all() as Record<string, unknown>[];
  assert.equal(uplinks.find((u) => u["wan_key"] === "WAN2")?.["active"], 1);
  assert.equal(uplinks.find((u) => u["wan_key"] === "WAN")?.["active"], 0);
});

test("per-uplink history records a transition to cellular independently of latest state", async () => {
  await ingest(snapshot1057({ active: "WAN3" }));

  const rows = db
    .prepare(
      "SELECT wan_key, active, uptime_seconds, downtime_seconds FROM unifi_wan_samples ORDER BY wan_key"
    )
    .all() as Record<string, unknown>[];
  assert.equal(rows.find((r) => r["wan_key"] === "WAN")?.["active"], 0);
  assert.equal(rows.find((r) => r["wan_key"] === "WAN3")?.["active"], 1);
  assert.equal(rows.find((r) => r["wan_key"] === "WAN3")?.["uptime_seconds"], 300);
});

test("a warm cellular tunnel is not labeled active while the primary WAN is routed", async () => {
  const snap = snapshot1057();
  const wan = snap["wan"] as Record<string, unknown>;
  const wanHealth = wan["_health"] as Record<string, unknown>;
  const wanStats = wanHealth["wan"] as Record<string, unknown>;
  (wanStats["uptime_stats"] as Record<string, unknown>)["WAN3"] = {
    availability: 100,
    latency_average: 52,
    uptime: 500000,
  };
  await ingest(snap);

  const active = (
    db.prepare("SELECT wan_key FROM unifi_wan_samples WHERE active = 1 ORDER BY wan_key").all() as Record<string, unknown>[]
  ).map((r) => r["wan_key"]);
  assert.deepEqual(active, ["WAN"]);
});

test("port sampling writes changes immediately and unchanged heartbeats hourly", () => {
  const state = { up: 1 as const, speed: 1000, poe_active: 1 as const, rx_errors: 0,
    port_name: null, connected: null, max_speed: null, full_duplex: null,
    poe_enabled: null, poe_power: null, tx_errors: null, rx_dropped: null,
    tx_dropped: null, stp_state: null };
  const fingerprint = portStateFingerprint(state);
  const now = Date.now();

  assert.equal(shouldRecordPortSample(null, fingerprint, now, 3600e3), true);
  assert.equal(
    shouldRecordPortSample({ fingerprint, received_at: now - 30 * 60 * 1000 }, fingerprint, now, 3600e3),
    false
  );
  assert.equal(
    shouldRecordPortSample({ fingerprint, received_at: now - 61 * 60 * 1000 }, fingerprint, now, 3600e3),
    true
  );
  assert.equal(
    shouldRecordPortSample(
      { fingerprint, received_at: now - 1000 },
      portStateFingerprint({ ...state, up: 0 }),
      now,
      3600e3
    ),
    true
  );
});

test("a WAN outage on 10.5.67 reads as not reachable from _health.www", async () => {
  await ingest(snapshot1057({ www: "error" }));

  const reading = db
    .prepare("SELECT internet_reachable FROM unifi_readings ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown>;
  assert.equal(reading["internet_reachable"], 0, "_health.www error → not reachable");
});

test("a 10.5.67 config with no traffic-route keys establishes no baseline and never wedges", async () => {
  const config = config1057();
  assert.ok(!("traffic_routes" in config));
  assert.ok(!("traffic_routes_available" in config));
  assert.ok(!("traffic_routes_collected_at" in config));

  const response = await ingest(snapshot1057({ config }));
  assert.equal(response.status, 200);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM unifi_route_baseline_meta").get() as { n: number }).n,
    0,
    "no observation timestamp is recorded when nothing was collected"
  );

  const withRoutes = snapshot1057({
    config: {
      ...config1057(),
      traffic_routes_available: true,
      traffic_routes: [
        {
          id: "route-1",
          name: "Kids VPN",
          enabled: true,
          matching_target: "DOMAIN",
          domains: ["example.com"],
          network_id: "wan-id-3",
          target_devices: [{ type: "CLIENT", client_mac: "aa:bb:cc:dd:ee:ff" }],
        },
      ],
      traffic_routes_collected_at: Date.now(),
    },
  });
  await ingest(withRoutes);

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM unifi_route_baseline").get() as { n: number }).n,
    1
  );
  const meta = db.prepare("SELECT * FROM unifi_route_baseline_meta WHERE id = 1").get() as Record<string, unknown>;
  assert.ok(meta && (meta["last_observed_at"] as number) <= Date.now());
});

test("an agent that stops reporting routes does not erase the baseline it established", async () => {
  await ingest(
    snapshot1057({
      config: {
        ...config1057(),
        traffic_routes_available: true,
        traffic_routes: [{ id: "route-1", name: "Kids VPN", enabled: true }],
        traffic_routes_collected_at: Date.now(),
      },
    })
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM unifi_route_baseline").get() as { n: number }).n,
    1
  );

  await ingest(snapshot1057());
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM unifi_route_baseline").get() as { n: number }).n,
    1,
    "configuration history survives a collection outage"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM unifi_route_drift").get() as { n: number }).n,
    0,
    "a missing collection is not drift"
  );
});

test("the 10.5.67 legacy-endpoint diagnostics survive ingest for the Logs UI", async () => {
  await ingest(snapshot1057());

  const row = db.prepare("SELECT payload FROM unifi_latest WHERE id = 1").get() as { payload: Buffer } | undefined;
  assert.ok(row, "unifi_latest row should exist after ingest");

  const { unpackJson } = await import("../../lib/monitoring/payloadCodec.js");
  const payload = unpackJson<Record<string, unknown>>(row.payload);
  assert.ok(payload, "payload should be non-null");
  const diag = payload["diagnostics"] as Record<string, unknown> | undefined;
  assert.ok(diag, "diagnostics should be present");
  const errors = diag["errors"] as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(errors).sort(),
    ["rest/alarm", "stat/event"],
    "the reason activity must come from the private API is retained"
  );
});

test("the overview event feed reads modern activity instead of the removed legacy endpoint", async () => {
  const now = Date.now();
  db.prepare(
    `INSERT INTO unifi_activity_logs (
       upstream_id, event_ts, received_at, severity, category, subcategory,
       event_type, title, message, actor, target, raw
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "modern-event-1",
    now,
    now,
    "HIGH",
    "INTERNET_AND_WAN",
    "INTERNET_OUTAGE_AND_FAILOVER",
    "WAN_FAILOVER",
    "WAN failover",
    "Primary WAN failed over",
    null,
    "WAN",
    Buffer.from("fixture")
  );
  db.prepare(
    `INSERT INTO unifi_collection_compat (
       stream, status, page_base, filter_variant, evidence, negotiated_at, held, updated_at
     ) VALUES ('activity', 'proven', 0, NULL, 'fixture', ?, 0, ?)`
  ).run(now, now);

  const response = await fetch(`${baseUrl}/api/unifi/events?range=24h&limit=10`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  const collection = body["collection"] as Record<string, unknown>;
  assert.equal(collection["status"], "proven");
  const events = body["events"] as Record<string, unknown>[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!["source"], "activity");
  assert.equal(events[0]!["key"], "WAN_FAILOVER");
  assert.equal(events[0]!["is_alarm"], 1);
});
