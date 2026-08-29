import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import type { UpsRepository } from "../../../lib/db/repositories/watchtower/upsRepository.js";
import { AGENT_FRESHNESS, seconds } from "../../../lib/monitoring/agentFreshness.js";
import { safeParse } from "../../../lib/monitoring/payloadCodec.js";
import { requireRole } from "../../auth/authorize.js";
import { asyncHandler, queryString, queryInteger } from "./http.js";
import { requireServiceToken } from "./serviceAuth.js";
import { asText } from "../../../lib/monitoring/values.js";

export interface UpsServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: UpsRepository;
}

export interface UpsRouterDependencies {
  readonly repository: UpsRepository;
}

const NUMERIC: Readonly<Record<string, string>> = {
  "battery.charge": "battery_charge",
  "battery.runtime": "battery_runtime",
  "battery.voltage": "battery_voltage",
  "ups.load": "ups_load",
  "input.voltage": "input_voltage",
  "output.voltage": "output_voltage",
  "output.power": "output_power",
  "ups.temperature": "ups_temperature",
};

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const STALE_MS = AGENT_FRESHNESS.ups.staleAfterMs;
const RANGES: Readonly<Record<string, number>> = {
  "24h": 24 * 3600e3,
  "7d": 7 * 24 * 3600e3,
  "30d": 30 * 24 * 3600e3,
};

const OB_TOKEN = "OB";
const LB_TOKEN = "LB";

function hasToken(status: string | null | undefined, token: string): boolean {
  return asText(status)
    .toUpperCase()
    .split(/\s+/)
    .includes(token);
}

interface OutageAccumulator {
  started_at: number;
  earliest_start: number | null;
  last_seen_at: number;
  samples: number;
  min_charge: number | null;
  min_runtime: number | null;
  low_battery: boolean;
}

interface OutageRecord {
  started_at: number;
  ended_at: number | null;
  earliest_start: number | null;
  observed_seconds: number;
  max_seconds: number | null;
  samples: number;
  min_charge: number | null;
  min_runtime: number | null;
  low_battery: boolean;
  ongoing: boolean;
  coarse: boolean;
}

function closeOutage(o: OutageAccumulator, recoveredAt: number | null): OutageRecord {
  const observedSeconds = Math.round((o.last_seen_at - o.started_at) / 1000);
  const maxSeconds =
    o.earliest_start != null && recoveredAt != null
      ? Math.round((recoveredAt - o.earliest_start) / 1000)
      : null;
  return {
    started_at: o.started_at,
    ended_at: recoveredAt,
    earliest_start: o.earliest_start,
    observed_seconds: observedSeconds,
    max_seconds: maxSeconds,
    samples: o.samples,
    min_charge: o.min_charge,
    min_runtime: o.min_runtime,
    low_battery: o.low_battery,
    ongoing: recoveredAt == null,
    coarse: o.samples < 2,
  };
}

function deriveOutages(
  rows: ReadonlyArray<{
    received_at: number;
    ups_status: string | null;
    battery_charge: number | null;
    battery_runtime: number | null;
  }>
): OutageRecord[] {
  const outages: OutageRecord[] = [];
  let current: OutageAccumulator | null = null;
  let lastMainsAt: number | null = null;

  for (const r of rows) {
    const onBattery = hasToken(r.ups_status, OB_TOKEN);

    if (onBattery) {
      if (!current) {
        current = {
          started_at: r.received_at,
          earliest_start: lastMainsAt,
          last_seen_at: r.received_at,
          samples: 0,
          min_charge: null,
          min_runtime: null,
          low_battery: false,
        };
      }
      current.last_seen_at = r.received_at;
      current.samples += 1;
      if (r.battery_charge != null) {
        current.min_charge =
          current.min_charge == null
            ? r.battery_charge
            : Math.min(current.min_charge, r.battery_charge);
      }
      if (r.battery_runtime != null) {
        current.min_runtime =
          current.min_runtime == null
            ? r.battery_runtime
            : Math.min(current.min_runtime, r.battery_runtime);
      }
      if (hasToken(r.ups_status, LB_TOKEN)) current.low_battery = true;
    } else {
      if (current) {
        outages.push(closeOutage(current, r.received_at));
        current = null;
      }
      lastMainsAt = r.received_at;
    }
  }

  if (current) outages.push(closeOutage(current, null));
  return outages;
}

