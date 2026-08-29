import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import type {
  IngestDisk,
  IngestExternal,
  IngestShare,
  IngestVolume,
  SynologyRepository,
} from "../../../lib/db/repositories/watchtower/synologyRepository.js";
import { AGENT_FRESHNESS, seconds } from "../../../lib/monitoring/agentFreshness.js";
import { packJson, unpackJson } from "../../../lib/monitoring/payloadCodec.js";
import { requireRole } from "../../auth/authorize.js";
import { asyncHandler, pathParam, queryString, queryInteger } from "./http.js";
import { requireServiceToken } from "./serviceAuth.js";
import { asText } from "../../../lib/monitoring/values.js";

export interface SynologyServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: SynologyRepository;
}

export interface SynologyRouterDependencies {
  readonly repository: SynologyRepository;
}

const STALE_MS = AGENT_FRESHNESS.synology.staleAfterMs;
const DAY_MS = 24 * 3600e3;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

export function createSynologyServiceRouter(deps: SynologyServiceRouterDependencies): Router {
  const router = Router();

  router.post(
    "/api/synology/ingest",
    requireServiceToken({
      expected: () => deps.config.serviceTokens.synology,
      unconfiguredMessage: "Synology ingest not configured — set SYNOLOGY_INGEST_TOKEN",
    }),
    express.json({ limit: "50mb" }),
    asyncHandler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== "object" || !body["nas_id"]) {
        res.status(400).json({ error: "Body must be a JSON object with nas_id" });
        return;
      }

      const now = Date.now();
      const prune = await deps.repository.shouldPrune(now);

      const nasId = asText(body["nas_id"], "nas").slice(0, 64);
      const label = asText(body["label"], nasId).slice(0, 120);
      const host = body["host"] ? asText(body["host"]).slice(0, 120) : null;
      const ts = Number.isFinite(Number(body["ts"])) ? Number(body["ts"]) : now;

      const volumes: IngestVolume[] = [];
      for (const v of Array.isArray(body["volumes"]) ? (body["volumes"] as unknown[]) : []) {
        if (!v || typeof v !== "object") continue;
        const vo = v as Record<string, unknown>;
        if (!vo["id"]) continue;
        volumes.push({
          id: asText(vo["id"]).slice(0, 64),
          total_bytes: num(vo["total_bytes"]),
          used_bytes: num(vo["used_bytes"]),
        });
      }

      const disks: IngestDisk[] = [];
      for (const d of Array.isArray(body["disks"]) ? (body["disks"] as unknown[]) : []) {
        if (!d || typeof d !== "object") continue;
        const di = d as Record<string, unknown>;
        if (!di["id"]) continue;
        disks.push({
          id: asText(di["id"]).slice(0, 64),
          temp_c: num(di["temp_c"]),
          smart_status: di["smart_status"] ? asText(di["smart_status"]).slice(0, 40) : null,
          health: di["health"] ? asText(di["health"]).slice(0, 40) : null,
          bad_sectors: num(di["bad_sectors"]),
        });
      }

      const shares: IngestShare[] = [];
      for (const s of Array.isArray(body["shares"]) ? (body["shares"] as unknown[]) : []) {
        if (!s || typeof s !== "object") continue;
        const sh = s as Record<string, unknown>;
        if (!sh["name"] || sh["used_bytes"] == null) continue;
        shares.push({
          name: asText(sh["name"]).slice(0, 120),
          used_bytes: num(sh["used_bytes"]),
        });
      }

      const backupTasks = [];
      for (const t of Array.isArray(body["backup_tasks"])
        ? (body["backup_tasks"] as unknown[])
        : []) {
        if (!t || typeof t !== "object") continue;
        const bt = t as Record<string, unknown>;
        if (!bt["id"] || !bt["last_run_ts"]) continue;
        backupTasks.push({
          id: asText(bt["id"]).slice(0, 64),
          name: bt["name"] ? asText(bt["name"]).slice(0, 120) : null,
          last_run_ts: Number(bt["last_run_ts"]),
          last_result: bt["last_result"] ? asText(bt["last_result"]).slice(0, 60) : null,
        });
      }

      const external: IngestExternal[] = [];
      for (const e of Array.isArray(body["external"]) ? (body["external"] as unknown[]) : []) {
        if (!e || typeof e !== "object") continue;
        const ex = e as Record<string, unknown>;
        if (!ex["id"]) continue;
        external.push({
          id: asText(ex["id"]).slice(0, 96),
          kind: ex["kind"] ? asText(ex["kind"]).slice(0, 20) : null,
          name: ex["name"] ? asText(ex["name"]).slice(0, 120) : null,
          model: ex["model"] ? asText(ex["model"]).slice(0, 120) : null,
          fs: ex["fs"] ? asText(ex["fs"]).slice(0, 40) : null,
          size_bytes: num(ex["size_bytes"]),
          used_bytes: num(ex["used_bytes"]),
        });
      }

      const result = await deps.repository.ingest(
        {
          nasId,
          label,
          host,
          payload: packJson(body),
          ts,
          now,
          volumes,
          disks,
          shares,
          backupTasks,
          external,
          prune,
        },
        deliveryIdFrom(req.get("x-hearth-delivery-id"), req.body)
      );

      if (prune && !result.duplicate) {
        await deps.repository.setLastPruneAt(now);
      }
      res.json({ ok: true, duplicate: result.duplicate, received_at: result.receivedAt });
    })
  );

  return router;
}

