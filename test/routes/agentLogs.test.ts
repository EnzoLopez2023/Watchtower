import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteAgentLogRepository } from "../../lib/db/repositories/watchtower/agentLogRepository.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteMonitoringArchiveRepository } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import { createAgentLogsServiceRouter, createAgentLogsRouter } from "../../server/routes/features/agentLogs.js";
import type { AppConfig } from "../../server/config.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";

const TMP_DIR = join(import.meta.dirname, "..", "..", ".scratch", "wt", "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = join(TMP_DIR, `agent-logs-test-${Date.now()}.db`);

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof openDatabase>;
let repo: SqliteAgentLogRepository;

const config = {
  serviceTokens: {
    unifi: "unifi-token",
    ups: "ups-token",
    synology: "synology-token",
    sonarr: "sonarr-token",
  },
} as unknown as AppConfig;

function stubAdmin(): express.RequestHandler {
  return (_req, res, next) => { res.locals["identity"] = { roles: ["admin"] } as unknown as AppIdentity; next(); };
}

before(() => {
  db = openDatabase({ path: DB_PATH, busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const retention = new SqliteMonitoringArchiveRepository(db, false);
  repo = new SqliteAgentLogRepository(db, receipts, retention);

  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(createAgentLogsServiceRouter({ config, repository: repo }));
  app.use(stubAdmin());
  app.use(createAgentLogsRouter({ config, repository: repo }));

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
  db.exec("DELETE FROM agent_logs; DELETE FROM agent_ingest_receipts;");
});

function insert(opts: { agent: string; minutesAgo?: number; level?: string; message?: string; delay?: number; ts?: number }) {
  const eventAt = opts.ts ?? (NOW - (opts.minutesAgo ?? 0) * MINUTE);
  return db.prepare("INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES (?, ?, ?, ?, ?)").run(
    opts.agent, eventAt, opts.level ?? "info", opts.message ?? "msg", eventAt + (opts.delay ?? 0)
  ).lastInsertRowid;
}

async function ingest(agent: string, lines: unknown[], token: string, deliveryId?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (deliveryId) headers["x-hearth-delivery-id"] = deliveryId;
  return fetch(`${baseUrl}/api/agent-logs/ingest`, { method: "POST", headers, body: JSON.stringify({ agent, lines }) });
}

// ── Auth matrix ───────────────────────────────────────────────────────────────

test("ingest 400 for unknown agent", async () => {
  const res = await ingest("badagent", [], "unifi-token");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "unknown agent" });
});

test("ingest 503 when token not configured", async () => {
  const noTokenConfig = { serviceTokens: {} } as unknown as AppConfig;
  const db2 = openDatabase({ path: join(TMP_DIR, `no-tok-${Date.now()}.db`), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db2);
  const repo2 = new SqliteAgentLogRepository(db2, new SqliteAgentIngestReceiptRepository(db2), new SqliteMonitoringArchiveRepository(db2, false));
  const app2 = express();
  app2.use(express.json());
  app2.use(createAgentLogsServiceRouter({ config: noTokenConfig, repository: repo2 }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/agent-logs/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer any" },
      body: JSON.stringify({ agent: "unifi", lines: [] }),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("ingest not configured for unifi"));
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
    db2.close();
  }
});

test("ingest 401 for bad token", async () => {
  const res = await ingest("unifi", [{ ts: NOW, level: "info", message: "hi" }], "wrong-token");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "bad token" });
});

test("ingest succeeds with correct per-agent token", async () => {
  const res = await ingest("unifi", [{ ts: NOW, level: "info", message: "hello" }], "unifi-token");
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; stored: number };
  assert.equal(body.ok, true);
  assert.equal(body.stored, 1);
});

test("ups token authenticates shutdown agent", async () => {
  const res = await ingest("shutdown", [{ ts: NOW, level: "warn", message: "shutting down" }], "ups-token");
  assert.equal(res.status, 200);
});

test("per-agent token isolation: ups token CANNOT authenticate unifi", async () => {
  const res = await ingest("unifi", [{ ts: NOW, level: "info", message: "test" }], "ups-token");
  assert.equal(res.status, 401);
});