export function createUpsServiceRouter(deps: UpsServiceRouterDependencies): Router {
  const router = Router();

  router.post(
    "/api/ups/ingest",
    requireServiceToken({
      expected: () => deps.config.serviceTokens.ups,
      unconfiguredMessage: "UPS ingest not configured — set UPS_INGEST_TOKEN",
      headers: ["x-ups-token"],
    }),
    express.json({ limit: "50mb" }),
    asyncHandler(async (req, res) => {
      const vars = (req.body as Record<string, unknown>)?.["vars"];
      if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
        res.status(400).json({ error: 'Body must include a "vars" object' });
        return;
      }
      const varsObj = vars as Record<string, unknown>;
      const body = req.body as Record<string, unknown>;

      const row = {
        received_at: Date.now(),
        device_ts: num(body["ts"]),
        ups_id:
          typeof body["ups_id"] === "string" && (body["ups_id"]).trim()
            ? (body["ups_id"]).trim()
            : "tower",
        ups_label:
          typeof body["ups_label"] === "string" && (body["ups_label"]).trim()
            ? (body["ups_label"]).trim()
            : null,
        ups_status:
          typeof varsObj["ups.status"] === "string" ? (varsObj["ups.status"]) : null,
        battery_charge: null as number | null,
        battery_runtime: null as number | null,
        battery_voltage: null as number | null,
        ups_load: null as number | null,
        input_voltage: null as number | null,
        output_voltage: null as number | null,
        output_power: null as number | null,
        ups_temperature: null as number | null,
        raw: JSON.stringify(vars),
        agent_diag:
          body["diagnostics"] && typeof body["diagnostics"] === "object"
            ? JSON.stringify(body["diagnostics"])
            : null,
      };
      for (const [nutKey, col] of Object.entries(NUMERIC)) {
        (row as Record<string, unknown>)[col] = num(varsObj[nutKey]);
      }

      const stored = await deps.repository.ingest(
        row,
        deliveryIdFrom(req.get("x-hearth-delivery-id"), req.body)
      );
      res.json({ ok: true, duplicate: !stored, received_at: row.received_at });
    })
  );

  return router;
}

export function createUpsRouter(deps: UpsRouterDependencies): Router {
  const router = Router();

  router.get(
    "/api/ups",
    requireRole("viewer"),
    asyncHandler(async (_req, res) => {
      const rows = await deps.repository.getLatestPerUps();
      if (!rows.length) {
        res.json({
          ok: true,
          present: false,
          upses: [],
          last_contact_at: null,
          expected_cadence_seconds: seconds(AGENT_FRESHNESS.ups.expectedCadenceMs),
          stale_after_seconds: seconds(STALE_MS),
        });
        return;
      }

      const now = Date.now();
      const upses = rows
        .map((r) => {
          const ageMs = now - r.received_at;
          return {
            ups_id: r.ups_id ?? "tower",
            label: r.ups_label ?? r.ups_id ?? "UPS",
            age_seconds: Math.round(ageMs / 1000),
            stale: ageMs > STALE_MS,
            last_contact_at: r.received_at,
            source_observed_at: r.device_ts ?? null,
            expected_cadence_seconds: seconds(AGENT_FRESHNESS.ups.expectedCadenceMs),
            stale_after_seconds: seconds(STALE_MS),
            reading: { ...r, raw: safeParse(r.raw) },
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label));

      const primary = rows[0]!;
      const ageMs = now - primary.received_at;
      res.json({
        ok: true,
        present: true,
        age_seconds: Math.round(ageMs / 1000),
        stale: ageMs > STALE_MS,
        last_contact_at: primary.received_at,
        source_observed_at: primary.device_ts ?? null,
        expected_cadence_seconds: seconds(AGENT_FRESHNESS.ups.expectedCadenceMs),
        stale_after_seconds: seconds(STALE_MS),
        reading: { ...primary, raw: safeParse(primary.raw) },
        upses,
        diagnostics: safeParse(primary.agent_diag),
      });
    })
  );

  router.get(
    "/api/ups/history",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const rangeKey = queryString(req.query["range"]);
      const range = rangeKey !== undefined && rangeKey in RANGES ? rangeKey : "24h";
      const cutoff = Date.now() - (RANGES[range] as number);
      const upsId = queryString(req.query["ups"]) ?? null;
      const points = await deps.repository.getHistory(cutoff, upsId);
      res.json({ ok: true, range, ups: upsId, points });
    })
  );

  router.get(
    "/api/ups/outages",
    requireRole("viewer"),
    asyncHandler(async (req, res) => {
      const days = queryInteger(req.query["days"], 90, 1, 90);
      const cutoff = Date.now() - days * 24 * 3600e3;
      const rows = await deps.repository.getOutageReadings(cutoff);

      const byUnit = new Map<
        string,
        { ups_id: string; label: string; rows: typeof rows }
      >();
      for (const r of rows) {
        const id = r.ups_id ?? "tower";
        if (!byUnit.has(id)) {
          byUnit.set(id, { ups_id: id, label: r.ups_label ?? id, rows: [] });
        }
        byUnit.get(id)!.rows.push(r);
      }

      const units = [...byUnit.values()]
        .map((u) => {
          const outages = deriveOutages(u.rows);
          return {
            ups_id: u.ups_id,
            label: u.label,
            readings: u.rows.length,
            outages: outages.slice().reverse(),
            summary: {
              count: outages.length,
              total_observed_seconds: outages.reduce((a, o) => a + o.observed_seconds, 0),
              longest_max_seconds: outages.reduce(
                (a, o) => Math.max(a, o.max_seconds ?? 0),
                0
              ),
              last_at: outages.length ? outages[outages.length - 1]!.started_at : null,
              ongoing: outages.some((o) => o.ongoing),
            },
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label));

      res.json({ ok: true, days, units });
    })
  );

  return router;
}
