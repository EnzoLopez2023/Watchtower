import type { RequestHandler } from "express";
import type { AppRole } from "../../lib/db/repositories/identityRepository.js";
import { HttpError } from "../http/errors.js";
import { requireFeatureRead, requireFeatureWrite, type ViewId } from "./featureAccess.js";

/**
 * The route → manifest-view map, and the middleware that enforces it.
 *
 * Declaring this centrally rather than sprinkling a guard argument through
 * fourteen router modules buys one thing that matters: a test can walk the
 * mounted Express stack and assert that **every** interactive endpoint resolves
 * to an entry here. A route added without a rule is denied rather than silently
 * unguarded, so the failure mode of forgetting is a visible 403, not an
 * authorization hole.
 *
 * `views` are the manifest ids from `OWNED_VIEW_IDS`. For reads the list is
 * any-of, because shared data legitimately backs several pages; the pairs below
 * were taken from what the client actually fetches, not from what sounds
 * related:
 *
 *   * `/api/ups*`      → UPS Monitor **and** the Power Topology canvas.
 *   * `/api/unifi`     → UniFi Network **and** UniFi Topology.
 *   * `/api/protect`   → Protect **and** UniFi Topology (camera nodes).
 *
 * Everything else is consumed by exactly one page, so widening it would hand
 * out data a hidden view is supposed to withhold.
 */

export type AccessKind = "read" | "write";

export interface FeatureRouteRule {
  readonly method: string;
  /** Express-style pattern; `:param` segments match one path segment. */
  readonly path: string;
  readonly kind: AccessKind;
  readonly views: readonly ViewId[];
  /** Role floor. Defaults to viewer for reads and operator for writes. */
  readonly role?: AppRole;
}

const UPS_VIEWS: readonly ViewId[] = ["power-monitor", "power-topology"];
const UNIFI_CORE_VIEWS: readonly ViewId[] = ["unifi-network", "unifi-topology"];
const PROTECT_VIEWS: readonly ViewId[] = ["protect", "unifi-topology"];
const UNIFI_NETWORK: readonly ViewId[] = ["unifi-network"];
const AZURE: readonly ViewId[] = ["azure-command-center"];
const OBSERVABILITY: readonly ViewId[] = ["observability"];
const SYNOLOGY: readonly ViewId[] = ["synology"];
const POWER_TOPOLOGY: readonly ViewId[] = ["power-topology"];
const IP_MIGRATION: readonly ViewId[] = ["ip-migration"];

