import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import type { ProtectRepository } from "../../../lib/db/repositories/watchtower/protectRepository.js";
import { AGENT_FRESHNESS, seconds } from "../../../lib/monitoring/agentFreshness.js";
import { safeParse } from "../../../lib/monitoring/payloadCodec.js";
import { requireRole } from "../../auth/authorize.js";
import { asyncHandler, queryString, queryInteger } from "./http.js";
import { requireServiceToken } from "./serviceAuth.js";
import { asText } from "../../../lib/monitoring/values.js";

export interface ProtectServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: ProtectRepository;
}

export interface ProtectRouterDependencies {
  readonly repository: ProtectRepository;
}

const STALE_MS = AGENT_FRESHNESS.protect.staleAfterMs;
const READINGS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RANGES: Readonly<Record<string, number>> = {
  "24h": 24 * 3600e3,
  "7d": 7 * 24 * 3600e3,
  "30d": 30 * 24 * 3600e3,
};

function isOnline(c: unknown): boolean {
  if (typeof c !== "object" || c === null) return false;
  const obj = c as Record<string, unknown>;
  const s = asText(obj["state"]).toUpperCase();
  return obj["online"] === true || s === "CONNECTED" || s === "ONLINE";
}

export function createProtectServiceRouter(deps: ProtectServiceRouterDependencies): Router {
  const router = Router();

  router.post(
    "/api/protect/ingest",
    requireServiceToken({
      expected: () => deps.config.serviceTokens.protect ?? deps.config.serviceTokens.unifi,
      unconfiguredMessage:
        "Protect ingest not configured — set PROTECT_INGEST_TOKEN or UNIFI_INGEST_TOKEN",
      headers: ["x-protect-token", "x-unifi-token"],
    }),
    express.json({ limit: "50mb" }),
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "Body must be a JSON object" });
        return;
      }

      const now = Date.now();
      const prune = await deps.repository.shouldPrune(now);

      const cameras = Array.isArray(body["cameras"]) ? (body["cameras"] as unknown[]) : [];
      const sensors = Array.isArray(body["sensors"]) ? (body["sensors"] as unknown[]) : [];
      const accessories = Array.isArray(body["accessories"]) ? (body["accessories"] as unknown[]) : [];
      const nvr =
        body["nvr"] && typeof body["nvr"] === "object" ? (body["nvr"] as Record<string, unknown>) : {};
      const online = cameras.filter(isOnline).length;

      const st =
        nvr["storage"] && typeof nvr["storage"] === "object"
          ? (nvr["storage"] as Record<string, unknown>)
          : null;
      const storageUsedBytes =
        st !== null && Number.isFinite(Number(st["used_bytes"]))
          ? Math.round(Number(st["used_bytes"]))
          : null;
      const storageTotalBytes =
        st !== null && Number.isFinite(Number(st["total_bytes"]))
          ? Math.round(Number(st["total_bytes"]))
          : null;

      const rawEvents = Array.isArray(body["events"]) ? (body["events"] as unknown[]) : [];
      const events: {
        event_id: string;
        start_ms: number;
        end_ms: number | null;
        type: string | null;
        camera_id: string | null;
        camera_name: string | null;
        smart_types: string;
        score: number | null;
      }[] = [];
      for (const e of rawEvents) {
        if (!e || typeof e !== "object") continue;
        const ev = e as Record<string, unknown>;
        if (!ev["id"] || !ev["start"]) continue;
        events.push({
          event_id: asText(ev["id"]),
          start_ms: Number(ev["start"]),
          end_ms: ev["end"] != null ? Number(ev["end"]) : null,
          type: ev["type"] != null ? asText(ev["type"]) : null,
          camera_id: ev["camera_id"] != null ? asText(ev["camera_id"]) : null,
          camera_name: ev["camera_name"] != null ? asText(ev["camera_name"]) : null,
          smart_types: JSON.stringify(Array.isArray(ev["smart_types"]) ? ev["smart_types"] : []),
          score: ev["score"] != null ? Number(ev["score"]) : null,
        });
      }

      const result = await deps.repository.ingest(
        {
          now,
          numCameras: cameras.length,
          camerasOnline: online,
          storageUsedBytes,
          storageTotalBytes,
          payload: JSON.stringify({ nvr, cameras, sensors, accessories }),
          events,
          prune,
        },
        deliveryIdFrom(req.get("x-hearth-delivery-id"), req.body)
      );

      if (prune && !result.duplicate) {
        await deps.repository.setLastPruneAt(result.receivedAt);
      }
      res.json({ ok: true, duplicate: result.duplicate, received_at: result.receivedAt });
    })
  );

  return router;
}

