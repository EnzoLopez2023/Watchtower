import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";
import { packJson, unpackJson } from "../../../monitoring/payloadCodec.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import { asText } from "../../../monitoring/values.js";

const RETENTION = {
  probes: 90 * 24 * 60 * 60 * 1000,
  isp: 90 * 24 * 60 * 60 * 1000,
  snmpDevices: 30 * 24 * 60 * 60 * 1000,
  snmpInterfaces: 90 * 24 * 60 * 60 * 1000,
  snmpEvents: 90 * 24 * 60 * 60 * 1000,
};
const MAX_PROBES = 500;
const MAX_ISP_METRICS = 1000;
const MAX_SNMP_DEVICES = 100;
const MAX_INTERFACES_PER_DEVICE = 1000;
const MAX_SNMP_EVENTS = 5000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const PROBE_KINDS = new Set(["lan", "dns", "http", "external"]);
export const RANGES: Record<string, number> = { "24h": 24 * 3600e3, "7d": 7 * 24 * 3600e3, "30d": 30 * 24 * 3600e3 };

function finite(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function integer(value: unknown): number | null {
  const n = finite(value);
  return n == null ? null : Math.round(n);
}
function epochMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = finite(value);
  if (n != null) return Math.round(n < 1e11 ? n * 1000 : n);
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : null;
}
function text(value: unknown, max = 500): string | null {
  const parsed = asText(value);
  return parsed === "" ? null : parsed.slice(0, max);
}
function boolInt(value: unknown): 0 | 1 | null {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}
function changedFromKnown(previous: unknown, current: unknown): boolean {
  return previous != null && current != null && previous !== current;
}
function counterDelta(previous: unknown, current: unknown): number {
  if (previous == null || current == null) return 0;
  const p = Number(previous), c = Number(current);
  return c >= p ? c - p : 0;
}
function mergeByKey<T>(previous: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  const merged = new Map((Array.isArray(previous) ? previous : []).map((item) => [keyOf(item), item]));
  for (const item of Array.isArray(incoming) ? incoming : []) merged.set(keyOf(item), item);
  return [...merged.values()];
}

export interface IngestResult {
  readonly duplicate: boolean;
  readonly probesStored: number;
  readonly ispStored: number;
  readonly snmpDevicesStored: number;
  readonly interfacesStored: number;
  readonly snmpEventsStored: number;
}

export interface ObserverLatestRow {
  readonly observer_id: string;
  readonly received_at: number;
  readonly age_seconds: number;
  readonly stale: boolean;
  readonly payload: unknown;
}

export interface ProbeHistoryRow {
  readonly id: number;
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly observer_id: string;
  readonly kind: string;
  readonly target_id: string;
  readonly target_label: string | null;
  readonly ok: number;
  readonly latency_ms: number | null;
  readonly status_code: number | null;
  readonly error: string | null;
}

export interface IspSampleRow {
  readonly id: number;
  readonly received_at: number;
  readonly observer_id: string;
  readonly unifi_host_id: string;
  readonly site_id: string;
  readonly metric_time: number;
  readonly metric_type: string | null;
  readonly isp_name: string | null;
  readonly isp_asn: string | null;
  readonly latency_ms: number | null;
  readonly max_latency_ms: number | null;
  readonly packet_loss_pct: number | null;
  readonly download_kbps: number | null;
  readonly upload_kbps: number | null;
  readonly uptime_pct: number | null;
  readonly downtime: number | null;
}

export interface SnmpEventRow {
  readonly id: number;
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly observer_id: string;
  readonly device_id: string;
  readonly device_label: string | null;
  readonly if_index: number;
  readonly name: string | null;
  readonly previous_admin_up: number | null;
  readonly admin_up: number | null;
  readonly previous_oper_up: number | null;
  readonly oper_up: number | null;
  readonly previous_speed_bps: number | null;
  readonly speed_bps: number | null;
  readonly in_errors_delta: number;
  readonly out_errors_delta: number;
  readonly in_discards_delta: number;
  readonly out_discards_delta: number;
  readonly in_bps: number | null;
  readonly out_bps: number | null;
}

export interface NetworkObserverRepository {
  ingest(body: unknown, now: number, deliveryId: string | null): Promise<IngestResult>;
  getLatest(staleAfterMs: number): Promise<ObserverLatestRow[]>;
  getProbeHistory(rangeMs: number, kind?: string, targetId?: string): Promise<ProbeHistoryRow[]>;
  getIspSamples(rangeMs: number): Promise<IspSampleRow[]>;
  getSnmpEvents(rangeMs: number, deviceId?: string, limit?: number): Promise<SnmpEventRow[]>;
  getSnmpSamples(rangeMs: number, deviceId?: string): Promise<{ devices: unknown[]; interfaces: unknown[] }>;
}

