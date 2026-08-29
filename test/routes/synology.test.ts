import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { openDatabase } from "../../lib/db/connection.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteSynologyRepository } from "../../lib/db/repositories/watchtower/synologyRepository.js";
import { errorHandler } from "../../server/http/errors.js";
import {
  createSynologyRouter,
  createSynologyServiceRouter,
} from "../../server/routes/features/synology.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";
import type { AppConfig } from "../../server/config.js";

const SCRATCH_DIR = resolve("./.scratch/wt/tmp");

let dbCounter = 0;
function makeTmpPath(): string {
  return join(SCRATCH_DIR, `synology-test-${process.pid}-${++dbCounter}.db`);
}

function makeConfig(token: string | undefined) {
  return {
    serviceTokens: { synology: token },
  } as unknown as AppConfig;
}

const VIEWER_IDENTITY = { roles: ["viewer"] } as unknown as AppIdentity;
const OPERATOR_IDENTITY = { roles: ["viewer", "operator"] } as unknown as AppIdentity;

function makeApp(token: string | undefined, identity = VIEWER_IDENTITY) {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteSynologyRepository(db, receipts);
  const config = makeConfig(token);

  const app = express();
  app.use(createSynologyServiceRouter({ config, repository }));

  app.use(express.json());
  app.use((_req, res, next) => { res.locals.identity = identity; next(); });
  app.use(createSynologyRouter({ repository }));
  app.use(errorHandler);

  return { app, db, dbPath };
}

const VALID_BODY = JSON.stringify({
  nas_id: "ds1821",
  label: "DS1821+",
  host: "192.168.1.51",
  volumes: [{ id: "volume_1", total_bytes: 1e12, used_bytes: 5e11 }],
  disks: [{ id: "disk1", temp_c: 35, smart_status: "Normal", health: "Normal" }],
  shares: [{ name: "homes", used_bytes: 1e9 }],
  backup_tasks: [],
  external: [],
});

test("Synology ingest: 503 when token not configured", async () => {
  const { app, db, dbPath } = makeApp(undefined);
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/ingest", base), {
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

test("Synology ingest: 401 on bad token", async () => {
  const { app, db, dbPath } = makeApp("correct");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/ingest", base), {
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

test("Synology ingest: 200 on success", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
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

test("Synology ingest: delivery-id idempotency", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const deliver = () =>
        fetch(new URL("/api/synology/ingest", base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer secret",
            "x-hearth-delivery-id": "synology-delivery-001",
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

test("GET /api/synology: not present when no data", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], false);
      assert.deepEqual(body["units"], []);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology: present after ingest", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      await fetch(new URL("/api/synology/ingest", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: VALID_BODY,
      });

      const r = await fetch(new URL("/api/synology", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], true);
      const units = body["units"] as Record<string, unknown>[];
      assert.equal(units.length, 1);
      assert.equal(units[0]!["nas_id"], "ds1821");
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/history: returns series", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/history", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["series"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/shares: returns shares and points", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/shares", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["shares"]));
      assert.ok(Array.isArray(body["points"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/backups: returns runs", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/backups", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["runs"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/summary: not present when empty", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/summary", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.equal(body["present"], false);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/external: returns devices", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/external", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["devices"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology/disks: returns points", async () => {
  const { app, db, dbPath } = makeApp("secret");
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/disks", base));
      const body = await r.json() as Record<string, unknown>;
      assert.equal(body["ok"], true);
      assert.ok(Array.isArray(body["points"]));
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("DELETE /api/synology/external: 404 when device not found", async () => {
  const { app, db, dbPath } = makeApp("secret", OPERATOR_IDENTITY);
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/external/nas1/device1", base), {
        method: "DELETE",
      });
      assert.equal(r.status, 404);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("DELETE /api/synology/external: 403 without operator role", async () => {
  const { app, db, dbPath } = makeApp("secret", VIEWER_IDENTITY);
  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology/external/nas1/device1", base), {
        method: "DELETE",
      });
      assert.equal(r.status, 403);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});

test("GET /api/synology: viewer role required", async () => {
  const dbPath = makeTmpPath();
  const db = openDatabase({ path: dbPath, busyTimeoutMs: 500 });
  ensureWatchtowerSchema(db);
  const receipts = new SqliteAgentIngestReceiptRepository(db);
  const repository = new SqliteSynologyRepository(db, receipts);
  const config = makeConfig("secret");

  const app = express();
  app.use(createSynologyServiceRouter({ config, repository }));
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.identity = undefined; next(); });
  app.use(createSynologyRouter({ repository }));
  app.use(errorHandler);

  try {
    await withAppServer(app, async (base) => {
      const r = await fetch(new URL("/api/synology", base));
      assert.equal(r.status, 403);
    });
  } finally {
    db.close();
    await rm(dbPath, { force: true });
  }
});