export const FEATURE_ROUTE_RULES: readonly FeatureRouteRule[] = [
  // ── System status ────────────────────────────────────────────────────────
  { method: "GET", path: "/api/status", kind: "read", views: ["system-status"] },

  // ── Observability (admin surfaces, still visibility-checked) ─────────────
  { method: "GET", path: "/api/observability/logs", kind: "read", views: OBSERVABILITY, role: "admin" },
  { method: "GET", path: "/api/observability/analytics", kind: "read", views: OBSERVABILITY, role: "admin" },
  { method: "GET", path: "/api/admin/logs", kind: "read", views: OBSERVABILITY, role: "admin" },

  // ── Azure Command Center ─────────────────────────────────────────────────
  { method: "GET", path: "/api/azure/overview", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/budget", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/resource", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/resources", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/webapps", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/webapps/:rg/:name", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/webapps/:rg/:name/metrics", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/plans", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/acr", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/acr/:rg/:name/runs", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/acr/:rg/:name/runs/:runId", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/acr/:rg/:name/runs/:runId/log", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/acr/:rg/:name/repositories", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/cognitive", kind: "read", views: AZURE },
  {
    method: "GET",
    path: "/api/azure/cognitive/:rg/:account/deployments/:name",
    kind: "read",
    views: AZURE
  },
  { method: "GET", path: "/api/azure/cost", kind: "read", views: AZURE },
  { method: "GET", path: "/api/azure/cost/service", kind: "read", views: AZURE },
  // Mutates shared server state, so it is a write even though it stores nothing.
  { method: "POST", path: "/api/azure/cache/bust", kind: "write", views: AZURE },

  // ── UPS / power monitor ──────────────────────────────────────────────────
  { method: "GET", path: "/api/ups", kind: "read", views: UPS_VIEWS },
  { method: "GET", path: "/api/ups/history", kind: "read", views: UPS_VIEWS },
  { method: "GET", path: "/api/ups/outages", kind: "read", views: UPS_VIEWS },

  // ── UniFi ────────────────────────────────────────────────────────────────
  { method: "GET", path: "/api/unifi", kind: "read", views: UNIFI_CORE_VIEWS },
  { method: "GET", path: "/api/unifi/history", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/wan-history", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/ports/history", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/events", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/outage-incidents", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/outage-incidents/:id", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/config", kind: "read", views: ["unifi-config"] },
  { method: "GET", path: "/api/unifi/logs/activity", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/logs/flows", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/unifi/logs/summary", kind: "read", views: UNIFI_NETWORK },

  // ── Network observer (rendered by the UniFi Network telemetry panel) ─────
  { method: "GET", path: "/api/network-observer", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/network-observer/history", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/network-observer/isp", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/network-observer/snmp-events", kind: "read", views: UNIFI_NETWORK },
  { method: "GET", path: "/api/network-observer/snmp", kind: "read", views: UNIFI_NETWORK },

  // ── Protect ──────────────────────────────────────────────────────────────
  { method: "GET", path: "/api/protect", kind: "read", views: PROTECT_VIEWS },
  { method: "GET", path: "/api/protect/history", kind: "read", views: ["protect"] },
  { method: "GET", path: "/api/protect/events", kind: "read", views: ["protect"] },
  { method: "GET", path: "/api/protect/activity", kind: "read", views: ["protect"] },
  { method: "GET", path: "/api/protect/storage-forecast", kind: "read", views: ["protect"] },

  // ── Synology ─────────────────────────────────────────────────────────────
  { method: "GET", path: "/api/synology", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/history", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/shares", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/backups", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/summary", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/external", kind: "read", views: SYNOLOGY },
  { method: "GET", path: "/api/synology/disks", kind: "read", views: SYNOLOGY },
  {
    method: "DELETE",
    path: "/api/synology/external/:nasId/:deviceId",
    kind: "write",
    views: SYNOLOGY
  },

  // ── Power topology ───────────────────────────────────────────────────────
  { method: "GET", path: "/api/power/diagrams", kind: "read", views: POWER_TOPOLOGY },
  { method: "GET", path: "/api/power/diagrams/:id", kind: "read", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/diagrams", kind: "write", views: POWER_TOPOLOGY },
  { method: "PATCH", path: "/api/power/diagrams/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "DELETE", path: "/api/power/diagrams/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/diagrams/:id/duplicate", kind: "write", views: POWER_TOPOLOGY },
  { method: "PUT", path: "/api/power/diagrams/:id/graph", kind: "write", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/items", kind: "write", views: POWER_TOPOLOGY },
  { method: "PATCH", path: "/api/power/items/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "DELETE", path: "/api/power/items/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/items/positions", kind: "write", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/connections", kind: "write", views: POWER_TOPOLOGY },
  { method: "PATCH", path: "/api/power/connections/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "DELETE", path: "/api/power/connections/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "POST", path: "/api/power/zones", kind: "write", views: POWER_TOPOLOGY },
  { method: "PATCH", path: "/api/power/zones/:id", kind: "write", views: POWER_TOPOLOGY },
  { method: "DELETE", path: "/api/power/zones/:id", kind: "write", views: POWER_TOPOLOGY },

  // ── IP migration ─────────────────────────────────────────────────────────
  { method: "GET", path: "/api/ip-plan", kind: "read", views: IP_MIGRATION },
  { method: "PATCH", path: "/api/ip-plan/:mac", kind: "write", views: IP_MIGRATION }
];

interface CompiledRule extends FeatureRouteRule {
  readonly segments: readonly string[];
  /** Literal segments win over `:param` ones when two patterns both match. */
  readonly specificity: number;
}

function compile(rule: FeatureRouteRule): CompiledRule {
  const segments = rule.path.split("/").filter((segment) => segment !== "");
  return {
    ...rule,
    segments,
    specificity: segments.reduce(
      (total, segment) => total + (segment.startsWith(":") ? 0 : 1),
      0
    )
  };
}

const COMPILED: readonly CompiledRule[] = FEATURE_ROUTE_RULES.map(compile);

function matches(rule: CompiledRule, method: string, segments: readonly string[]): boolean {
  const normalizedMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  if (rule.method !== normalizedMethod) return false;
  if (rule.segments.length !== segments.length) return false;
  return rule.segments.every(
    (segment, index) =>
      segment.startsWith(":") ||
      segment.toLowerCase() === segments[index]?.toLowerCase()
  );
}

/** The rule governing a request, or undefined when none is declared. */
export function findFeatureRule(method: string, path: string): FeatureRouteRule | undefined {
  const segments = path.split("?")[0]?.split("/").filter((segment) => segment !== "") ?? [];
  let best: CompiledRule | undefined;
  for (const rule of COMPILED) {
    if (!matches(rule, method, segments)) continue;
    if (!best || rule.specificity > best.specificity) best = rule;
  }
  return best;
}

export interface MountedRoute {
  readonly method: string;
  readonly path: string;
}

interface RouteLayer {
  readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
  readonly handle?: { readonly stack?: readonly RouteLayer[] };
}

/**
 * Every method/path pair an Express router actually serves.
 *
 * Read from the router's own stack rather than a hand-kept list, so the
 * inventory test compares the rules against what is really mounted.
 */
export function mountedRoutes(router: unknown): MountedRoute[] {
  const found: MountedRoute[] = [];
  const walk = (layers: readonly RouteLayer[] | undefined): void => {
    for (const layer of layers ?? []) {
      const path = layer.route?.path;
      if (typeof path === "string") {
        for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
          if (enabled && method !== "_all") found.push({ method: method.toUpperCase(), path });
        }
      }
      walk(layer.handle?.stack);
    }
  };
  const stack = (router as { stack?: readonly RouteLayer[] } | null)?.stack;
  walk(stack);
  return found;
}

/**
 * Applies the declared rule for the matched route.
 *
 * Mounted at the head of the interactive router. A request that matches a
 * mounted interactive endpoint with no declared rule is refused — a new
 * endpoint stays unreachable until its access is stated, which is the safe
 * direction to fail in. A request matching nothing is passed through untouched
 * so it still reaches the typed `/api` 404 rather than being masked as a 403.
 */
export function enforceFeatureAccess(options: {
  readonly mounted: readonly MountedRoute[];
}): RequestHandler {
  const readGuards = new Map<string, RequestHandler>();
  const writeGuards = new Map<string, RequestHandler>();

  const guardFor = (rule: FeatureRouteRule): RequestHandler => {
    const key = `${rule.kind}:${rule.role ?? ""}:${rule.views.join(",")}`;
    const cache = rule.kind === "read" ? readGuards : writeGuards;
    let guard = cache.get(key);
    if (!guard) {
      guard =
        rule.kind === "read"
          ? requireFeatureRead({
              views: rule.views,
              ...(rule.role ? { role: rule.role } : {})
            })
          : requireFeatureWrite({
              views: rule.views,
              ...(rule.role ? { role: rule.role } : {})
            });
      cache.set(key, guard);
    }
    return guard;
  };

  const mounted = options.mounted.map((route) =>
    compile({ ...route, kind: "read", views: [] })
  );

  const isMounted = (method: string, segments: readonly string[]): boolean =>
    mounted.some((route) => matches(route, method, segments));

  return (request, response, next) => {
    const rule = findFeatureRule(request.method, request.path);
    if (rule) {
      guardFor(rule)(request, response, next);
      return;
    }
    const segments = request.path.split("/").filter((segment) => segment !== "");
    if (isMounted(request.method, segments)) {
      next(
        new HttpError(
          403,
          "feature_rule_missing",
          "No feature access rule is declared for this endpoint"
        )
      );
      return;
    }
    // Not ours: let it fall through to the typed /api 404.
    next();
  };
}
