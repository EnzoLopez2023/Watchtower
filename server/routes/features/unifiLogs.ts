import { createHash } from "node:crypto";
import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import type {
  UnifiLogsRepository,
  ArchiveStatusSummary,
  NormalizedGap,
} from "../../../lib/db/repositories/watchtower/unifiLogsRepository.js";
import type { UnifiRepository } from "../../../lib/db/repositories/watchtower/unifiRepository.js";
import {
  ACTIVITY_NORMALIZATION_VERSION,
  activityPresentation,
} from "../../../lib/monitoring/unifiActivity.js";
import { packJson } from "../../../lib/monitoring/payloadCodec.js";
import { requireServiceToken } from "./serviceAuth.js";
import { requireRole } from "../../auth/authorize.js";
import type { SqlValue } from "../../../lib/db/repositories/watchtower/base.js";
import { asText } from "../../../lib/monitoring/values.js";
import { serverError } from "./http.js";

export interface UnifiLogsServiceRouterDependencies {
  readonly config: AppConfig;
  readonly logsRepository: UnifiLogsRepository;
}

export interface UnifiLogsRouterDependencies {
  readonly logsRepository: UnifiLogsRepository;
  readonly unifiRepository: UnifiRepository;
  readonly archiveStatus: { archiveSummary(): Promise<ArchiveStatusSummary> };
}

const RETENTION = {
  activityMs: 90 * 24 * 60 * 60 * 1000,
  flowsMs: 14 * 24 * 60 * 60 * 1000,
  gapsMs: 365 * 24 * 60 * 60 * 1000,
  activityRows: 250_000,
  flowRows: 500_000,
};

const MAX_ACTIVITY_PER_PUSH = 1000;
const MAX_FLOWS_PER_PUSH = 5000;
const MAX_GAPS_PER_PUSH = 200;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TRUSTED_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
const SKEW_TOLERANCE_MS = 5000;

let lastMaintenanceAt = 0;

const COMPAT_STATUSES = new Set([
  "proven", "empty", "indeterminate", "unfiltered", "unverifiable", "ignored", "failed", "unverified",
]);

function shortText(value: unknown, max = 500): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochMs(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null || n < 0) return null;
  return Math.round(n < 1_000_000_000_000 ? n * 1000 : n);
}

