import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { AGENT_FRESHNESS, seconds } from "../../../lib/monitoring/agentFreshness.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { tokenMatches, bearerToken } from "./serviceAuth.js";
import { requireRole } from "../../auth/authorize.js";
import type { AppConfig } from "../../config.js";
import type { NetworkObserverRepository } from "../../../lib/db/repositories/watchtower/networkObserverRepository.js";
import type { UnifiRepository } from "../../../lib/db/repositories/watchtower/unifiRepository.js";
import { RANGES } from "../../../lib/db/repositories/watchtower/networkObserverRepository.js";
import { unpackJson } from "../../../lib/monitoring/payloadCodec.js";
import { asText } from "../../../lib/monitoring/values.js";
import { asyncHandler, serverError } from "./http.js";

export interface NetworkObserverServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: NetworkObserverRepository;
  readonly unifiRepository: Pick<UnifiRepository, "getLatestPayload">;
}

export interface NetworkObserverRouterDependencies {
  readonly config: AppConfig;
  readonly repository: NetworkObserverRepository;
}

const MAX_DISCOVERY_DEVICES = 512;

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createNetworkObserverServiceRouter(deps: NetworkObserverServiceRouterDependencies): Router {
  const router = Router();

  // Authentication runs before the 50 MB parser: an unauthenticated caller must
  // never be able to make this process read and buffer a large body.
  const authenticate: RequestHandler = (req, res, next) => {
    const expected = deps.config.serviceTokens.networkObserver ?? deps.config.serviceTokens.unifi;
    if (!expected) {
      res.status(503).json({ error: "Network observer ingest not configured — set NETWORK_OBSERVER_INGEST_TOKEN or UNIFI_INGEST_TOKEN" });
      return;
    }
    if (!tokenMatches(bearerToken(req), expected)) {
      res.status(401).json({ error: "Invalid or missing ingest token" });
      return;
    }
    next();
  };

  router.get(
    "/api/network-observer/discovery/unifi",
    authenticate,
    asyncHandler(async (_req: Request, res: Response) => {
      const row = await deps.unifiRepository.getLatestPayload();
      if (!row) {
        res.json({
          ok: true,
          present: false,
          last_contact_at: null,
          stale: true,
          devices: []
        });
        return;
      }
      const payload = unpackJson<Record<string, unknown>>(row.payload);
      if (!payload) throw new Error("UniFi discovery snapshot is unreadable");
      const sourceDevices = Array.isArray(payload.devices) ? payload.devices : [];
      const devices = sourceDevices
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && !Array.isArray(value)
        )
        .slice(0, MAX_DISCOVERY_DEVICES)
        .map((device) => ({
          id: optionalText(device.id),
          mac: optionalText(device.mac),
          ip: optionalText(device.ip),
          model: optionalText(device.model),
          name: optionalText(device.name),
          type: optionalText(device.type)
        }));
      res.json({
        ok: true,
        present: true,
        last_contact_at: row.received_at,
        stale: Date.now() - row.received_at > AGENT_FRESHNESS.unifi.staleAfterMs,
        devices
      });
    })
  );

  router.post("/api/network-observer/ingest", authenticate, express.json({ limit: "50mb" }), asyncHandler(async (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Body must be a JSON object" });
      return;
    }
    const now = Date.now();
    const deliveryId = deliveryIdFrom(req.get("x-hearth-delivery-id"), req.body);
    try {
      const result = await deps.repository.ingest(req.body as Record<string, unknown>, now, deliveryId);
      res.json({ ok: true, ...result, received_at: now });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "observer_id is required") {
        res.status(400).json({ error: msg });
        return;
      }
      serverError(res, "network-observer", err);
    }
  }));

  return router;
}

export function createNetworkObserverRouter(deps: NetworkObserverRouterDependencies): Router {
  const router = Router();

  router.get("/api/network-observer", requireRole("viewer"), asyncHandler(async (_req: Request, res: Response) => {
    const observers = await deps.repository.getLatest(AGENT_FRESHNESS.network_observer.staleAfterMs);
    res.json({
      ok: true,
      present: observers.length > 0,
      expected_cadence_seconds: seconds(AGENT_FRESHNESS.network_observer.expectedCadenceMs),
      stale_after_seconds: seconds(AGENT_FRESHNESS.network_observer.staleAfterMs),
      observers,
    });
  }));

  router.get("/api/network-observer/history", requireRole("viewer"), asyncHandler(async (req: Request, res: Response) => {
    const rangeKey = RANGES[asText(req.query["range"])] ? asText(req.query["range"]) : "24h";
    const rangeMs = RANGES[rangeKey] as number;
    const kind = asText(req.query["kind"]).trim();
    const targetId = asText(req.query["targetId"]).trim();
    const points = await deps.repository.getProbeHistory(rangeMs, kind || undefined, targetId || undefined);
    res.json({ ok: true, range: rangeKey, kind: kind || null, targetId: targetId || null, points });
  }));

  router.get("/api/network-observer/isp", requireRole("viewer"), asyncHandler(async (req: Request, res: Response) => {
    const rangeKey = RANGES[asText(req.query["range"])] ? asText(req.query["range"]) : "24h";
    const rangeMs = RANGES[rangeKey] as number;
    const points = await deps.repository.getIspSamples(rangeMs);
    res.json({ ok: true, range: rangeKey, points });
  }));

  router.get("/api/network-observer/snmp-events", requireRole("viewer"), asyncHandler(async (req: Request, res: Response) => {
    const MAX_SNMP_EVENTS = 5000;
    const rangeKey = RANGES[asText(req.query["range"])] ? asText(req.query["range"]) : "24h";
    const rangeMs = RANGES[rangeKey] as number;
    const deviceId = asText(req.query["deviceId"]).trim();
    const requestedLimit = Number.parseInt(asText(req.query["limit"]), 10);
    const limit = Math.min(Math.max(Number.isInteger(requestedLimit) ? requestedLimit : MAX_SNMP_EVENTS, 1), MAX_SNMP_EVENTS);
    const events = await deps.repository.getSnmpEvents(rangeMs, deviceId || undefined, limit);
    res.json({ ok: true, range: rangeKey, deviceId: deviceId || null, events });
  }));

  router.get("/api/network-observer/snmp", requireRole("viewer"), asyncHandler(async (req: Request, res: Response) => {
    const rangeKey = RANGES[asText(req.query["range"])] ? asText(req.query["range"]) : "24h";
    const rangeMs = RANGES[rangeKey] as number;
    const deviceId = asText(req.query["deviceId"]).trim();
    const { devices, interfaces } = await deps.repository.getSnmpSamples(rangeMs, deviceId || undefined);
    res.json({ ok: true, range: rangeKey, deviceId: deviceId || null, devices, interfaces });
  }));

  return router;
}
