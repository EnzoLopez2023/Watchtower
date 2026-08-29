import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteUnifiRepository } from "../../lib/db/repositories/watchtower/unifiRepository.js";
import { createUnifiServiceRouter } from "../../server/routes/features/unifi.js";
import { loadConfig } from "../../server/config.js";
import type { SqliteDatabase } from "../../lib/db/connection.js";

const tmpDir = mkdtempSync(join(".scratch", "wt", "tmp", "unifi-clock-"));
const TOKEN = "clock-token";
let server: Server;
let baseUrl: string;
let db: SqliteDatabase;
let seq = 0;

before(() => {
  db = openDatabase({ path: join(tmpDir, "clock.db"), busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);
  const config = loadConfig({ NODE_ENV: "test", DB_PATH: join(tmpDir, "clock.db"), UNIFI_INGEST_TOKEN: TOKEN });
  const repository = new SqliteUnifiRepository(db, new SqliteAgentIngestReceiptRepository(db));
  const app = express();
  app.use(createUnifiServiceRouter({ config, repository }));
  server = app.listen(0);
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function routeConfig(collectedAt: unknown): Record<string, unknown> {
  return {
    config: {
      traffic_routes_available: true,
      traffic_routes_collected_at: collectedAt,
      traffic_routes: [
        { _id: "route-a", enabled: true, name: "Route A", description: "primary" },
      ],
    },
  };
}

async function ingest(body: Record<string, unknown>): Promise<Response> {
  seq += 1;
  return fetch(`${baseUrl}/api/unifi/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-hearth-delivery-id": `clock-${seq}`,
    },
    body: JSON.stringify(body),
  });
}

function meta(): { established_at: number | null; last_observed_at: number | null } | undefined {
  return db
    .prepare("SELECT established_at, last_observed_at FROM unifi_route_baseline_meta WHERE id = 1")
    .get() as { established_at: number | null; last_observed_at: number | null } | undefined;
}

test("ISO-string traffic_routes_collected_at does not write a NULL baseline clock", async () => {
  const before = Date.now();
  const res = await ingest(routeConfig("2024-05-01T00:00:00.000Z"));
  assert.equal(res.status, 200, "a non-numeric clock must not fail the ingest");

  const row = meta();
  assert.ok(row, "baseline metadata must be established");
  assert.notEqual(row.established_at, null, "established_at must never be NULL");
  assert.notEqual(row.last_observed_at, null, "last_observed_at must never be NULL");
  const observed = row.last_observed_at;
  assert.ok(
    observed != null && Number.isFinite(observed) && observed >= before,
    `unparseable clocks fall back to server received_at, got ${String(observed)}`
  );
});

test("a non-numeric clock leaves the stale-observation guard armed", async () => {
  // If NaN had been persisted, `observedAt < last_observed_at` would be false
  // for every future sample and the guard would silently never trip again.
  const row = meta();
  assert.ok(row && Number.isFinite(row.last_observed_at));

  const res = await ingest({
    config: {
      traffic_routes_available: true,
      traffic_routes_collected_at: 1_000,
      traffic_routes: [{ _id: "route-a", enabled: false, name: "Route A", description: "primary" }],
    },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);

  const after = meta();
  assert.equal(
    after?.last_observed_at,
    row.last_observed_at,
    "an older observation must be rejected as stale, not overwrite the clock"
  );
});

test("non-numeric clocks do not partially commit or 500", async () => {
  for (const value of [{}, [], "not-a-date", true, Number.NaN, "Infinity"]) {
    const res = await ingest(routeConfig(value));
    assert.equal(res.status, 200, `value ${JSON.stringify(value)} must not 500`);
    const row = meta();
    assert.ok(
      row && Number.isFinite(row.last_observed_at),
      `value ${JSON.stringify(value)} corrupted the baseline clock`
    );
  }
});

test("a valid numeric clock is rounded and preserved as the baseline observation", async () => {
  const precise = Date.now() + 60_000 + 0.7;
  const res = await ingest({
    config: {
      traffic_routes_available: true,
      traffic_routes_collected_at: precise,
      traffic_routes: [{ _id: "route-a", enabled: true, name: "Route A", description: "primary" }],
    },
  });
  assert.equal(res.status, 200);

  const row = meta();
  assert.ok(row);
  const stored = row.last_observed_at;
  assert.ok(Number.isInteger(stored), "the stored clock must be a rounded integer");
  // The route reports min(collectedAt, receivedAt); a future agent clock is
  // clamped to the server's own received_at rather than trusted.
  assert.ok(
    stored != null && stored <= Date.now(),
    "an agent clock ahead of the server must be clamped to received_at"
  );
});
