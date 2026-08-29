import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "../../lib/db/connection.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteProtectRepository } from "../../lib/db/repositories/watchtower/protectRepository.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { errorHandler } from "../../server/http/errors.js";
import {
  createProtectRouter,
  createProtectServiceRouter,
} from "../../server/routes/features/protect.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";
import type { AppConfig } from "../../server/config.js";

const SCRATCH_DIR = resolve("./.scratch/wt/tmp");

let dbCounter = 0;
function makeTmpPath(): string {
  return join(SCRATCH_DIR, `protect-test-${process.pid}-${++dbCounter}.db`);
}

function makeConfig(token: string | undefined) {
  return {
    serviceTokens: { protect: token },
  } as unknown as AppConfig;
}

function makeApp(token: string | undefined) {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteProtectRepository(db, receipts);
  const config = makeConfig(token);

  const app = express();
  app.use(createProtectServiceRouter({ config, repository }));

  app.use(express.json());
  const viewer = { roles: ["viewer"] } as unknown as AppIdentity;
  app.use((_req, res, next) => { res.locals.identity = viewer; next(); });
  app.use(createProtectRouter({ repository }));
  app.use(errorHandler);

  return { app, db, dbPath };
}

const VALID_BODY = JSON.stringify({
  nvr: { name: "Test NVR" },
  cameras: [{ id: "cam1", state: "CONNECTED" }],
  sensors: [],
  accessories: [],
  events: [],
});

test("Protect ingest: 503 when token not configured", async () => {
  const { app, db, dbPath } = makeApp(undefined);
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: VALID_BODY,
      });
      assert.equal(r.status, 503);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("Protect ingest: 401 on bad token", async () => {
  const { app, db, dbPath } = makeApp("correct");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: VALID_BODY,
      });
      assert.equal(r.status, 401);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("Protect ingest: 401 accepted via x-protect-token", async () => {
  const { app, db, dbPath } = makeApp("correct");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-protect-token": "wrong" },
        body: VALID_BODY,
      });
      assert.equal(r.status, 401);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("Protect ingest: 200 success via x-unifi-token fallback header", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-protect-token": "secret" },
        body: VALID_BODY,
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

test("Protect ingest: delivery-id idempotency", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const deliver = () =>
        fetch(new URL("/api/protect/ingest", base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer secret",
            "x-hearth-delivery-id": "protect-delivery-001",
          },
          body: VALID_BODY,
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

test("GET /api/protect: not present when no data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], false);
      assert.equal(body["last_contact_at"], null);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect: present after ingest", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: VALID_BODY,
      });

      const r = await fetch(new URL("/api/protect", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], true);
      assert.equal(typeof body["received_at"], "number");
      assert.equal(body["num_cameras"], 1);
      assert.equal(body["cameras_online"], 1);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect/history: returns points", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/history?range=24h", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["points"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect/events: returns events and by_type", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/events", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["events"]));
      assert.ok(Array.isArray(body["by_type"]));
      assert.equal(typeof body["total"], "number");
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect/activity: returns cameras and hour_totals", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/activity", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["cameras"]));
      assert.ok(Array.isArray(body["hour_totals"]));
      assert.equal((body["hour_totals"] as unknown[]).length, 24);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect/storage-forecast: collecting when no data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/storage-forecast", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["state"], "collecting");
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("Protect: falls back to unifi token when protect token unset", async () => {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteProtectRepository(db, receipts);
  const config = {
    serviceTokens: { protect: undefined, unifi: "unifi-secret" },
  } as unknown as AppConfig;

  const app = express();
  app.use(createProtectServiceRouter({ config, repository }));
  app.use(errorHandler);

  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer unifi-secret" },
        body: VALID_BODY,
      });
      assert.equal(r.status, 200);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/protect: role enforcement — viewer required", async () => {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteProtectRepository(db, receipts);
  const config = makeConfig("secret");

  const app = express();
  app.use(createProtectServiceRouter({ config, repository }));
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.identity = undefined; next(); });
  app.use(createProtectRouter({ repository }));
  app.use(errorHandler);

  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/protect", base));
      assert.equal(r.status, 403);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});
