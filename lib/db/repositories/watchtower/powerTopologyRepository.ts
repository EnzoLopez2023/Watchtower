import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository, type SqlValue } from "./base.js";
import { safeParse } from "../../../monitoring/payloadCodec.js";
import { asText } from "../../../monitoring/values.js";

export interface PowerTopologyRepository {
  listDiagrams(): Promise<PowerDiagram[]>;
  createDiagram(name: string): Promise<Record<string, unknown>>;
  renameDiagram(id: number, name: string): Promise<Record<string, unknown> | null>;
  deleteDiagram(id: number): Promise<boolean>;
  getDiagramGraph(id: number): Promise<{ diagram: unknown; items: unknown[]; connections: unknown[]; zones: unknown[] } | null>;
  createItem(b: Record<string, unknown>): Promise<{ error: ValidationError } | { item: Record<string, unknown> }>;
  updateItem(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { item: Record<string, unknown> }>;
  deleteItem(id: number): Promise<{ error: ValidationError } | true>;
  createConnection(b: Record<string, unknown>): Promise<{ error: ValidationError } | { connection: unknown } | { unique: true }>;
  updateConnection(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { connection: unknown } | { unique: true }>;
  deleteConnection(id: number): Promise<{ error: ValidationError } | true>;
  bulkUpdatePositions(positions: unknown[]): Promise<void>;
  createZone(b: Record<string, unknown>): Promise<{ error: ValidationError } | { zone: unknown }>;
  updateZone(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { zone: unknown }>;
  deleteZone(id: number): Promise<{ error: ValidationError } | true>;
  duplicateDiagram(srcId: number, name?: string | null): Promise<{ error: ValidationError } | { diagram: unknown }>;
  replaceGraph(diagramId: number, items: unknown[], connections: unknown[], zones: unknown[]): Promise<{ error: ValidationError } | { items: unknown[]; connections: unknown[]; zones: unknown[] }>;
}

const PROVIDES_PLUGS = new Set(["power_strip", "ups", "outlet"]);
const ACCEPTS_POWER = new Set(["device", "power_strip", "ups"]);
const KINDS = new Set(["device", "power_strip", "ups", "outlet"]);
const SUBTYPES = new Set(["computer", "monitor", "laptop_dock", "usb_charging_station", "tv", "game_console", "printer", "scanner", "external_hdd", "network_switch", "network_router", "isp_modem", "nvr"]);
const PLUG_TYPES = new Set(["battery", "surge"]);

function normalizeSubtype(kind: string, subtype: unknown): string | null {
  if (kind !== "device") return null;
  return typeof subtype === "string" && SUBTYPES.has(subtype) ? subtype : null;
}
function wattsOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return null;
  return Math.max(0, Math.round(Number(v)));
}
function colorOrNull(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null;
}
function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function upsIdOrNull(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v.trim()) ? v.trim() : null;
}
function safeParseJson(s: unknown, fallback: unknown = null): unknown {
  if (s == null) return fallback;
  return safeParse(s) ?? fallback;
}
function shapeItem(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, plug_labels: safeParseJson(row["plug_labels"], []) ?? [], plug_types: safeParseJson(row["plug_types"], null) };
}
function serializeLabels(labels: unknown, plugCount: number): string | null {
  if (!Array.isArray(labels)) return null;
  const clean = labels.slice(0, plugCount).map((l) => (typeof l === "string" && l.trim() ? l.trim() : null));
  return clean.some((l) => l !== null) ? JSON.stringify(clean) : null;
}
function serializePlugTypes(types: unknown, plugCount: number): string | null {
  if (!Array.isArray(types)) return null;
  const clean: (string | null)[] = (types as unknown[])
    .slice(0, plugCount)
    .map((entry) => (typeof entry === "string" && PLUG_TYPES.has(entry) ? entry : null));
  while (clean.length < plugCount) clean.push(null);
  return clean.some((t) => t !== null) ? JSON.stringify(clean) : null;
}

export interface ValidationError { readonly status: 400 | 404 | 409; readonly error: string }

export interface PowerDiagram { readonly id: number; readonly name: string; readonly updated_at: string }

