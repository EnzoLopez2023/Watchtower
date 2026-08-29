import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository, type SqlValue } from "./base.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import { unpackJson, packJson } from "../../../monitoring/payloadCodec.js";
import { asText } from "../../../monitoring/values.js";
import {
  internetReachable,
  portStateFingerprint,
  shouldRecordPortSample,
  wanUplinks,
} from "../../../monitoring/unifiTelemetry.js";
import {
  syncTrafficRouteBaseline as syncTrafficRouteBaselineImpl,
  activeTrafficRouteDriftEvents as activeTrafficRouteDriftEventsImpl,
  trafficRouteDriftStatus as trafficRouteDriftStatusImpl,
  type RouteDriftDb,
  type RouteDriftMeta,
  type RouteDriftBaselineRow,
  type ActiveDriftEntry,
  type ActiveDriftKeyRow,
  type RouteDriftHistoryRow,
  type SyncTrafficRouteResult,
  type ActiveDriftEvent,
  type RouteDriftStatus,
} from "../../../monitoring/unifiRouteDrift.js";

// ── Types consumed by route layer ────────────────────────────────────────────

export interface UnifiLatestRow {
  readonly id: number;
  readonly received_at: number;
  readonly payload: Buffer | null;
}

export interface UnifiReadingRow {
  readonly received_at: number;
  readonly wan_rx_bps: number | null;
  readonly wan_tx_bps: number | null;
  readonly wan_latency_ms: number | null;
  readonly internet_reachable: 0 | 1 | null;
  readonly active_wan: string | null;
  readonly active_wan_name: string | null;
  readonly num_clients: number | null;
  readonly devices_online: number | null;
  [key: string]: unknown;
}

export interface UnifiWanSampleRow {
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly wan_key: string;
  readonly name: string | null;
  readonly primary_uplink: 0 | 1;
  readonly active: 0 | 1;
  readonly internet_reachable: 0 | 1 | null;
  readonly latency_ms: number | null;
  readonly availability: number | null;
  readonly uptime_seconds: number | null;
  readonly downtime_seconds: number | null;
  readonly time_period_seconds: number | null;
  readonly monitors: Buffer | null;
}

export interface UnifiEventRow {
  readonly id: number;
  readonly upstream_id: string;
  readonly event_ts: number;
  readonly is_alarm: 0 | 1;
  readonly key: string | null;
  readonly subsystem: string | null;
  readonly message: string | null;
  readonly title: string | null;
  readonly severity: string | null;
  readonly source: string;
}

export interface UnifiCompatRow {
  readonly status: string;
  readonly page_base: number | null;
  readonly evidence: string | null;
  readonly negotiated_at: number | null;
  readonly held: 0 | 1;
  readonly updated_at: number | null;
}

export interface OutageIncident {
  id: string;
  scope: string;
  status: string;
  classification: string | null;
  confidence: number | null;
  startedAt: number;
  lastEvidenceAt: number;
  recoveredAt: number | null;
  finalizeAfter: number | null;
  finalizedAt: number | null;
  recoveryReason: string | null;
  classifications: string[];
  pendingSeconds: number | null;
  reportId: string | null;
  executiveSummary: string | null;
  report: unknown;
  evidence?: OutageEvidence[];
}

export interface OutageEvidence {
  evidenceKey: string;
  source: string;
  signal: string;
  state: string;
  occurredAt: number;
  receivedAt: number;
  confidence: number;
  summary: string | null;
  detail: string | null;
}

export interface OutageIncidentsRepository {
  listOutageIncidents(limit?: number): Promise<OutageIncident[]>;
  getOutageIncident(id: string): Promise<OutageIncident | null>;
  outageRecoveryHoldMs(): Promise<number>;
}

export interface UnifiIngestInput {
  readonly body: Record<string, unknown>;
  readonly heavy: boolean;
  readonly deliveryId: string | null;
}

export interface UnifiIngestResult {
  readonly duplicate: boolean;
  readonly receivedAt: number;
}

