import { Router } from "express";
import type { Request, Response } from "express";
import { requireRole } from "../../auth/authorize.js";
import type { IpPlanRepository, IpPlanRow } from "../../../lib/db/repositories/watchtower/ipPlanRepository.js";
import { unpackJson } from "../../../lib/monitoring/payloadCodec.js";
import { IP_PLAN_BLOCKS, IP_PLAN_SEED } from "../../../lib/monitoring/ipPlanSeed.js";
import { asText } from "../../../lib/monitoring/values.js";
import { asyncHandler, readBody } from "./http.js";

export interface IpPlanRouterDependencies {
  readonly repository: IpPlanRepository;
}

const PLAN_SUBNET = IP_PLAN_BLOCKS[0]?.subnet ?? "192.168.1";

function macKey(m: unknown): string {
  return asText(m).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function octetIn(ip: unknown): number | null {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(asText(ip));
  return m != null && m[1] === PLAN_SUBNET ? Number(m[2]) : null;
}

function blockFor(ip: unknown): { code: string; label: string } | null {
  const n = octetIn(ip);
  if (n == null) return null;
  const b = IP_PLAN_BLOCKS.find((x) => n >= x.lo && n <= x.hi);
  return b ? { code: b.code, label: b.label } : null;
}

const DYN_BLOCK = IP_PLAN_BLOCKS.find((b) => b.code === "DYN") ?? null;

function inPool(ip: unknown, pool: { start?: unknown; stop?: unknown } | null): boolean {
  const n = octetIn(ip);
  if (n == null) return false;
  const lo = octetIn(pool?.start) ?? DYN_BLOCK?.lo;
  const hi = octetIn(pool?.stop) ?? DYN_BLOCK?.hi;
  return lo != null && hi != null && n >= lo && n <= hi;
}

function poolFrom(payload: Record<string, unknown> | null): { network: string | null; start: string; stop: string; lease_seconds: number | null } | null {
  const cfg = payload?.["config"] as Record<string, unknown> | null | undefined;
  const nets = Array.isArray(cfg?.["networks"]) ? (cfg["networks"] as Record<string, unknown>[]) : [];
  const lan = nets.find((n) => n["dhcp_start"] && n["dhcp_stop"] && asText(n["subnet"]).startsWith(`${PLAN_SUBNET}.`));
  if (!lan) return null;
  return { network: lan["name"] as string ?? null, start: asText(lan["dhcp_start"]), stop: asText(lan["dhcp_stop"]), lease_seconds: Number.isFinite(lan["dhcp_lease_seconds"]) ? Number(lan["dhcp_lease_seconds"]) : null };
}

interface ObservedEntry { ip: string | null; source: string | null; kind: "gateway" | "device" | "client"; lanIps?: string[] }

function observedByMac(repo: IpPlanRepository): Promise<{ at: number | null; map: Map<string, ObservedEntry>; payload: Record<string, unknown> | null }> {
  return repo.getUnifiLatest().then((row) => {
    if (!row) return { at: null, map: new Map<string, ObservedEntry>(), payload: null };
    const payload = (unpackJson<Record<string, unknown>>(row.payload) ?? {});
    const map = new Map<string, ObservedEntry>();
    const wanPayload = payload["wan"] as Record<string, unknown> | null | undefined;
    const wanHealth = wanPayload?.["_health"] as Record<string, unknown> | null | undefined;
    const wanHealthWan = wanHealth?.["wan"] as Record<string, unknown> | null | undefined;
    const gwMac = macKey(wanHealthWan?.["gw_mac"]);
    const cfgPayload = payload["config"] as Record<string, unknown> | null | undefined;
    const lanIps = (Array.isArray(cfgPayload?.["networks"]) ? (cfgPayload["networks"] as Record<string, unknown>[]) : [])
      .map((n) => n["gateway_ip"] as string | undefined).filter(Boolean) as string[];
    for (const d of (Array.isArray(payload["devices"]) ? payload["devices"] as Record<string, unknown>[] : [])) {
      const k = macKey(d["mac"]);
      if (!k) continue;
      if (k === gwMac && lanIps.length) {
        map.set(k, { ip: d["ip"] as string ?? null, source: null, kind: "gateway", lanIps });
      } else {
        map.set(k, { ip: d["ip"] as string ?? null, source: null, kind: "device" });
      }
    }
    for (const c of (Array.isArray(payload["clients"]) ? payload["clients"] as Record<string, unknown>[] : [])) {
      const k = macKey(c["mac"]);
      if (k) map.set(k, { ip: c["ip"] as string ?? null, source: c["ip_source"] as string ?? null, kind: "client" });
    }
    return { at: row.received_at, map, payload };
  });
}

type EvalState = "no-action" | "offline" | "verified" | "at-target" | "pending" | "mismatch";

function evaluate(row: IpPlanRow, obs: ObservedEntry | null): { state: EvalState; observedIp: string | null } {
  if (!row.target_ip) return { state: "no-action", observedIp: obs?.ip ?? null };
  if (!obs || !obs.ip) return { state: "offline", observedIp: null };
  if (obs.kind === "gateway") {
    const observedIp = obs.lanIps?.includes(row.target_ip) ? row.target_ip : (obs.lanIps?.[0] ?? null);
    if (obs.lanIps?.includes(row.target_ip)) return { state: "verified", observedIp };
    if (row.marked_done) return { state: "mismatch", observedIp };
    return { state: "pending", observedIp };
  }
  const atTarget = obs.ip === row.target_ip;
  const pinned = obs.kind === "device" || obs.source === "reserved" || obs.source === "static";
  if (atTarget && pinned) return { state: "verified", observedIp: obs.ip };
  if (atTarget) return { state: "at-target", observedIp: obs.ip };
  if (row.marked_done) return { state: "mismatch", observedIp: obs.ip };
  return { state: "pending", observedIp: obs.ip };
}

function collectUnplanned(payload: Record<string, unknown> | null, planned: Set<string>, targets: Map<string, unknown>, pool: { start?: string; stop?: string } | null): unknown[] {
  const out: unknown[] = [];
  if (!payload) return out;
  const vendorName = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s && !/^\d+$/.test(s) ? s : null; };
  for (const d of (Array.isArray(payload["devices"]) ? payload["devices"] as Record<string, unknown>[] : [])) {
    const k = macKey(d["mac"]);
    if (!k || planned.has(k)) continue;
    out.push({ mac: d["mac"], name: d["name"] ?? null, vendor: d["model"] ?? null, ip: d["ip"] ?? null, kind: "device", ip_source: null, fixed_ip: null, block: blockFor(d["ip"]), conflict: null, classification: "new-hardware" });
  }
  for (const c of (Array.isArray(payload["clients"]) ? payload["clients"] as Record<string, unknown>[] : [])) {
    const k = macKey(c["mac"]);
    if (!k || planned.has(k)) continue;
    const raw = (c["raw"] as Record<string, unknown>) ?? {};
    const reserved = c["ip_source"] === "reserved";
    const named = (c["name"] as string | null) || (raw["hostname"] as string | null) || "";
    const stale = !reserved && c["fixed_ip"] ? (targets.get(c["fixed_ip"] as string) ?? null) : null;
    out.push({
      mac: c["mac"], name: (named && macKey(named) !== k) ? named : null,
      vendor: vendorName(raw["oui"]) ?? vendorName(raw["dev_vendor"]),
      ip: c["ip"] ?? null, kind: "client", ip_source: c["ip_source"] ?? null, fixed_ip: c["fixed_ip"] ?? null,
      block: blockFor(c["ip"]), conflict: stale,
      classification: stale ? "conflict" : reserved ? "reserved" : (c["ip"] && !inPool(c["ip"], pool)) ? "unpinned" : "roaming",
    });
  }
  const rank: Record<string, number> = { conflict: 0, "new-hardware": 1, unpinned: 2, reserved: 3, roaming: 4 };
  return out.sort((a, b) => {
    const ar = rank[(a as Record<string, unknown>)["classification"] as string] ?? 99;
    const br2 = rank[(b as Record<string, unknown>)["classification"] as string] ?? 99;
    return (ar - br2) || ((octetIn((a as Record<string, unknown>)["ip"]) ?? 999) - (octetIn((b as Record<string, unknown>)["ip"]) ?? 999));
  });
}