export class SqlitePowerTopologyRepository extends SqliteRepository implements PowerTopologyRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  private touchDiagram(diagramId: number): void {
    this.run("UPDATE power_diagrams SET updated_at = datetime('now') WHERE id = ?", diagramId);
  }

  public async listDiagrams(): Promise<PowerDiagram[]> {
    return this.all("SELECT * FROM power_diagrams ORDER BY updated_at DESC, id DESC");
  }

  public async createDiagram(name: string): Promise<Record<string, unknown>> {
    const info = this.run("INSERT INTO power_diagrams (name) VALUES (?)", name);
    return this.get<Record<string, unknown>>("SELECT * FROM power_diagrams WHERE id = ?", info.lastInsertRowid) ?? {};
  }

  public async renameDiagram(id: number, name: string): Promise<Record<string, unknown> | null> {
    const info = this.run("UPDATE power_diagrams SET name = ?, updated_at = datetime('now') WHERE id = ?", name, id);
    if (info.changes === 0) return null;
    return this.get<Record<string, unknown>>("SELECT * FROM power_diagrams WHERE id = ?", id) ?? null;
  }

  public async deleteDiagram(id: number): Promise<boolean> {
    return this.run("DELETE FROM power_diagrams WHERE id = ?", id).changes > 0;
  }

  public async getDiagramGraph(id: number): Promise<{ diagram: unknown; items: unknown[]; connections: unknown[]; zones: unknown[] } | null> {
    const diagram = this.get<Record<string, unknown>>("SELECT * FROM power_diagrams WHERE id = ?", id);
    if (!diagram) return null;
    const items = this.all<Record<string, unknown>>("SELECT * FROM power_items WHERE diagram_id = ? ORDER BY id ASC", id).map(shapeItem);
    const connections = this.all("SELECT * FROM power_connections WHERE diagram_id = ? ORDER BY id ASC", id);
    const zones = this.all("SELECT * FROM power_zones WHERE diagram_id = ? ORDER BY id ASC", id);
    return { diagram, items, connections, zones };
  }

  public async createItem(b: Record<string, unknown>): Promise<{ error: ValidationError } | { item: Record<string, unknown> }> {
    const diagramId = Number(b["diagram_id"]);
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    const kind = typeof b["kind"] === "string" ? b["kind"] : "";
    if (!Number.isInteger(diagramId)) return { error: { status: 400, error: "diagram_id is required" } };
    if (!name) return { error: { status: 400, error: "name is required" } };
    if (!KINDS.has(kind)) return { error: { status: 400, error: "invalid kind" } };
    if (!this.get("SELECT id FROM power_diagrams WHERE id = ?", diagramId)) return { error: { status: 404, error: "diagram not found" } };

    const plugCount = kind === "device" ? 0 : Math.max(1, Math.min(64, Math.floor(Number(b["plug_count"]) || 1)));
    const info = this.runNamed(
      `INSERT INTO power_items (diagram_id, name, kind, subtype, plug_count, plug_labels, plug_types, watts, link_live, ups_id, pos_x, pos_y, notes)
       VALUES (@diagram_id, @name, @kind, @subtype, @plug_count, @plug_labels, @plug_types, @watts, @link_live, @ups_id, @pos_x, @pos_y, @notes)`,
      {
        diagram_id: diagramId, name, kind,
        subtype: normalizeSubtype(kind, b["subtype"]),
        plug_count: plugCount,
        plug_labels: serializeLabels(b["plug_labels"], plugCount),
        plug_types: serializePlugTypes(b["plug_types"], plugCount),
        watts: wattsOrNull(b["watts"]),
        link_live: kind === "ups" && b["link_live"] ? 1 : 0,
        ups_id: kind === "ups" && b["link_live"] ? upsIdOrNull(b["ups_id"]) : null,
        pos_x: Number.isFinite(Number(b["pos_x"])) ? Number(b["pos_x"]) : 0,
        pos_y: Number.isFinite(Number(b["pos_y"])) ? Number(b["pos_y"]) : 0,
        notes: typeof b["notes"] === "string" ? b["notes"] : null,
      }
    );
    this.touchDiagram(diagramId);
    return { item: shapeItem(this.get<Record<string, unknown>>("SELECT * FROM power_items WHERE id = ?", info.lastInsertRowid) ?? {}) };
  }

  public async updateItem(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { item: Record<string, unknown> }> {
    const item = this.get<Record<string, unknown>>("SELECT * FROM power_items WHERE id = ?", id);
    if (!item) return { error: { status: 404, error: "item not found" } };

    const next: Record<string, unknown> = {
      name: item["name"], subtype: item["subtype"], plug_count: item["plug_count"],
      plug_labels: item["plug_labels"], plug_types: item["plug_types"],
      watts: item["watts"], link_live: item["link_live"], ups_id: item["ups_id"],
      pos_x: item["pos_x"], pos_y: item["pos_y"], notes: item["notes"],
    };

    if (typeof b["name"] === "string" && b["name"].trim()) next["name"] = b["name"].trim();
    if (b["subtype"] !== undefined) next["subtype"] = normalizeSubtype(asText(item["kind"]), b["subtype"]);
    if (b["watts"] !== undefined) next["watts"] = wattsOrNull(b["watts"]);
    if (b["link_live"] !== undefined) next["link_live"] = item["kind"] === "ups" && b["link_live"] ? 1 : 0;
    if (b["ups_id"] !== undefined) next["ups_id"] = upsIdOrNull(b["ups_id"]);
    if (!next["link_live"]) next["ups_id"] = null;
    if (typeof b["notes"] === "string" || b["notes"] === null) next["notes"] = b["notes"];
    if (Number.isFinite(Number(b["pos_x"]))) next["pos_x"] = Number(b["pos_x"]);
    if (Number.isFinite(Number(b["pos_y"]))) next["pos_y"] = Number(b["pos_y"]);

    if (b["plug_count"] !== undefined && item["kind"] !== "device") {
      const requested = Math.max(1, Math.min(64, Math.floor(Number(b["plug_count"]) || 1)));
      const maxUsedRow = this.get<{ m: number | null }>("SELECT MAX(source_plug_index) AS m FROM power_connections WHERE source_item_id = ?", id);
      const maxUsed = maxUsedRow?.m ?? null;
      if (maxUsed != null && requested <= maxUsed) {
        return { error: { status: 409, error: `Cannot reduce below ${maxUsed + 1} plugs — plug ${maxUsed + 1} is in use. Remove that cable first.` } };
      }
      next["plug_count"] = requested;
    }
    if (b["plug_labels"] !== undefined) next["plug_labels"] = serializeLabels(b["plug_labels"], Number(next["plug_count"]));
    if (b["plug_types"] !== undefined) next["plug_types"] = serializePlugTypes(b["plug_types"], Number(next["plug_count"]));

    this.runNamed(
      `UPDATE power_items SET name = @name, subtype = @subtype, plug_count = @plug_count, plug_labels = @plug_labels, plug_types = @plug_types, watts = @watts, link_live = @link_live, ups_id = @ups_id, pos_x = @pos_x, pos_y = @pos_y, notes = @notes, updated_at = datetime('now') WHERE id = @id`,
      { ...next, id }
    );
    this.touchDiagram(Number(item["diagram_id"]));
    return { item: shapeItem(this.get<Record<string, unknown>>("SELECT * FROM power_items WHERE id = ?", id) ?? {}) };
  }

  public async deleteItem(id: number): Promise<{ error: ValidationError } | true> {
    const item = this.get<{ diagram_id: number }>("SELECT diagram_id FROM power_items WHERE id = ?", id);
    if (!item) return { error: { status: 404, error: "item not found" } };
    this.run("DELETE FROM power_items WHERE id = ?", id);
    this.touchDiagram(item.diagram_id);
    return true;
  }

  private validateConnection(diagramId: number, sourceItemId: number, sourcePlugIndex: number, targetItemId: number): ValidationError | null {
    if (![diagramId, sourceItemId, targetItemId].every(Number.isInteger) || !Number.isInteger(sourcePlugIndex)) {
      return { status: 400, error: "diagram_id, source_item_id, source_plug_index and target_item_id are required" };
    }
    if (sourceItemId === targetItemId) return { status: 400, error: "an item cannot power itself" };
    const source = this.get<{ diagram_id: number; kind: string; plug_count: number }>("SELECT * FROM power_items WHERE id = ?", sourceItemId);
    const target = this.get<{ diagram_id: number; kind: string }>("SELECT * FROM power_items WHERE id = ?", targetItemId);
    if (!source || !target) return { status: 404, error: "source or target item not found" };
    if (source.diagram_id !== diagramId || target.diagram_id !== diagramId) return { status: 400, error: "items belong to a different diagram" };
    if (!PROVIDES_PLUGS.has(source.kind)) return { status: 400, error: `${source.kind} has no output plugs` };
    if (!ACCEPTS_POWER.has(target.kind)) return { status: 400, error: "a wall outlet cannot be powered by another item" };
    if (sourcePlugIndex < 0 || sourcePlugIndex >= source.plug_count) return { status: 400, error: "plug index out of range" };
    return null;
  }

  public async createConnection(b: Record<string, unknown>): Promise<{ error: ValidationError } | { connection: unknown } | { unique: true }> {
    const diagramId = Number(b["diagram_id"]);
    const sourceItemId = Number(b["source_item_id"]);
    const sourcePlugIndex = Number(b["source_plug_index"]);
    const targetItemId = Number(b["target_item_id"]);
    const invalid = this.validateConnection(diagramId, sourceItemId, sourcePlugIndex, targetItemId);
    if (invalid) return { error: invalid };
    try {
      const info = this.run(
        "INSERT INTO power_connections (diagram_id, source_item_id, source_plug_index, target_item_id, label, color) VALUES (?, ?, ?, ?, ?, ?)",
        diagramId, sourceItemId, sourcePlugIndex, targetItemId, textOrNull(b["label"]), colorOrNull(b["color"])
      );
      this.touchDiagram(diagramId);
      return { connection: this.get("SELECT * FROM power_connections WHERE id = ?", info.lastInsertRowid) };
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) return { unique: true };
      throw err;
    }
  }

  public async updateConnection(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { connection: unknown } | { unique: true }> {
    const existing = this.get<{ id: number; diagram_id: number; source_item_id: number; source_plug_index: number; target_item_id: number; label: string | null; color: string | null }>("SELECT * FROM power_connections WHERE id = ?", id);
    if (!existing) return { error: { status: 404, error: "connection not found" } };
    const wiringTouched = b["source_item_id"] !== undefined || b["source_plug_index"] !== undefined || b["target_item_id"] !== undefined;
    const sourceItemId = b["source_item_id"] !== undefined ? Number(b["source_item_id"]) : existing.source_item_id;
    const sourcePlugIndex = b["source_plug_index"] !== undefined ? Number(b["source_plug_index"]) : existing.source_plug_index;
    const targetItemId = b["target_item_id"] !== undefined ? Number(b["target_item_id"]) : existing.target_item_id;
    if (wiringTouched) {
      const invalid = this.validateConnection(existing.diagram_id, sourceItemId, sourcePlugIndex, targetItemId);
      if (invalid) return { error: invalid };
    }
    const label = b["label"] !== undefined ? textOrNull(b["label"]) : existing.label;
    const color = b["color"] !== undefined ? colorOrNull(b["color"]) : existing.color;
    try {
      this.run("UPDATE power_connections SET source_item_id = ?, source_plug_index = ?, target_item_id = ?, label = ?, color = ? WHERE id = ?", sourceItemId, sourcePlugIndex, targetItemId, label, color, id);
      this.touchDiagram(existing.diagram_id);
      return { connection: this.get("SELECT * FROM power_connections WHERE id = ?", id) };
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) return { unique: true };
      throw err;
    }
  }

  public async deleteConnection(id: number): Promise<{ error: ValidationError } | true> {
    const row = this.get<{ diagram_id: number }>("SELECT diagram_id FROM power_connections WHERE id = ?", id);
    if (!row) return { error: { status: 404, error: "connection not found" } };
    this.run("DELETE FROM power_connections WHERE id = ?", id);
    this.touchDiagram(row.diagram_id);
    return true;
  }

  public async bulkUpdatePositions(positions: unknown[]): Promise<void> {
    const diagramIds = this.transaction(() => this.bulkUpdatePositionsSync(positions));
    for (const d of diagramIds) this.touchDiagram(d);
  }

  private bulkUpdatePositionsSync(positions: unknown[]): Set<number> {
    const diagramIds = new Set<number>();
    for (const p of positions) {
      const pos = p as Record<string, unknown>;
      const id = Number(pos["id"]);
      if (!Number.isInteger(id)) continue;
      const row = this.get<{ diagram_id: number }>("SELECT diagram_id FROM power_items WHERE id = ?", id);
      if (!row) continue;
      this.run("UPDATE power_items SET pos_x = ?, pos_y = ?, updated_at = datetime('now') WHERE id = ?", Number(pos["pos_x"]) || 0, Number(pos["pos_y"]) || 0, id);
      diagramIds.add(row.diagram_id);
    }
    return diagramIds;
  }

  public async createZone(b: Record<string, unknown>): Promise<{ error: ValidationError } | { zone: unknown }> {
    const diagramId = Number(b["diagram_id"]);
    if (!Number.isInteger(diagramId)) return { error: { status: 400, error: "diagram_id is required" } };
    if (!this.get("SELECT id FROM power_diagrams WHERE id = ?", diagramId)) return { error: { status: 404, error: "diagram not found" } };
    const info = this.runNamed(
      "INSERT INTO power_zones (diagram_id, name, pos_x, pos_y, width, height, color) VALUES (@diagram_id, @name, @pos_x, @pos_y, @width, @height, @color)",
      { diagram_id: diagramId, name: textOrNull(b["name"]) ?? "Zone", pos_x: Number(b["pos_x"]) || 0, pos_y: Number(b["pos_y"]) || 0, width: Math.max(80, Number(b["width"]) || 320), height: Math.max(80, Number(b["height"]) || 220), color: colorOrNull(b["color"]) }
    );
    this.touchDiagram(diagramId);
    return { zone: this.get("SELECT * FROM power_zones WHERE id = ?", info.lastInsertRowid) };
  }

  public async updateZone(id: number, b: Record<string, unknown>): Promise<{ error: ValidationError } | { zone: unknown }> {
    const zone = this.get<Record<string, unknown>>("SELECT * FROM power_zones WHERE id = ?", id);
    if (!zone) return { error: { status: 404, error: "zone not found" } };
    const next: Record<string, SqlValue> = {
      name: (b["name"] !== undefined ? (textOrNull(b["name"]) ?? "Zone") : asText(zone["name"])),
      pos_x: b["pos_x"] !== undefined ? Number(b["pos_x"]) || 0 : Number(zone["pos_x"]),
      pos_y: b["pos_y"] !== undefined ? Number(b["pos_y"]) || 0 : Number(zone["pos_y"]),
      width: b["width"] !== undefined ? Math.max(80, Number(b["width"]) || 320) : Number(zone["width"]),
      height: b["height"] !== undefined ? Math.max(80, Number(b["height"]) || 220) : Number(zone["height"]),
      color: b["color"] !== undefined ? colorOrNull(b["color"]) : (zone["color"] as string | null),
    };
    this.runNamed("UPDATE power_zones SET name=@name, pos_x=@pos_x, pos_y=@pos_y, width=@width, height=@height, color=@color, updated_at=datetime('now') WHERE id=@id", { ...next, id });
    this.touchDiagram(Number(zone["diagram_id"]));
    return { zone: this.get("SELECT * FROM power_zones WHERE id = ?", id) };
  }

  public async deleteZone(id: number): Promise<{ error: ValidationError } | true> {
    const zone = this.get<{ diagram_id: number }>("SELECT diagram_id FROM power_zones WHERE id = ?", id);
    if (!zone) return { error: { status: 404, error: "zone not found" } };
    this.run("DELETE FROM power_zones WHERE id = ?", id);
    this.touchDiagram(zone.diagram_id);
    return true;
  }

  public async duplicateDiagram(srcId: number, name?: string | null): Promise<{ error: ValidationError } | { diagram: unknown }> {
    const src = this.get<{ name: string }>("SELECT * FROM power_diagrams WHERE id = ?", srcId);
    if (!src) return { error: { status: 404, error: "diagram not found" } };
    const newDiagramId = this.transaction(() => this.duplicateDiagramSync(srcId, src.name, name));
    return { diagram: this.get("SELECT * FROM power_diagrams WHERE id = ?", newDiagramId) };
  }

  private duplicateDiagramSync(srcId: number, srcName: string, name?: string | null): number {
    const newName = textOrNull(name) ?? `${srcName} (copy)`;
    const info = this.run("INSERT INTO power_diagrams (name) VALUES (?)", newName);
    const newId = info.lastInsertRowid;
    const idMap = new Map<number, number>();
    const items = this.all<Record<string, unknown>>("SELECT * FROM power_items WHERE diagram_id = ?", srcId);
    for (const it of items) {
      const r = this.runNamed(
        "INSERT INTO power_items (diagram_id, name, kind, subtype, plug_count, plug_labels, plug_types, watts, link_live, ups_id, pos_x, pos_y, notes) VALUES (@diagram_id, @name, @kind, @subtype, @plug_count, @plug_labels, @plug_types, @watts, @link_live, @ups_id, @pos_x, @pos_y, @notes)",
        { ...it, diagram_id: newId }
      );
      idMap.set(Number(it["id"]), r.lastInsertRowid);
    }
    const conns = this.all<{ id: number; source_item_id: number; source_plug_index: number; target_item_id: number; label: string | null; color: string | null }>("SELECT * FROM power_connections WHERE diagram_id = ?", srcId);
    for (const c of conns) {
      this.run("INSERT INTO power_connections (diagram_id, source_item_id, source_plug_index, target_item_id, label, color) VALUES (?, ?, ?, ?, ?, ?)",
        newId, idMap.get(c.source_item_id) ?? c.source_item_id, c.source_plug_index, idMap.get(c.target_item_id) ?? c.target_item_id, c.label, c.color);
    }
    const zones = this.all<{ name: string; pos_x: number; pos_y: number; width: number; height: number; color: string | null }>("SELECT * FROM power_zones WHERE diagram_id = ?", srcId);
    for (const z of zones) this.run("INSERT INTO power_zones (diagram_id, name, pos_x, pos_y, width, height, color) VALUES (?, ?, ?, ?, ?, ?, ?)", newId, z.name, z.pos_x, z.pos_y, z.width, z.height, z.color);
    return newId;
  }

  public async replaceGraph(diagramId: number, items: unknown[], connections: unknown[], zones: unknown[]): Promise<{ error: ValidationError } | { items: unknown[]; connections: unknown[]; zones: unknown[] }> {
    if (!this.get("SELECT id FROM power_diagrams WHERE id = ?", diagramId)) return { error: { status: 404, error: "diagram not found" } };
    return this.transaction(() => this.replaceGraphSync(diagramId, items, connections, zones));
  }

  private replaceGraphSync(diagramId: number, items: unknown[], connections: unknown[], zones: unknown[]): { items: unknown[]; connections: unknown[]; zones: unknown[] } {
    this.run("DELETE FROM power_connections WHERE diagram_id = ?", diagramId);
    this.run("DELETE FROM power_zones WHERE diagram_id = ?", diagramId);
    this.run("DELETE FROM power_items WHERE diagram_id = ?", diagramId);
    for (const it of items) {
      const item = it as Record<string, unknown>;
      const link_live = item["kind"] === "ups" && item["link_live"] ? 1 : 0;
      this.runNamed(
        "INSERT INTO power_items (id, diagram_id, name, kind, subtype, plug_count, plug_labels, plug_types, watts, link_live, ups_id, pos_x, pos_y, notes) VALUES (@id, @diagram_id, @name, @kind, @subtype, @plug_count, @plug_labels, @plug_types, @watts, @link_live, @ups_id, @pos_x, @pos_y, @notes)",
        {
          id: Number(item["id"]), diagram_id: diagramId,
          name: asText(item["name"], "Item"),
          kind: KINDS.has(asText(item["kind"])) ? asText(item["kind"]) : "device",
          subtype: normalizeSubtype(asText(item["kind"]), item["subtype"]),
          plug_count: Number(item["plug_count"]) || 0,
          plug_labels: serializeLabels(item["plug_labels"], Number(item["plug_count"]) || 0),
          plug_types: serializePlugTypes(item["plug_types"], Number(item["plug_count"]) || 0),
          watts: wattsOrNull(item["watts"]),
          link_live, ups_id: link_live ? upsIdOrNull(item["ups_id"]) : null,
          pos_x: Number(item["pos_x"]) || 0, pos_y: Number(item["pos_y"]) || 0,
          notes: typeof item["notes"] === "string" ? item["notes"] : null,
        }
      );
    }
    for (const c of connections) {
      const conn = c as Record<string, unknown>;
      this.run("INSERT INTO power_connections (id, diagram_id, source_item_id, source_plug_index, target_item_id, label, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
        Number(conn["id"]), diagramId, Number(conn["source_item_id"]), Number(conn["source_plug_index"]), Number(conn["target_item_id"]), textOrNull(conn["label"]), colorOrNull(conn["color"]));
    }
    for (const z of zones) {
      const zone = z as Record<string, unknown>;
      this.run("INSERT INTO power_zones (id, diagram_id, name, pos_x, pos_y, width, height, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        Number(zone["id"]), diagramId, textOrNull(zone["name"]) ?? "Zone", Number(zone["pos_x"]) || 0, Number(zone["pos_y"]) || 0, Math.max(80, Number(zone["width"]) || 320), Math.max(80, Number(zone["height"]) || 220), colorOrNull(zone["color"]));
    }
    this.touchDiagram(diagramId);
    return {
      items: this.all<Record<string, unknown>>("SELECT * FROM power_items WHERE diagram_id = ? ORDER BY id ASC", diagramId).map(shapeItem),
      connections: this.all("SELECT * FROM power_connections WHERE diagram_id = ? ORDER BY id ASC", diagramId),
      zones: this.all("SELECT * FROM power_zones WHERE diagram_id = ? ORDER BY id ASC", diagramId),
    };
  }
}