export class SqliteNetworkObserverRepository extends SqliteRepository implements NetworkObserverRepository {
  private lastMaintenanceAt = 0;

  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim
  ) {
    super(database);
  }

  public async ingest(body: unknown, now: number, deliveryId: string | null): Promise<IngestResult> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const doMaintenance = now - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS;

    const result = this.transaction<IngestResult>(() => {
      if (!this.receipts.claim(deliveryId, "/api/network-observer/ingest", now)) {
        return { duplicate: true, probesStored: 0, ispStored: 0, snmpDevicesStored: 0, interfacesStored: 0, snmpEventsStored: 0 };
      }

      const observerId = text(b["observer_id"], 120);
      if (!observerId) throw new Error("observer_id is required");
      const deviceTs = epochMs(b["ts"]);

      const probes = (Array.isArray(b["probes"]) ? b["probes"].slice(0, MAX_PROBES) : []) as Record<string, unknown>[];
      const ispMetrics = (Array.isArray(b["isp_metrics"]) ? b["isp_metrics"].slice(0, MAX_ISP_METRICS) : []) as Record<string, unknown>[];
      const snmpDevices = (Array.isArray(b["snmp_devices"]) ? b["snmp_devices"].slice(0, MAX_SNMP_DEVICES) : []) as Record<string, unknown>[];

      let probesStored = 0, ispStored = 0, snmpDevicesStored = 0, interfacesStored = 0, snmpEventsStored = 0;

      for (const probe of probes) {
        const kind = text(probe["kind"], 20);
        const targetId = text(probe["id"], 160);
        const ok = boolInt(probe["ok"]);
        if (!PROBE_KINDS.has(kind ?? "") || !targetId || ok == null) continue;
        const probeTs = epochMs(probe["ts"]) ?? deviceTs;
        probesStored += this.runNamed(
          `INSERT INTO network_probe_samples (received_at, device_ts, observer_id, kind, target_id, target_label, ok, latency_ms, status_code, error, detail)
           VALUES (@received_at, @device_ts, @observer_id, @kind, @target_id, @target_label, @ok, @latency_ms, @status_code, @error, @detail)`,
          {
            received_at: now, device_ts: probeTs, observer_id: observerId, kind: kind,
            target_id: targetId, target_label: text(probe["label"], 240),
            ok, latency_ms: finite(probe["latency_ms"]), status_code: integer(probe["status"]),
            error: text(probe["error"], 1000),
            detail: packJson(probe["detail"] != null && typeof probe["detail"] === "object" ? probe["detail"] : {}),
          }
        ).changes;
      }

      for (const metric of ispMetrics) {
        const unifiHostId = text(metric["host_id"], 240);
        const siteId = text(metric["site_id"], 240);
        const metricTime = epochMs(metric["metric_time"]);
        if (!unifiHostId || !siteId || metricTime == null) continue;
        const wan = metric["wan"] && typeof metric["wan"] === "object" ? metric["wan"] as Record<string, unknown> : metric;
        ispStored += this.runNamed(
          `INSERT INTO network_isp_samples (received_at, observer_id, unifi_host_id, site_id, metric_time, metric_type, isp_name, isp_asn, latency_ms, max_latency_ms, packet_loss_pct, download_kbps, upload_kbps, uptime_pct, downtime, raw)
           VALUES (@received_at, @observer_id, @unifi_host_id, @site_id, @metric_time, @metric_type, @isp_name, @isp_asn, @latency_ms, @max_latency_ms, @packet_loss_pct, @download_kbps, @upload_kbps, @uptime_pct, @downtime, @raw)
           ON CONFLICT(observer_id, unifi_host_id, site_id, metric_time) DO UPDATE SET
             received_at = excluded.received_at, metric_type = excluded.metric_type, isp_name = excluded.isp_name,
             isp_asn = excluded.isp_asn, latency_ms = excluded.latency_ms, max_latency_ms = excluded.max_latency_ms,
             packet_loss_pct = excluded.packet_loss_pct, download_kbps = excluded.download_kbps,
             upload_kbps = excluded.upload_kbps, uptime_pct = excluded.uptime_pct, downtime = excluded.downtime, raw = excluded.raw`,
          {
            received_at: now, observer_id: observerId, unifi_host_id: unifiHostId, site_id: siteId,
            metric_time: metricTime, metric_type: text(metric["metric_type"], 20),
            isp_name: text(wan["isp_name"] ?? wan["ispName"], 240),
            isp_asn: text(wan["isp_asn"] ?? wan["ispAsn"], 80),
            latency_ms: finite(wan["latency_ms"] ?? wan["avgLatency"]),
            max_latency_ms: finite(wan["max_latency_ms"] ?? wan["maxLatency"]),
            packet_loss_pct: finite(wan["packet_loss_pct"] ?? wan["packetLoss"]),
            download_kbps: finite(wan["download_kbps"]),
            upload_kbps: finite(wan["upload_kbps"]),
            uptime_pct: finite(wan["uptime_pct"] ?? wan["uptime"]),
            downtime: finite(wan["downtime"]),
            raw: packJson(metric),
          }
        ).changes;
      }

      for (const device of snmpDevices) {
        const deviceId = text(device["id"], 160);
        const ok = boolInt(device["ok"]);
        if (!deviceId || ok == null) continue;
        const system = device["system"] && typeof device["system"] === "object" ? device["system"] as Record<string, unknown> : {};
        const deviceTs2 = epochMs(device["ts"]) ?? deviceTs;
        snmpDevicesStored += this.runNamed(
          `INSERT INTO network_snmp_device_samples (received_at, device_ts, observer_id, device_id, label, host, ok, uptime_s, cpu_pct, mem_pct, temp_c, error)
           VALUES (@received_at, @device_ts, @observer_id, @device_id, @label, @host, @ok, @uptime_s, @cpu_pct, @mem_pct, @temp_c, @error)`,
          {
            received_at: now, device_ts: deviceTs2, observer_id: observerId, device_id: deviceId,
            label: text(device["label"], 240), host: text(device["host"], 240), ok,
            uptime_s: integer(system["uptime_s"]), cpu_pct: finite(system["cpu_pct"]),
            mem_pct: finite(system["mem_pct"]), temp_c: finite(system["temp_c"]),
            error: text(device["error"], 1000),
          }
        ).changes;

        const ifaces = (Array.isArray(device["interfaces"]) ? device["interfaces"].slice(0, MAX_INTERFACES_PER_DEVICE) : []) as Record<string, unknown>[];
        for (const iface of ifaces) {
          const ifIndex = integer(iface["if_index"]);
          if (ifIndex == null) continue;
          const sample = {
            received_at: now, device_ts: deviceTs2, observer_id: observerId, device_id: deviceId,
            if_index: ifIndex, name: text(iface["name"], 240),
            admin_up: boolInt(iface["admin_up"]), oper_up: boolInt(iface["oper_up"]),
            speed_bps: integer(iface["speed_bps"]), in_octets: integer(iface["in_octets"]),
            out_octets: integer(iface["out_octets"]), in_bps: finite(iface["in_bps"]), out_bps: finite(iface["out_bps"]),
            in_errors: integer(iface["in_errors"]), out_errors: integer(iface["out_errors"]),
            in_discards: integer(iface["in_discards"]), out_discards: integer(iface["out_discards"]),
          };
          const previous = this.get<{ admin_up: number | null; oper_up: number | null; speed_bps: number | null; in_errors: number | null; out_errors: number | null; in_discards: number | null; out_discards: number | null }>(
            `SELECT admin_up, oper_up, speed_bps, in_errors, out_errors, in_discards, out_discards
               FROM network_snmp_interface_samples WHERE observer_id = ? AND device_id = ? AND if_index = ? ORDER BY received_at DESC LIMIT 1`,
            observerId, deviceId, ifIndex
          );
          interfacesStored += this.runNamed(
            `INSERT INTO network_snmp_interface_samples (received_at, device_ts, observer_id, device_id, if_index, name, admin_up, oper_up, speed_bps, in_octets, out_octets, in_bps, out_bps, in_errors, out_errors, in_discards, out_discards)
             VALUES (@received_at, @device_ts, @observer_id, @device_id, @if_index, @name, @admin_up, @oper_up, @speed_bps, @in_octets, @out_octets, @in_bps, @out_bps, @in_errors, @out_errors, @in_discards, @out_discards)`,
            sample
          ).changes;

          if (!previous) continue;
          const inErrorsDelta = counterDelta(previous.in_errors, sample.in_errors);
          const outErrorsDelta = counterDelta(previous.out_errors, sample.out_errors);
          const inDiscardsDelta = counterDelta(previous.in_discards, sample.in_discards);
          const outDiscardsDelta = counterDelta(previous.out_discards, sample.out_discards);
          const stateChanged = changedFromKnown(previous.admin_up, sample.admin_up)
            || changedFromKnown(previous.oper_up, sample.oper_up)
            || changedFromKnown(previous.speed_bps, sample.speed_bps);
          if (!stateChanged && inErrorsDelta + outErrorsDelta + inDiscardsDelta + outDiscardsDelta === 0) continue;
          snmpEventsStored += this.runNamed(
            `INSERT INTO network_snmp_interface_events (received_at, device_ts, observer_id, device_id, device_label, if_index, name, previous_admin_up, admin_up, previous_oper_up, oper_up, previous_speed_bps, speed_bps, in_errors_delta, out_errors_delta, in_discards_delta, out_discards_delta, in_bps, out_bps)
             VALUES (@received_at, @device_ts, @observer_id, @device_id, @device_label, @if_index, @name, @previous_admin_up, @admin_up, @previous_oper_up, @oper_up, @previous_speed_bps, @speed_bps, @in_errors_delta, @out_errors_delta, @in_discards_delta, @out_discards_delta, @in_bps, @out_bps)`,
            {
              ...sample,
              device_label: text(device["label"], 240),
              previous_admin_up: previous.admin_up, previous_oper_up: previous.oper_up, previous_speed_bps: previous.speed_bps,
              in_errors_delta: inErrorsDelta, out_errors_delta: outErrorsDelta,
              in_discards_delta: inDiscardsDelta, out_discards_delta: outDiscardsDelta,
            }
          ).changes;
        }
      }

      const previousRow = this.get<{ payload: unknown }>("SELECT payload FROM network_observer_latest WHERE observer_id = ?", observerId);
      const prev: Record<string, unknown> = previousRow
        ? (unpackJson<Record<string, unknown>>(previousRow.payload) ?? {})
        : {};

      const latestSnmpDevices = snmpDevices.map((device) => {
        const { latest_interfaces: latestInterfaces, ...rest } = device as Record<string, unknown> & { latest_interfaces?: unknown };
        return { ...rest, interfaces: Array.isArray(latestInterfaces) ? latestInterfaces : device["interfaces"] };
      });

      const snmpRefreshed = b["snmp_refreshed"] === true;
      const latest = {
        ts: deviceTs,
        observer_id: observerId,
        agent_build: integer(b["agent_build"]),
        probes: mergeByKey(
          Array.isArray(prev["probes"]) ? prev["probes"] as Record<string, unknown>[] : [],
          probes.map((p) => ({ ...p, ts: epochMs(p["ts"]) ?? deviceTs })),
          (p) => `${asText(p["kind"])}:${asText(p["id"])}`
        ),
        isp_metrics: mergeByKey(
          Array.isArray(prev["isp_metrics"]) ? prev["isp_metrics"] as Record<string, unknown>[] : [],
          ispMetrics,
          (m) => `${asText(m["host_id"])}:${asText(m["site_id"])}`
        ),
        snmp_devices: snmpRefreshed
          ? latestSnmpDevices
          : mergeByKey(
            Array.isArray(prev["snmp_devices"]) ? prev["snmp_devices"] as Record<string, unknown>[] : [],
            latestSnmpDevices,
            (d) => asText(d["id"])
          ),
        diagnostics: b["diagnostics"] && typeof b["diagnostics"] === "object"
          ? b["diagnostics"]
          : (prev["diagnostics"] ?? {}),
      };
      this.runNamed(
        `INSERT INTO network_observer_latest (observer_id, received_at, payload) VALUES (@observer_id, @received_at, @payload)
         ON CONFLICT(observer_id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`,
        { observer_id: observerId, received_at: now, payload: packJson(latest) }
      );

      if (doMaintenance) {
        // Every cutoff prunes on the server-authored received_at, never an
        // agent-supplied clock. metric_time stays as evidence of when the WAN
        // sample was taken, but it must not decide retention.
        this.run("DELETE FROM network_probe_samples WHERE received_at < ?", now - RETENTION.probes);
        this.run("DELETE FROM network_isp_samples WHERE received_at < ?", now - RETENTION.isp);
        this.run("DELETE FROM network_snmp_device_samples WHERE received_at < ?", now - RETENTION.snmpDevices);
        this.run("DELETE FROM network_snmp_interface_samples WHERE received_at < ?", now - RETENTION.snmpInterfaces);
        this.run("DELETE FROM network_snmp_interface_events WHERE received_at < ?", now - RETENTION.snmpEvents);
      }

      return { duplicate: false, probesStored, ispStored, snmpDevicesStored, interfacesStored, snmpEventsStored };
    });

    if (doMaintenance) this.lastMaintenanceAt = now;
    return result;
  }

  public async getLatest(staleAfterMs: number): Promise<ObserverLatestRow[]> {
    const rows = this.all<{ observer_id: string; received_at: number; payload: unknown }>(
      "SELECT observer_id, received_at, payload FROM network_observer_latest ORDER BY observer_id"
    );
    const now = Date.now();
    return rows.map((row) => ({
      observer_id: row.observer_id,
      received_at: row.received_at,
      age_seconds: Math.max(0, Math.round((now - row.received_at) / 1000)),
      stale: now - row.received_at > staleAfterMs,
      payload: unpackJson(row.payload),
    }));
  }

  public async getProbeHistory(rangeMs: number, kind?: string, targetId?: string): Promise<ProbeHistoryRow[]> {
    const cutoff = Date.now() - rangeMs;
    const where = ["received_at >= ?"];
    const params: (string | number)[] = [cutoff];
    if (kind) { where.push("kind = ?"); params.push(kind); }
    if (targetId) { where.push("target_id = ?"); params.push(targetId); }
    params.push(20_000);
    return this.all<ProbeHistoryRow>(
      `SELECT * FROM (SELECT id, received_at, device_ts, observer_id, kind, target_id, target_label, ok, latency_ms, status_code, error
         FROM network_probe_samples WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT ?) ORDER BY received_at ASC`,
      ...params
    );
  }

  public async getIspSamples(rangeMs: number): Promise<IspSampleRow[]> {
    const cutoff = Date.now() - rangeMs;
    return this.all<IspSampleRow>(
      `SELECT * FROM (SELECT id, received_at, observer_id, unifi_host_id, site_id, metric_time, metric_type, isp_name, isp_asn, latency_ms, max_latency_ms, packet_loss_pct, download_kbps, upload_kbps, uptime_pct, downtime
         FROM network_isp_samples WHERE metric_time >= ? ORDER BY metric_time DESC LIMIT 20000) ORDER BY metric_time ASC`,
      cutoff
    );
  }

  public async getSnmpEvents(rangeMs: number, deviceId?: string, limit = MAX_SNMP_EVENTS): Promise<SnmpEventRow[]> {
    const cutoff = Date.now() - rangeMs;
    const where = ["received_at >= ?"];
    const params: (string | number)[] = [cutoff];
    if (deviceId) { where.push("device_id = ?"); params.push(deviceId); }
    const safeLimit = Math.min(Math.max(limit, 1), MAX_SNMP_EVENTS);
    params.push(safeLimit);
    return this.all(
      `SELECT * FROM (SELECT id, received_at, device_ts, observer_id, device_id, device_label, if_index, name, previous_admin_up, admin_up, previous_oper_up, oper_up, previous_speed_bps, speed_bps, in_errors_delta, out_errors_delta, in_discards_delta, out_discards_delta, in_bps, out_bps
         FROM network_snmp_interface_events WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT ?) ORDER BY received_at ASC`,
      ...params
    );
  }

  public async getSnmpSamples(rangeMs: number, deviceId?: string): Promise<{ devices: unknown[]; interfaces: unknown[] }> {
    const cutoff = Date.now() - rangeMs;
    const deviceWhere = ["received_at >= ?"];
    const deviceParams: (string | number)[] = [cutoff];
    const ifaceWhere = ["received_at >= ?"];
    const ifaceParams: (string | number)[] = [cutoff];
    if (deviceId) {
      deviceWhere.push("device_id = ?"); deviceParams.push(deviceId);
      ifaceWhere.push("device_id = ?"); ifaceParams.push(deviceId);
    }
    deviceParams.push(10_000);
    ifaceParams.push(20_000);
    const devices = this.all(
      `SELECT * FROM (SELECT * FROM network_snmp_device_samples WHERE ${deviceWhere.join(" AND ")} ORDER BY received_at DESC LIMIT ?) ORDER BY received_at ASC`,
      ...deviceParams
    );
    const interfaces = this.all(
      `SELECT * FROM (SELECT * FROM network_snmp_interface_samples WHERE ${ifaceWhere.join(" AND ")} ORDER BY received_at DESC LIMIT ?) ORDER BY received_at ASC`,
      ...ifaceParams
    );
    return { devices, interfaces };
  }
}