function valueAt(object: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    const v = path.split(".").reduce<unknown>(
      (cur, part) =>
        cur == null || typeof cur !== "object" ? undefined : (cur as Record<string, unknown>)[part],
      object
    );
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function stableId(prefix: string, record: Record<string, unknown>, timestamp: number): string {
  const upstream = shortText(valueAt(record, "id", "_id"), 300);
  if (upstream) return upstream;
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify({ timestamp, record }))
    .digest("hex")}`;
}

function normalizeActivity(
  record: unknown,
  receivedAt: number
): Record<string, SqlValue> | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const eventTs = epochMs(valueAt(r, "timestamp", "time", "datetime")) ?? receivedAt;
  const presentation = activityPresentation(r);
  if (!presentation) return null;
  return {
    upstream_id: stableId("activity", r, eventTs),
    event_ts: eventTs,
    received_at: receivedAt,
    severity: presentation.severity,
    category: presentation.category,
    subcategory: presentation.subcategory,
    event_type: presentation.event_type,
    title: presentation.title,
    message: presentation.message,
    actor: presentation.actor,
    target: presentation.target,
    normalization_version: ACTIVITY_NORMALIZATION_VERSION,
    raw: packJson(r),
  };
}

function endpointFields(endpoint: unknown): {
  name: string | null;
  ip: string | null;
  mac: string | null;
  port: number | null;
  network: string | null;
  zone: string | null;
} {
  const s = endpoint && typeof endpoint === "object" ? (endpoint as Record<string, unknown>) : {};
  return {
    name: shortText(valueAt(s, "client_name", "host_name", "name", "domain"), 240),
    ip: shortText(s["ip"], 80),
    mac: shortText(s["mac"], 40)?.toLowerCase() ?? null,
    port: finiteNumber(s["port"]),
    network: shortText(valueAt(s, "network_name", "network.id", "network_id"), 160),
    zone: shortText(valueAt(s, "zone_name", "zone.id", "zone_id"), 160),
  };
}

function interfaceName(value: unknown): string | null {
  return (
    shortText(valueAt(value, "name", "network_name", "interface_name", "id"), 160) ??
    shortText(value, 160)
  );
}

function normalizeFlow(
  record: unknown,
  receivedAt: number
): Record<string, SqlValue> | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const flowTs = epochMs(valueAt(r, "time", "flow_start_time", "timestamp")) ?? receivedAt;
  const source = endpointFields(r["source"]);
  const destination = endpointFields(r["destination"]);
  const policies = Array.isArray(r["policies"]) ? (r["policies"] as unknown[]) : [];
  const policyNames = [
    ...new Set(
      policies
        .map((p) => shortText(valueAt(p, "name", "description", "policy_name", "id"), 240))
        .filter((v): v is string => v !== null)
    ),
  ];
  const policyTypes = [
    ...new Set([
      ...policies
        .map((p) => shortText(valueAt(p, "type", "policy_type"), 120))
        .filter((v): v is string => v !== null),
      ...(Array.isArray(r["policy_type"])
        ? (r["policy_type"] as unknown[]).map((v) => shortText(v, 120)).filter((v): v is string => v !== null)
        : []),
    ]),
  ];
  const traffic = r["traffic_data"] && typeof r["traffic_data"] === "object"
    ? (r["traffic_data"] as Record<string, unknown>)
    : {};

  return {
    upstream_id: stableId("flow", r, flowTs),
    flow_ts: flowTs,
    flow_end_ts: epochMs(r["flow_end_time"]),
    received_at: receivedAt,
    duration_ms: finiteNumber(r["duration_milliseconds"]),
    action: shortText(r["action"], 40),
    direction: shortText(r["direction"], 40),
    protocol: shortText(r["protocol"], 40),
    service: shortText(r["service"], 120),
    risk: shortText(r["risk"], 40),
    source_name: source.name,
    source_ip: source.ip,
    source_mac: source.mac,
    source_port: source.port,
    source_network: source.network,
    source_zone: source.zone,
    destination_name: destination.name,
    destination_ip: destination.ip,
    destination_mac: destination.mac,
    destination_port: destination.port,
    destination_network: destination.network,
    destination_zone: destination.zone,
    ingress_name: interfaceName(r["in"]),
    egress_name: interfaceName(r["out"]),
    bytes_rx: finiteNumber(valueAt(traffic, "bytes_rx", "rx_bytes")),
    bytes_tx: finiteNumber(valueAt(traffic, "bytes_tx", "tx_bytes")),
    bytes_total: finiteNumber(valueAt(traffic, "bytes_total", "total_bytes")),
    packets_total: finiteNumber(valueAt(traffic, "packets_total", "total_packets")),
    policy_names: JSON.stringify(policyNames),
    policy_types: JSON.stringify(policyTypes),
  };
}

function normalizeCompat(
  stream: string,
  detail: unknown
): {
  stream: string;
  status: string;
  page_base: number | null;
  filter_variant: string | null;
  evidence: string | null;
  negotiated_at: number | null;
  held: 0 | 1;
} | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const compat = d["compat"];
  if (!compat || typeof compat !== "object") return null;
  const c = compat as Record<string, unknown>;
  const status = shortText(c["status"], 24);
  if (!status || !COMPAT_STATUSES.has(status)) return null;
  const pageBase = Number.isInteger(c["pageBase"]) ? (c["pageBase"] as number) : null;
  return {
    stream,
    status,
    page_base: pageBase,
    filter_variant: shortText(c["filterVariant"], 24),
    evidence: shortText(c["evidence"], 200),
    negotiated_at: epochMs(c["negotiatedAt"]),
    held: d["held"] === true ? 1 : 0,
  };
}

interface ClockOffset {
  offset: number;
  skew: number | null;
  trusted: boolean;
}

function clockOffset(collectedAt: number | null, receivedAt: number): ClockOffset {
  if (collectedAt == null) return { offset: 0, skew: null, trusted: false };
  const skew = collectedAt - receivedAt;
  if (skew > MAX_TRUSTED_SKEW_MS) return { offset: 0, skew, trusted: false };
  return { offset: skew > SKEW_TOLERANCE_MS ? skew : 0, skew, trusted: true };
}

function normalizeGap(
  record: unknown,
  receivedAt: number,
  clock: ClockOffset
): NormalizedGap | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const stream = shortText(r["stream"], 40);
  const from = epochMs(r["from"]);
  const to = epochMs(r["to"]);
  if (!stream || from == null || to == null || to < from) return null;

  const offset = clock.offset;
  const shifted = { from: from - offset, to: to - offset };
  const untrusted = shifted.from > receivedAt + SKEW_TOLERANCE_MS;
  return {
    stream,
    from_ts: untrusted ? from : shifted.from,
    to_ts: untrusted ? to : Math.min(shifted.to, receivedAt),
    source_from_ts: from,
    clock_untrusted: untrusted ? 1 : 0,
    kind: r["kind"] === "hold" ? "hold" : "unreadable",
    reason: shortText(r["reason"], 500) ?? "unspecified",
  };
}

export function createUnifiLogsServiceRouter(
  deps: UnifiLogsServiceRouterDependencies
): Router {
  const router = Router();

  router.post(
    "/api/unifi/logs/ingest",
    requireServiceToken({
      expected: () => deps.config.serviceTokens.unifi,
      unconfiguredMessage: "UniFi ingest not configured — set UNIFI_INGEST_TOKEN",
      unconfiguredCode: "unifi_ingest_unconfigured",
      invalidCode: "unifi_ingest_invalid_token",
      invalidMessage: "Invalid or missing ingest token",
    }),
    express.json({ limit: "50mb" }),
    async (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      const activity = Array.isArray(body?.["activity"])
        ? (body["activity"] as unknown[]).slice(0, MAX_ACTIVITY_PER_PUSH)
        : [];
      const flows = Array.isArray(body?.["flows"])
        ? (body["flows"] as unknown[]).slice(0, MAX_FLOWS_PER_PUSH)
        : [];
      const gaps = Array.isArray(body?.["gaps"])
        ? (body["gaps"] as unknown[]).slice(0, MAX_GAPS_PER_PUSH)
        : [];
      const diagnostics = body?.["diagnostics"];
      const hasCompat = ["activity", "flows"].some(
        (stream) => normalizeCompat(stream, (diagnostics as Record<string, unknown> | undefined)?.[stream]) != null
      );
      if (!activity.length && !flows.length && !gaps.length && !hasCompat) {
        res.json({ ok: true, activityStored: 0, flowsStored: 0, gapsStored: 0 });
        return;
      }

      try {
        const now = Date.now();
        const maintenance = now - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS;
        const clock = clockOffset(epochMs(body?.["collected_at"]), now);
        const deliveryId = deliveryIdFrom(req.get("x-hearth-delivery-id"), body);

        const normalizedActivity: Record<string, SqlValue>[] = [];
        const activityTimestamps: number[] = [];
        for (const record of activity) {
          const row = normalizeActivity(record, now);
          if (row) {
            normalizedActivity.push(row);
            if (typeof row["event_ts"] === "number") activityTimestamps.push(row["event_ts"]);
          }
        }

        const normalizedFlows: Record<string, SqlValue>[] = [];
        const flowTimestamps: number[] = [];
        for (const record of flows) {
          const row = normalizeFlow(record, now);
          if (row) {
            normalizedFlows.push(row);
            if (typeof row["flow_ts"] === "number") flowTimestamps.push(row["flow_ts"]);
          }
        }

        const normalizedGaps: NormalizedGap[] = [];
        const heldAnchors = new Map<string, number>();
        for (const record of gaps) {
          const row = normalizeGap(record, now, clock);
          if (row) {
            normalizedGaps.push(row);
            if (row.kind === "hold") heldAnchors.set(row.stream, row.source_from_ts);
          }
        }

        const diag = diagnostics && typeof diagnostics === "object"
          ? (diagnostics as Record<string, unknown>)
          : null;

        const holdSettles: { stream: string; keepSourceFromTs: number | null }[] = [];
        for (const stream of ["activity", "flows"]) {
          const detail = diag?.[stream];
          if (!detail || typeof detail !== "object") continue;
          if (heldAnchors.has(stream)) {
            holdSettles.push({ stream, keepSourceFromTs: heldAnchors.get(stream)! });
          } else if ((detail as Record<string, unknown>)["held"] === false) {
            holdSettles.push({ stream, keepSourceFromTs: null });
          }
        }

        const normalizedCompat: {
          stream: string;
          status: string;
          page_base: number | null;
          filter_variant: string | null;
          evidence: string | null;
          negotiated_at: number | null;
          held: 0 | 1;
        }[] = [];
        for (const stream of ["activity", "flows"]) {
          const row = normalizeCompat(stream, diag?.[stream]);
          if (row) normalizedCompat.push(row);
        }

        const result = await deps.logsRepository.ingest({
          deliveryId,
          now,
          maintenance,
          normalizedActivity,
          activityTimestamps,
          normalizedFlows,
          flowTimestamps,
          normalizedGaps,
          holdSettles,
          normalizedCompat,
          ingestHealth: {
            skew_ms: clock.skew != null && clock.skew > SKEW_TOLERANCE_MS ? clock.skew : null,
            skew_trusted: clock.trusted === false ? 0 : 1,
            gaps_untrusted: normalizedGaps.filter((g) => g.clock_untrusted).length,
            last_untrusted_at: normalizedGaps.some((g) => g.clock_untrusted) ? now : null,
          },
        });

        if (maintenance) lastMaintenanceAt = now;
        res.json({
          ok: true,
          ...result,
          activityReceived: activity.length,
          flowsReceived: flows.length,
          gapsReceived: gaps.length,
          receivedAt: now,
        });
      } catch (err) {
        serverError(res, "unifiLogs", err);
      }
    }
  );

  return router;
}

function optionalInteger(value: unknown): number | null {
  const input = asText(value).trim();
  if (!input) return null;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

export function createUnifiLogsRouter(deps: UnifiLogsRouterDependencies): Router {
  const router = Router();
  const viewerGuard = requireRole("viewer");

  router.get("/api/unifi/logs/activity", viewerGuard, async (req, res) => {
    try {
      const from = optionalInteger(req.query["from"]);
      const to = optionalInteger(req.query["to"]);
      const beforeTs = optionalInteger(req.query["beforeTs"]);
      const beforeId = optionalInteger(req.query["beforeId"]);
      if ([from, to, beforeTs, beforeId].some(Number.isNaN)) {
        res.status(400).json({ error: "timestamp and cursor values must be non-negative safe integers" });
        return;
      }
      if (from != null && to != null && (from) > (to)) {
        res.status(400).json({ error: "from must be earlier than or equal to to" });
        return;
      }
      if ((beforeTs == null) !== (beforeId == null)) {
        res.status(400).json({ error: "beforeTs and beforeId must be provided together" });
        return;
      }

      const limit = Math.min(Math.max(Number(req.query["limit"]) || 200, 1), 500);
      const category = asText(req.query["category"]).trim();
      const severity = asText(req.query["severity"]).trim();
      const query = asText(req.query["q"]).trim().slice(0, 160);

      const page = await deps.logsRepository.readPage(
        {
          table: "unifi_activity_logs",
          tsColumn: "event_ts",
          columns: `id, upstream_id, event_ts, received_at, severity, category,
            subcategory, event_type, title, message, actor, target`,
          retention: { hotDays: RETENTION.activityMs / 86_400_000, maxRows: RETENTION.activityRows },
          addFilters(where, params, q, cat, sev) {
            if (cat) { where.push("category = ?"); params.push(cat); }
            if (sev) { where.push("severity = ?"); params.push(sev); }
            if (q) {
              where.push("(title LIKE ? OR message LIKE ? OR actor LIKE ? OR target LIKE ? OR event_type LIKE ?)");
              params.push(...(Array(5).fill(`%${q}%`) as string[]));
            }
          },
        },
        {
          from: from,
          to: to,
          beforeTs: beforeTs,
          beforeId: beforeId,
          limit,
        },
        { query, category, severity }
      );

      const { rows, ...rest } = page;
      res.json({ ...rest, activity: rows });
    } catch (err) {
      serverError(res, "unifiLogs", err);
    }
  });

  router.get("/api/unifi/logs/flows", viewerGuard, async (req, res) => {
    try {
      const from = optionalInteger(req.query["from"]);
      const to = optionalInteger(req.query["to"]);
      const beforeTs = optionalInteger(req.query["beforeTs"]);
      const beforeId = optionalInteger(req.query["beforeId"]);
      if ([from, to, beforeTs, beforeId].some(Number.isNaN)) {
        res.status(400).json({ error: "timestamp and cursor values must be non-negative safe integers" });
        return;
      }
      if (from != null && to != null && (from) > (to)) {
        res.status(400).json({ error: "from must be earlier than or equal to to" });
        return;
      }
      if ((beforeTs == null) !== (beforeId == null)) {
        res.status(400).json({ error: "beforeTs and beforeId must be provided together" });
        return;
      }

      const limit = Math.min(Math.max(Number(req.query["limit"]) || 200, 1), 500);
      const action = asText(req.query["action"]).trim();
      const protocol = asText(req.query["protocol"]).trim();
      const policy = asText(req.query["policy"]).trim().slice(0, 160);
      const query = asText(req.query["q"]).trim().slice(0, 160);

      const page = await deps.logsRepository.readPage(
        {
          table: "unifi_traffic_flows",
          tsColumn: "flow_ts",
          columns: "*",
          retention: { hotDays: RETENTION.flowsMs / 86_400_000, maxRows: RETENTION.flowRows },
          addFilters(where, params, q, _cat, _sev, act, proto, pol) {
            if (act) { where.push("action = ?"); params.push(act); }
            if (proto) { where.push("protocol = ?"); params.push(proto); }
            if (pol) { where.push("policy_names LIKE ?"); params.push(`%${pol}%`); }
            if (q) {
              where.push(`(
                source_name LIKE ? OR source_ip LIKE ? OR source_mac LIKE ?
                OR destination_name LIKE ? OR destination_ip LIKE ? OR destination_mac LIKE ?
                OR service LIKE ? OR policy_names LIKE ?
              )`);
              params.push(...(Array(8).fill(`%${q}%`) as string[]));
            }
          },
        },
        {
          from: from,
          to: to,
          beforeTs: beforeTs,
          beforeId: beforeId,
          limit,
        },
        { query, action, protocol, policy }
      );

      type FlowRow = Record<string, unknown>;
      const flows = page.rows.map((row) => ({
        ...(row as FlowRow),
        policy_names: JSON.parse(asText((row as FlowRow)["policy_names"], "[]")) as unknown,
        policy_types: JSON.parse(asText((row as FlowRow)["policy_types"], "[]")) as unknown,
      }));
      const { rows: _discarded, ...rest } = page;
      void _discarded;
      res.json({ ...rest, flows });
    } catch (err) {
      serverError(res, "unifiLogs", err);
    }
  });

  router.get("/api/unifi/logs/summary", viewerGuard, async (_req, res) => {
    try {
      const repo = deps.logsRepository;
      const [activity, flows, categories, severities, actions, protocols, gaps, trafficRoutes, ingestHealth, compat, archive] =
        await Promise.all([
          repo.summarizeActivity(),
          repo.summarizeFlows(),
          repo.activityCategories(),
          repo.activitySeverities(),
          repo.flowActions(),
          repo.flowProtocols(),
          repo.listGaps(),
          deps.unifiRepository.trafficRouteDriftStatus(),
          repo.getIngestHealthStatus(),
          repo.listCompat(),
          deps.archiveStatus.archiveSummary(),
        ]);
      res.json({
        ok: true,
        activity: {
          ...activity,
          retention: { hotDays: RETENTION.activityMs / 86_400_000, maxRows: RETENTION.activityRows },
        },
        flows: {
          ...flows,
          retention: { hotDays: RETENTION.flowsMs / 86_400_000, maxRows: RETENTION.flowRows },
        },
        filters: {
          activity: { categories, severities },
          flows: { actions, protocols },
        },
        gaps,
        trafficRoutes,
        ingestHealth,
        compat,
        archive,
      });
    } catch (err) {
      serverError(res, "unifiLogs", err);
    }
  });

  return router;
}
