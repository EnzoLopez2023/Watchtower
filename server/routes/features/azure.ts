import { Router, type RequestHandler } from "express";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import type { AppConfig } from "../../config.js";
import type { AzureArmClients, AzureCache } from "../../clients/azure.js";
import { collect } from "../../clients/azure.js";
import {
  fetchAcrRunLog,
  isTrustedAcrLogUrl,
  ACR_LOG_MAX_BYTES,
  type AcrLogFailureReason
} from "../../clients/acrLogProxy.js";
import { requireRole } from "../../auth/authorize.js";
import { HttpError } from "../../http/errors.js";
import { asyncHandler, bodyString, isRecord, pathParam, queryInteger, queryString } from "./http.js";
import { asText } from "../../../lib/monitoring/values.js";

export interface AzureRouterDependencies {
  readonly config: AppConfig;
  readonly clients: AzureArmClients;
  readonly cache: AzureCache;
  /** Injectable HTTP seam. Defaults to the global `fetch`; tests supply a stub so no live call is made. */
  readonly fetch?: typeof fetch;
  /** Injectable ARM credential. Defaults to `DefaultAzureCredential`; tests supply a stub token provider. */
  readonly credential?: TokenCredential;
}

/** How much of the (sanitized) build log the run-detail response inlines as a tail preview. */
const ACR_LOG_TAIL_CHARS = 60_000;

/** Authorization scheme for ARM bearer calls (kept as a constant to build headers safely). */
const AUTH_SCHEME = "Bearer";

/** Typed, non-leaking responses for the bounded log-proxy failure modes. */
const ACR_LOG_ERROR_RESPONSES: Readonly<Record<AcrLogFailureReason, { status: number; code: string; message: string }>> = {
  upstream_error:           { status: 502, code: "log_upstream_error",           message: "The build log could not be retrieved" },
  timeout:                  { status: 504, code: "log_timeout",                  message: "Timed out retrieving the build log" },
  unsupported_content_type: { status: 502, code: "log_unsupported_content_type", message: "The build log was not in an expected format" },
  untrusted_url:             { status: 502, code: "log_untrusted_url",             message: "The build log location was not trusted" },
  network:                  { status: 502, code: "log_fetch_failed",             message: "The build log could not be retrieved" },
};

const RESOURCE_GROUP_NAME = /^[-A-Za-z0-9_().]{1,90}$/;
const REGISTRY_NAME = /^[A-Za-z0-9]{5,50}$/;
const RUN_ID = /^[A-Za-z0-9-]{1,80}$/;

function validatedArmSegment(
  value: string,
  pattern: RegExp,
  code: string,
  label: string
): string {
  if (value === "." || value === ".." || !pattern.test(value)) {
    throw new HttpError(400, code, `${label} is invalid`);
  }
  return value;
}

function encodedArmSegment(value: string): string {
  return encodeURIComponent(value);
}

function acrRouteValues(
  rgValue: string,
  registryValue: string,
  runValue?: string
): { rg: string; registry: string; runId?: string } {
  const rg = validatedArmSegment(
    rgValue,
    RESOURCE_GROUP_NAME,
    "invalid_resource_group",
    "Azure resource group"
  );
  const registry = validatedArmSegment(
    registryValue,
    REGISTRY_NAME,
    "invalid_registry_name",
    "Azure Container Registry name"
  );
  if (runValue === undefined) return { rg, registry };
  return {
    rg,
    registry,
    runId: validatedArmSegment(runValue, RUN_ID, "invalid_run_id", "ACR run id")
  };
}

function validatedLoginServer(value: string, registry: string): string {
  const expected = `${registry.toLowerCase()}.azurecr.io`;
  if (value.toLowerCase() !== expected) {
    throw new HttpError(
      502,
      "invalid_registry_endpoint",
      "Azure returned an unexpected Container Registry endpoint"
    );
  }
  return expected;
}

const APP_SERVICE_PLAN_SPECS: Readonly<Record<string, { cores: string; ram: string; storage: string; family: string; hourly: number; monthly: number }>> = {
  F1:   { cores: "1 (shared)", ram: "1 GB",    storage: "1 GB",   family: "Free",      hourly: 0,      monthly: 0 },
  D1:   { cores: "1 (shared)", ram: "1 GB",    storage: "1 GB",   family: "Shared",    hourly: 0.013,  monthly: 9.50 },
  B1:   { cores: "1 (shared)", ram: "1.75 GB", storage: "10 GB",  family: "Basic",     hourly: 0.018,  monthly: 13.14 },
  B2:   { cores: "2 (shared)", ram: "3.5 GB",  storage: "10 GB",  family: "Basic",     hourly: 0.036,  monthly: 26.28 },
  B3:   { cores: "4 (shared)", ram: "7 GB",    storage: "10 GB",  family: "Basic",     hourly: 0.072,  monthly: 52.56 },
  S1:   { cores: "1 (shared)", ram: "1.75 GB", storage: "50 GB",  family: "Standard",  hourly: 0.10,   monthly: 73.00 },
  S2:   { cores: "2 (shared)", ram: "3.5 GB",  storage: "50 GB",  family: "Standard",  hourly: 0.20,   monthly: 146.00 },
  S3:   { cores: "4 (shared)", ram: "7 GB",    storage: "50 GB",  family: "Standard",  hourly: 0.40,   monthly: 292.00 },
  P0v3: { cores: "1 vCPU",    ram: "4 GB",    storage: "250 GB", family: "PremiumV3", hourly: 0.075,  monthly: 54.75 },
  P1v3: { cores: "2 vCPU",    ram: "8 GB",    storage: "250 GB", family: "PremiumV3", hourly: 0.150,  monthly: 109.50 },
  P2v3: { cores: "4 vCPU",    ram: "16 GB",   storage: "250 GB", family: "PremiumV3", hourly: 0.300,  monthly: 219.00 },
  P3v3: { cores: "8 vCPU",    ram: "32 GB",   storage: "250 GB", family: "PremiumV3", hourly: 0.600,  monthly: 438.00 },
};

const STATIC_NON_RUNTIME_USAGE = [
  { account: "enzol-mgr7gyi7-eastus2", deployment: "gpt-image-1", appName: "sudoku",
    via: "tools/_genlib.mjs (build-time)", kind: "build-time" },
  { account: "enzol-mgr7gyi7-eastus2", deployment: "gpt-image-2", appName: "sudoku",
    via: "lib/imageGen.mjs (build-time)", kind: "build-time" },
];

function rgFromId(id: string | null | undefined): string | null {
  return (id?.match(/\/resourceGroups\/([^/]+)/i) ?? [])[1] ?? null;
}

interface MetricResponse {
  value?: Array<{
    timeseries?: Array<{
      data?: Array<Record<string, unknown>>;
    }>;
  }>;
}

