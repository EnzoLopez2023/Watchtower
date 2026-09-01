import type { MediaHealthClient, MediaHealthV1 } from "../../server/clients/marqueeMediaHealth.js";
import { MediaHealthClientError } from "../../server/clients/marqueeMediaHealth.js";
import type { InfraStatusRepository } from "../db/repositories/watchtower/infraStatusRepository.js";
import { AGENT_FRESHNESS, freshnessFields, type AgentSource } from "./agentFreshness.js";
import { safeParse, unpackJson } from "./payloadCodec.js";
import { asText } from "./values.js";
import type { ActiveDriftEvent } from "./unifiRouteDrift.js";
import { wanUplinks, type WanUplink } from "./unifiTelemetry.js";

// ── Frozen mobile contract ───────────────────────────────────────────────────
// These types are the wire shape of GET /api/mobile/dashboard and GET /api/status.
// The iOS app decodes them directly, so fields may be added but never renamed,
// retyped, or removed.

export type Severity = "ok" | "stale" | "warn" | "critical";

export interface OfflineEntry {
  readonly name: string | null;
  readonly model: string | null;
  readonly ip: string | null;
  readonly mac: string | null;
}

export interface CellularUsage {
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly totalBytes: number;
  readonly carrier: string | null;
  readonly limited: boolean;
  readonly warning: boolean;
  readonly device: string | null;
}

export interface UPSUnit {
  readonly ups_id: string;
  readonly label: string;
  readonly severity: Severity;
  readonly headline: string;
  readonly detail: string | null;
  readonly ts: number | null;
  readonly lastContactAt: number | null;
  readonly expectedCadenceSeconds: number;
  readonly staleAfterSeconds: number;
  readonly onBattery: boolean;
  readonly lowBattery: boolean;
  readonly charge: number | null;
  readonly runtimeSeconds: number | null;
  readonly runtimeMinutes: number | null;
  readonly voltage: number | null;
  readonly load: number | null;
  readonly onBatterySince: number | null;
  readonly unreachable: boolean;
  readonly readError: string | null;
}

export interface AgentUnit {
  readonly id: string;
  readonly label: string;
  readonly severity: Severity;
  readonly headline: string;
  readonly detail: string;
  readonly ts: number | null;
  readonly lastContactAt: number | null;
  readonly expectedCadenceSeconds: number;
  readonly staleAfterSeconds: number;
}

export interface NotificationPolicy {
  readonly kind: "consecutive-samples";
  readonly sampleKey: string;
  readonly generationKey: string;
  readonly signature: string;
  readonly failureSamples: number;
  readonly recoverySamples: number;
  readonly confirmable?: boolean;
}

export interface Subsystem {
  readonly key: string;
  readonly label: string;
  readonly severity: Severity;
  readonly headline: string;
  readonly detail: string | null;
  readonly ts: number | null;
  readonly lastContactAt?: number | null;
  readonly expectedCadenceSeconds?: number;
  readonly staleAfterSeconds?: number;
  readonly escalation?: number;
  readonly informational?: boolean;
  readonly units?: readonly UPSUnit[];
  readonly agents?: readonly AgentUnit[];
  readonly uplinks?: readonly WanUplink[];
  readonly cellular?: CellularUsage | null;
  readonly offline?: readonly OfflineEntry[];
  readonly probes?: readonly unknown[];
  readonly oldestContactAt?: number | null;
  readonly newestContactAt?: number | null;
  readonly notificationPolicy?: NotificationPolicy;
  readonly media?: MediaHealthSummary;
}

export interface MediaHealthSummary {
  readonly source: "marquee";
  readonly overall: "healthy" | "degraded" | "unavailable" | "unreachable";
  readonly generatedAt: string | null;
  readonly plexConfigured: boolean;
  readonly tautulliConfigured: boolean;
  readonly sonarrPresent: boolean;
  readonly error: string | null;
}

export interface InfraEvent {
  readonly id: string;
  readonly critical: boolean;
  readonly title: string;
  readonly body: string;
}

export interface DashboardPayload {
  readonly schema: number;
  readonly generatedAt: number;
  readonly overall: {
    readonly severity: Severity;
    readonly issueCount: number;
    readonly summary: string;
  };
  readonly subsystems: readonly Subsystem[];
  readonly events: readonly InfraEvent[];
}

// ── Derivation ───────────────────────────────────────────────────────────────

// Severity ladder. `stale` sits below `warn`: not-hearing-from-something is less
// urgent than hearing that something is wrong, but still not "ok".
const RANK: Readonly<Record<Severity, number>> = { ok: 0, stale: 1, warn: 2, critical: 3 };

export const NETWORK_OBSERVER_ALERT_DEFAULT_SAMPLES = 3;
const NETWORK_OBSERVER_ALERT_MAX_SAMPLES = 10;
const AGENT_ALERT_CONFIRMATION_SAMPLES = 3;

const worst = (...severities: readonly Severity[]): Severity =>
  severities.reduce<Severity>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

const STALE = {
  unifi: AGENT_FRESHNESS.unifi.staleAfterMs,
  protect: AGENT_FRESHNESS.protect.staleAfterMs,
  ups: AGENT_FRESHNESS.ups.staleAfterMs,
  synology: AGENT_FRESHNESS.synology.staleAfterMs
};

