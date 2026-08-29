import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import type {
  UnifiRepository,
  OutageIncidentsRepository,
} from "../../../lib/db/repositories/watchtower/unifiRepository.js";
import { unpackJson } from "../../../lib/monitoring/payloadCodec.js";
import { AGENT_FRESHNESS, seconds } from "../../../lib/monitoring/agentFreshness.js";
import { requireServiceToken } from "./serviceAuth.js";
import { requireRole } from "../../auth/authorize.js";
import { asText } from "../../../lib/monitoring/values.js";
import { serverError } from "./http.js";

export interface UnifiServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: UnifiRepository;
}

export interface UnifiRouterDependencies {
  readonly repository: UnifiRepository;
  readonly outage: OutageIncidentsRepository;
}

const STALE_MS = AGENT_FRESHNESS.unifi.staleAfterMs;
const AGENT_BUILD_PORT_FORWARDS = 47;
const UI_CONSOLE_HOSTNAME = /^[0-9a-f]{20,}\.id\.ui\.direct$/i;
const HEAVY_WRITE_INTERVAL = 5 * 60 * 1000;
const RANGES: Record<string, number> = {
  "24h": 24 * 3600e3,
  "7d": 7 * 24 * 3600e3,
  "30d": 30 * 24 * 3600e3,
};

let lastHeavyWriteAt = 0;

/**
 * Epoch-millisecond reader for agent-supplied values. A non-numeric value must
 * become null, not NaN: NaN survives a `== null` guard and would propagate into
 * the route-baseline clock, silently disabling the stale-observation check.
 */
const int = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

async function labelKnownConsoles(
  clients: unknown[],
  repository: UnifiRepository
): Promise<unknown[]> {
  let nvrHost: string | null = null;
  let nvrName: string | null = null;
  try {
    const row = await repository.getLatest();
    if (row) {
      const nvr = await repository.protectNvrIdentity();
      nvrHost = nvr.host;
      nvrName = nvr.name;
    }
  } catch {
    // Protect is optional
  }

  return clients.map((c) => {
    if (!c || typeof c !== "object") return c;
    const client = c as Record<string, unknown>;
    const looksLikeConsole = UI_CONSOLE_HOSTNAME.test(asText(client["name"]));
    if (nvrHost && client["ip"] === nvrHost) {
      return { ...client, name: nvrName ?? client["name"], display_role: "UniFi Protect NVR", is_console: true };
    }
    if (looksLikeConsole) {
      return { ...client, display_role: "UniFi console", is_console: true };
    }
    return c;
  });
}

export function createUnifiServiceRouter(deps: UnifiServiceRouterDependencies): Router {
  const router = Router();

  router.post(
    "/api/unifi/ingest",
    requireServiceToken({
      expected: () => deps.config.serviceTokens.unifi,
      unconfiguredMessage: "UniFi ingest not configured — set UNIFI_INGEST_TOKEN",
      headers: ["x-unifi-token"],
      unconfiguredCode: "unifi_ingest_unconfigured",
      invalidCode: "unifi_ingest_invalid_token",
      invalidMessage: "Invalid or missing ingest token",
    }),
    express.json({ limit: "50mb" }),
    async (req, res) => {
      const body = req.body as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        res.status(400).json({ error: "Body must be a JSON object" });
        return;
      }
      try {
        const now = Date.now();
        const heavy = now - lastHeavyWriteAt >= HEAVY_WRITE_INTERVAL;
        const deliveryId = deliveryIdFrom(req.get("x-hearth-delivery-id"), body);
        const result = await deps.repository.ingest({
          body: body as Record<string, unknown>,
          heavy,
          deliveryId,
        });
        const cfg = (body as Record<string, unknown>).config;
        const collectedAt = int(
          cfg && typeof cfg === "object"
            ? (cfg as Record<string, unknown>)["traffic_routes_collected_at"]
            : undefined
        );
        await deps.repository.syncTrafficRouteBaseline(
          cfg,
          collectedAt == null ? result.receivedAt : Math.min(collectedAt, result.receivedAt)
        );
        if (!result.duplicate && heavy) lastHeavyWriteAt = result.receivedAt;
        res.json({ ok: true, duplicate: result.duplicate, received_at: result.receivedAt });
      } catch (err) {
        serverError(res, "unifi", err);
      }
    }
  );

  return router;
}