export interface UnifiRepository {
  ingest(input: UnifiIngestInput): Promise<UnifiIngestResult>;
  syncTrafficRouteBaseline(config: unknown, observedAt?: number): Promise<SyncTrafficRouteResult>;
  activeTrafficRouteDriftEvents(): Promise<ActiveDriftEvent[]>;
  trafficRouteDriftStatus(): Promise<RouteDriftStatus>;
  getLatest(): Promise<UnifiLatestRow | undefined>;
  getLatestPayload(): Promise<UnifiLatestRow | undefined>;
  protectNvrIdentity(): Promise<{ host: string | null; name: string | null }>;
  queryReadings(cutoff: number): Promise<UnifiReadingRow[]>;
  queryWanHistory(cutoff: number, wanKey: string | null, limit: number): Promise<UnifiWanSampleRow[]>;
  queryDeviceSamples(deviceId: string, cutoff: number): Promise<unknown[]>;
  queryPortHistory(cutoff: number, deviceId: string | null, portIdx: number | null, limit: number): Promise<unknown[]>;
  queryClientSamples(clientId: string, cutoff: number): Promise<unknown[]>;
  queryEvents(cutoff: number, limit: number): Promise<UnifiEventRow[]>;
  getActivityCompatRow(): Promise<UnifiCompatRow>;
  listOutageIncidents(limit?: number): Promise<OutageIncident[]>;
  getOutageIncident(id: string): Promise<OutageIncident | null>;
  outageRecoveryHoldMs(): Promise<number>;
}

// ── Private ingest helpers ────────────────────────────────────────────────────

const INGEST_RETENTION = {
  readings: 90 * 24 * 60 * 60 * 1000,
  wan_samples: 90 * 24 * 60 * 60 * 1000,
  device_samples: 30 * 24 * 60 * 60 * 1000,
  port_samples: 90 * 24 * 60 * 60 * 1000,
  client_samples: 2 * 24 * 60 * 60 * 1000,
  events: 90 * 24 * 60 * 60 * 1000,
};

const PORT_HEARTBEAT_INTERVAL = 60 * 60 * 1000;

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n);
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const boolInt = (value: unknown): 0 | 1 | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value === 0 ? 0 : 1;
  const normalized = asText(value).trim().toLowerCase();
  if (["true", "yes", "up", "enabled", "1"].includes(normalized)) return 1;
  if (["false", "no", "down", "disabled", "0"].includes(normalized)) return 0;
  return null;
};

// ── Repository ────────────────────────────────────────────────────────────────

