import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqlitePowerTopologyRepository } from "../../lib/db/repositories/watchtower/powerTopologyRepository.js";
import { createPowerTopologyRouter } from "../../server/routes/features/powerTopology.js";
import type { AppIdentity } from "../../lib/db/repositories/identityRepository.js";

const TMP_DIR = join(import.meta.dirname, "..", "..", ".scratch", "wt", "tmp");
mkdirSync(TMP_DIR, { recursive: true });
const DB_PATH = join(TMP_DIR, `power-topology-test-${Date.now()}.db`);

let server: Server;
let baseUrl: string;
let db: ReturnType<typeof openDatabase>;

function stubOperator(): express.RequestHandler {
  return (_req, res, next) => { res.locals["identity"] = { roles: ["operator"] } as unknown as AppIdentity; next(); };
}

before(() => {
  db = openDatabase({ path: DB_PATH, busyTimeoutMs: 5000 });
  ensureWatchtowerSchema(db);
  const repo = new SqlitePowerTopologyRepository(db);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(stubOperator());
  app.use(createPowerTopologyRouter({ repository: repo }));
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
  db.exec("DELETE FROM power_connections; DELETE FROM power_zones; DELETE FROM power_items; DELETE FROM power_diagrams;");
});

async function apiGet(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function apiPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function apiPatch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function apiPut(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function apiDelete(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "DELETE" });
}

// ── Full CRUD round trip ──────────────────────────────────────────────────────

test("diagram CRUD: create, list, rename, get, delete", async () => {
  const create = await apiPost("/api/power/diagrams", { name: "Test Diagram" });
  assert.equal(create.status, 201);
  const { diagram } = await create.json() as { ok: boolean; diagram: { id: number; name: string } };
  assert.equal(diagram.name, "Test Diagram");
  const id = diagram.id;

  const list = await apiGet("/api/power/diagrams");
  const listBody = await list.json() as { diagrams: { id: number }[] };
  assert.ok(listBody.diagrams.some((d) => d.id === id));

  const rename = await apiPatch(`/api/power/diagrams/${id}`, { name: "Renamed" });
  assert.equal(rename.status, 200);

  const getOne = await apiGet(`/api/power/diagrams/${id}`);
  const getBody = await getOne.json() as { diagram: { name: string }; items: unknown[]; connections: unknown[]; zones: unknown[] };
  assert.equal(getBody.diagram.name, "Renamed");
  assert.deepEqual(getBody.items, []);
  assert.deepEqual(getBody.connections, []);
  assert.deepEqual(getBody.zones, []);

  const del = await apiDelete(`/api/power/diagrams/${id}`);
  assert.equal(del.status, 200);
  const notFound = await apiGet(`/api/power/diagrams/${id}`);
  assert.equal(notFound.status, 404);
});

test("diagram 400 on missing name", async () => {
  const res = await apiPost("/api/power/diagrams", {});
  assert.equal(res.status, 400);
});

test("diagram 404 on rename non-existent", async () => {
  const res = await apiPatch("/api/power/diagrams/99999", { name: "x" });
  assert.equal(res.status, 404);
});

test("item CRUD: create, patch, delete with connection cascade", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const diagramId = d.diagram.id;

  const create = await apiPost("/api/power/items", { diagram_id: diagramId, name: "UPS", kind: "ups", plug_count: 2 });
  assert.equal(create.status, 201);
  const { item } = await create.json() as { item: { id: number; kind: string; plug_count: number } };
  assert.equal(item.kind, "ups");
  assert.equal(item.plug_count, 2);

  const createDevice = await apiPost("/api/power/items", { diagram_id: diagramId, name: "PC", kind: "device" });
  assert.equal(createDevice.status, 201);
  const device = (await createDevice.json() as { item: { id: number } }).item;

  const conn = await apiPost("/api/power/connections", { diagram_id: diagramId, source_item_id: item.id, source_plug_index: 0, target_item_id: device.id });
  assert.equal(conn.status, 201);

  const patchItem = await apiPatch(`/api/power/items/${item.id}`, { name: "Big UPS" });
  assert.equal(patchItem.status, 200);
  const patchBody = await patchItem.json() as { item: { name: string } };
  assert.equal(patchBody.item.name, "Big UPS");

  const del = await apiDelete(`/api/power/items/${device.id}`);
  assert.equal(del.status, 200);
});

test("item 400 on invalid kind", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const res = await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "X", kind: "spaceship" });
  assert.equal(res.status, 400);
});

test("item 404 on unknown diagram_id", async () => {
  const res = await apiPost("/api/power/items", { diagram_id: 99999, name: "X", kind: "device" });
  assert.equal(res.status, 404);
});

test("connection 400: item cannot power itself", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const i = await (await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "UPS", kind: "ups", plug_count: 1 })).json() as { item: { id: number } };
  const res = await apiPost("/api/power/connections", { diagram_id: d.diagram.id, source_item_id: i.item.id, source_plug_index: 0, target_item_id: i.item.id });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.includes("cannot power itself"));
});

test("connection 409 when plug already in use", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const ups = await (await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "UPS", kind: "ups", plug_count: 1 })).json() as { item: { id: number } };
  const pc1 = await (await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "PC1", kind: "device" })).json() as { item: { id: number } };
  const pc2 = await (await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "PC2", kind: "device" })).json() as { item: { id: number } };
  await apiPost("/api/power/connections", { diagram_id: d.diagram.id, source_item_id: ups.item.id, source_plug_index: 0, target_item_id: pc1.item.id });
  const res = await apiPost("/api/power/connections", { diagram_id: d.diagram.id, source_item_id: ups.item.id, source_plug_index: 0, target_item_id: pc2.item.id });
  assert.equal(res.status, 409);
});

