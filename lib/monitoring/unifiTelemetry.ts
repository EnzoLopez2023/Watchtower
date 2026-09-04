import { createHash } from "node:crypto";
import { asText } from "./values.js";

function finiteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const PRIMARY_WAN_KEY = "WAN";

export function internetReachable(payload: Record<string, unknown>): boolean | null {
  const wan = payload.wan as Record<string, unknown> | null | undefined;
  const health = wan?._health as Record<string, unknown> | null | undefined;
  const www = health?.www as Record<string, unknown> | null | undefined;
  const healthStatus = asText(www?.status).toLowerCase();
  if (healthStatus) return healthStatus === "ok";
  const legacyStatus = asText(wan?.status).toLowerCase();
  if (legacyStatus === "up" || legacyStatus === "ok") return true;
  if (legacyStatus === "down" || legacyStatus === "error") return false;
  return null;
}

export interface WanUplink {
  key: string;
  name: string;
  primary: boolean;
  active: boolean;
  linkUp: boolean;
  uptimeSeconds: number | null;
  downtimeSeconds: number | null;
  latencyMs: number | null;
  availability: number | null;
  timePeriodSeconds: number | null;
  monitors: unknown[];
  alertingMonitors: unknown[];
}

export function wanUplinks(payload: Record<string, unknown>): WanUplink[] {
  const wan = payload.wan as Record<string, unknown> | null | undefined;
  const health = wan?._health as Record<string, unknown> | null | undefined;
  const wanHealth = health?.wan as Record<string, unknown> | null | undefined;
  const stats = wanHealth?.uptime_stats;
  if (!stats || typeof stats !== "object") return [];

  const config = payload.config as Record<string, unknown> | null | undefined;
  const wans = Array.isArray(config?.wans) ? (config.wans as unknown[]) : [];
  const names = wans
    .map((w) => (typeof w === "object" && w !== null ? (w as Record<string, unknown>).name : null))
    .filter((n): n is string => typeof n === "string");

  const slot = (key: string): number =>
    key === PRIMARY_WAN_KEY
      ? 0
      : (Number(key.replace(/^WAN/i, "")) || 1) - 1;

  const entries = Object.entries(stats as Record<string, unknown>).sort(([a], [b]) => slot(a) - slot(b));

  const routedKey =
    entries.find(([, state]) => {
      const s = state as Record<string, unknown>;
      return finiteNumber(s?.uptime) != null;
    })?.[0] ?? null;

  return entries.map(([key, state]) => {
    const s = (state as Record<string, unknown>) ?? {};
    const uptime = finiteNumber(s.uptime);
    return {
      key,
      name: names[slot(key)] ?? key,
      primary: key === PRIMARY_WAN_KEY,
      active: key === routedKey,
      linkUp: uptime != null,
      uptimeSeconds: uptime,
      downtimeSeconds: finiteNumber(s.downtime),
      latencyMs: finiteNumber(s.latency_average),
      availability: finiteNumber(s.availability),
      timePeriodSeconds: finiteNumber(s.time_period),
      monitors: Array.isArray(s.monitors) ? s.monitors : [],
      alertingMonitors: Array.isArray(s.alerting_monitors) ? s.alerting_monitors : [],
    };
  });
}

export interface PortStateLike {
  port_name: string | null;
  connected: string | null;
  up: 0 | 1 | null;
  speed: number | null;
  max_speed: number | null;
  full_duplex: 0 | 1 | null;
  poe_enabled: 0 | 1 | null;
  poe_active: 0 | 1 | null;
  stp_state: string | null;
  [key: string]: unknown;
}

export function portStateFingerprint(state: PortStateLike): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        port_name: state.port_name,
        connected: state.connected,
        up: state.up,
        speed: state.speed,
        max_speed: state.max_speed,
        full_duplex: state.full_duplex,
        poe_enabled: state.poe_enabled,
        poe_active: state.poe_active,
        stp_state: state.stp_state,
      })
    )
    .digest("hex");
}

export interface PreviousPortSample {
  readonly fingerprint: string;
  readonly received_at: number;
}

export function shouldRecordPortSample(
  previous: PreviousPortSample | undefined | null,
  fingerprint: string,
  now: number,
  heartbeatMs: number
): boolean {
  return (
    !previous ||
    previous.fingerprint !== fingerprint ||
    now - previous.received_at >= heartbeatMs
  );
}