export function createUnifiRouter(deps: UnifiRouterDependencies): Router {
  const router = Router();
  const viewerGuard = requireRole("viewer");

  router.get("/api/unifi", viewerGuard, async (_req, res) => {
    try {
      const row = await deps.repository.getLatestPayload();
      if (!row) {
        res.json({
          ok: true,
          present: false,
          last_contact_at: null,
          expected_cadence_seconds: seconds(AGENT_FRESHNESS.unifi.expectedCadenceMs),
          stale_after_seconds: seconds(STALE_MS),
        });
        return;
      }
      const payload = (unpackJson(row.payload) as Record<string, unknown>) ?? {
        wan: {},
        devices: [],
        clients: [],
      };
      const wan = (payload.wan as Record<string, unknown>) ?? {};
      const devices = Array.isArray(payload.devices) ? payload.devices : [];
      const clients = await labelKnownConsoles(
        Array.isArray(payload.clients) ? payload.clients : [],
        deps.repository
      );
      const devicesOnline = devices.filter((d) => d && typeof d === "object" && (d as Record<string, unknown>)["online"]).length;
      const ageMs = Date.now() - row.received_at;
      res.json({
        ok: true,
        present: true,
        age_seconds: Math.round(ageMs / 1000),
        stale: ageMs > STALE_MS,
        last_contact_at: row.received_at,
        source_observed_at: payload.ts ?? null,
        expected_cadence_seconds: seconds(AGENT_FRESHNESS.unifi.expectedCadenceMs),
        stale_after_seconds: seconds(STALE_MS),
        reading: {
          received_at: row.received_at,
          wan_status: wan.status ?? null,
          wan_latency_ms: wan.latency_ms ?? null,
          wan_uptime: wan.uptime ?? null,
          wan_rx_bps: wan.rx_bps ?? null,
          wan_tx_bps: wan.tx_bps ?? null,
          num_clients: clients.length,
          num_devices: devices.length,
          devices_online: devicesOnline,
          raw: { ...payload, clients },
        },
        diagnostics: payload.diagnostics ?? null,
      });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/history", viewerGuard, async (req, res) => {
    const rangeKey = typeof req.query.range === "string" && RANGES[req.query.range] ? req.query.range : "24h";
    const cutoff = Date.now() - RANGES[rangeKey]!;
    const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId.trim() : "";
    try {
      let points: unknown[];
      if (deviceId) {
        points = await deps.repository.queryDeviceSamples(deviceId, cutoff);
      } else if (clientId) {
        points = await deps.repository.queryClientSamples(clientId, cutoff);
      } else {
        points = await deps.repository.queryReadings(cutoff);
      }
      res.json({ ok: true, range: rangeKey, points });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/wan-history", viewerGuard, async (req, res) => {
    const rangeKey = typeof req.query.range === "string" && RANGES[req.query.range] ? req.query.range : "24h";
    const cutoff = Date.now() - RANGES[rangeKey]!;
    const wanKey = typeof req.query.wanKey === "string" ? req.query.wanKey.trim() : "";
    try {
      const points = await deps.repository.queryWanHistory(cutoff, wanKey || null, 10_000);
      res.json({ ok: true, range: rangeKey, wanKey: wanKey || null, points });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/ports/history", viewerGuard, async (req, res) => {
    const rangeKey = typeof req.query.range === "string" && RANGES[req.query.range] ? req.query.range : "24h";
    const cutoff = Date.now() - RANGES[rangeKey]!;
    const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
    const portIdxRaw = typeof req.query.portIdx === "string" ? req.query.portIdx.trim() : "";
    let portIdx: number | null = null;
    if (portIdxRaw) {
      const parsed = Number(portIdxRaw);
      if (!Number.isInteger(parsed)) {
        res.status(400).json({ error: "portIdx must be an integer" });
        return;
      }
      portIdx = parsed;
    }
    try {
      const points = await deps.repository.queryPortHistory(cutoff, deviceId || null, portIdx, 10_000);
      res.json({
        ok: true,
        range: rangeKey,
        deviceId: deviceId || null,
        portIdx: portIdxRaw || null,
        points,
      });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/events", viewerGuard, async (req, res) => {
    const rangeKey = typeof req.query.range === "string" && RANGES[req.query.range] ? req.query.range : "24h";
    const cutoff = Date.now() - RANGES[rangeKey]!;
    const limit = Math.min(
      Math.max(parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10) || 200, 1),
      1000
    );
    try {
      const rows = await deps.repository.queryEvents(cutoff, limit);
      const collection = await deps.repository.getActivityCompatRow();
      res.json({ ok: true, range: rangeKey, collection, events: rows });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/outage-incidents", viewerGuard, async (req, res) => {
    const requestedLimit = Number.parseInt(
      typeof req.query.limit === "string" ? req.query.limit : "",
      10
    );
    const limit = Number.isInteger(requestedLimit) ? requestedLimit : 25;
    try {
      const incidents = await deps.outage.listOutageIncidents(limit);
      res.json({
        ok: true,
        recoveryHoldSeconds: Math.round((await deps.outage.outageRecoveryHoldMs()) / 1000),
        pendingCount: incidents.filter((i) => i.status === "recovery_pending").length,
        incidents,
      });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/outage-incidents/:id", viewerGuard, async (req, res) => {
    try {
      const incident = await deps.outage.getOutageIncident(asText(req.params["id"]));
      if (!incident) {
        res.status(404).json({ error: "Outage incident not found" });
        return;
      }
      res.json({ ok: true, incident });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  router.get("/api/unifi/config", viewerGuard, async (_req, res) => {
    try {
      const row = await deps.repository.getLatestPayload();
      if (!row) {
        res.json({ ok: true, present: false });
        return;
      }
      const payload = (unpackJson(row.payload) as Record<string, unknown>) ?? {};
      const config = payload.config as Record<string, unknown> | null | undefined;
      if (!config) {
        res.json({ ok: true, present: false });
        return;
      }

      const clients = Array.isArray(payload.clients) ? (payload.clients as Record<string, unknown>[]) : [];
      const bySsid = new Map<string, number>();
      const byNetwork = new Map<string, number>();
      for (const c of clients) {
        const raw = c?.["raw"] as Record<string, unknown> | undefined;
        const essid = raw?.["essid"] as string | undefined;
        if (essid) bySsid.set(essid, (bySsid.get(essid) ?? 0) + 1);
        const net = (raw?.["network"] ?? raw?.["last_connection_network_name"]) as string | undefined;
        const netId = raw?.["network_id"] as string | undefined;
        if (net) byNetwork.set(net, (byNetwork.get(net) ?? 0) + 1);
        if (netId) byNetwork.set(netId, (byNetwork.get(netId) ?? 0) + 1);
      }

      const diagnostics = payload.diagnostics as Record<string, unknown> | undefined;
      res.json({
        ok: true,
        present: true,
        received_at: row.received_at,
        age_seconds: Math.round((Date.now() - row.received_at) / 1000),
        agent_build: diagnostics?.["agent_build"] ?? null,
        agent_build_for_port_forwards: AGENT_BUILD_PORT_FORWARDS,
        ...config,
        wifi: (Array.isArray(config.wifi) ? (config.wifi as Record<string, unknown>[]) : []).map(
          (w) => ({ ...w, client_count: bySsid.get(w["name"] as string) ?? 0 })
        ),
        networks: (Array.isArray(config.networks) ? (config.networks as Record<string, unknown>[]) : []).map(
          (n) => ({
            ...n,
            client_count: byNetwork.get(n["name"] as string) ?? byNetwork.get(n["id"] as string) ?? 0,
          })
        ),
      });
    } catch (err) {
      serverError(res, "unifi", err);
    }
  });

  return router;
}