const UPS_ERROR_WINDOW_MS = 30 * 60 * 1000;
const UPS_UNREACHABLE_CRITICAL_MS = 15 * 60 * 1000;
const BLACKOUT_MS = 10 * 60 * 1000;
const FAILOVER_BANDS = [5, 15, 30, 60, 120, 240];
const RUNTIME_BANDS = [2, 5, 10, 15, 20];
const LOW_BATTERY_BAND = RUNTIME_BANDS.length + 1;
const OFFLINE_NAMED = 3;
const OFFLINE_LISTED = 12;
const NAS_SHUTDOWN_WARN_SECONDS = 90;
const PRIMARY_PF_INTERFACE = "wan";

export interface ObserverAlertSamples {
  readonly failure: number;
  readonly recovery: number;
}

export interface InfraStatusDependencies {
  readonly repository: InfraStatusRepository;
  /**
   * Async read of the currently open traffic-route drift, supplied by the UniFi
   * adapter. Declared structurally so this module never sees a concrete adapter.
   */
  readonly routeDrift: { activeTrafficRouteDriftEvents(): Promise<readonly ActiveDriftEvent[]> };
  readonly mediaHealth: MediaHealthClient;
  readonly observerAlertSamples?: ObserverAlertSamples;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const statusTokens = (value: unknown): string[] =>
  asText(value)
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const round = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.round(value);

function failoverBand(minutes: number | null): number {
  if (minutes === null) return 1;
  return 1 + FAILOVER_BANDS.filter((band) => minutes >= band).length;
}

function runtimeBand(seconds: number | null): number {
  if (seconds === null) return 0;
  const minutes = seconds / 60;
  for (let index = 0; index < RUNTIME_BANDS.length; index += 1) {
    const band = RUNTIME_BANDS[index];
    if (band !== undefined && minutes <= band) return RUNTIME_BANDS.length - index;
  }
  return 0;
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const bytesLabel = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

function offlineSummary(names: readonly string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} offline`;
  const shown = names.slice(0, OFFLINE_NAMED);
  const rest = names.length - shown.length;
  return `${names.length} offline: ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

/**
 * Cellular data from the modem's own SIM counters, which reset on the carrier
 * billing cycle. The gateway's GRE tunnel counters start when the tunnel comes
 * up — often days before any traffic — so they are not per-incident.
 */
function cellularUsage(payload: Record<string, unknown>): CellularUsage | null {
  for (const entry of array(payload.devices)) {
    const device = record(entry);
    const mbb = record(record(device.raw).legacy).mbb;
    const sims = array(record(mbb).sim).map(record);
    const sim = sims.find((candidate) => candidate.active) ?? sims[0];
    if (!sim) continue;
    const rx = Number(sim.rxbytes);
    const tx = Number(sim.txbytes);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    return {
      rxBytes: rx,
      txBytes: tx,
      totalBytes: rx + tx,
      carrier: typeof sim.spn === "string" ? sim.spn : null,
      limited: sim.data_limited === true,
      warning: sim.data_warning === true,
      device:
        typeof device.name === "string"
          ? device.name
          : typeof device.model === "string"
            ? device.model
            : null
    };
  }
  return null;
}

async function internetStatus(repository: InfraStatusRepository, now: number): Promise<Subsystem> {
  const row = await repository.unifiLatest();
  if (!row) {
    return {
      key: "internet",
      label: "Internet",
      severity: "stale",
      headline: "No data",
      detail: "UniFi agent has never reported",
      ts: null,
      escalation: 0,
      uplinks: [],
      ...freshnessFields("unifi", null)
    };
  }

  const payload = record(unpackJson(row.payload));
  const wan = record(payload.wan);
  const health = isRecord(wan._health) ? wan._health : null;
  const age = now - row.received_at;
  const stale = age > STALE.unifi;
  const blackout = age > BLACKOUT_MS;

  const uplinks = wanUplinks(payload);
  const active = uplinks.find((uplink) => uplink.active) ?? null;
  const onBackup = active !== null && !active.primary;
  const down = uplinks.filter((uplink) => !uplink.active && uplink.downtimeSeconds !== null);

  // `_health.wan` reports GATEWAY ADOPTION, which reads ok while the internet is
  // down; `_health.www` is the actual internet verdict. Legacy payloads written
  // before `_health` existed only carry `wan.status`.
  let reachable: boolean | null = null;
  if (health) {
    const status = asText(record(health.www).status).toLowerCase();
    if (status) reachable = status === "ok";
  } else {
    const status = wan.status ?? null;
    if (status === "up") reachable = true;
    else if (status === "down") reachable = false;
  }

  const latency = round(
    active?.latencyMs ?? (typeof wan.latency_ms === "number" ? wan.latency_ms : null)
  );
  const onBackupMs = onBackup && active.uptimeSeconds !== null ? active.uptimeSeconds * 1000 : null;
  const cellular = cellularUsage(payload);

  let severity: Severity;
  let headline: string;
  let detail: string | null;
  if (blackout) {
    severity = "critical";
    headline = "No contact";
    detail = `Nothing from the UniFi agent for ${duration(age)} — the site is probably entirely offline`;
  } else if (stale) {
    severity = "stale";
    headline = "Stale";
    detail = "Agent not reporting";
  } else if (reachable === false) {
    severity = "critical";
    headline = "Offline";
    detail = down.length
      ? `${down.map((uplink) => uplink.name).join(", ")} down`
      : "No internet on any uplink";
  } else if (onBackup && active) {
    severity = "warn";
    headline = `Backup uplink: ${active.name}`;
    detail = [
      onBackupMs === null || onBackupMs < 60000
        ? "just failed over"
        : `${duration(onBackupMs)} on backup`,
      cellular ? `${bytesLabel(cellular.totalBytes)} cell data this cycle` : null,
      down.length
        ? `${down.filter((uplink) => uplink.primary).map((uplink) => uplink.name).join(", ") || "primary"} down`
        : null,
      latency !== null ? `${latency} ms` : null
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (reachable === true) {
    severity = "ok";
    headline = active ? `Online via ${active.name}` : "Online";
    detail = latency !== null ? `${latency} ms latency` : null;
  } else {
    severity = "warn";
    headline = "Unknown";
    detail = null;
  }

  return {
    key: "internet",
    label: "Internet",
    severity,
    headline,
    detail,
    ts: row.received_at,
    ...freshnessFields("unifi", row.received_at),
    escalation: onBackup ? failoverBand(onBackupMs !== null ? onBackupMs / 60000 : null) : 0,
    uplinks,
    cellular
  };
}

async function devicesStatus(repository: InfraStatusRepository, now: number): Promise<Subsystem> {
  const row = await repository.unifiLatest();
  if (!row) {
    return {
      key: "devices",
      label: "Network Devices",
      severity: "stale",
      headline: "No data",
      detail: null,
      ts: null,
      ...freshnessFields("unifi", null)
    };
  }

  const payload = record(unpackJson(row.payload));
  const devices = array(payload.devices).map(record);
  const total = devices.length;
  const offlineDevices = devices.filter((device) => !device.online);
  const online = total - offlineDevices.length;
  const stale = now - row.received_at > STALE.unifi;

  let severity: Severity = "ok";
  if (stale) severity = "stale";
  else if (offlineDevices.length > 0) severity = "warn";

  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    key: "devices",
    label: "Network Devices",
    severity,
    headline: total ? `${online}/${total} online` : "No devices",
    detail: stale
      ? "Agent not reporting"
      : offlineDevices.length > 0
        ? offlineSummary(
            offlineDevices.map(
              (device) =>
                text(device.name) ?? text(device.model) ?? text(device.mac) ?? "unknown"
            )
          )
        : "All devices up",
    ts: row.received_at,
    ...freshnessFields("unifi", row.received_at),
    escalation: offlineDevices.length,
    offline: offlineDevices.slice(0, OFFLINE_LISTED).map((device) => ({
      name: text(device.name) ?? text(device.model),
      model: text(device.model),
      ip: text(device.ip),
      mac: text(device.mac)
    }))
  };
}

interface UpsReadError {
  readonly error: string;
  readonly at: number;
}

/**
 * Read failures the agent reported on whichever unit managed to push. `errors`
 * flickers empty between cycles because the agent polls units in parallel and
 * mutates one shared object, so scan a window and keep the newest error per unit.
 */
async function upsReadErrors(repository: InfraStatusRepository, now: number) {
  const rows = await repository.upsDiagnostics(now - UPS_ERROR_WINDOW_MS, 40);
  const errors = new Map<string, UpsReadError>();
  const known = new Map<string, { label: string; host: string | null }>();
  for (const row of rows) {
    const diagnostic = safeParse<Record<string, unknown>>(row.agent_diag);
    if (!diagnostic) continue;
    for (const entry of array(diagnostic.units)) {
      const unit = record(entry);
      const id = typeof unit.id === "string" ? unit.id : null;
      if (id && !known.has(id)) {
        known.set(id, {
          label: typeof unit.label === "string" ? unit.label : id,
          host: typeof unit.host === "string" ? unit.host : null
        });
      }
    }
    for (const [id, value] of Object.entries(record(diagnostic.errors))) {
      const entry = record(value);
      const at = Number(entry.at) || null;
      if (!at) continue;
      const previous = errors.get(id);
      if (!previous || at > previous.at) {
        errors.set(id, { error: asText(entry.error, "unreadable"), at });
      }
    }
  }
  return { errors, known };
}

async function upsStatus(repository: InfraStatusRepository, now: number): Promise<Subsystem> {
  const rows = await repository.latestUpsReadings();
  if (!rows.length) {
    return {
      key: "ups",
      label: "UPS Power",
      severity: "stale",
      headline: "No data",
      detail: null,
      ts: null,
      units: [],
      escalation: 0,
      ...freshnessFields("ups", null)
    };
  }

  const { errors: readErrors, known: knownUnits } = await upsReadErrors(repository, now);

  const units: UPSUnit[] = (
    await Promise.all(
      rows.map(async (row) => {
      const stale = now - row.received_at > STALE.ups;
      const tokens = statusTokens(row.ups_status);
      const onBattery = tokens.includes("OB");
      const lowBattery = tokens.includes("LB");
      const charge = round(row.battery_charge);

      // Only an error newer than this unit's last good read means contact is
      // currently lost; an older one describes an outage it recovered from.
      const readError = row.ups_id === null ? undefined : readErrors.get(row.ups_id);
      const unreachable = readError !== undefined && readError.at > row.received_at;
      const unreachableForMs = unreachable ? now - row.received_at : null;

      let severity: Severity;
      let headline: string;
      if (lowBattery) {
        severity = "critical";
        headline = unreachable ? "Low Battery — contact lost" : "Low Battery";
      } else if (onBattery) {
        severity = "critical";
        headline = unreachable ? "On Battery — contact lost" : "On Battery";
      } else if (unreachable) {
        severity = (unreachableForMs ?? 0) > UPS_UNREACHABLE_CRITICAL_MS ? "critical" : "warn";
        headline = "Unreachable";
      } else if (stale) {
        severity = "stale";
        headline = "Stale";
      } else {
        severity = "ok";
        headline = "Online";
      }

      const runtimeMinutes =
        row.battery_runtime !== null ? Math.round(row.battery_runtime / 60) : null;
      const bits: string[] = [];
      if (unreachable) {
        bits.push(`no contact for ${Math.max(1, Math.round((unreachableForMs ?? 0) / 60000))} min`);
      }
      if (charge !== null) bits.push(`${charge}% battery${unreachable ? " when last seen" : ""}`);
      if (onBattery && runtimeMinutes !== null) bits.push(`${runtimeMinutes} min runtime`);
      if (stale && !unreachable) bits.push("stale");
      if (unreachable && readError) bits.push(readError.error);

      return {
        ups_id: row.ups_id ?? "tower",
        label: row.ups_label ?? row.ups_id ?? "UPS",
        severity,
        headline,
        detail: bits.join(" · ") || null,
        ts: row.received_at,
        ...freshnessFields("ups", row.received_at),
        onBattery,
        lowBattery,
        charge,
        runtimeSeconds: row.battery_runtime ?? null,
        runtimeMinutes,
        voltage: row.battery_voltage ?? null,
        load: round(row.ups_load),
        onBatterySince: onBattery ? await repository.onBatterySince(row.ups_id) : null,
        unreachable,
        readError: unreachable && readError ? readError.error : null
        } satisfies UPSUnit;
      })
    )
  ).sort((a, b) => a.label.localeCompare(b.label));

  // A unit the agent knows about but that has never produced a reading has no
  // row to hang a severity on, so it would be indistinguishable from absent.
  const seen = new Set(units.map((unit) => unit.ups_id));
  for (const [id, meta] of knownUnits) {
    if (seen.has(id)) continue;
    const readError = readErrors.get(id);
    units.push({
      ups_id: id,
      label: meta.label,
      severity: "critical",
      headline: "Never reported",
      detail: readError ? readError.error : `${meta.host ?? "host"} has never been read`,
      ts: null,
      ...freshnessFields("ups", null),
      onBattery: false,
      lowBattery: false,
      charge: null,
      runtimeSeconds: null,
      runtimeMinutes: null,
      voltage: null,
      load: null,
      onBatterySince: null,
      unreachable: true,
      readError: readError ? readError.error : null
    });
  }
  units.sort((a, b) => a.label.localeCompare(b.label));

  const severity = worst(...units.map((unit) => unit.severity));
  const onBattery = units.filter((unit) => unit.onBattery);
  const lowBattery = units.filter((unit) => unit.lowBattery);
  const unreachable = units.filter((unit) => unit.unreachable);
  const tightest = onBattery.length
    ? onBattery.reduce((a, b) =>
        (b.runtimeSeconds ?? Infinity) < (a.runtimeSeconds ?? Infinity) ? b : a
      )
    : null;
  const runtimeSuffix =
    tightest?.runtimeMinutes !== null && tightest?.runtimeMinutes !== undefined
      ? ` · ${tightest.runtimeMinutes} min left`
      : "";
  const headline =
    lowBattery.length > 0
      ? `LOW BATTERY: ${lowBattery.map((unit) => unit.label).join(", ")}${runtimeSuffix}`
      : onBattery.length > 0
        ? `${onBattery.length} on battery${runtimeSuffix}`
        : unreachable.length > 0
          ? `Cannot read ${unreachable.map((unit) => unit.label).join(", ")}`
          : units.length === 1
            ? (units[0]?.headline ?? "Online")
            : `${units.length} units online`;

  let detail =
    units.length === 1
      ? (units[0]?.detail ?? null)
      : units.map((unit) => `${unit.label}: ${unit.headline}`).join(" · ");
  if (onBattery.length) {
    detail = onBattery
      .map(
        (unit) =>
          `${unit.label}: ${unit.runtimeMinutes !== null ? `${unit.runtimeMinutes} min left` : "on battery"}${
            unit.charge !== null ? ` (${unit.charge}%)` : ""
          }`
      )
      .join(" · ");
  }

  const contactTimes = units
    .map((unit) => unit.ts)
    .filter((value): value is number => value !== null);
  const newestContactAt = contactTimes.length ? Math.max(...contactTimes) : null;
  const oldestContactAt = contactTimes.length ? Math.min(...contactTimes) : null;

  // `LB` outranks every runtime band: it is the UPS's own declaration that it is
  // about to give up, and an On Battery → Low Battery flip moves neither severity
  // nor runtime band on its own.
  let escalation = 0;
  if (onBattery.length) {
    escalation = Math.max(
      ...onBattery.map((unit) => {
        if (unit.lowBattery) return LOW_BATTERY_BAND;
        return unit.runtimeSeconds === null ? 1 : runtimeBand(unit.runtimeSeconds);
      })
    );
  } else if (unreachable.length) {
    // Deliberately below the on-battery bands: not knowing is serious, but a
    // confirmed drain is worse and must never be outranked by it.
    escalation = Math.max(
      ...unreachable.map((unit) =>
        unit.ts === null || now - unit.ts > UPS_UNREACHABLE_CRITICAL_MS ? 2 : 1
      )
    );
  }

  return {
    key: "ups",
    label: "UPS Power",
    severity,
    headline,
    detail,
    ts: oldestContactAt,
    units,
    escalation,
    oldestContactAt,
    newestContactAt,
    ...freshnessFields("ups", oldestContactAt)
  };
}

async function camerasStatus(repository: InfraStatusRepository, now: number): Promise<Subsystem> {
  const row = await repository.protectLatest();
  if (!row) {
    return {
      key: "cameras",
      label: "Cameras",
      severity: "ok",
      headline: "No cameras",
      detail: null,
      ts: null,
      ...freshnessFields("protect", null)
    };
  }

  const payload = record(safeParse(row.payload));
  const cameras = array(payload.cameras).map(record);
  const total = cameras.length;
  const isOnline = (camera: Record<string, unknown>): boolean => {
    const state = asText(camera.state ?? camera.status).toUpperCase();
    return state === "CONNECTED" || state === "ONLINE" || camera.isConnected === true;
  };
  const offlineCameras = cameras.filter((camera) => !isOnline(camera));
  const online = total - offlineCameras.length;
  const stale = now - row.received_at > STALE.protect;

  let severity: Severity = "ok";
  if (stale) severity = "stale";
  else if (total > 0 && offlineCameras.length > 0) severity = "warn";

  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    key: "cameras",
    label: "Cameras",
    severity,
    headline: total ? `${online}/${total} online` : "No cameras",
    detail: stale
      ? "Agent not reporting"
      : total
        ? offlineCameras.length > 0
          ? offlineSummary(
              offlineCameras.map(
                (camera) =>
                  text(camera.name) ?? text(camera.model_name) ?? text(camera.mac) ?? "unknown"
              )
            )
          : "All cameras up"
        : null,
    ts: row.received_at,
    ...freshnessFields("protect", row.received_at),
    escalation: Math.max(0, offlineCameras.length),
    offline: offlineCameras.slice(0, OFFLINE_LISTED).map((camera) => ({
      name: text(camera.name) ?? text(camera.model_name),
      model: text(camera.model_name) ?? text(camera.model),
      ip: text(camera.ip),
      mac: text(camera.mac)
    }))
  };
}

async function nasStatus(repository: InfraStatusRepository, now: number): Promise<Subsystem> {
  const rows = await repository.synologyLatest();
  if (!rows.length) {
    return {
      key: "nas",
      label: "Synology NAS",
      severity: "stale",
      headline: "No data",
      detail: null,
      ts: null,
      ...freshnessFields("synology", null)
    };
  }

  let disks = 0;
  let unhealthy = 0;
  let stale = 0;
  let worstPct: number | null = null;
  let worstName: string | null = null;

  for (const row of rows) {
    const payload = record(unpackJson(row.payload));
    if (now - row.received_at > STALE.synology) stale += 1;
    for (const entry of array(payload.disks)) {
      const disk = record(entry);
      disks += 1;
      const signal = `${asText(disk.smart_status)} ${asText(disk.health)}`.toLowerCase();
      if (
        /(fail|crash|critical|warning|abnormal|bad)/.test(signal) ||
        Number(disk.bad_sectors ?? 0) > 0
      ) {
        unhealthy += 1;
      }
    }
    for (const entry of array(payload.volumes)) {
      const volume = record(entry);
      const usedPct = typeof volume.used_pct === "number" ? volume.used_pct : null;
      if (usedPct !== null && (worstPct === null || usedPct > worstPct)) {
        worstPct = usedPct;
        worstName = `${row.label ?? row.nas_id} · ${asText(volume.name)}`;
      }
    }
  }

  const backupFailures = (await repository.latestBackupRunResults()).filter(
    (run) => run.result && !/success|done|finish|ok/i.test(asText(run.result))
  ).length;

  let severity: Severity = "ok";
  if (unhealthy > 0) severity = "critical";
  else if (backupFailures > 0 || (worstPct !== null && worstPct >= 90)) severity = "warn";
  else if (stale > 0) severity = "stale";

  const problems: string[] = [];
  if (unhealthy > 0) problems.push(`${unhealthy} disk${unhealthy === 1 ? "" : "s"} unhealthy`);
  if (backupFailures > 0) {
    problems.push(`${backupFailures} backup${backupFailures === 1 ? "" : "s"} failing`);
  }
  if (worstPct !== null && worstPct >= 90) {
    problems.push(`${worstName} ${Math.round(worstPct)}% full`);
  }
  if (stale > 0) problems.push(`${stale} unit${stale === 1 ? "" : "s"} not reporting`);

  const contactTimes = rows.map((row) => row.received_at);
  const newestContactAt = Math.max(...contactTimes);
  const ts = Math.min(...contactTimes);
  return {
    key: "nas",
    label: "Synology NAS",
    severity,
    headline: `${rows.length} NAS · ${disks} disks`,
    detail: problems.length ? problems.join(" · ") : "All healthy",
    ts,
    oldestContactAt: ts,
    newestContactAt,
    ...freshnessFields("synology", ts),
    escalation: unhealthy * 10 + backupFailures
  };
}

function agentAgo(now: number, ms: number | null): string | null {
  if (ms === null) return null;
  const secondsAgo = Math.max(0, Math.round((now - ms) / 1000));
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  const minutes = Math.round(secondsAgo / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * On-site agent health. The shutdown watchdog is the one agent that *acts*
 * rather than observes, so its silence is critical — nothing else would notice
 * that the thing meant to shut the office down safely had stopped running.
 *
 * Sonarr is not an owned collector any more: its liveness comes from the Marquee
 * media-health contract, and an unreachable contract is reported as unknown
 * rather than assumed healthy. A Sonarr-only failure is confirmation-gated because
 * Marquee cold starts can briefly publish it as absent; owned-agent failures remain
 * immediate, and recoveries must remain stable before they are announced.
 */
async function agentsStatus(
  repository: InfraStatusRepository,
  now: number,
  media: MediaHealthSummary
): Promise<Subsystem> {
  const contact = await repository.agentContact();
  const checks: Array<{
    source: AgentSource;
    label: string;
    stale: boolean;
    critical: boolean;
    ts: number | null;
  }> = [];
  const add = (source: AgentSource, receivedAt: number | null): void => {
    const policy = AGENT_FRESHNESS[source];
    const age = receivedAt === null ? null : now - receivedAt;
    checks.push({
      source,
      label: policy.label,
      stale: age === null || age > policy.staleAfterMs,
      critical: policy.critical === true,
      ts: receivedAt
    });
  };

  add("unifi", contact.unifi);
  add("protect", contact.protect);
  add("ups", contact.ups);
  add("shutdown", contact.shutdown);
  add("synology", contact.synology);
  if (contact.networkObserver !== null) add("network_observer", contact.networkObserver);

  const sonarrPolicy = AGENT_FRESHNESS.sonarr;
  const sonarrReachable = media.overall !== "unreachable";
  const sonarrSilent = !sonarrReachable || !media.sonarrPresent;

  const staleOnes = checks.filter((check) => check.stale);
  const criticalStale = staleOnes.filter((check) => check.critical);
  const silentCount = staleOnes.length + (sonarrSilent ? 1 : 0);
  const reportingCount = checks.length + 1;

  let severity: Severity = "ok";
  if (criticalStale.length) severity = "critical";
  else if (silentCount) severity = "warn";

  const silentLabels = [...staleOnes.map((check) => check.label)];
  if (sonarrSilent) silentLabels.push(sonarrPolicy.label);
  const sonarrOnlySilent = sonarrSilent && staleOnes.length === 0;

  const agents: AgentUnit[] = checks.map((check) => ({
    id: check.label,
    label: check.label,
    severity: check.stale ? (check.critical ? "critical" : "warn") : "ok",
    headline: check.stale ? "Silent" : "Reporting",
    detail: check.ts ? `Last seen ${agentAgo(now, check.ts)}` : "Never reported",
    ts: check.ts,
    ...freshnessFields(check.source, check.ts)
  }));
  agents.push({
    id: sonarrPolicy.label,
    label: sonarrPolicy.label,
    severity: sonarrSilent ? "warn" : "ok",
    headline: sonarrSilent ? "Silent" : "Reporting",
    detail: sonarrReachable
      ? media.sonarrPresent
        ? `Marquee media health reports Sonarr present (${media.overall})`
        : "Marquee media health reports no Sonarr instance"
      : `Marquee media health unavailable: ${media.error ?? "unknown"}`,
    ts: null,
    ...freshnessFields("sonarr", null)
  });

  const contactTimes = checks
    .map((check) => check.ts)
    .filter((value): value is number => value !== null);
  const oldestContactAt = contactTimes.length ? Math.min(...contactTimes) : null;

  return {
    key: "agents",
    label: "On-site Agents",
    severity,
    headline: silentCount ? `${silentCount} silent` : `${reportingCount} reporting`,
    detail: silentCount ? `${silentLabels.join(", ")} not reporting` : "All agents reporting",
    ts: oldestContactAt,
    lastContactAt: oldestContactAt,
    oldestContactAt,
    agents,
    escalation: silentCount,
    notificationPolicy: {
      kind: "consecutive-samples",
      sampleKey: String(now),
      generationKey: JSON.stringify({ agents: now }),
      signature: silentLabels.length ? silentLabels.join("|") : "all-reporting",
      failureSamples: sonarrOnlySilent ? AGENT_ALERT_CONFIRMATION_SAMPLES : 1,
      recoverySamples: AGENT_ALERT_CONFIRMATION_SAMPLES
    }
  };
}

async function networkObserverStatus(
  repository: InfraStatusRepository,
  now: number,
  samples: ObserverAlertSamples
): Promise<Subsystem | null> {
  const row = await repository.observerLatest();
  if (!row) return null;
  const payload = record(unpackJson(row.payload));
  const stale = now - row.received_at > AGENT_FRESHNESS.network_observer.staleAfterMs;

  const keyedProbes = new Map<string, Record<string, unknown>>();
  for (const entry of array(payload.probes)) {
    const probe = record(entry);
    const targetKey = `${asText(probe.kind, "unknown")}:${asText(probe.id, "unknown")}`;
    const previous = keyedProbes.get(targetKey);
    if (!previous || Number(probe.ts) >= Number(previous.ts)) keyedProbes.set(targetKey, probe);
  }
  const expectedProbes = [...keyedProbes.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const probes = expectedProbes
    .map(([, probe]) => probe)
    .filter((probe) => {
      const observedAt = Number(probe.ts);
      return (
        Number.isFinite(observedAt) &&
        now - observedAt <= AGENT_FRESHNESS.network_observer.staleAfterMs
      );
    });
  const failures = probes.filter((probe) => probe.ok === false);
  const failureSignature = [
    ...new Set(
      failures.map((probe) => `${asText(probe.kind, "unknown")}:${asText(probe.id, "unknown")}`)
    )
  ]
    .sort()
    .join("|");
  const gatewayFailure = failures.some(
    (probe) => probe.kind === "lan" && probe.id === "gateway"
  );
  const severity: Severity = stale ? "stale" : failures.length ? "warn" : "ok";
  const headline = stale
    ? "Observer stale"
    : gatewayFailure
      ? "Gateway probe failed"
      : failures.length
        ? `${failures.length} probe${failures.length === 1 ? "" : "s"} failing`
        : `${probes.length} probes healthy`;
  const detail = failures.length
    ? failures
        .slice(0, 4)
        .map((probe) => asText(probe.label ?? probe.id))
        .join(", ")
    : `Independent witness: ${row.observer_id}`;
  const targetSignature = expectedProbes.map(([targetKey]) => targetKey).join("|");
  const completeHealthySweep =
    severity === "ok" &&
    expectedProbes.length > 0 &&
    expectedProbes.every(([, probe]) => {
      const observedAt = Number(probe.ts);
      return (
        probe.ok === true &&
        Number.isFinite(observedAt) &&
        now - observedAt <= AGENT_FRESHNESS.network_observer.staleAfterMs
      );
    });
  const relevantProbes = severity === "warn" ? failures : expectedProbes.map(([, probe]) => probe);
  const generations = relevantProbes.map((probe) => Number(probe.ts)).filter(Number.isFinite);
  const observationGeneration = generations.length ? Math.min(...generations) : null;
  const memberGenerations = Object.fromEntries(
    relevantProbes.map((probe) => [
      `${asText(probe.kind, "unknown")}:${asText(probe.id, "unknown")}`,
      Number(probe.ts)
    ])
  );

  const status: Subsystem = {
    key: "network-observer",
    label: "Network Observer",
    severity,
    headline,
    detail,
    ts: row.received_at,
    escalation: 0,
    probes,
    ...freshnessFields("network_observer", row.received_at)
  };
  if (stale) return status;
  return {
    ...status,
    notificationPolicy: {
      kind: "consecutive-samples",
      sampleKey: observationGeneration !== null ? String(observationGeneration) : "no-observations",
      generationKey: JSON.stringify(memberGenerations),
      signature: severity === "warn" ? failureSignature : `healthy:${targetSignature}`,
      failureSamples: samples.failure,
      recoverySamples: samples.recovery,
      ...(severity === "ok" && !completeHealthySweep ? { confirmable: false } : {})
    }
  };
}

/**
 * Media health from Marquee's contract endpoint. Watchtower no longer reads Plex,
 * Tautulli or Sonarr — directly or through a shared database — so an unreachable
 * contract is reported as a degraded tile rather than silently omitted.
 */
async function mediaStatus(client: MediaHealthClient, now: number): Promise<Subsystem> {
  let document: MediaHealthV1 | null = null;
  let error: string | null = null;
  try {
    document = await client.get();
  } catch (caught) {
    error =
      caught instanceof MediaHealthClientError
        ? `${caught.code}: ${caught.message}`
        : caught instanceof Error
          ? caught.message
          : "unknown";
  }

  const summary: MediaHealthSummary = document
    ? {
        source: "marquee",
        overall: document.overall,
        generatedAt: document.generatedAt,
        plexConfigured: document.providers.plex.configured,
        tautulliConfigured: document.providers.tautulli.configured,
        sonarrPresent: document.sonarr.present,
        error: null
      }
    : {
        source: "marquee",
        overall: "unreachable",
        generatedAt: null,
        plexConfigured: false,
        tautulliConfigured: false,
        sonarrPresent: false,
        error
      };

  const severity: Severity =
    summary.overall === "healthy" ? "ok" : summary.overall === "degraded" ? "warn" : "warn";
  const headline =
    summary.overall === "healthy"
      ? "Healthy"
      : summary.overall === "degraded"
        ? "Degraded"
        : summary.overall === "unavailable"
          ? "Unavailable"
          : "Unreachable";
  const detail =
    summary.overall === "unreachable"
      ? `Marquee media health unavailable: ${error ?? "unknown"}`
      : [
          `plex ${summary.plexConfigured ? "configured" : "not configured"}`,
          `tautulli ${summary.tautulliConfigured ? "configured" : "not configured"}`,
          `sonarr ${summary.sonarrPresent ? "present" : "absent"}`
        ].join(" · ");

  return {
    key: "media",
    label: "Media",
    severity,
    headline,
    detail,
    ts: now,
    escalation: 0,
    // A healthy media stack is informational — streaming activity is not a fault.
    // Anything else is graded so a broken contract is visible in the issue count.
    ...(severity === "ok" ? { informational: true } : {}),
    media: summary
  };
}

/**
 * Both NASes are NUT slaves of the UPS Tower and enter Safe Mode on their own DSM
 * timer, which Watchtower neither controls nor is told about. Deriving the
 * deadline from the moment the UPS went on battery is the only warning available.
 */
async function nasShutdownEvents(
  repository: InfraStatusRepository,
  now: number,
  ups: Subsystem
): Promise<InfraEvent[]> {
  const events: InfraEvent[] = [];
  const onBattery = (ups.units ?? []).filter((unit) => unit.onBattery && unit.onBatterySince);
  if (!onBattery.length) return events;

  const diagnostic = record(unpackJson(await repository.newestUpsDiagnostic()));
  const hostToId = new Map(
    array(diagnostic.units).map((entry) => {
      const unit = record(entry);
      return [asText(unit.host), asText(unit.id)];
    })
  );

  for (const row of await repository.synologyLatest()) {
    const upsConfig = record(record(unpackJson(row.payload)).ups);
    const shutdownSeconds = Number(upsConfig.shutdown_seconds);
    if (
      upsConfig.enabled !== true ||
      upsConfig.shutdown_enabled !== true ||
      !Number.isFinite(shutdownSeconds) ||
      shutdownSeconds <= 0
    ) {
      continue;
    }

    const unit = onBattery.find(
      (candidate) => candidate.ups_id === hostToId.get(asText(upsConfig.server))
    );
    if (!unit || unit.onBatterySince === null) continue;

    const deadline = unit.onBatterySince + shutdownSeconds * 1000;
    const remaining = Math.round((deadline - now) / 1000);
    if (remaining > NAS_SHUTDOWN_WARN_SECONDS || remaining <= 0) continue;

    events.push({
      // The on-battery start makes this unique per outage, so the next one fires again.
      id: `nas-shutdown:${row.nas_id}:${unit.onBatterySince}`,
      critical: true,
      title: `${row.label ?? row.nas_id} shutting down`,
      body: `Enters Safe Mode in ${remaining}s — ${unit.label} on battery${
        unit.runtimeMinutes !== null ? ` · ${unit.runtimeMinutes} min left` : ""
      }`
    });
  }
  return events;
}

/**
 * A forward bound to `both` or to a backup uplink is an inbound path that stays
 * open on the metered cellular link. Config, not telemetry, so it is a one-shot
 * event keyed on (forward, binding) rather than a per-poll nag.
 */
async function portForwardDriftEvents(repository: InfraStatusRepository): Promise<InfraEvent[]> {
  const row = await repository.unifiLatest();
  if (!row) return [];
  const forwards = record(record(unpackJson(row.payload)).config).port_forwards;
  if (!Array.isArray(forwards)) return [];

  const events: InfraEvent[] = [];
  for (const entry of forwards) {
    const forward = record(entry);
    if (!isRecord(entry) || forward.enabled === false) continue;
    const iface = asText(forward.interface).trim().toLowerCase();
    if (!iface || iface === PRIMARY_PF_INTERFACE) continue;
    events.push({
      id: `pf-wan-drift:${asText(forward.id ?? forward.name)}:${iface}`,
      critical: false,
      title: "Port forward open on a backup WAN",
      body: `"${asText(forward.name)}" (${asText(forward.dst_port)} → ${asText(forward.fwd_ip)}) is bound to "${iface}", not the primary WAN. Inbound traffic can reach it over the metered uplink.`
    });
  }
  return events;
}

export function observerAlertSamples(
  raw: string | undefined,
  fallback = NETWORK_OBSERVER_ALERT_DEFAULT_SAMPLES
): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= NETWORK_OBSERVER_ALERT_MAX_SAMPLES
    ? value
    : fallback;
}

export async function buildInfraStatus(
  dependencies: InfraStatusDependencies,
  now: number = Date.now()
): Promise<DashboardPayload> {
  const { repository, routeDrift, mediaHealth } = dependencies;
  const samples = dependencies.observerAlertSamples ?? {
    failure: NETWORK_OBSERVER_ALERT_DEFAULT_SAMPLES,
    recovery: NETWORK_OBSERVER_ALERT_DEFAULT_SAMPLES
  };

  const media = await mediaStatus(mediaHealth, now);
  const mediaSummary = media.media as MediaHealthSummary;
  const ups = await upsStatus(repository, now);
  const subsystems: Subsystem[] = [
    await internetStatus(repository, now),
    ups,
    await nasStatus(repository, now),
    await camerasStatus(repository, now),
    await devicesStatus(repository, now),
    await agentsStatus(repository, now, mediaSummary)
  ];
  const observer = await networkObserverStatus(repository, now, samples);
  if (observer) subsystems.splice(1, 0, observer);
  subsystems.push(media);

  // The overall verdict ignores informational tiles so "N issues" means N things
  // actually wrong.
  const graded = subsystems.filter((subsystem) => !subsystem.informational);
  const overallSeverity = worst(...graded.map((subsystem) => subsystem.severity));
  const issues = graded.filter(
    (subsystem) => subsystem.severity === "warn" || subsystem.severity === "critical"
  );
  const summary =
    issues.length === 0
      ? graded.some((subsystem) => subsystem.severity === "stale")
        ? "All systems reporting some stale data"
        : "All systems OK"
      : `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues
          .map((subsystem) => subsystem.label)
          .join(", ")}`;

  return {
    schema: 1,
    generatedAt: now,
    overall: { severity: overallSeverity, issueCount: issues.length, summary },
    subsystems,
    events: [
      ...(await nasShutdownEvents(repository, now, ups)),
      ...(await portForwardDriftEvents(repository)),
      ...(await routeDrift.activeTrafficRouteDriftEvents())
    ]
  };
}