function summarizeMetric(metricResponse: MetricResponse | null | undefined, agg: string): { avg: number | null; max: number | null; latest: number | null } {
  const ts = metricResponse?.value?.[0]?.timeseries?.[0]?.data;
  if (!ts || ts.length === 0) return { avg: null, max: null, latest: null };
  const values = ts.map((d) => d[agg] as number | null | undefined).filter((v): v is number => v != null);
  if (values.length === 0) return { avg: null, max: null, latest: null };
  return {
    avg:    values.reduce((s, v) => s + v, 0) / values.length,
    max:    Math.max(...values),
    latest: values[values.length - 1] ?? null,
  };
}

function metricSeries(metricResponse: MetricResponse | null | undefined, agg: string): Array<{ t: unknown; v: number }> {
  const ts = metricResponse?.value?.[0]?.timeseries?.[0]?.data ?? [];
  return ts.map((d) => ({ t: d["timeStamp"], v: (d[agg] as number | null | undefined) ?? 0 }));
}

/**
 * The ARM SDK's metric response is structurally wider than the few fields this
 * module reads. Narrowing once, behind a runtime shape check, keeps the
 * conversion in a single place instead of a blind cast at every call site.
 */
function asMetricResponse(value: unknown): MetricResponse | null {
  if (!isRecord(value)) return null;
  return value.value === undefined || Array.isArray(value.value) ? value : null;
}

async function tryMetric(fn: () => Promise<unknown>): Promise<MetricResponse | null> {
  try { return asMetricResponse(await fn()); }
  catch (e1) {
    const err = e1 as { statusCode?: number };
    if (err.statusCode !== 429) return null;
    await new Promise<void>((r) => setTimeout(r, 1000));
    try { return asMetricResponse(await fn()); } catch { return null; }
  }
}