export class SqliteUnifiRepository extends SqliteRepository implements UnifiRepository {
  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim
  ) {
    super(database);
  }

  // ── Ingest (transactional write) ──────────────────────────────────────────

  public async ingest(input: UnifiIngestInput): Promise<UnifiIngestResult> {
    return this.transaction(() => this.ingestSync(input));
  }

  private ingestSync(input: UnifiIngestInput): UnifiIngestResult {
    const { body, heavy, deliveryId } = input;
    const now = Date.now();

    if (!this.receipts.claim(deliveryId, "/api/unifi/ingest", now)) {
      return { duplicate: true, receivedAt: now };
    }

    const wan = body.wan && typeof body.wan === "object" ? (body.wan as Record<string, unknown>) : {};
    const devices = Array.isArray(body.devices) ? body.devices : [];
    const clients = Array.isArray(body.clients) ? body.clients : [];
    const events = Array.isArray(body.events) ? body.events : [];
    const config = body.config && typeof body.config === "object" ? body.config : undefined;

    let keptConfig: unknown = config;
    if (!keptConfig) {
      const prev = this.getLatestSync();
      const parsed = prev ? unpackJson<Record<string, unknown>>(prev.payload) : null;
      keptConfig = parsed?.["config"] ?? null;
    }

    const telemetryPayload = { ...body, config: keptConfig };
    const uplinks = wanUplinks(telemetryPayload);
    const reachable = internetReachable(telemetryPayload);
    const activeUplink = uplinks.find((uplink) => uplink.active) ?? null;

    const devicesOnline = devices.filter((d) => {
      if (!d || typeof d !== "object") return false;
      const dev = d as Record<string, unknown>;
      const s = asText(dev["state"] ?? dev["status"]).toLowerCase();
      return dev["online"] === true || s === "online" || s === "connected" || s === "1";
    }).length;

    this.insertReadingSync({
      received_at: now,
      device_ts: int(body.ts),
      wan_status: str(wan.status),
      wan_latency_ms: num(wan.latency_ms),
      wan_uptime: int(wan.uptime),
      wan_rx_bps: num(wan.rx_bps),
      wan_tx_bps: num(wan.tx_bps),
      internet_reachable: reachable == null ? null : reachable ? 1 : 0,
      active_wan: str(activeUplink?.key),
      active_wan_name: str(activeUplink?.name),
      num_clients: clients.length,
      num_devices: devices.length,
      devices_online: devicesOnline,
      raw: null,
    });

    for (const uplink of uplinks) {
      this.insertWanSampleSync({
        received_at: now,
        device_ts: int(body.ts),
        wan_key: uplink.key,
        name: str(uplink.name),
        primary_uplink: uplink.primary ? 1 : 0,
        active: uplink.active ? 1 : 0,
        internet_reachable: reachable == null ? null : reachable ? 1 : 0,
        latency_ms: num(uplink.latencyMs),
        availability: num(uplink.availability),
        uptime_seconds: int(uplink.uptimeSeconds),
        downtime_seconds: int(uplink.downtimeSeconds),
        time_period_seconds: int(uplink.timePeriodSeconds),
        monitors: packJson({ monitors: uplink.monitors, alerting_monitors: uplink.alertingMonitors }),
      });
    }

    const diagnostics =
      body.diagnostics && typeof body.diagnostics === "object" ? body.diagnostics : null;
    this.upsertLatestSync(
      now,
      packJson({ ts: int(body.ts), wan, devices, clients, config: keptConfig, diagnostics })
    );

    if (heavy) {
      for (const d of devices) {
        if (!d || typeof d !== "object") continue;
        const dev = d as Record<string, unknown>;
        const id = str(dev["id"]) ?? str(dev["mac"]) ?? str(dev["name"]);
        if (!id) continue;

        this.insertDeviceSampleSync({
          received_at: now,
          device_id: id,
          name: str(dev["name"]) ?? str(dev["model"]),
          rx_bps: num(dev["rx_bps"]),
          tx_bps: num(dev["tx_bps"]),
          poe_power: num(dev["poe_power"]),
          online: dev["online"] === true ? 1 : 0,
          uptime: int(dev["uptime"]),
          cpu: num(dev["cpu"]),
          mem: num(dev["mem"]),
          temperature: num(dev["temperature"]),
        });

        for (const port of Array.isArray(dev["ports"]) ? (dev["ports"] as unknown[]) : []) {
          if (!port || typeof port !== "object") continue;
          const p = port as Record<string, unknown>;
          const portIdx = int(p["idx"]);
          if (portIdx == null) continue;

          const state = {
            port_name: str(p["name"]),
            connected: str(p["connected"]),
            up: p["up"] == null ? null : (p["up"] ? 1 : 0),
            speed: int(p["speed"]),
            max_speed: int(p["max_speed"]),
            full_duplex: boolInt(p["full_duplex"]),
            poe_enabled: boolInt(p["poe_enabled"]),
            poe_active: boolInt(p["poe_active"]),
            poe_power: num(p["poe_power"]),
            rx_errors: int(p["rx_errors"]),
            tx_errors: int(p["tx_errors"]),
            rx_dropped: int(p["rx_dropped"]),
            tx_dropped: int(p["tx_dropped"]),
            stp_state: str(p["stp_state"]),
          };
          const fingerprint = portStateFingerprint(state as Parameters<typeof portStateFingerprint>[0]);
          const previous = this.getLatestPortSampleSync(id, portIdx);
          if (shouldRecordPortSample(previous, fingerprint, now, PORT_HEARTBEAT_INTERVAL)) {
            this.insertPortSampleSync({
              received_at: now,
              device_id: id,
              device_name: str(dev["name"]) ?? str(dev["model"]),
              port_idx: portIdx,
              ...state,
              fingerprint,
            });
          }
        }
      }

      for (const c of clients) {
        if (!c || typeof c !== "object") continue;
        const client = c as Record<string, unknown>;
        const id = str(client["id"]) ?? str(client["mac"]);
        if (!id) continue;
        this.insertClientSampleSync({
          received_at: now,
          client_id: id,
          name: str(client["name"]) ?? str(client["hostname"]) ?? str(client["mac"]),
          rx_bps: num(client["rx_bps"]),
          tx_bps: num(client["tx_bps"]),
        });
      }
    }

    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const event = e as Record<string, unknown>;
      const upstream = str(event["id"]) ?? str(event["_id"]);
      if (!upstream) continue;
      this.upsertEventSync({
        upstream_id: upstream,
        event_ts: int(event["ts"]) ?? now,
        received_at: now,
        is_alarm: event["is_alarm"] ? 1 : 0,
        key: str(event["key"]),
        subsystem: str(event["subsystem"]),
        message: str(event["message"]) ?? str(event["msg"]),
        raw: JSON.stringify(e),
      });
    }

    if (heavy) {
      this.run("DELETE FROM unifi_readings WHERE received_at < ?", now - INGEST_RETENTION.readings);
      this.run("DELETE FROM unifi_wan_samples WHERE received_at < ?", now - INGEST_RETENTION.wan_samples);
      this.run("DELETE FROM unifi_device_samples WHERE received_at < ?", now - INGEST_RETENTION.device_samples);
      this.run("DELETE FROM unifi_port_samples WHERE received_at < ?", now - INGEST_RETENTION.port_samples);
      this.run("DELETE FROM unifi_client_samples WHERE received_at < ?", now - INGEST_RETENTION.client_samples);
      this.run("DELETE FROM unifi_events WHERE received_at < ?", now - INGEST_RETENTION.events);
    }

    return { duplicate: false, receivedAt: now };
  }

  // ── Traffic-route drift (transactional) ───────────────────────────────────

  /**
   * Synchronous drift port handed to the pure drift module. Kept private so the
   * twelve statement-level members never appear on the repository's public
   * contract, where a caller could run them outside a transaction.
   */
  private get driftPort(): RouteDriftDb {
    return {
      getMeta: () => this.getMeta(),
      insertMeta: (establishedAt, lastObservedAt) => this.insertMeta(establishedAt, lastObservedAt),
      updateLastObserved: (observedAt) => this.updateLastObserved(observedAt),
      listBaseline: () => this.listBaseline(),
      insertBaseline: (routeId, routeName, returnedIndex, fingerprint, payload, establishedAt) =>
        this.insertBaseline(routeId, routeName, returnedIndex, fingerprint, payload, establishedAt),
      listActive: () => this.listActive(),
      upsertActive: (drift, now) => this.upsertActive(drift, now),
      insertHistory: (drift, now) => this.insertHistory(drift, now),
      updateOpenHistory: (drift, now) => this.updateOpenHistory(drift, now),
      resolveHistory: (driftKey, now) => this.resolveHistory(driftKey, now),
      deleteActive: (driftKey) => this.deleteActive(driftKey),
      listDrift: () => this.listDrift()
    };
  }

  public async syncTrafficRouteBaseline(
    config: unknown,
    observedAt = Date.now()
  ): Promise<SyncTrafficRouteResult> {
    return this.transaction(() => syncTrafficRouteBaselineImpl(this.driftPort, config, observedAt));
  }

  public async activeTrafficRouteDriftEvents(): Promise<ActiveDriftEvent[]> {
    return activeTrafficRouteDriftEventsImpl(this.driftPort);
  }

  public async trafficRouteDriftStatus(): Promise<RouteDriftStatus> {
    return trafficRouteDriftStatusImpl(this.driftPort);
  }

  // ── unifi_latest ─────────────────────────────────────────────────────────

  public async getLatest(): Promise<UnifiLatestRow | undefined> {
    return this.getLatestSync();
  }

  private getLatestSync(): UnifiLatestRow | undefined {
    return this.get<UnifiLatestRow>("SELECT id, received_at, payload FROM unifi_latest WHERE id = 1");
  }

  public async protectNvrIdentity(): Promise<{ host: string | null; name: string | null }> {
    const row = this.get<{ payload: unknown }>("SELECT payload FROM protect_latest WHERE id = 1");
    const nvr = row ? unpackJson<Record<string, unknown>>(row.payload)?.["nvr"] : null;
    const record = typeof nvr === "object" && nvr !== null ? (nvr as Record<string, unknown>) : {};
    return {
      host: typeof record["host"] === "string" ? record["host"] : null,
      name: typeof record["name"] === "string" ? record["name"] : null
    };
  }

  public async getLatestPayload(): Promise<UnifiLatestRow | undefined> {
    return this.get<UnifiLatestRow>("SELECT * FROM unifi_latest WHERE id = 1");
  }

  private upsertLatestSync(receivedAt: number, payload: Buffer): void {
    this.run(
      `INSERT INTO unifi_latest (id, received_at, payload) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`,
      receivedAt, payload
    );
  }

  // ── unifi_readings ────────────────────────────────────────────────────────

  private insertReadingSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_readings
        (received_at, device_ts, wan_status, wan_latency_ms, wan_uptime,
         wan_rx_bps, wan_tx_bps, internet_reachable, active_wan, active_wan_name,
         num_clients, num_devices, devices_online, raw)
       VALUES
        (@received_at, @device_ts, @wan_status, @wan_latency_ms, @wan_uptime,
         @wan_rx_bps, @wan_tx_bps, @internet_reachable, @active_wan, @active_wan_name,
         @num_clients, @num_devices, @devices_online, @raw)`,
      params
    );
  }

  public async queryReadings(cutoff: number): Promise<UnifiReadingRow[]> {
    return this.all<UnifiReadingRow>(
      `SELECT received_at, wan_rx_bps, wan_tx_bps, wan_latency_ms,
              internet_reachable, active_wan, active_wan_name,
              num_clients, devices_online
         FROM unifi_readings
        WHERE received_at >= ?
        ORDER BY received_at ASC LIMIT 3000`,
      cutoff
    );
  }

  // ── unifi_wan_samples ─────────────────────────────────────────────────────

  private insertWanSampleSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_wan_samples (
         received_at, device_ts, wan_key, name, primary_uplink, active,
         internet_reachable, latency_ms, availability, uptime_seconds,
         downtime_seconds, time_period_seconds, monitors
       ) VALUES (
         @received_at, @device_ts, @wan_key, @name, @primary_uplink, @active,
         @internet_reachable, @latency_ms, @availability, @uptime_seconds,
         @downtime_seconds, @time_period_seconds, @monitors
       )`,
      params
    );
  }

  public async queryWanHistory(cutoff: number, wanKey: string | null, limit: number): Promise<UnifiWanSampleRow[]> {
    const where = ["received_at >= ?"];
    const params: SqlValue[] = [cutoff];
    if (wanKey) {
      where.push("wan_key = ?");
      params.push(wanKey);
    }
    params.push(limit);
    return this.all<UnifiWanSampleRow>(
      `SELECT * FROM (
         SELECT * FROM unifi_wan_samples
          WHERE ${where.join(" AND ")}
          ORDER BY received_at DESC LIMIT ?
       ) ORDER BY received_at ASC`,
      ...params
    ).map((row) => ({ ...row, monitors: unpackJson(row.monitors) })) as unknown as UnifiWanSampleRow[];
  }

  // ── unifi_device_samples ──────────────────────────────────────────────────

  private insertDeviceSampleSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_device_samples (
         received_at, device_id, name, rx_bps, tx_bps, poe_power,
         online, uptime, cpu, mem, temperature
       ) VALUES (
         @received_at, @device_id, @name, @rx_bps, @tx_bps, @poe_power,
         @online, @uptime, @cpu, @mem, @temperature
       )`,
      params
    );
  }

  public async queryDeviceSamples(deviceId: string, cutoff: number): Promise<unknown[]> {
    return this.all(
      `SELECT received_at, rx_bps, tx_bps, poe_power, online, uptime, cpu, mem, temperature
         FROM unifi_device_samples
        WHERE device_id = ? AND received_at >= ?
        ORDER BY received_at ASC LIMIT 3000`,
      deviceId, cutoff
    );
  }

  // ── unifi_port_samples ────────────────────────────────────────────────────

  private getLatestPortSampleSync(deviceId: string, portIdx: number): { received_at: number; fingerprint: string } | undefined {
    return this.get<{ received_at: number; fingerprint: string }>(
      `SELECT received_at, fingerprint FROM unifi_port_samples
        WHERE device_id = ? AND port_idx = ?
        ORDER BY received_at DESC LIMIT 1`,
      deviceId, portIdx
    );
  }

  private insertPortSampleSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_port_samples (
         received_at, device_id, device_name, port_idx, port_name, connected,
         up, speed, max_speed, full_duplex, poe_enabled, poe_active, poe_power,
         rx_errors, tx_errors, rx_dropped, tx_dropped, stp_state, fingerprint
       ) VALUES (
         @received_at, @device_id, @device_name, @port_idx, @port_name, @connected,
         @up, @speed, @max_speed, @full_duplex, @poe_enabled, @poe_active, @poe_power,
         @rx_errors, @tx_errors, @rx_dropped, @tx_dropped, @stp_state, @fingerprint
       )`,
      params
    );
  }

  public async queryPortHistory(cutoff: number, deviceId: string | null, portIdx: number | null, limit: number): Promise<unknown[]> {
    const where = ["received_at >= ?"];
    const params: SqlValue[] = [cutoff];
    if (deviceId) {
      where.push("device_id = ?");
      params.push(deviceId);
    }
    if (portIdx != null) {
      where.push("port_idx = ?");
      params.push(portIdx);
    }
    params.push(limit);
    return this.all(
      `SELECT * FROM (
         SELECT * FROM unifi_port_samples
          WHERE ${where.join(" AND ")}
          ORDER BY received_at DESC LIMIT ?
       ) ORDER BY received_at ASC`,
      ...params
    );
  }

  // ── unifi_client_samples ──────────────────────────────────────────────────

  private insertClientSampleSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_client_samples (received_at, client_id, name, rx_bps, tx_bps)
       VALUES (@received_at, @client_id, @name, @rx_bps, @tx_bps)`,
      params
    );
  }

  public async queryClientSamples(clientId: string, cutoff: number): Promise<unknown[]> {
    return this.all(
      `SELECT received_at, rx_bps, tx_bps
         FROM unifi_client_samples
        WHERE client_id = ? AND received_at >= ?
        ORDER BY received_at ASC LIMIT 3000`,
      clientId, cutoff
    );
  }

  // ── unifi_events ──────────────────────────────────────────────────────────

  private upsertEventSync(params: Readonly<Record<string, SqlValue>>): void {
    this.runNamed(
      `INSERT INTO unifi_events (upstream_id, event_ts, received_at, is_alarm, key, subsystem, message, raw)
       VALUES (@upstream_id, @event_ts, @received_at, @is_alarm, @key, @subsystem, @message, @raw)
       ON CONFLICT(upstream_id) DO NOTHING`,
      params
    );
  }

  public async queryEvents(cutoff: number, limit: number): Promise<UnifiEventRow[]> {
    return this.all<UnifiEventRow>(
      `SELECT * FROM (
         SELECT
           id, upstream_id, event_ts,
           CASE WHEN UPPER(COALESCE(severity, '')) IN ('HIGH', 'VERY_HIGH', 'CRITICAL') THEN 1 ELSE 0 END AS is_alarm,
           COALESCE(event_type, title) AS key,
           category AS subsystem,
           COALESCE(message, title) AS message,
           title, severity,
           'activity' AS source
         FROM unifi_activity_logs WHERE event_ts >= ?
         UNION ALL
         SELECT
           id, upstream_id, event_ts, is_alarm, key, subsystem, message,
           NULL AS title, NULL AS severity, 'legacy' AS source
         FROM unifi_events WHERE event_ts >= ?
       )
       ORDER BY event_ts DESC LIMIT ?`,
      cutoff, cutoff, limit
    );
  }

  public async getActivityCompatRow(): Promise<UnifiCompatRow> {
    return (
      this.get<UnifiCompatRow>(
        `SELECT status, page_base, evidence, negotiated_at, held, updated_at
           FROM unifi_collection_compat WHERE stream = 'activity'`
      ) ?? {
        status: "unverified",
        page_base: null,
        evidence: "No modern activity compatibility report has reached Hearth yet",
        negotiated_at: null,
        held: 0,
        updated_at: null,
      }
    );
  }

  // ── RouteDriftDb ──────────────────────────────────────────────────────────

  private getMeta(): RouteDriftMeta | undefined {
    return this.get<RouteDriftMeta>(
      "SELECT established_at, last_observed_at FROM unifi_route_baseline_meta WHERE id = 1"
    );
  }

  private insertMeta(establishedAt: number, lastObservedAt: number): void {
    this.run(
      `INSERT INTO unifi_route_baseline_meta (id, established_at, last_observed_at) VALUES (1, ?, ?)`,
      establishedAt, lastObservedAt
    );
  }

  private updateLastObserved(observedAt: number): void {
    this.run(
      `UPDATE unifi_route_baseline_meta
          SET last_observed_at = MAX(COALESCE(last_observed_at, 0), ?)
        WHERE id = 1`,
      observedAt
    );
  }

  private listBaseline(): RouteDriftBaselineRow[] {
    return this.all<RouteDriftBaselineRow>(
      "SELECT route_id, route_name, returned_index, fingerprint, payload FROM unifi_route_baseline"
    );
  }

  private insertBaseline(
    routeId: string,
    routeName: string | null,
    returnedIndex: number,
    fingerprint: string,
    payload: Buffer,
    establishedAt: number
  ): void {
    this.run(
      `INSERT INTO unifi_route_baseline (route_id, route_name, returned_index, fingerprint, payload, established_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      routeId, routeName, returnedIndex, fingerprint, payload, establishedAt
    );
  }

  private listActive(): ActiveDriftKeyRow[] {
    return this.all<ActiveDriftKeyRow>("SELECT drift_key FROM unifi_route_drift");
  }

  private upsertActive(drift: ActiveDriftEntry, now: number): void {
    this.runNamed(
      `INSERT INTO unifi_route_drift (
         drift_key, route_id, route_name, drift_type, detail,
         first_seen_at, last_seen_at, baseline, current
       ) VALUES (
         @drift_key, @route_id, @route_name, @drift_type, @detail,
         @now, @now, @baseline, @current
       )
       ON CONFLICT(drift_key) DO UPDATE SET
         route_id = excluded.route_id,
         route_name = excluded.route_name,
         drift_type = excluded.drift_type,
         detail = excluded.detail,
         last_seen_at = excluded.last_seen_at,
         baseline = excluded.baseline,
         current = excluded.current`,
      { ...drift, now }
    );
  }

  private insertHistory(drift: ActiveDriftEntry, now: number): void {
    this.runNamed(
      `INSERT OR IGNORE INTO unifi_route_drift_history (
         drift_key, route_id, route_name, drift_type, detail,
         detected_at, last_seen_at, baseline, current
       ) VALUES (
         @drift_key, @route_id, @route_name, @drift_type, @detail,
         @now, @now, @baseline, @current
       )`,
      { ...drift, now }
    );
  }

  private updateOpenHistory(drift: ActiveDriftEntry, now: number): void {
    this.runNamed(
      `UPDATE unifi_route_drift_history
          SET last_seen_at = @now,
              detail = @detail,
              baseline = @baseline,
              current = @current
        WHERE drift_key = @drift_key AND resolved_at IS NULL`,
      { ...drift, now }
    );
  }

  private resolveHistory(driftKey: string, now: number): void {
    this.run(
      `UPDATE unifi_route_drift_history
          SET resolved_at = ?, last_seen_at = ?
        WHERE drift_key = ? AND resolved_at IS NULL`,
      now, now, driftKey
    );
  }

  private deleteActive(driftKey: string): void {
    this.run("DELETE FROM unifi_route_drift WHERE drift_key = ?", driftKey);
  }

  private listDrift(): RouteDriftHistoryRow[] {
    return this.all<RouteDriftHistoryRow>(
      `SELECT drift_key, route_id, route_name, drift_type, detail, first_seen_at, last_seen_at
         FROM unifi_route_drift
        ORDER BY first_seen_at DESC`
    );
  }

  // ── OutageIncidentsRepository ─────────────────────────────────────────────

  public async outageRecoveryHoldMs(): Promise<number> {
    const raw = Number(process.env["OUTAGE_RECOVERY_HOLD_SECONDS"]);
    const seconds = Number.isFinite(raw) && raw >= 60 && raw <= 3600 ? raw : 7 * 60;
    return seconds * 1000;
  }

  public async listOutageIncidents(limit = 25): Promise<OutageIncident[]> {
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const now = Date.now();
    const rows = this.all<Record<string, unknown>>(
      `SELECT i.*, p.id AS report_id, p.executive_summary
         FROM outage_incidents i
         LEFT JOIN outage_postmortems p ON p.incident_id = i.id
        ORDER BY i.started_at DESC LIMIT ?`,
      safeLimit
    );
    return rows.map((row) => deserializeIncident(row, now));
  }

  public async getOutageIncident(id: string): Promise<OutageIncident | null> {
    const now = Date.now();
    const row = this.get<Record<string, unknown>>(
      `SELECT i.*, p.id AS report_id, p.executive_summary, p.report
         FROM outage_incidents i
         LEFT JOIN outage_postmortems p ON p.incident_id = i.id
        WHERE i.id = ?`,
      id
    );
    if (!row) return null;
    const evidence = this.all<Record<string, unknown>>(
      `SELECT evidence_key, source, signal, state, occurred_at,
              received_at, confidence, summary, detail
         FROM outage_incident_evidence
        WHERE incident_id = ?
        ORDER BY occurred_at, id`,
      id
    );
    return {
      ...deserializeIncident(row, now),
      evidence: evidence.map((item) => ({
        evidenceKey: asText(item.evidence_key),
        source: asText(item.source),
        signal: asText(item.signal),
        state: asText(item.state),
        occurredAt: Number(item.occurred_at),
        receivedAt: Number(item.received_at),
        confidence: Number(item.confidence),
        summary: item.summary != null ? asText(item.summary) : null,
        detail: item.detail != null ? asText(item.detail) : null,
      })),
    };
  }
}