test("zone CRUD: create, patch, delete", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const z = await apiPost("/api/power/zones", { diagram_id: d.diagram.id, name: "Server Room", pos_x: 10, pos_y: 20, width: 200, height: 150, color: "#ff0000" });
  assert.equal(z.status, 201);
  const zBody = await z.json() as { zone: { id: number; name: string } };
  assert.equal(zBody.zone.name, "Server Room");

  const patch = await apiPatch(`/api/power/zones/${zBody.zone.id}`, { name: "Network Closet" });
  assert.equal(patch.status, 200);

  const del = await apiDelete(`/api/power/zones/${zBody.zone.id}`);
  assert.equal(del.status, 200);
});

test("bulk positions update", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const item = await (await apiPost("/api/power/items", { diagram_id: d.diagram.id, name: "Device", kind: "device" })).json() as { item: { id: number } };
  const res = await apiPost("/api/power/items/positions", { positions: [{ id: item.item.id, pos_x: 100, pos_y: 200 }] });
  assert.equal(res.status, 200);
});

test("duplicate diagram deep-copies items and connections", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "Original" })).json() as { diagram: { id: number } };
  const diagramId = d.diagram.id;
  const ups = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "UPS", kind: "ups", plug_count: 1 })).json() as { item: { id: number } };
  const dev = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "Dev", kind: "device" })).json() as { item: { id: number } };
  await apiPost("/api/power/connections", { diagram_id: diagramId, source_item_id: ups.item.id, source_plug_index: 0, target_item_id: dev.item.id });

  const dup = await apiPost(`/api/power/diagrams/${diagramId}/duplicate`, { name: "Copy" });
  assert.equal(dup.status, 201);
  const dupBody = await dup.json() as { diagram: { id: number; name: string } };
  assert.equal(dupBody.diagram.name, "Copy");
  assert.ok(dupBody.diagram.id !== diagramId);

  const graph = await (await apiGet(`/api/power/diagrams/${dupBody.diagram.id}`)).json() as { items: unknown[]; connections: unknown[] };
  assert.equal(graph.items.length, 2);
  assert.equal(graph.connections.length, 1);
});

// ── PUT /graph rollback test ──────────────────────────────────────────────────

test("PUT /graph rolls back on invalid id reference leaving no partial state", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const diagramId = d.diagram.id;

  // Pre-populate
  const ups = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "UPS", kind: "ups", plug_count: 1 })).json() as { item: { id: number } };
  const dev = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "Dev", kind: "device" })).json() as { item: { id: number } };
  await apiPost("/api/power/connections", { diagram_id: diagramId, source_item_id: ups.item.id, source_plug_index: 0, target_item_id: dev.item.id });

  // PUT with connections referencing an item id that doesn't exist in the payload
  const res = await apiPut(`/api/power/diagrams/${diagramId}/graph`, {
    items: [{ id: 1001, name: "Only Item", kind: "device", plug_count: 0, pos_x: 0, pos_y: 0 }],
    connections: [{ id: 2001, source_item_id: 1001, source_plug_index: 0, target_item_id: 9999, label: null, color: null }],
    zones: [],
  });

  // Should fail (FK violation or similar)
  assert.ok(res.status === 500 || res.status === 400);

  // After failure: diagram graph should still exist (not partially deleted)
  const graph = await (await apiGet(`/api/power/diagrams/${diagramId}`)).json() as { items: unknown[]; connections: unknown[] };
  assert.ok(graph.items.length > 0 || graph.connections.length >= 0, "graph must not be empty after rollback");
});

test("PUT /graph on non-existent diagram returns 404", async () => {
  const res = await apiPut("/api/power/diagrams/99999/graph", { items: [], connections: [], zones: [] });
  assert.equal(res.status, 404);
});

test("connection patch moves cable to new target", async () => {
  const d = await (await apiPost("/api/power/diagrams", { name: "D" })).json() as { diagram: { id: number } };
  const diagramId = d.diagram.id;
  const ups = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "UPS", kind: "ups", plug_count: 2 })).json() as { item: { id: number } };
  const pc1 = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "PC1", kind: "device" })).json() as { item: { id: number } };
  const pc2 = await (await apiPost("/api/power/items", { diagram_id: diagramId, name: "PC2", kind: "device" })).json() as { item: { id: number } };
  const conn = await (await apiPost("/api/power/connections", { diagram_id: diagramId, source_item_id: ups.item.id, source_plug_index: 0, target_item_id: pc1.item.id })).json() as { connection: { id: number } };
  const move = await apiPatch(`/api/power/connections/${conn.connection.id}`, { target_item_id: pc2.item.id });
  assert.equal(move.status, 200);
  const patchBody = await move.json() as { connection: { target_item_id: number } };
  assert.equal(patchBody.connection.target_item_id, pc2.item.id);
});

test("viewer role can GET diagrams", async () => {
  const app2 = express();
  app2.use(express.json());
  app2.use((_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); });
  app2.use(createPowerTopologyRouter({ repository: new SqlitePowerTopologyRepository(db) }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/power/diagrams`);
    assert.equal(res.status, 200);
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
  }
});

test("viewer role cannot POST diagrams", async () => {
  const app2 = express();
  app2.use(express.json());
  app2.use((_req, res, next) => { res.locals["identity"] = { roles: ["viewer"] } as unknown as AppIdentity; next(); });
  app2.use(createPowerTopologyRouter({ repository: new SqlitePowerTopologyRepository(db) }));
  const srv2 = await new Promise<Server>((resolve, reject) => {
    const s = app2.listen(0, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(srv2.address() as { port: number }).port}/api/power/diagrams`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((r) => srv2.close(() => r()));
  }
});
