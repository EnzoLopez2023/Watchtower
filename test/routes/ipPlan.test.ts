import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteIpPlanRepository } from "../../lib/db/repositories/watchtower/ipPlanRepository.js";
import { createIpPlanRouter } from "../../server/routes/features/ipPlan.js";
import { IP_PLAN_SEED } from "../../lib/monitoring/ipPlanSeed.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";

const TMP_DIR = join(import.meta.dirname, "..", "..", ".scratch", "wt", "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = join(TMP_DIR, `ip-plan-test-${Date.now()}.db`);

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof openDatabase>;
let repo: SqliteIpPlanRepository;

function stubOperator(): express.RequestHandler {
  return (_req, res, next) => { res.locals["identity"] = { roles: ["operator"] } as unknown as AppIdentity; next(); };
}

before(() => {
  db = openDatabase({ path: DB_PATH, busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);
  repo = new SqliteIpPlanRepository(db);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(stubOperator());
  app.use(createIpPlanRouter({ repository: repo }));
  return new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  }).then(() => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM ip_plan;");
});

async function getIpPlan(): Promise<Response> {
  return fetch(`${baseUrl}/api/ip-plan`);
}

async function patchIpPlan(mac: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/ip-plan/${mac}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Seed merge behavior ───────────────────────────────────────────────────────

test("seed populates ip_plan from IP_PLAN_SEED", async () => {
  await repo.seed(IP_PLAN_SEED);
  const rows = await repo.getAllRows();
  assert.ok(rows.length >= IP_PLAN_SEED.length);
  const gw = rows.find((r) => r.mac === "e4:38:83:2e:d0:51");
  assert.ok(gw);
  assert.equal(gw.name, "Dream Machine Pro");
  assert.equal(gw.group_code, "GW");
  assert.equal(gw.target_ip, "192.168.1.1");
});

test("seed is idempotent: running twice does not duplicate rows", async () => {
  await repo.seed(IP_PLAN_SEED);
  await repo.seed(IP_PLAN_SEED);
  const rows = await repo.getAllRows();
  const macs = rows.map((r) => r.mac);
  assert.equal(macs.length, new Set(macs).size, "no duplicate MACs");
});

test("seed preserves user progress (marked_done/notes) on re-seed", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  await repo.updateMark(mac, true, Date.now());
  await repo.updateNotes(mac, "my note");
  await repo.seed(IP_PLAN_SEED);
  const row = await repo.getByMac(mac);
  assert.equal(row?.marked_done, 1);
  assert.equal(row?.notes, "my note");
});

test("GET /api/ip-plan returns seeded data in groups", async () => {
  await repo.seed(IP_PLAN_SEED);
  const res = await getIpPlan();
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; groups: { code: string; items: unknown[] }[]; progress: { actionable: number } };
  assert.equal(body.ok, true);
  assert.ok(body.groups.length > 0);
  assert.ok(body.progress.actionable > 0);
  const gwGroup = body.groups.find((g) => g.code === "GW");
  assert.ok(gwGroup);
  assert.ok(gwGroup.items.length > 0);
});

// ── PATCH validation ──────────────────────────────────────────────────────────

test("PATCH /api/ip-plan/:mac marks device as done", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  const res = await patchIpPlan(mac, { marked_done: true });
  assert.equal(res.status, 200);
  const row = await repo.getByMac(mac);
  assert.equal(row?.marked_done, 1);
  assert.ok(row?.marked_at != null);
});

test("PATCH sets marked_at to null when un-marking", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  await patchIpPlan(mac, { marked_done: true });
  await patchIpPlan(mac, { marked_done: false });
  const row = await repo.getByMac(mac);
  assert.equal(row?.marked_done, 0);
  assert.equal(row?.marked_at, null);
});

test("PATCH /api/ip-plan/:mac updates notes", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  await patchIpPlan(mac, { notes: "in progress" });
  const row = await repo.getByMac(mac);
  assert.equal(row?.notes, "in progress");
});

test("PATCH truncates notes over 500 chars", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  await patchIpPlan(mac, { notes: "x".repeat(600) });
  const row = await repo.getByMac(mac);
  assert.equal(row?.notes?.length, 500);
});

test("PATCH notes empty string stores null", async () => {
  await repo.seed(IP_PLAN_SEED);
  const mac = IP_PLAN_SEED[0]!.mac;
  await patchIpPlan(mac, { notes: "x" });
  await patchIpPlan(mac, { notes: "" });
  const row = await repo.getByMac(mac);
  assert.equal(row?.notes, null);
});

test("PATCH 404 for unknown MAC", async () => {
  await repo.seed(IP_PLAN_SEED);
  const res = await patchIpPlan("aa:bb:cc:dd:ee:ff", { marked_done: true });
  assert.equal(res.status, 404);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "Unknown device");
});

test("GET /api/ip-plan includes unplanned field", async () => {
  await repo.seed(IP_PLAN_SEED);
  const res = await getIpPlan();
  const body = await res.json() as { unplanned: unknown[]; unplanned_attention: number };
  assert.ok(Array.isArray(body.unplanned));
  assert.ok(typeof body.unplanned_attention === "number");
});

test("GET /api/ip-plan includes pool field (null when no unifi snapshot)", async () => {
  await repo.seed(IP_PLAN_SEED);
  const res = await getIpPlan();
  const body = await res.json() as { pool: null };
  assert.equal(body.pool, null);
});

test("GET /api/ip-plan last_polled is null with no unifi snapshot", async () => {
  repo.seed(IP_PLAN_SEED);
  const res = await getIpPlan();
  const body = await res.json() as { last_polled: null };
  assert.equal(body.last_polled, null);
});

test("viewer role can read ip-plan", async () => {
  repo.seed(IP_PLAN_SEED);
  const app2 = express();
  app2.use(express.json());
  app2.use((_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); });
  app2.use(createIpPlanRouter({ repository: repo }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/ip-plan`);
    assert.equal(res.status, 200);
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
  }
});

test("viewer role cannot PATCH ip-plan", async () => {
  repo.seed(IP_PLAN_SEED);
  const app2 = express();
  app2.use(express.json());
  app2.use((_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); });
  app2.use(createIpPlanRouter({ repository: repo }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const mac = IP_PLAN_SEED[0]!.mac;
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/ip-plan/${mac}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marked_done: true }),
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
  }
});