export function createIpPlanRouter(deps: IpPlanRouterDependencies): Router {
  const router = Router();
  const repo = deps.repository;

  void repo.seed(IP_PLAN_SEED);

  router.get("/api/ip-plan", requireRole("viewer"), asyncHandler(async (_req: Request, res: Response) => {
    const { at, map, payload } = await observedByMac(repo);
    const rows = await repo.getAllRows();
    const now = Date.now();

    const plannedMacs = new Set(rows.map((r) => macKey(r.mac)));
    const plannedTargets = new Map<string, unknown>();
    for (const r of rows) {
      if (r.target_ip) plannedTargets.set(r.target_ip, { name: r.name, group_code: r.group_code, group_label: r.group_label });
    }

    const groups = new Map<string, { code: string; label: string; order: number; items: unknown[]; total: number; verified: number }>();
    let actionable = 0, verified = 0, marked = 0, mismatched = 0;

    for (const r of rows) {
      const obs = map.get(macKey(r.mac)) ?? null;
      const { state, observedIp } = evaluate(r, obs);
      if (state === "verified" && !r.first_verified_at) {
        await repo.setFirstVerified(r.mac, now);
      }
      if (r.target_ip) {
        actionable++;
        if (state === "verified") verified++;
        if (r.marked_done) marked++;
        if (state === "mismatch") mismatched++;
      }
      if (!groups.has(r.group_code)) {
        groups.set(r.group_code, { code: r.group_code, label: r.group_label, order: r.group_order, items: [], total: 0, verified: 0 });
      }
      const g = groups.get(r.group_code)!;
      g.items.push({
        mac: r.mac, name: r.name, original_ip: r.original_ip, target_ip: r.target_ip,
        marked_done: r.marked_done === 1, marked_at: r.marked_at, notes: r.notes,
        first_verified_at: r.first_verified_at, already_reserved: r.already_reserved === 1,
        observed_ip: observedIp ?? null, ip_source: obs?.source ?? null, kind: obs?.kind ?? null, state,
      });
      if (r.target_ip) { g.total++; if (state === "verified") g.verified++; }
    }

    const pool = poolFrom(payload);
    const unplanned = collectUnplanned(payload, plannedMacs, plannedTargets, pool);

    return res.json({
      ok: true,
      last_polled: at,
      last_polled_age_seconds: at ? Math.round((now - at) / 1000) : null,
      progress: { actionable, verified, marked, mismatched, remaining: actionable - verified },
      pool,
      unplanned,
      unplanned_attention: unplanned.filter((u) => (u as Record<string, unknown>)["classification"] !== "roaming").length,
      groups: [...groups.values()].sort((a, b) => a.order - b.order),
    });
  }));

  router.patch("/api/ip-plan/:mac", requireRole("operator"), asyncHandler(async (req: Request, res: Response) => {
    const mac = asText(req.params["mac"]).toLowerCase();
    const existing = await repo.getByMac(mac);
    if (!existing) return res.status(404).json({ error: "Unknown device" });
    const body = readBody(req);
    if (typeof body["marked_done"] === "boolean") {
      const markedDone = body["marked_done"];
      await repo.updateMark(mac, markedDone, markedDone ? Date.now() : null);
    }
    if (typeof body["notes"] === "string") {
      await repo.updateNotes(mac, body["notes"].slice(0, 500) || null);
    }
    return res.json({ ok: true });
  }));

  return router;
}
