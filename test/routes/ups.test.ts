import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "../../lib/db/connection.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteUpsRepository } from "../../lib/db/repositories/watchtower/upsRepository.js";
import { errorHandler } from "../../server/http/errors.js";
import { createUpsRouter, createUpsServiceRouter } from "../../server/routes/features/ups.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";
import type { AppConfig } from "../../server/config.js";

const SCRATCH_DIR = resolve("./.scratch/wt/tmp");

let dbCounter = 0;
function makeTmpPath(): string {
  return join(SCRATCH_DIR, `ups-test-${process.pid}-${++dbCounter}.db`);
}

function makeConfig(token: string | undefined) {
  return {
    serviceTokens: { ups: token },
  } as unknown as AppConfig;
}

function makeApp(token: string | undefined) {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteUpsRepository(db, receipts);
  const config = makeConfig(token);

  const app = express();
  app.use(createUpsServiceRouter({ config, repository }));

  app.use(express.json());
  const viewer = { roles: ["viewer"] } as unknown as AppIdentity;
  app.use((_req, res, next) => { res.locals.identity = viewer; next(); });
  app.use(createUpsRouter({ repository }));
  app.use(errorHandler);

  return { app, db, dbPath };
}

test("UPS ingest: 503 when token not configured", async () => {
  const { app, db, dbPath } = makeApp(undefined);
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vars: { "ups.status": "OL" } }),
      });
      assert.equal(r.status, 503);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("UPS ingest: 401 on bad token", async () => {
  const { app, db, dbPath } = makeApp("correct-token");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ vars: { "ups.status": "OL" } }),
      });
      assert.equal(r.status, 401);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("UPS ingest: 200 on success with x-ups-token header", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ups-token": "secret",
        },
        body: JSON.stringify({ vars: { "ups.status": "OL", "battery.charge": "100" } }),
      });
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["duplicate"], false);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("UPS ingest: delivery-id idempotency", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const deliver = () =>
        fetch(new URL("/api/ups/ingest", base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer secret",
            "x-hearth-delivery-id": "test-delivery-001",
          },
          body: JSON.stringify({ vars: { "ups.status": "OL" } }),
        });

      const r1 = await deliver();
      assert.equal(r1.status, 200);
      const b1 = await r1.json() as Record<string, unknown>;
      assert.equal(b1["duplicate"], false);

      const r2 = await deliver();
      assert.equal(r2.status, 200);
      const b2 = await r2.json() as Record<string, unknown>;
      assert.equal(b2["duplicate"], true);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/ups: not present when no data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups", base));
      assert.equal(r.status, 200);
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], false);
      assert.deepEqual(body["upses"], []);
      assert.equal(body["last_contact_at"], null);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/ups: present with data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({
          ups_id: "tower",
          ups_label: "Tower UPS",
          vars: { "ups.status": "OL", "battery.charge": "98" },
        }),
      });

      const r = await fetch(new URL("/api/ups", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], true);
      assert.ok(Array.isArray(body["upses"]));
      assert.equal((body["upses"] as unknown[]).length, 1);
      const u = (body["upses"] as Record<string, unknown>[])[0]!;
      assert.equal(u["ups_id"], "tower");
      assert.equal(u["label"], "Tower UPS");
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/ups/history: returns points array", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups/history?range=24h", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["range"], "24h");
      assert.ok(Array.isArray(body["points"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/ups/outages: empty when no data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups/outages", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["units"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/ups: role enforcement — viewer role required", async () => {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteUpsRepository(db, receipts);
  const config = makeConfig("secret");

  const app = express();
  app.use(createUpsServiceRouter({ config, repository }));
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.identity = undefined; next(); });
  app.use(createUpsRouter({ repository }));
  app.use(errorHandler);

  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/ups", base));
      assert.equal(r.status, 403);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("UPS outage bounds: single OB sample produces observed_seconds=0, non-null max_seconds, coarse=true", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const post = (status: string, ts: number) =>
        fetch(new URL("/api/ups/ingest", base), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
          body: JSON.stringify({
            ups_id: "tower",
            ts,
            vars: { "ups.status": status },
          }),
        });

      const t0 = Date.now() - 3 * 60 * 60 * 1000;
      await post("OL", t0);
      await post("OB DISCHRG", t0 + 5 * 60 * 1000);
      await post("OL", t0 + 10 * 60 * 1000);

      const r = await fetch(new URL("/api/ups/outages", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      const units = body["units"] as Record<string, unknown>[];
      assert.ok(units.length > 0);
      const outages = (units[0]!["outages"] as Record<string, unknown>[]);
      assert.ok(outages.length > 0);
      const outage = outages[0]!;
      assert.equal(outage["observed_seconds"], 0, "single sample → observed_seconds must be 0");
      assert.ok(outage["max_seconds"] !== null, "max_seconds must be non-null with known mains bookend");
      assert.equal(outage["coarse"], true, "single sample → coarse must be true");
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});