function parseClassifications(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map((entry) => asText(entry)) : [];
  } catch {
    return [];
  }
}

function deserializeIncident(row: Record<string, unknown>, now: number): OutageIncident {
  const report =
    row.status === "finalized" && row.report
      ? (unpackJson(row.report))
      : null;
  const finalizeAfter = row.finalize_after != null ? Number(row.finalize_after) : null;
  return {
    id: asText(row.id),
    scope: asText(row.scope),
    status: asText(row.status),
    classification: row.classification != null ? asText(row.classification) : null,
    confidence: row.confidence != null ? Number(row.confidence) : null,
    startedAt: Number(row.started_at),
    lastEvidenceAt: Number(row.last_evidence_at),
    recoveredAt: row.recovered_at != null ? Number(row.recovered_at) : null,
    finalizeAfter,
    finalizedAt: row.finalized_at != null ? Number(row.finalized_at) : null,
    recoveryReason: row.recovery_reason != null ? asText(row.recovery_reason) : null,
    classifications: parseClassifications(row.classifications),
    pendingSeconds:
      row.status === "recovery_pending" && finalizeAfter != null
        ? Math.max(0, Math.ceil((finalizeAfter - now) / 1000))
        : null,
    reportId: row.status === "finalized" ? (row.report_id ? asText(row.report_id) : null) : null,
    executiveSummary:
      row.status === "finalized"
        ? row.executive_summary
          ? asText(row.executive_summary)
          : null
        : null,
    report,
  };
}

export type { RouteDriftDb };