async function resolveCurrentBillingCycle(
  subscriptionId: string,
  now: Date = new Date()
): Promise<{ cycleStart: Date; cycleEnd: Date; source: string }> {
  try {
    const cred = new DefaultAzureCredential();
    const tokenResult = await cred.getToken("https://management.azure.com/.default");
    const r = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Billing/billingPeriods?api-version=2018-03-01-preview`,
      { headers: { Authorization: `Bearer ${tokenResult.token}` } }
    );
    if (r.ok) {
      const body = (await r.json()) as { value?: Array<{ properties?: { billingPeriodStartDate?: string; billingPeriodEndDate?: string } }> };
      const periods = (body.value ?? [])
        .filter((p) => p.properties?.billingPeriodStartDate && p.properties?.billingPeriodEndDate)
        .map((p) => ({
          start:        new Date(p.properties!.billingPeriodStartDate! + "T00:00:00Z"),
          endInclusive: new Date(p.properties!.billingPeriodEndDate!   + "T00:00:00Z"),
        }));
      const containing = periods.find((p) => {
        const exclusiveEnd = new Date(p.endInclusive.getTime() + 86400000);
        return now >= p.start && now < exclusiveEnd;
      });
      if (containing) {
        return {
          cycleStart: containing.start,
          cycleEnd:   new Date(containing.endInclusive.getTime() + 86400000),
          source:     "azure-billing-periods",
        };
      }
      if (periods.length > 0) {
        const mostRecent = periods.reduce((a, b) => (a.start > b.start ? a : b));
        const annDay = mostRecent.start.getUTCDate();
        const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), annDay));
        const cycleStart = candidate > now
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, annDay))
          : candidate;
        const cycleEnd = candidate > now
          ? candidate
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, annDay));
        return { cycleStart, cycleEnd, source: "computed-from-anniversary" };
      }
    }
  } catch (err) {
    console.warn("[azure] resolveCurrentBillingCycle failed:", (err as Error)?.message ?? err);
  }
  return {
    cycleStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    cycleEnd:   new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    source:     "calendar-month-fallback",
  };
}

interface CostRange {
  from: string;
  to: string;
  label: string;
  mode: string;
  days?: number;
}

async function resolveCostRange(
  subscriptionId: string,
  query: Record<string, unknown>
): Promise<CostRange> {
  const fromQ = queryString(query["from"]);
  const toQ = queryString(query["to"]);
  if (fromQ && toQ) {
    return {
      from:  fromQ + "T00:00:00Z",
      to:    toQ   + "T23:59:59Z",
      label: `${fromQ} → ${toQ}`,
      mode:  "custom",
    };
  }
  if (queryString(query["mode"]) === "cycle") {
    const now = new Date();
    const { cycleStart, cycleEnd } = await resolveCurrentBillingCycle(subscriptionId, now);
    const toDate = cycleEnd > now ? now : new Date(cycleEnd.getTime() - 1000);
    const fromIso = cycleStart.toISOString().slice(0, 10) + "T00:00:00Z";
    const toIso   = toDate.toISOString().slice(0, 10) + "T23:59:59Z";
    return {
      from:  fromIso,
      to:    toIso,
      label: `Cycle to date ${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`,
      mode:  "cycle",
    };
  }
  const days = Math.min(90, Math.max(1, typeof query["days"] === "string" ? (parseInt(query["days"]) || 30) : 30));
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);
  return {
    from:  from.toISOString().slice(0, 10) + "T00:00:00Z",
    to:    to.toISOString().slice(0, 10)   + "T23:59:59Z",
    label: `Last ${days} days`,
    mode:  "days",
    days,
  };
}

function armAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function createAzureRouter(deps: AzureRouterDependencies): Router {
  const { config, clients, cache } = deps;
  const { azure } = config;
  const router = Router();

  // Each route authorizes first and only then reveals whether the integration is
  // configured, so an unauthorized caller cannot probe the deployment's shape.
  const requireAzureEnabled: RequestHandler = (_req, res, next) => {
    if (!azure.enabled) {
      res.status(503).json({ error: "Azure integration is not configured on this server" });
      return;
    }
    next();
  };

  // Injectable HTTP seam. Every ACR log request goes through this so a test can
  // stub the upstream and prove no live Azure call is made.
  const httpFetch: typeof fetch = deps.fetch ?? fetch;

  // The credential is resolved lazily and per request. Tests always inject one,
  // so a real DefaultAzureCredential is never constructed under test.
  const acquireManagementToken = async (): Promise<string> => {
    const credential: TokenCredential = deps.credential ?? new DefaultAzureCredential();
    const result = await credential.getToken("https://management.azure.com/.default");
    const token = result?.token;
    if (!token) throw new Error("Azure management token unavailable");
    return token;
  };

  // Resolve a run's log SAS URL server-side. The returned URL is for immediate,
  // transient use by the caller only — it is never cached, logged or returned to
  // the browser.
  const resolveAcrRunLogSasUrl = async (rg: string, name: string, runId: string, token: string): Promise<string | null> => {
    const url =
      `https://management.azure.com/subscriptions/${azure.subscriptionId}` +
      `/resourceGroups/${encodedArmSegment(rg)}` +
      `/providers/Microsoft.ContainerRegistry/registries/${encodedArmSegment(name)}` +
      `/runs/${encodedArmSegment(runId)}` +
      `/listLogSasUrl?api-version=2019-06-01-preview`;
    const response = await httpFetch(url, {
      method: "POST",
      headers: { Authorization: `${AUTH_SCHEME} ${token}` },
      signal: armAbortSignal(azure.requestTimeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { logLink?: unknown };
    return typeof body.logLink === "string" && isTrustedAcrLogUrl(body.logLink)
      ? body.logLink
      : null;
  };

  // ── /api/azure/overview ─────────────────────────────────────────────────
  router.get(
    "/api/azure/overview",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const sig = armAbortSignal(azure.requestTimeoutMs);
      const overview = await cache.get("overview", 60, async () => {
        const [rgs, allResources, webApps, plans, acrs, cognitive] = await Promise.all([
          collect(clients.resources().resourceGroups.list({ abortSignal: sig })),
          collect(clients.resources().resources.list({ abortSignal: sig })),
          collect(clients.webApps().webApps.list({ abortSignal: sig })),
          collect(clients.webApps().appServicePlans.list({ abortSignal: sig })),
          collect(clients.acr().registries.list({ abortSignal: sig })),
          collect(clients.cognitive().accounts.list({ abortSignal: sig })),
        ]);
        const rgCounts: Record<string, number> = {};
        for (const r of allResources) {
          const k = rgFromId(r.id);
          if (!k) continue;
          rgCounts[k] = (rgCounts[k] ?? 0) + 1;
        }
        const memNow = Date.now();
        const startMem = new Date(memNow - 30 * 60 * 1000).toISOString();
        const endMem = new Date(memNow).toISOString();
        const memSamples = await Promise.all(webApps.map(async (w) => {
          const m = await tryMetric(() =>
            clients.monitor().metrics.list(w.id ?? "", {
              metricnames: "MemoryWorkingSet",
              timespan:    `${startMem}/${endMem}`,
              interval:    "PT5M",
              aggregation: "Average,Maximum",
              abortSignal: sig,
            })
          );
          const ts = m?.value?.[0]?.timeseries?.[0]?.data ?? [];
          const nonNull = ts.filter((p) => (p["maximum"] != null || p["average"] != null));
          const latest = nonNull[nonNull.length - 1];
          return {
            name:        w.name,
            state:       w.state,
            bytes:       (latest?.["average"] ?? latest?.["maximum"] ?? null) as number | null,
            bytesPeak30: nonNull.reduce((a, p) => Math.max(a, (p["maximum"] as number | null | undefined) ?? 0), 0) || null,
            bytesAvg30:  nonNull.length ? nonNull.reduce((s, p) => s + ((p["average"] as number | null | undefined) ?? 0), 0) / nonNull.length : null,
            sampleAt:    (latest?.["timeStamp"] ?? null) as string | null,
          };
        }));
        const aggregates = {
          totalMemoryBytes: memSamples.reduce((s, x) => s + (x.bytes ?? 0), 0),
          webAppMemorySamples: memSamples,
          calculation: "Sum of each web app's most recent MemoryWorkingSet (5-min granularity, last 30 min window). Concurrent snapshot — not a sum of peaks.",
        };
        return {
          subscription: { id: azure.subscriptionId, tenantId: azure.tenantId },
          counts: {
            resourceGroups:    rgs.length,
            resources:         allResources.length,
            webApps:           webApps.length,
            appServicePlans:   plans.length,
            acrRegistries:     acrs.length,
            cognitiveAccounts: cognitive.length,
          },
          resourceGroups: rgs.map((rg) => ({
            name:          rg.name,
            location:      rg.location,
            tags:          rg.tags ?? {},
            resourceCount: rgCounts[rg.name ?? ""] ?? 0,
          })),
          webAppsByState: webApps.reduce((acc: Record<string, number>, w) => {
            const k = w.state ?? "Unknown";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {}),
          aggregates,
        };
      });
      res.json(overview);
    })
  );

  // ── /api/azure/budget ───────────────────────────────────────────────────
  router.get(
    "/api/azure/budget",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const data = await cache.get("budget", 120, async () => {
        const cred = new DefaultAzureCredential();
        const tokenResult = await cred.getToken("https://management.azure.com/.default");
        const arm = (path: string) =>
          fetch(`https://management.azure.com${path}`, {
            headers: { Authorization: `${AUTH_SCHEME} ${tokenResult.token}` },
            signal: armAbortSignal(azure.requestTimeoutMs),
          });

        let userBudgets: unknown[] = [];
        try {
          const r = await arm(`/subscriptions/${azure.subscriptionId}/providers/Microsoft.Consumption/budgets?api-version=2021-10-01`);
          if (r.ok) {
            const body = (await r.json()) as { value?: Array<{ name?: string; properties?: { amount?: number; timeGrain?: string; timePeriod?: { startDate?: string; endDate?: string }; currentSpend?: { amount?: number; unit?: string }; currencyCode?: string } }> };
            userBudgets = (body.value ?? []).map((b) => ({
              name:         b.name,
              amount:       b.properties?.amount,
              timeGrain:    b.properties?.timeGrain,
              startDate:    b.properties?.timePeriod?.startDate,
              endDate:      b.properties?.timePeriod?.endDate,
              currentSpend: b.properties?.currentSpend?.amount,
              unit:         b.properties?.currentSpend?.unit ?? b.properties?.currencyCode ?? "USD",
            }));
          }
        } catch (_) { /* keep userBudgets = [] */ }

        const now = new Date();
        const { cycleStart, cycleEnd, source } = await resolveCurrentBillingCycle(azure.subscriptionId, now);
        const daysLeft = Math.max(0, Math.ceil((cycleEnd.getTime() - now.getTime()) / 86400000));
        const daysElapsed = Math.max(1, Math.floor((now.getTime() - cycleStart.getTime()) / 86400000) + 1);
        const cycleDays = Math.round((cycleEnd.getTime() - cycleStart.getTime()) / 86400000);

        let mtdSpend = 0;
        let currency = "USD";
        const cycleStartIso = cycleStart.toISOString().slice(0, 10) + "T00:00:00Z";
        const costEndDate = cycleEnd > now ? now : new Date(cycleEnd.getTime() - 1000);
        const cycleEndIso = costEndDate.toISOString().slice(0, 10) + "T23:59:59Z";
        try {
          const cost = await clients.cost().query.usage(`/subscriptions/${azure.subscriptionId}`, {
            type: "ActualCost",
            timeframe: "Custom",
            timePeriod: { from: new Date(cycleStartIso), to: new Date(cycleEndIso) },
            dataset: {
              granularity: "None",
              aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
            },
          });
          const cols = (cost?.columns ?? []).map((c) => c.name);
          const cCol = cols.indexOf("PreTaxCost");
          const curCol = cols.indexOf("Currency");
          mtdSpend = Number(cost?.rows?.[0]?.[cCol]) || 0;
          currency = asText(cost?.rows?.[0]?.[curCol], "USD");
        } catch (_) { /* keep mtdSpend = 0 */ }

        const dailyAvg = mtdSpend / daysElapsed;
        const projected = dailyAvg * cycleDays;
        return {
          cycle: {
            startDate:  cycleStart.toISOString(),
            endDate:    cycleEnd.toISOString(),
            daysElapsed,
            daysLeft,
            cycleDays,
            source,
          },
          currency,
          mtdSpend,
          dailyAvg,
          projectedTotal: projected,
          vsEnterpriseCredit: 150,
          userBudgets,
        };
      });
      res.json(data);
    })
  );

  // ── /api/azure/resource ─────────────────────────────────────────────────
  router.get(
    "/api/azure/resource",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const id = queryString(req.query["id"]);
      if (!id) return void res.status(400).json({ error: "id query param is required" });
      const apiVersion = queryString(req.query["apiVersion"]) ?? "2021-04-01";
      const key = `resource:${id}`;
      const data = await cache.get(key, 300, async () => {
        const r = await clients.resources().resources.getById(id, apiVersion, { abortSignal: armAbortSignal(azure.requestTimeoutMs) });
        return {
          id: r.id, name: r.name, type: r.type, kind: r.kind,
          location: r.location, tags: r.tags ?? {}, sku: r.sku ?? null,
          properties: (r.properties as unknown) ?? null, plan: r.plan ?? null,
          identity: r.identity ?? null, managedBy: r.managedBy ?? null,
          createdTime: (r as unknown as Record<string, unknown>)["createdTime"], changedTime: (r as unknown as Record<string, unknown>)["changedTime"],
        };
      });
      res.json(data);
    })
  );

  // ── /api/azure/resources ────────────────────────────────────────────────
  router.get(
    "/api/azure/resources",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const all = await cache.get("resources-flat", 600, async () =>
        collect(clients.resources().resources.list({ abortSignal: armAbortSignal(azure.requestTimeoutMs) }))
      );
      let filtered = all;
      const rgFilter = queryString(req.query["rg"]);
      const typeFilter = queryString(req.query["type"]);
      if (rgFilter) {
        const rg = rgFilter.toLowerCase();
        filtered = filtered.filter((r) => (r.id ?? "").toLowerCase().includes(`/resourcegroups/${rg}/`));
      }
      if (typeFilter) {
        const t = typeFilter.toLowerCase();
        filtered = filtered.filter((r) => (r.type ?? "").toLowerCase() === t);
      }
      res.json({
        total: filtered.length,
        data: filtered.map((r) => ({
          id:            r.id,
          name:          r.name,
          type:          r.type,
          kind:          r.kind,
          location:      r.location,
          tags:          r.tags ?? {},
          resourceGroup: rgFromId(r.id),
        })),
      });
    })
  );

  // ── /api/azure/webapps ──────────────────────────────────────────────────
  router.get(
    "/api/azure/webapps",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const apps = await cache.get("webapps-list", 300, async () => {
        const list = await collect(clients.webApps().webApps.list({ abortSignal: armAbortSignal(azure.requestTimeoutMs) }));
        return list.map((a) => ({
          name:             a.name,
          resourceGroup:    rgFromId(a.id),
          location:         a.location,
          state:            a.state,
          kind:             a.kind,
          defaultHostName:  a.defaultHostName,
          enabledHostNames: a.enabledHostNames,
          httpsOnly:        a.httpsOnly,
          linuxFxVersion:   a.siteConfig?.linuxFxVersion,
          planId:           a.serverFarmId,
          planName:         a.serverFarmId?.split("/").pop() ?? null,
          lastModifiedTime: a.lastModifiedTimeUtc,
        }));
      });
      res.json({ data: apps });
    })
  );

  // ── /api/azure/webapps/:rg/:name ────────────────────────────────────────
  router.get(
    "/api/azure/webapps/:rg/:name",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const rg = pathParam(req.params["rg"]);
      const name = pathParam(req.params["name"]);
      const key = `webapp-detail:${rg}:${name}`;
      const sig = armAbortSignal(azure.requestTimeoutMs);
      const detail = await cache.get(key, 180, async () => {
        const [site, settings, hostnames, slots] = await Promise.all([
          clients.webApps().webApps.get(rg, name, { abortSignal: sig }),
          clients.webApps().webApps.listApplicationSettings(rg, name).catch((e: { statusCode?: number; code?: string; message?: string }) => {
            console.warn(`listApplicationSettings ${rg}/${name}: ${e.statusCode ?? ""} ${e.code ?? ""} ${e.message ?? "unknown"}`);
            return { properties: {} };
          }),
          collect(clients.webApps().webApps.listHostNameBindings(rg, name)),
          collect(clients.webApps().webApps.listSlots(rg, name)).catch(() => []),
        ]);
        const resourceUri = site.id ?? "";
        const endIso = new Date().toISOString();
        const startIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const [memMetric, cpuMetric, reqMetric, errMetric] = await Promise.all([
          tryMetric(() => clients.monitor().metrics.list(resourceUri, { metricnames: "MemoryWorkingSet", timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Average,Maximum", abortSignal: sig })),
          tryMetric(() => clients.monitor().metrics.list(resourceUri, { metricnames: "CpuTime",          timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Total",           abortSignal: sig })),
          tryMetric(() => clients.monitor().metrics.list(resourceUri, { metricnames: "Requests",         timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Total",           abortSignal: sig })),
          tryMetric(() => clients.monitor().metrics.list(resourceUri, { metricnames: "Http5xx",          timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Total",           abortSignal: sig })),
        ]);
        return {
          name:             site.name,
          state:            site.state,
          kind:             site.kind,
          location:         site.location,
          resourceId:       site.id,
          defaultHostName:  site.defaultHostName,
          enabledHostNames: site.enabledHostNames,
          httpsOnly:        site.httpsOnly,
          linuxFxVersion:   site.siteConfig?.linuxFxVersion,
          numberOfWorkers:  site.siteConfig?.numberOfWorkers,
          alwaysOn:         site.siteConfig?.alwaysOn,
          acrUseManagedIdentityCreds: site.siteConfig?.acrUseManagedIdentityCreds,
          clientCertEnabled: site.clientCertEnabled,
          clientAffinityEnabled: site.clientAffinityEnabled,
          reserved:         site.reserved,
          minTlsVersion:    site.siteConfig?.minTlsVersion,
          ftpsState:        site.siteConfig?.ftpsState,
          http20Enabled:    site.siteConfig?.http20Enabled,
          planId:           site.serverFarmId,
          planName:         site.serverFarmId?.split("/").pop() ?? null,
          lastModifiedTime: site.lastModifiedTimeUtc,
          createdTime:      (site as unknown as Record<string, unknown>)["containerSize"] ? null : ((site as unknown as Record<string, unknown>)["createdTime"] ?? null),
          appSettings:      Object.keys(settings.properties ?? {}).sort(),
          hostnameBindings: hostnames.map((h) => ({
            name:       h.name,
            siteName:   h.siteName,
            sslState:   h.sslState,
            thumbprint: h.thumbprint,
            customHostNameDnsRecordType: h.customHostNameDnsRecordType,
            hostNameType: h.hostNameType,
          })),
          slots: slots.map((s) => ({ name: s.name, state: s.state })),
          identity: site.identity ? {
            principalId: site.identity.principalId,
            tenantId:    site.identity.tenantId,
            type:        site.identity.type,
          } : null,
          tags: site.tags ?? {},
          memory24h:     summarizeMetric(memMetric, "maximum"),
          cpuSeconds24h: summarizeMetric(cpuMetric, "total"),
          requests24h:   summarizeMetric(reqMetric, "total"),
          errors24h:     summarizeMetric(errMetric, "total"),
          series: {
            memory:   metricSeries(memMetric, "maximum"),
            cpu:      metricSeries(cpuMetric, "total"),
            requests: metricSeries(reqMetric, "total"),
            errors:   metricSeries(errMetric, "total"),
          },
        };
      });
      res.json(detail);
    })
  );

  // ── /api/azure/webapps/:rg/:name/metrics ────────────────────────────────
  router.get(
    "/api/azure/webapps/:rg/:name/metrics",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const rg = pathParam(req.params["rg"]);
      const name = pathParam(req.params["name"]);
      const metric = queryString(req.query["metric"]) ?? "CpuPercentage";
      const hours = queryInteger(req.query["hours"], 24, 1, 168);
      const interval = queryString(req.query["interval"]) ?? (hours <= 6 ? "PT5M" : hours <= 24 ? "PT1H" : "PT6H");
      const key = `webapp-metrics:${rg}:${name}:${metric}:${hours}:${interval}`;
      const sig = armAbortSignal(azure.requestTimeoutMs);
      const data = await cache.get(key, 180, async () => {
        const site = await clients.webApps().webApps.get(rg, name, { abortSignal: sig });
        const endIso = new Date().toISOString();
        const startIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const r = await clients.monitor().metrics.list(site.id ?? "", {
          metricnames: metric,
          timespan:    `${startIso}/${endIso}`,
          interval,
          aggregation: "Average,Maximum",
          abortSignal: sig,
        }) as MetricResponse;
        const ts = r?.value?.[0]?.timeseries?.[0]?.data ?? [];
        return {
          metric,
          hours,
          interval,
          points: ts.map((p) => ({
            t:   p["timeStamp"],
            avg: (p["average"] as number | null | undefined) ?? null,
            max: (p["maximum"] as number | null | undefined) ?? null,
          })),
        };
      });
      res.json(data);
    })
  );

  // ── /api/azure/plans ────────────────────────────────────────────────────
  router.get(
    "/api/azure/plans",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const sig = armAbortSignal(azure.requestTimeoutMs);
      const plans = await cache.get("plans-list", 300, async () => {
        const list = await collect(clients.webApps().appServicePlans.list({ abortSignal: sig }));
        const withMetrics = await Promise.all(list.map(async (p) => {
          const rg = rgFromId(p.id) ?? azure.defaultResourceGroup;
          const endIso = new Date().toISOString();
          const startIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
          const [cpu, mem, diskQ, httpQ, bIn, bOut] = await Promise.all([
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "CpuPercentage",    timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Average,Maximum", abortSignal: sig })),
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "MemoryPercentage", timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Average,Maximum", abortSignal: sig })),
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "DiskQueueLength",  timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Average,Maximum", abortSignal: sig })),
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "HttpQueueLength",  timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Average,Maximum", abortSignal: sig })),
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "BytesReceived",    timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Total",           abortSignal: sig })),
            tryMetric(() => clients.monitor().metrics.list(p.id ?? "", { metricnames: "BytesSent",        timespan: `${startIso}/${endIso}`, interval: "PT1H", aggregation: "Total",           abortSignal: sig })),
          ]);
          let sites: unknown[] = [];
          try {
            const siteList = await collect(clients.webApps().appServicePlans.listWebApps(rg, p.name ?? ""));
            sites = siteList.map((s) => ({
              name:            s.name,
              state:           s.state,
              kind:            s.kind,
              defaultHostName: s.defaultHostName,
              httpsOnly:       s.httpsOnly,
              linuxFxVersion:  s.siteConfig?.linuxFxVersion,
              resourceGroup:   rgFromId(s.id) ?? rg,
            }));
          } catch (err) {
            console.warn(`[azure/plans] listWebApps failed for ${p.name ?? "?"}:`, (err as Error)?.message ?? err);
          }
          const skuSpec  = APP_SERVICE_PLAN_SPECS[p.sku?.name ?? ""] ?? null;
          const capacity = p.sku?.capacity ?? 1;
          const locKey   = (p.location ?? "").toLowerCase().replace(/\s+/g, "");
          const pricing  = (skuSpec && locKey === "eastus")
            ? { hourly: skuSpec.hourly * capacity, monthly: skuSpec.monthly * capacity, region: p.location }
            : null;
          return {
            name:          p.name,
            resourceGroup: rg,
            location:      p.location,
            kind:          p.kind,
            skuName:       p.sku?.name,
            skuTier:       p.sku?.tier,
            skuSize:       p.sku?.size,
            skuFamily:     p.sku?.family,
            capacity,
            skuSpec,
            pricing,
            reserved:      p.reserved,
            isXenon:       p.isXenon,
            hyperV:        p.hyperV,
            isSpot:        p.isSpot,
            spotExpirationTime: p.spotExpirationTime,
            freeOfferExpirationTime: p.freeOfferExpirationTime,
            perSiteScaling: p.perSiteScaling,
            elasticScaleEnabled: p.elasticScaleEnabled,
            maximumElasticWorkerCount: p.maximumElasticWorkerCount,
            maximumNumberOfWorkers: p.maximumNumberOfWorkers,
            numberOfWorkers: p.numberOfWorkers,
            targetWorkerCount: p.targetWorkerCount,
            targetWorkerSizeId: p.targetWorkerSizeId,
            workerTierName: p.workerTierName,
            zoneRedundant:  p.zoneRedundant,
            status:         p.status,
            provisioningState: p.provisioningState,
            geoRegion:      p.geoRegion,
            adminSiteName:  (p as unknown as Record<string, unknown>)["adminSiteName"],
            numberOfSites:  p.numberOfSites,
            tags:           p.tags ?? {},
            cpu24h:         summarizeMetric(cpu,   "average"),
            cpu24hPeak:     summarizeMetric(cpu,   "maximum"),
            memory24h:      summarizeMetric(mem,   "average"),
            memory24hPeak:  summarizeMetric(mem,   "maximum"),
            diskQueue24h:   summarizeMetric(diskQ, "maximum"),
            httpQueue24h:   summarizeMetric(httpQ, "maximum"),
            bytesIn24h:     summarizeMetric(bIn,   "total"),
            bytesOut24h:    summarizeMetric(bOut,  "total"),
            sites,
            series: {
              cpu:           metricSeries(cpu,   "average"),
              memory:        metricSeries(mem,   "average"),
              diskQueue:     metricSeries(diskQ, "maximum"),
              httpQueue:     metricSeries(httpQ, "maximum"),
              bytesReceived: metricSeries(bIn,   "total"),
              bytesSent:     metricSeries(bOut,  "total"),
            },
          };
        }));
        return withMetrics;
      });
      res.json({ data: plans });
    })
  );

  // ── /api/azure/acr ──────────────────────────────────────────────────────
  router.get(
    "/api/azure/acr",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const regs = await cache.get("acr-list", 900, async () => {
        const list = await collect(clients.acr().registries.list({ abortSignal: armAbortSignal(azure.requestTimeoutMs) }));
        return list.map((r) => ({
          name:          r.name,
          resourceGroup: rgFromId(r.id),
          location:      r.location,
          sku:           r.sku?.name,
          loginServer:   r.loginServer,
          adminEnabled:  r.adminUserEnabled,
          createdAt:     r.creationDate,
          publicNetworkAccess: r.publicNetworkAccess,
        }));
      });
      res.json({ data: regs });
    })
  );

  // ── /api/azure/acr/:rg/:name/runs ───────────────────────────────────────
  router.get(
    "/api/azure/acr/:rg/:name/runs",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const { rg, registry: name } = acrRouteValues(
        pathParam(req.params["rg"]),
        pathParam(req.params["name"])
      );
      const limit = queryInteger(req.query["limit"], 20, 1, 50);
      const key = `acr-runs:${rg}:${name}:${limit}`;
      const runs = await cache.get(key, 180, async () => {
        const token = await acquireManagementToken();
        const url = `https://management.azure.com/subscriptions/${azure.subscriptionId}` +
                    `/resourceGroups/${encodedArmSegment(rg)}` +
                    `/providers/Microsoft.ContainerRegistry/registries/${encodedArmSegment(name)}` +
                    `/runs?api-version=2019-06-01-preview&$top=${limit}`;
        const r = await httpFetch(url, {
          headers: { Authorization: `${AUTH_SCHEME} ${token}` },
          signal: armAbortSignal(azure.requestTimeoutMs),
        });
        if (!r.ok) throw new Error(`ARM /runs failed: ${r.status} ${await r.text()}`);
        const body = (await r.json()) as { value?: Array<{ name?: string; properties?: Record<string, unknown> }> };
        return (body.value ?? []).map((run) => {
          const p = (run.properties ?? {});
          return {
            runId:      run.name,
            status:     p["status"],
            runType:    p["runType"],
            createTime: p["createTime"],
            startTime:  p["startTime"],
            finishTime: p["finishTime"],
            imageManifests: ((p["outputImages"] as Array<{ registry?: string; repository?: string; tag?: string }> | undefined) ?? []).map((i) => `${i.registry ?? ""}/${i.repository ?? ""}:${i.tag ?? ""}`),
            isArchiveEnabled: p["isArchiveEnabled"],
          };
        });
      });
      res.json({ data: runs });
    })
  );

  // ── /api/azure/acr/:rg/:name/runs/:runId ────────────────────────────────
  router.get(
    "/api/azure/acr/:rg/:name/runs/:runId",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const values = acrRouteValues(
        pathParam(req.params["rg"]),
        pathParam(req.params["name"]),
        pathParam(req.params["runId"])
      );
      const { rg, registry: name } = values;
      const runId = values.runId!;
      const key = `acr-run-detail:${rg}:${name}:${runId}`;
      const detail = await cache.get(key, 180, async () => {
        const token = await acquireManagementToken();
        const runUrl =
          `https://management.azure.com/subscriptions/${azure.subscriptionId}` +
          `/resourceGroups/${encodedArmSegment(rg)}` +
          `/providers/Microsoft.ContainerRegistry/registries/${encodedArmSegment(name)}` +
          `/runs/${encodedArmSegment(runId)}` +
          `?api-version=2019-06-01-preview`;
        const runR = await httpFetch(runUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: armAbortSignal(azure.requestTimeoutMs),
        });
        if (!runR.ok) throw new Error(`ARM run get failed: ${runR.status}`);
        const run = (await runR.json()) as { name?: string; properties?: Record<string, unknown> };
        const p = (run.properties ?? {});

        // The registry hands out a replayable SAS URL for the log blob. It is
        // resolved and read entirely server-side: the browser receives a
        // sanitized tail plus a boolean and fetches the full log through the
        // bounded /log proxy — never the SAS itself.
        let logAvailable = false;
        let logTail: string | null = null;
        const sasUrl = await resolveAcrRunLogSasUrl(rg, name, runId, token);
        if (sasUrl) {
          logAvailable = true;
          const log = await fetchAcrRunLog(sasUrl, httpFetch, { maxBytes: ACR_LOG_MAX_BYTES, timeoutMs: azure.requestTimeoutMs });
          if (log.ok) {
            logTail = log.text.length > ACR_LOG_TAIL_CHARS ? log.text.slice(-ACR_LOG_TAIL_CHARS) : log.text;
          }
        }
        type OutputImage = { registry?: string; repository?: string; tag?: string; digest?: string };
        return {
          runId:           run.name,
          status:          p["status"],
          runType:         p["runType"],
          createTime:      p["createTime"],
          startTime:       p["startTime"],
          finishTime:      p["finishTime"],
          lastUpdatedTime: p["lastUpdatedTime"],
          isArchiveEnabled: p["isArchiveEnabled"],
          provisioningState: p["provisioningState"],
          runErrorMessage: p["runErrorMessage"],
          taskName:        p["task"],
          agentConfiguration: p["agentConfiguration"] ?? null,
          platform:        p["platform"] ?? null,
          sourceTrigger:   p["sourceTrigger"] ?? null,
          sourceRegistryAuth: p["sourceRegistryAuth"] ?? null,
          imageUpdateTrigger: p["imageUpdateTrigger"] ?? null,
          timerTrigger:    p["timerTrigger"] ?? null,
          outputImages:    ((p["outputImages"] as OutputImage[] | undefined) ?? []).map((i) => ({
            registry:   i.registry,
            repository: i.repository,
            tag:        i.tag,
            digest:     i.digest,
          })),
          customRegistries: p["customRegistries"] ?? null,
          logAvailable,
          logTail,
        };
      });
      res.json(detail);
    })
  );

  // ── /api/azure/acr/:rg/:name/runs/:runId/log ────────────────
  // Bounded, authenticated proxy for a run's build log. The SAS URL is resolved
  // server-side per request; the blob is read under a byte/timeout budget and an
  // expected content type; the response is sanitized text with no upstream URL.
  // This replaces handing a replayable SAS URL to the browser.
  router.get(
    "/api/azure/acr/:rg/:name/runs/:runId/log",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const values = acrRouteValues(
        pathParam(req.params["rg"]),
        pathParam(req.params["name"]),
        pathParam(req.params["runId"])
      );
      const { rg, registry: name } = values;
      const runId = values.runId!;

      const token = await acquireManagementToken();
      const sasUrl = await resolveAcrRunLogSasUrl(rg, name, runId, token);
      if (!sasUrl) {
        res.status(404).json({ error: { code: "log_unavailable", message: "No build log is available for this run" } });
        return;
      }

      const log = await fetchAcrRunLog(sasUrl, httpFetch, { maxBytes: ACR_LOG_MAX_BYTES, timeoutMs: azure.requestTimeoutMs });
      if (!log.ok) {
        const mapped = ACR_LOG_ERROR_RESPONSES[log.reason];
        res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
        return;
      }

      res.status(200).json({ runId, log: log.text, bytes: log.bytes, truncated: log.truncated });
    })
  );

  // ── /api/azure/acr/:rg/:name/repositories ───────────────────────────────
  router.get(
    "/api/azure/acr/:rg/:name/repositories",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const { rg, registry: name } = acrRouteValues(
        pathParam(req.params["rg"]),
        pathParam(req.params["name"])
      );
      const key = `acr-repos:${rg}:${name}`;
      const repos = await cache.get(key, 600, async () => {
        const sig = armAbortSignal(azure.requestTimeoutMs);
        const reg = await clients.acr().registries.get(rg, name, { abortSignal: sig });
        const loginServer = validatedLoginServer(reg.loginServer ?? "", name);
        const aadToken = await acquireManagementToken();
        const exchangeRes = await httpFetch(`https://${loginServer}/oauth2/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type:   "access_token",
            service:      loginServer,
            access_token: aadToken,
          }),
          signal: sig,
        });
        if (!exchangeRes.ok) throw new Error(`ACR token exchange failed: ${exchangeRes.status}`);
        const { refresh_token: refreshToken } = (await exchangeRes.json()) as { refresh_token: string };
        const accessRes = await httpFetch(`https://${loginServer}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type:    "refresh_token",
            service:       loginServer,
            scope:         "registry:catalog:*",
            refresh_token: refreshToken,
          }),
          signal: sig,
        });
        if (!accessRes.ok) throw new Error(`ACR access token failed: ${accessRes.status}`);
        const { access_token: accessToken } = (await accessRes.json()) as { access_token: string };
        const catRes = await httpFetch(`https://${loginServer}/v2/_catalog?n=200`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: sig,
        });
        if (!catRes.ok) throw new Error(`ACR catalog failed: ${catRes.status}`);
        const { repositories } = (await catRes.json()) as { repositories?: string[] };
        return repositories ?? [];
      });
      res.json({ data: repos });
    })
  );

  // ── /api/azure/cognitive ────────────────────────────────────────────────
  router.get(
    "/api/azure/cognitive",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (_req, res) => {
      const sig = armAbortSignal(azure.requestTimeoutMs);
      const accounts = await cache.get("cognitive-accounts", 600, async () => {
        const list = await collect(clients.cognitive().accounts.list({ abortSignal: sig }));
        const withDeployments = await Promise.all(list.map(async (a) => {
          const rg = rgFromId(a.id);
          let deployments: Array<{
            name: string | undefined;
            model: string | undefined;
            version: string | undefined;
            format: string | undefined;
            sku: string | undefined;
            capacity: number | undefined;
            state: string | undefined;
            referencedBy: Array<{ name: string; resourceGroup: string | null; settingKeys: string[]; via?: string; kind: string }>;
          }> = [];
          if (rg && a.name) {
            try {
              const deps = await collect(clients.cognitive().deployments.list(rg, a.name));
              deployments = deps.map((d) => ({
                name:      d.name,
                model:     d.properties?.model?.name,
                version:   d.properties?.model?.version,
                format:    d.properties?.model?.format,
                sku:       d.sku?.name,
                capacity:  d.sku?.capacity,
                state:     d.properties?.provisioningState,
                referencedBy: [],
              }));
            } catch { /* no deployments or no permission */ }
          }
          return {
            name:         a.name,
            resourceGroup: rg,
            location:     a.location,
            kind:         a.kind,
            sku:          a.sku?.name,
            endpoint:     a.properties?.endpoint,
            provisioningState: a.properties?.provisioningState,
            deployments,
          };
        }));

        // Discover which web apps reference each deployment.
        try {
          const webApps = await collect(clients.webApps().webApps.list({ abortSignal: sig }));
          const appSettings = await Promise.all(webApps.map(async (w) => {
            const wRg = rgFromId(w.id);
            try {
              const s = await clients.webApps().webApps.listApplicationSettings(wRg ?? "", w.name ?? "");
              return { name: w.name ?? "", resourceGroup: wRg, settings: s.properties ?? {} };
            } catch (e) {
              const err = e as { statusCode?: number; code?: string; message?: string };
              console.warn(`listApplicationSettings ${wRg ?? "?"}/${w.name ?? "?"}: ${err.statusCode ?? ""} ${err.code ?? ""} ${err.message ?? "unknown"}`);
              return { name: w.name ?? "", resourceGroup: wRg, settings: {} };
            }
          }));

          const referencesAccount = (values: string[], accountName: string): boolean => {
            const prefix = accountName.toLowerCase() + ".";
            for (const v of values) {
              try { if (new URL(v).hostname.toLowerCase().startsWith(prefix)) return true; } catch { /* not a URL */ }
            }
            return false;
          };

          for (const account of withDeployments) {
            if (!account.name) continue;
            for (const dep of account.deployments) {
              for (const app of appSettings) {
                const values = Object.values(app.settings).filter((v): v is string => typeof v === "string");
                const usesAccount = referencesAccount(values, account.name);
                const usesDeployment = values.some((v) => v === dep.name);
                if (usesAccount && usesDeployment) {
                  const keys = Object.entries(app.settings)
                    .filter(([, v]) => v === dep.name)
                    .map(([k]) => k);
                  dep.referencedBy.push({
                    name: app.name,
                    resourceGroup: app.resourceGroup ?? null,
                    settingKeys: keys,
                    kind: "runtime",
                  });
                }
              }
            }
          }

          const appNameSet = new Set(appSettings.map((a) => a.name.toLowerCase()));
          const findRealApp = (alias: string) => {
            const a = alias.toLowerCase();
            if (appNameSet.has(a)) return appSettings.find((x) => x.name.toLowerCase() === a);
            for (const x of appSettings) {
              const stripped = x.name.toLowerCase().replace(/^app-/, "").replace(/-prod-[a-z0-9]+$/, "");
              if (stripped === a) return x;
            }
            return null;
          };
          for (const entry of STATIC_NON_RUNTIME_USAGE) {
            const acct = withDeployments.find((a) => a.name === entry.account);
            if (!acct) continue;
            const dep = acct.deployments.find((d) => d.name === entry.deployment);
            if (!dep) continue;
            const real = findRealApp(entry.appName);
            dep.referencedBy.push({
              name:          real?.name ?? entry.appName,
              resourceGroup: real?.resourceGroup ?? null,
              settingKeys:   [],
              via:           entry.via,
              kind:          entry.kind,
            });
          }
        } catch (e) {
          console.warn("Cognitive deployment usage discovery skipped:", (e as Error).message);
        }

        return withDeployments;
      });
      res.json({ data: accounts });
    })
  );

  // ── /api/azure/cognitive/:rg/:account/deployments/:name ─────────────────
  router.get(
    "/api/azure/cognitive/:rg/:account/deployments/:name",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const rg = pathParam(req.params["rg"]);
      const account = pathParam(req.params["account"]);
      const name = pathParam(req.params["name"]);
      const key = `cog-dep-detail:${rg}:${account}:${name}`;
      const detail = await cache.get(key, 180, async () => {
        const d = await clients.cognitive().deployments.get(rg, account, name, { abortSignal: armAbortSignal(azure.requestTimeoutMs) });
        const p = d.properties ?? {};
        return {
          name:               d.name,
          id:                 d.id,
          etag:               d.etag,
          sku:                d.sku ?? null,
          systemData:         d.systemData ?? null,
          provisioningState:  p.provisioningState,
          model: {
            format:    p.model?.format,
            name:      p.model?.name,
            version:   p.model?.version,
            publisher: p.model?.publisher ?? null,
            source:    p.model?.source ?? null,
          },
          capabilities:        p.capabilities ?? null,
          raiPolicyName:       p.raiPolicyName ?? null,
          versionUpgradeOption: p.versionUpgradeOption ?? null,
          currentCapacity:     p.currentCapacity ?? null,
          rateLimits:          p.rateLimits ?? null,
          scaleSettings:       p.scaleSettings ?? null,
          dynamicThrottlingEnabled: p.dynamicThrottlingEnabled ?? null,
          callRateLimit:       p.callRateLimit ?? null,
          parentDeploymentName: p.parentDeploymentName ?? null,
          raw:                 d,
        };
      });
      res.json(detail);
    })
  );

  // ── /api/azure/cost ──────────────────────────────────────────────────────
  router.get(
    "/api/azure/cost",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const range = await resolveCostRange(azure.subscriptionId, req.query);
      const key = `cost:${range.mode}:${range.from}:${range.to}`;
      const data = await cache.get(key, 600, async () => {
        const scope = `/subscriptions/${azure.subscriptionId}`;
        const raw = await clients.cost().query.usage(scope, {
          type:      "ActualCost",
          timeframe: "Custom",
          timePeriod: { from: new Date(range.from), to: new Date(range.to) },
          dataset: {
            granularity: "Daily",
            aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
            grouping: [{ type: "Dimension", name: "ServiceName" }],
          },
        });
        const cols = (raw?.columns ?? []).map((c) => c.name);
        const dateCol = cols.indexOf("UsageDate");
        const costCol = cols.indexOf("PreTaxCost");
        const svcCol  = cols.indexOf("ServiceName");
        const curCol  = cols.indexOf("Currency");
        const dailyByService = (raw?.rows ?? []).map((r) => ({
          date:    asText(r[dateCol]),
          service: asText(r[svcCol]),
          cost:    Number(r[costCol]) || 0,
        }));
        const currency = asText(raw?.rows?.[0]?.[curCol], "USD");
        const dailyMap = new Map<string, number>();
        for (const row of dailyByService) {
          dailyMap.set(row.date, (dailyMap.get(row.date) ?? 0) + row.cost);
        }
        const daily = [...dailyMap.entries()]
          .map(([date, cost]) => ({ date, cost, currency }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const svcMap = new Map<string, number>();
        for (const row of dailyByService) {
          svcMap.set(row.service, (svcMap.get(row.service) ?? 0) + row.cost);
        }
        const services = [...svcMap.entries()]
          .map(([service, cost]) => ({ service, cost }))
          .sort((a, b) => b.cost - a.cost);
        const total = daily.reduce((s, d) => s + d.cost, 0);
        return {
          mode:     range.mode,
          label:    range.label,
          days:     range.days ?? daily.length,
          from:     range.from.slice(0, 10),
          to:       range.to.slice(0, 10),
          total,
          currency: daily[0]?.currency ?? "USD",
          daily,
          services,
          dailyByService,
        };
      });
      res.json(data);
    })
  );

  // ── /api/azure/cost/service ──────────────────────────────────────────────
  router.get(
    "/api/azure/cost/service",
    requireRole("viewer"),
    requireAzureEnabled,
    asyncHandler(async (req, res) => {
      const service = queryString(req.query["service"]);
      if (!service) return void res.status(400).json({ error: "service query param is required" });
      const range = await resolveCostRange(azure.subscriptionId, req.query);
      const key = `cost-service:${service}:${range.mode}:${range.from}:${range.to}`;
      const data = await cache.get(key, 600, async () => {
        const scope = `/subscriptions/${azure.subscriptionId}`;
        const baseFilter = {
          dimensions: { name: "ServiceName", operator: "In", values: [service] },
        };
        const dailyRaw = await clients.cost().query.usage(scope, {
          type:      "ActualCost",
          timeframe: "Custom",
          timePeriod: { from: new Date(range.from), to: new Date(range.to) },
          dataset: {
            granularity: "Daily",
            aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
            filter: baseFilter,
          },
        });
        const dCols = (dailyRaw?.columns ?? []).map((c) => c.name);
        const daily = (dailyRaw?.rows ?? []).map((r) => ({
          date: asText(r[dCols.indexOf("UsageDate")]),
          cost: Number(r[dCols.indexOf("PreTaxCost")]) || 0,
        })).sort((a, b) => a.date.localeCompare(b.date));
        const byResRaw = await clients.cost().query.usage(scope, {
          type:      "ActualCost",
          timeframe: "Custom",
          timePeriod: { from: new Date(range.from), to: new Date(range.to) },
          dataset: {
            granularity: "None",
            aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
            filter: baseFilter,
            grouping: [{ type: "Dimension", name: "ResourceId" }],
          },
        });
        const rCols = (byResRaw?.columns ?? []).map((c) => c.name);
        const resourcesList = (byResRaw?.rows ?? []).map((r) => {
          const id = String(r[rCols.indexOf("ResourceId")] ?? "");
          return {
            resourceId: id,
            name:       id.split("/").pop() ?? id,
            cost:       Number(r[rCols.indexOf("PreTaxCost")]) || 0,
          };
        }).sort((a, b) => b.cost - a.cost);
        let meters: Array<{ meter: string; cost: number }> = [];
        try {
          const byMeterRaw = await clients.cost().query.usage(scope, {
            type:      "ActualCost",
            timeframe: "Custom",
            timePeriod: { from: new Date(range.from), to: new Date(range.to) },
            dataset: {
              granularity: "None",
              aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
              filter: baseFilter,
              grouping: [{ type: "Dimension", name: "Meter" }],
            },
          });
          const mCols = (byMeterRaw?.columns ?? []).map((c) => c.name);
          meters = (byMeterRaw?.rows ?? []).map((r) => ({
            meter: String(r[mCols.indexOf("Meter")] ?? ""),
            cost:  Number(r[mCols.indexOf("PreTaxCost")]) || 0,
          })).sort((a, b) => b.cost - a.cost);
        } catch (_) { /* meter dimension can occasionally fail; leave empty */ }
        const total = daily.reduce((s, d) => s + d.cost, 0);
        return {
          service,
          mode:  range.mode,
          label: range.label,
          from:  range.from.slice(0, 10),
          to:    range.to.slice(0, 10),
          total,
          currency: "USD",
          daily,
          resources: resourcesList,
          meters,
        };
      });
      res.json(data);
    })
  );

  // ── POST /api/azure/cache/bust ───────────────────────────────────────────
  router.post(
    "/api/azure/cache/bust",
    requireRole("operator"),
    requireAzureEnabled,
    (req, res) => {
      const prefix = bodyString(
        typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : {},
        "prefix"
      );
      if (!prefix) return void res.status(400).json({ error: "prefix is required" });
      cache.bust(prefix);
      res.json({ busted: prefix });
    }
  );

  return router;
}