export function createSynologyRouter(deps: SynologyRouterDependencies): Router {
  const router = Router();

  router.get(
    "/api/synology",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const rows = await deps.repository.getAll();
      if (!rows.length) {
        res.json({
          ok: true,
          present: false,
          units: [],
          last_contact_at: null,
          expected_cadence_seconds: seconds(AGENT_FRESHNESS.synology.expectedCadenceMs),
          stale_after_seconds: seconds(STALE_MS),
        });
        return;
      }

      const now = Date.now();
      const units = rows.map((r) => {
        const payload = unpackJson<Record<string, unknown>>(r.payload) ?? {};
        const ageMs = now - r.received_at;
        return {
          nas_id: r.nas_id,
          label: r.label,
          host: r.host,
          ...payload,
          received_at: r.received_at,
          age_seconds: Math.round(ageMs / 1000),
          stale: ageMs > STALE_MS,
          last_contact_at: r.received_at,
          source_observed_at: (payload["ts"] as number | null | undefined) ?? null,
          expected_cadence_seconds: seconds(AGENT_FRESHNESS.synology.expectedCadenceMs),
          stale_after_seconds: seconds(STALE_MS),
        };
      });
      const lastContactAt = Math.max(...rows.map((row) => row.received_at));
      res.json({
        ok: true,
        present: true,
        units,
        last_contact_at: lastContactAt,
        expected_cadence_seconds: seconds(AGENT_FRESHNESS.synology.expectedCadenceMs),
        stale_after_seconds: seconds(STALE_MS),
      });
    })
  );

  router.get(
    "/api/synology/history",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 90, 1, 180);
      const nasId = queryString(req.query["nas"]) ?? null;
      const cutoff = Date.now() - days * DAY_MS;
      const series = await deps.repository.getHistory(cutoff, nasId);
      res.json({ ok: true, days, series });
    })
  );

  router.get(
    "/api/synology/shares",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 90, 1, 180);
      const nasId = queryString(req.query["nas"]) ?? null;
      const cutoff = Date.now() - days * DAY_MS;
      const { shares, points } = await deps.repository.getShares(cutoff, nasId);
      res.json({ ok: true, days, shares, points });
    })
  );

  router.get(
    "/api/synology/backups",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 60, 1, 365);
      const cutoffSec = Math.floor((Date.now() - days * DAY_MS) / 1000);
      const runs = await deps.repository.getBackups(cutoffSec);
      res.json({ ok: true, days, runs });
    })
  );

  router.get(
    "/api/synology/summary",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const rows = await deps.repository.getSummaryRows();
      if (!rows.length) {
        res.json({ ok: true, present: false });
        return;
      }

      const now = Date.now();
      let disks = 0;
      let unhealthy = 0;
      let worstVolumePct: number | null = null;
      let worstVolumeName: string | null = null;
      let stale = 0;

      for (const r of rows) {
        const p = unpackJson<Record<string, unknown>>(r.payload) ?? {};
        if (now - r.received_at > STALE_MS) stale++;
        const pdisks = Array.isArray(p["disks"]) ? (p["disks"] as unknown[]) : [];
        for (const d of pdisks) {
          disks++;
          if (typeof d !== "object" || d === null) continue;
          const dobj = d as Record<string, unknown>;
          const s = `${asText(dobj["smart_status"])} ${asText(dobj["health"])}`.toLowerCase();
          if (
            /(fail|crash|critical|warning|abnormal|bad)/.test(s) ||
            (Number(dobj["bad_sectors"] ?? 0) > 0)
          ) {
            unhealthy++;
          }
        }
        const pvols = Array.isArray(p["volumes"]) ? (p["volumes"] as unknown[]) : [];
        for (const v of pvols) {
          if (typeof v !== "object" || v === null) continue;
          const vobj = v as Record<string, unknown>;
          const pct = vobj["used_pct"] != null ? Number(vobj["used_pct"]) : null;
          if (pct != null && (worstVolumePct == null || pct > worstVolumePct)) {
            worstVolumePct = pct;
            worstVolumeName = `${r.label} · ${asText(vobj["name"])}`;
          }
        }
      }

      const latestRuns = await deps.repository.getLatestBackupRuns();
      const backupFailures = latestRuns.filter(
        (r) => r.result && !/success|done|finish|ok/i.test(asText(r.result))
      ).length;

      res.json({
        ok: true,
        present: true,
        units: rows.length,
        stale,
        disks,
        unhealthy,
        worst_volume_pct: worstVolumePct,
        worst_volume_name: worstVolumeName,
        backup_tasks: latestRuns.length,
        backup_failures: backupFailures,
      });
    })
  );

  router.get(
    "/api/synology/external",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const { devices } = await deps.repository.getExternal();
      res.json({ ok: true, devices });
    })
  );

  router.delete(
    "/api/synology/external/:nasId/:deviceId",
    requireRole("operator"),
    asyncHandler(async (req, res) => {
      const nasId = pathParam(req.params["nasId"]);
      const deviceId = pathParam(req.params["deviceId"]);

      const row = await deps.repository.getExternalDevice(nasId, deviceId);
      if (!row) {
        res.status(404).json({ error: "No such device" });
        return;
      }

      const lastPush = await deps.repository.getLastPushAt(nasId);
      if (lastPush > 0 && row.last_seen >= lastPush) {
        res
          .status(409)
          .json({
            error:
              "Device is still attached — unplug it first, or it will reappear on the next push.",
          });
        return;
      }

      await deps.repository.deleteExternalDevice(nasId, deviceId);
      res.json({ ok: true });
    })
  );

  router.get(
    "/api/synology/disks",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 30, 1, 180);
      const nasId = queryString(req.query["nas"]) ?? null;
      const cutoff = Date.now() - days * DAY_MS;
      const points = await deps.repository.getDisks(cutoff, nasId);
      res.json({ ok: true, days, points });
    })
  );

  return router;
}