export function createProtectRouter(deps: ProtectRouterDependencies): Router {
  const router = Router();

  router.get(
    "/api/protect",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const row = await deps.repository.getLatest();
      if (!row) {
        res.json({
          ok: true,
          present: false,
          last_contact_at: null,
          expected_cadence_seconds: seconds(AGENT_FRESHNESS.protect.expectedCadenceMs),
          stale_after_seconds: seconds(STALE_MS),
        });
        return;
      }

      const payload = safeParse<Record<string, unknown>>(row.payload) ?? {};
      const cameras = Array.isArray(payload["cameras"]) ? payload["cameras"] : [];
      const sensors = Array.isArray(payload["sensors"]) ? payload["sensors"] : [];
      const accessories = Array.isArray(payload["accessories"]) ? payload["accessories"] : [];
      const ageMs = Date.now() - row.received_at;

      res.json({
        ok: true,
        present: true,
        age_seconds: Math.round(ageMs / 1000),
        stale: ageMs > STALE_MS,
        received_at: row.received_at,
        last_contact_at: row.received_at,
        source_observed_at: (payload["ts"] as number | null | undefined) ?? null,
        expected_cadence_seconds: seconds(AGENT_FRESHNESS.protect.expectedCadenceMs),
        stale_after_seconds: seconds(STALE_MS),
        nvr: payload["nvr"] ?? {},
        num_cameras: cameras.length,
        cameras_online: cameras.filter(isOnline).length,
        num_sensors: sensors.length,
        sensors_online: sensors.filter(isOnline).length,
        cameras,
        sensors,
        accessories,
      });
    })
  );

  router.get(
    "/api/protect/history",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const rangeKey = queryString(req.query["range"]);
      const range = rangeKey !== undefined && rangeKey in RANGES ? rangeKey : "24h";
      const cutoff = Date.now() - (RANGES[range] as number);
      const points = await deps.repository.getHistory(cutoff);
      res.json({ ok: true, range, points });
    })
  );

  router.get(
    "/api/protect/events",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const limit = queryInteger(req.query["limit"], 100, 1, 500);
      const hours = queryInteger(req.query["hours"], 24, 1, 720);
      const cutoff = Date.now() - hours * 3600e3;
      const camera = queryString(req.query["camera"]);
      const type = queryString(req.query["type"]);

      const rows = await deps.repository.getEvents(cutoff, camera, type);
      const byType = await deps.repository.getEventTypeCount(cutoff, camera, type);
      const total = await deps.repository.getEventTotal(cutoff, camera, type);

      res.json({
        ok: true,
        hours,
        total,
        by_type: byType,
        events: rows.slice(0, limit).map((r) => ({
          ...r,
          smart_types: (safeParse(r.smart_types) as unknown[]) ?? [],
        })),
      });
    })
  );

  router.get(
    "/api/protect/activity",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 7, 1, 30);
      const tzRaw = parseInt(asText(req.query["tz"], "0"), 10);
      const tz = Math.min(Math.max(Number.isFinite(tzRaw) ? tzRaw : 0, -840), 840);
      const cutoff = Date.now() - days * 24 * 3600e3;

      const rows = await deps.repository.getActivity(cutoff, tz * 60000);

      const byCamera = new Map<
        string,
        { camera: string; total: number; hours: number[] }
      >();
      for (const r of rows) {
        if (!byCamera.has(r.camera)) {
          byCamera.set(r.camera, { camera: r.camera, total: 0, hours: Array(24).fill(0) as number[] });
        }
        const entry = byCamera.get(r.camera)!;
        if (r.hour >= 0 && r.hour < 24) (entry.hours)[r.hour] = r.n;
        entry.total += r.n;
      }
      const cameras = [...byCamera.values()].sort((a, b) => b.total - a.total);
      const peak = cameras.reduce((m, c) => Math.max(m, ...(c.hours)), 0);
      const hourTotals = Array(24).fill(0) as number[];
      for (const c of cameras) {
        for (let h = 0; h < 24; h++) {
          const cur = (hourTotals)[h];
          if (cur !== undefined) {
            (hourTotals)[h] = cur + ((c.hours)[h] ?? 0);
          }
        }
      }

      res.json({
        ok: true,
        days,
        peak,
        total: cameras.reduce((s, c) => s + c.total, 0),
        hour_totals: hourTotals,
        cameras,
      });
    })
  );

  router.get(
    "/api/protect/storage-forecast",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const rows = await deps.repository.getStorageSamples(Date.now() - READINGS_RETENTION_MS);

      if (rows.length < 2) {
        res.json({ ok: true, state: "collecting", samples: rows.length });
        return;
      }

      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const spanMs = last.received_at - first.received_at;
      const spanDays = spanMs / 86_400_000;

      if (spanMs < 6 * 3600e3) {
        res.json({ ok: true, state: "collecting", samples: rows.length, span_days: spanDays });
        return;
      }

      const n = rows.length;
      const t0 = first.received_at;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const r of rows) {
        const x = (r.received_at - t0) / 86_400_000;
        const y = r.used;
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const denom = n * sxx - sx * sx;
      const perDay = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;

      const total = last.total ?? null;
      const used = last.used;
      const free = total != null ? total - used : null;
      const pct = total ? (used / total) * 100 : null;
      const recycling = pct != null && pct >= 92 && perDay <= 0;

      let daysUntilFull = null;
      if (!recycling && perDay > 0 && free != null && free > 0) daysUntilFull = free / perDay;

      res.json({
        ok: true,
        state: recycling ? "recycling" : daysUntilFull != null ? "filling" : "stable",
        samples: n,
        span_days: spanDays,
        bytes_per_day: perDay,
        used_bytes: used,
        total_bytes: total,
        free_bytes: free,
        used_pct: pct,
        days_until_full: daysUntilFull,
      });
    })
  );

  return router;
}
