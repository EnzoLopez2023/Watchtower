import { Router } from "express";
import type { Request, Response } from "express";
import { requireRole } from "../../auth/authorize.js";
import type { PowerTopologyRepository } from "../../../lib/db/repositories/watchtower/powerTopologyRepository.js";
import { asyncHandler, bodyString, readBody } from "./http.js";

export interface PowerTopologyRouterDependencies {
  readonly repository: PowerTopologyRepository;
}

export function createPowerTopologyRouter(deps: PowerTopologyRouterDependencies): Router {
  const router = Router();
  const repo = deps.repository;

  // ── Diagrams ──────────────────────────────────────────────────────────────

  router.get("/api/power/diagrams", requireRole("viewer"), asyncHandler(async (_req: Request, res: Response) => {
    return res.json({ ok: true, diagrams: await repo.listDiagrams() });
  }));

  router.post("/api/power/diagrams", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const name = bodyString(readBody(req), "name") ?? "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const diagram = await repo.createDiagram(name);
    return res.status(201).json({ ok: true, diagram });
  }));

  router.patch("/api/power/diagrams/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const name = bodyString(readBody(req), "name") ?? "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const diagram = await repo.renameDiagram(id, name);
    if (!diagram) return res.status(404).json({ error: "diagram not found" });
    return res.json({ ok: true, diagram });
  }));

  router.delete("/api/power/diagrams/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    if (!await repo.deleteDiagram(id)) return res.status(404).json({ error: "diagram not found" });
    return res.json({ ok: true });
  }));

  router.get("/api/power/diagrams/:id", requireRole("viewer"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const graph = await repo.getDiagramGraph(id);
    if (!graph) return res.status(404).json({ error: "diagram not found" });
    return res.json({ ok: true, ...graph });
  }));

  // ── Items ─────────────────────────────────────────────────────────────────

  router.post("/api/power/items", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const result = await repo.createItem(readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.status(201).json({ ok: true, item: result.item });
  }));

  router.patch("/api/power/items/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.updateItem(id, readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true, item: result.item });
  }));

  router.delete("/api/power/items/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.deleteItem(id);
    if (result !== true) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true });
  }));

  // ── Connections ───────────────────────────────────────────────────────────

  router.post("/api/power/connections", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const result = await repo.createConnection(readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    if ("unique" in result) return res.status(409).json({ error: "That plug is already in use, or the target is already powered." });
    return res.status(201).json({ ok: true, connection: result.connection });
  }));

  router.patch("/api/power/connections/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.updateConnection(id, readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    if ("unique" in result) return res.status(409).json({ error: "That plug is already in use, or the target is already powered." });
    return res.json({ ok: true, connection: result.connection });
  }));

  router.delete("/api/power/connections/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.deleteConnection(id);
    if (result !== true) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true });
  }));

  // ── Bulk positions ────────────────────────────────────────────────────────

  router.post("/api/power/items/positions", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const rawPositions = readBody(req)["positions"];
    const positions = Array.isArray(rawPositions) ? rawPositions : null;
    if (!positions) return res.status(400).json({ error: "positions array required" });
    await repo.bulkUpdatePositions(positions as unknown[]);
    return res.json({ ok: true });
  }));

  // ── Zones ─────────────────────────────────────────────────────────────────

  router.post("/api/power/zones", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const result = await repo.createZone(readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.status(201).json({ ok: true, zone: result.zone });
  }));

  router.patch("/api/power/zones/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.updateZone(id, readBody(req));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true, zone: result.zone });
  }));

  router.delete("/api/power/zones/:id", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params["id"]);
    const result = await repo.deleteZone(id);
    if (result !== true) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true });
  }));

  // ── Duplicate ─────────────────────────────────────────────────────────────

  router.post("/api/power/diagrams/:id/duplicate", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const srcId = Number(req.params["id"]);
    const result = await repo.duplicateDiagram(srcId, bodyString(readBody(req), "name"));
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.status(201).json({ ok: true, diagram: result.diagram });
  }));

  // ── Replace graph ─────────────────────────────────────────────────────────

  router.put("/api/power/diagrams/:id/graph", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const diagramId = Number(req.params["id"]);
    const graph = readBody(req);
    const items = Array.isArray(graph["items"]) ? graph["items"] : [];
    const connections = Array.isArray(graph["connections"]) ? graph["connections"] : [];
    const zones = Array.isArray(graph["zones"]) ? graph["zones"] : [];
    const result = await repo.replaceGraph(diagramId, items as unknown[], connections as unknown[], zones as unknown[]);
    if ("error" in result) return res.status(result.error.status).json({ error: result.error.error });
    return res.json({ ok: true, items: result.items, connections: result.connections, zones: result.zones });
  }));

  return router;
}