test("unified agentLog token authenticates any agent", async () => {
  const unifiedConfig = { serviceTokens: { unifi: "unifi-token", agentLog: "unified-secret" } } as unknown as AppConfig;
  const db3 = openDatabase({ path: join(TMP_DIR, `unified-${Date.now()}.db`), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db3);
  const receipts3 = new SqliteAgentIngestReceiptRepository(db3);
  const ret3 = new SqliteMonitoringArchiveRepository(db3, false);
  const repo3 = new SqliteAgentLogRepository(db3, receipts3, ret3);
  const app3 = express();
  app3.use(express.json());
  app3.use(createAgentLogsServiceRouter({ config: unifiedConfig, repository: repo3 }));
  const srv3 = await new Promise<Server>((resolve, reject) => {
    const s = app3.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const url = `http://127.0.0.1:${(srv3.address() as { port: number }).port}/api/agent-logs/ingest`;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer unified-secret" }, body: JSON.stringify({ agent: "sonarr", lines: [{ ts: NOW, level: "info", message: "hi" }] }) });
    assert.equal(res.status, 200);
  } finally {
    await new Promise<void>((r) => srv3.close(() => r()));
    db3.close();
  }
});

// ── Delivery-id idempotency ────────────────────────────────────────────────────

test("duplicate delivery-id is idempotent", async () => {
  const r1 = await ingest("unifi", [{ ts: NOW, level: "info", message: "once" }], "unifi-token", "dup-001");
  const b1 = await r1.json() as { stored: number; duplicate: boolean };
  assert.equal(b1.stored, 1);
  assert.equal(b1.duplicate, false);

  const r2 = await ingest("unifi", [{ ts: NOW, level: "info", message: "once" }], "unifi-token", "dup-001");
  const b2 = await r2.json() as { stored: number; duplicate: boolean };
  assert.equal(b2.duplicate, true);
  assert.equal(b2.stored, 0);
});

// ── Line/message caps ─────────────────────────────────────────────────────────

test("501 lines are truncated to 500", async () => {
  const lines = Array.from({ length: 501 }, (_, i) => ({ ts: NOW + i, level: "info", message: `line ${i}` }));
  const res = await ingest("unifi", lines, "unifi-token");
  assert.equal(res.status, 200);
  const body = await res.json() as { stored: number };
  assert.equal(body.stored, 500);
});

test("3000-char message is truncated to 2000", async () => {
  const longMsg = "x".repeat(3000);
  const res = await ingest("unifi", [{ ts: NOW, level: "info", message: longMsg }], "unifi-token");
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT message FROM agent_logs ORDER BY id DESC LIMIT 1").get() as { message: string };
  assert.equal(row.message.length, 2000);
});

// ── Port of agentLogs.test.js ─────────────────────────────────────────────────

test("explorer applies exact multi-source, multi-level, and literal message filters", async () => {
  insert({ agent: "unifi", minutesAgo: 10, level: "error", message: "CPU reached 100%" });
  insert({ agent: "unifi", minutesAgo: 9, level: "warn", message: "CPU reached 1000" });
  insert({ agent: "sonarr", minutesAgo: 8, level: "error", message: "CPU reached 100%" });
  insert({ agent: "ups", minutesAgo: 7, level: "error", message: "CPU reached 100%" });

  const result = await repo.queryLogs({ agents: "unifi,sonarr", levels: "error", q: "100%", from: NOW - 30 * MINUTE, to: NOW }) as { matchingTotal: number; lines: { agent: string; level: string; message: string }[] };
  assert.equal(result.matchingTotal, 2);
  assert.deepEqual(result.lines.map((l) => l.agent), ["sonarr", "unifi"]);
  assert.ok(result.lines.every((l) => l.level === "error"));
  assert.ok(result.lines.every((l) => l.message.endsWith("100%")));
});

test("cursor pagination is stable in newest and oldest order when timestamps tie", async () => {
  const tiedTs = NOW - 10 * MINUTE;
  const ids = [
    insert({ agent: "unifi", ts: tiedTs, message: "first" }),
    insert({ agent: "unifi", ts: tiedTs, message: "second" }),
    insert({ agent: "unifi", ts: tiedTs, message: "third" }),
  ];

  const newest = await repo.queryLogs({ limit: 2, order: "newest" }) as { lines: { id: number }[]; nextCursor: { ts: number; id: number } | null };
  assert.deepEqual(newest.lines.map((l) => l.id), [Number(ids[2]), Number(ids[1])]);
  assert.deepEqual(newest.nextCursor, { ts: tiedTs, id: Number(ids[1]) });

  const newestNext = await repo.queryLogs({ limit: 2, order: "newest", cursorTs: newest.nextCursor.ts, cursorId: newest.nextCursor.id }) as { lines: { id: number }[] };
  assert.deepEqual(newestNext.lines.map((l) => l.id), [Number(ids[0])]);

  const oldest = await repo.queryLogs({ limit: 2, order: "oldest" }) as { lines: { id: number }[]; nextCursor: { ts: number; id: number } | null };
  assert.deepEqual(oldest.lines.map((l) => l.id), [Number(ids[0]), Number(ids[1])]);
  const oldestNext = await repo.queryLogs({ limit: 2, order: "oldest", cursorTs: oldest.nextCursor!.ts, cursorId: oldest.nextCursor!.id }) as { lines: { id: number }[] };
  assert.deepEqual(oldestNext.lines.map((l) => l.id), [Number(ids[2])]);
});

test("analytics covers the full selected corpus and excludes future clocks from latency", async () => {
  insert({ agent: "unifi", minutesAgo: 50, level: "info", message: "poll complete", delay: 100 });
  insert({ agent: "unifi", minutesAgo: 40, level: "error", message: "failed to poll", delay: 500 });
  insert({ agent: "ups", minutesAgo: 30, level: "warn", message: "battery low", delay: 2_000 });
  insert({ agent: "sonarr", minutesAgo: 20, level: "error", message: "queue failed", delay: 5_000 });
  insert({ agent: "synology", minutesAgo: 10, level: "info", message: "source clock ahead", delay: -1_000 });

  const result = await repo.queryAnalytics({ from: NOW - 60 * MINUTE, to: NOW }, NOW) as { summary: { total: number; errors: number; clockSkewCount: number; errorRate: number }; volume: { total: number }[]; levels: { level: string; count: number }[] };
  assert.equal(result.summary.total, 5);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.clockSkewCount, 1);
  assert.ok(Math.abs(result.summary.errorRate - 2 / 5) < 1e-9);
  assert.ok(result.volume.some((v) => v.total > 0));
  const errLevel = result.levels.find((l) => l.level === "error");
  assert.equal(errLevel?.count, 2);
});

// ── Role enforcement ──────────────────────────────────────────────────────────

test("logs endpoint requires admin role", async () => {
  const app2 = express();
  app2.use(express.json());
  app2.use((_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); });
  app2.use(createAgentLogsRouter({ config, repository: repo }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/observability/logs`);
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
  }
});
