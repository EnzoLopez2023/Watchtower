import { createHash } from "node:crypto";
import { packJson, unpackJson } from "./payloadCodec.js";
import { asText } from "./values.js";

function text(value: unknown): string | null {
  const parsed = asText(value);
  return parsed === "" ? null : parsed;
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter((s): s is string => s !== null))].sort()
    : [];
}

export interface RouteTarget {
  type: string | null;
  client_mac: string | null;
  network_id: string | null;
}

export interface RouteShape {
  id: string | null;
  name: string | null;
  enabled: boolean;
  matching_target: string | null;
  target_devices: RouteTarget[];
  network_id: string | null;
  kill_switch_enabled: boolean;
  domains: string[];
  ip_addresses: string[];
  ip_ranges: string[];
  regions: string[];
  returned_index: number;
}

function routeShape(route: unknown, returnedIndex = 0): RouteShape {
  const r = route && typeof route === "object" ? (route as Record<string, unknown>) : {};
  const targetDevices = (Array.isArray(r.target_devices) ? r.target_devices : [])
    .map((target: unknown) => {
      const t = target && typeof target === "object" ? (target as Record<string, unknown>) : {};
      return {
        type: text(t.type),
        client_mac: text(t.client_mac)?.toLowerCase() ?? null,
        network_id: text(t.network_id),
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    id: text(r.id ?? r._id),
    name: text(r.name ?? r.description),
    enabled: r.enabled !== false,
    matching_target: text(r.matching_target),
    target_devices: targetDevices,
    network_id: text(r.network_id),
    kill_switch_enabled: r.kill_switch_enabled === true,
    domains: sortedStrings(r.domains),
    ip_addresses: sortedStrings(r.ip_addresses),
    ip_ranges: sortedStrings(r.ip_ranges),
    regions: sortedStrings(r.regions),
    returned_index: Number.isSafeInteger(r.returned_index) ? (r.returned_index as number) : returnedIndex,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

function configFingerprint(route: RouteShape): string {
  // The position a route was returned in is not part of its configuration.
  const config = { ...route };
  delete (config as { returned_index?: unknown }).returned_index;
  return digest(config);
}

function matchFingerprint(route: RouteShape): string {
  return digest({
    target_devices: route.target_devices,
    matching_target: route.matching_target,
    domains: route.domains,
    ip_addresses: route.ip_addresses,
    ip_ranges: route.ip_ranges,
    regions: route.regions,
  });
}

function changedFields(before: RouteShape | null, after: RouteShape): string[] {
  const labels: Record<string, string> = {
    name: "name",
    enabled: "enabled state",
    target_devices: "source membership",
    matching_target: "destination type",
    network_id: "egress network",
    kill_switch_enabled: "kill switch",
    domains: "domains",
    ip_addresses: "destination addresses",
    ip_ranges: "destination ranges",
    regions: "destination regions",
  };
  return Object.entries(labels)
    .filter(([key]) =>
      canonical((before as unknown as Record<string, unknown> | null)?.[key]) !==
      canonical((after as unknown as Record<string, unknown>)[key])
    )
    .map(([, label]) => label);
}

function driftKey(type: string, routeId: string, discriminator = ""): string {
  return `${type}:${routeId || "route"}:${digest(discriminator).slice(0, 16)}`;
}

export interface RouteDriftMeta {
  established_at: number;
  last_observed_at: number | null;
}

export interface RouteDriftBaselineRow {
  route_id: string;
  route_name: string | null;
  returned_index: number;
  fingerprint: string;
  payload: Buffer | null;
}

export interface ActiveDriftEntry {
  drift_key: string;
  route_id: string;
  route_name: string | null;
  drift_type: string;
  detail: string;
  baseline: Buffer | null;
  current: Buffer | null;
}

export interface ActiveDriftKeyRow {
  drift_key: string;
}

export interface RouteDriftHistoryRow {
  drift_key: string;
  route_id: string;
  route_name: string | null;
  drift_type: string;
  detail: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface RouteDriftDb {
  getMeta(): RouteDriftMeta | undefined;
  insertMeta(establishedAt: number, lastObservedAt: number): void;
  updateLastObserved(observedAt: number): void;
  listBaseline(): RouteDriftBaselineRow[];
  insertBaseline(
    routeId: string,
    routeName: string | null,
    returnedIndex: number,
    fingerprint: string,
    payload: Buffer,
    establishedAt: number
  ): void;
  listActive(): ActiveDriftKeyRow[];
  upsertActive(drift: ActiveDriftEntry, now: number): void;
  insertHistory(drift: ActiveDriftEntry, now: number): void;
  updateOpenHistory(drift: ActiveDriftEntry, now: number): void;
  resolveHistory(driftKey: string, now: number): void;
  deleteActive(driftKey: string): void;
  listDrift(): RouteDriftHistoryRow[];
}

export interface SyncTrafficRouteResult {
  collected: boolean;
  initialized?: boolean;
  staleObservation?: boolean;
  baselineCount?: number;
  currentCount?: number;
  driftCount?: number;
}

export function syncTrafficRouteBaseline(
  db: RouteDriftDb,
  config: unknown,
  observedAt = Date.now()
): SyncTrafficRouteResult {
  const cfg = config && typeof config === "object" ? (config as Record<string, unknown>) : null;
  if (!cfg || cfg.traffic_routes_available !== true || !Array.isArray(cfg.traffic_routes)) {
    return { collected: false };
  }
  return { collected: true, ...syncRoutes(db, cfg.traffic_routes as unknown[], observedAt) };
}

function syncRoutes(
  db: RouteDriftDb,
  routes: unknown[],
  observedAt: number
): Omit<SyncTrafficRouteResult, "collected"> {
  const current = routes
      .map((route, index) => routeShape(route, index))
      .filter((route) => route.id !== null) as (RouteShape & { id: string })[];

    const meta = db.getMeta();
    if (!meta) {
      db.insertMeta(observedAt, observedAt);
      for (const route of current) {
        db.insertBaseline(
          route.id,
          route.name,
          route.returned_index,
          configFingerprint(route),
          packJson(route),
          observedAt
        );
      }
      return { initialized: true, baselineCount: current.length, driftCount: 0 };
    }

    if (meta.last_observed_at != null && observedAt < meta.last_observed_at) {
      return {
        initialized: false,
        staleObservation: true,
        baselineCount: db.listBaseline().length,
        driftCount: db.listActive().length,
      };
    }

    db.updateLastObserved(observedAt);

    const baseline = new Map<string, { row: RouteDriftBaselineRow; route: RouteShape | null }>(
      db.listBaseline().map((row) => [row.route_id, { row, route: unpackJson(row.payload) }])
    );
    const currentById = new Map(current.map((route) => [route.id, route]));
    const drifts: ActiveDriftEntry[] = [];

    for (const [routeId, { row, route: baselineRoute }] of baseline) {
      const live = currentById.get(routeId);
      if (!live) {
        drifts.push({
          drift_key: driftKey("missing", routeId, row.fingerprint),
          route_id: routeId,
          route_name: row.route_name,
          drift_type: "missing",
          detail: `"${row.route_name ?? routeId}" is missing from the current Traffic Route list.`,
          baseline: row.payload,
          current: null,
        });
        continue;
      }

      const changed = changedFields(baselineRoute, live);
      if (changed.length) {
        drifts.push({
          drift_key: driftKey("changed", routeId, configFingerprint(live)),
          route_id: routeId,
          route_name: live.name ?? row.route_name,
          drift_type: "changed",
          detail: `"${live.name ?? row.route_name ?? routeId}" changed: ${changed.join(", ")}.`,
          baseline: row.payload,
          current: packJson(live),
        });
      }
    }

    for (const route of current) {
      if (baseline.has(route.id)) continue;
      drifts.push({
        drift_key: driftKey("added", route.id, configFingerprint(route)),
        route_id: route.id,
        route_name: route.name,
        drift_type: "added",
        detail: `New Traffic Route "${route.name ?? route.id}" is not in the established baseline.`,
        baseline: null,
        current: packJson(route),
      });
    }

    const byMatch = new Map<string, Array<RouteShape & { id: string }>>();
    for (const route of current.filter((r) => r.enabled)) {
      const key = matchFingerprint(route);
      const group = byMatch.get(key) ?? [];
      group.push(route);
      byMatch.set(key, group);
    }
    for (const [key, group] of byMatch) {
      const outcomes = new Set(
        group.map((route) => canonical({ network_id: route.network_id, kill_switch_enabled: route.kill_switch_enabled }))
      );
      if (group.length < 2 || outcomes.size < 2) continue;
      const ids = group.map((r) => r.id).sort();
      drifts.push({
        drift_key: driftKey("conflict", ids.join(","), key),
        route_id: ids.join(","),
        route_name: group.map((r) => r.name ?? r.id).join(" / "),
        drift_type: "conflict",
        detail: `Overlapping enabled Traffic Routes select different egress or kill-switch behavior: ${group.map((r) => `"${r.name ?? r.id}"`).join(", ")}.`,
        baseline: null,
        current: packJson(group),
      });
    }

    const activeKeys = new Set(drifts.map((d) => d.drift_key));
    for (const drift of drifts) {
      db.upsertActive(drift, observedAt);
      db.insertHistory(drift, observedAt);
      db.updateOpenHistory(drift, observedAt);
    }
    for (const row of db.listActive()) {
      if (activeKeys.has(row.drift_key)) continue;
      db.resolveHistory(row.drift_key, observedAt);
      db.deleteActive(row.drift_key);
    }

    return {
      initialized: false,
      baselineCount: baseline.size,
      currentCount: current.length,
      driftCount: drifts.length,
    };
}

export interface ActiveDriftEvent {
  id: string;
  critical: boolean;
  title: string;
  body: string;
}

export function activeTrafficRouteDriftEvents(db: RouteDriftDb): ActiveDriftEvent[] {
  return db.listDrift().map((row) => ({
    id: `traffic-route-drift:${row.drift_key}`,
    critical: false,
    title:
      row.drift_type === "conflict"
        ? "Conflicting UniFi Traffic Routes"
        : `UniFi Traffic Route drift: ${row.route_name ?? row.drift_type}`,
    body: row.detail,
  }));
}

export interface RouteDriftStatus {
  initialized: boolean;
  establishedAt: number | null;
  lastObservedAt: number | null;
  baseline: Array<{ route_id: string; route_name: string | null; returned_index: number; route: RouteShape | null }>;
  drift: RouteDriftHistoryRow[];
}

export function trafficRouteDriftStatus(db: RouteDriftDb): RouteDriftStatus {
  const meta = db.getMeta();
  const baseline = db.listBaseline().map((row) => ({
    route_id: row.route_id,
    route_name: row.route_name,
    returned_index: row.returned_index,
    route: unpackJson<RouteShape>(row.payload),
  }));
  const drift = db.listDrift();
  return {
    initialized: Boolean(meta),
    establishedAt: meta?.established_at ?? null,
    lastObservedAt: meta?.last_observed_at ?? meta?.established_at ?? null,
    baseline,
    drift,
  };
}
