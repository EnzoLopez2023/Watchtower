import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import type { ArchiveRetention } from "./monitoringArchiveRepository.js";
import { asText } from "../../../monitoring/values.js";

export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ROWS_PER_AGENT = 100_000;
export const MAX_LINES_PER_PUSH = 500;
export const MAX_MESSAGE_CHARS = 2000;
export const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_ANALYTICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_QUERY_CHARS = 200;

export const LEVELS = new Set(["debug", "info", "warn", "error"]);
export const LEVEL_ORDER = ["debug", "info", "warn", "error"] as const;
export type LogLevel = "debug" | "info" | "warn" | "error";

export const AGENT_TOKENS_KEYS = new Set(["unifi", "ups", "shutdown", "synology", "sonarr"]);

interface RawLogLine {
  readonly ts?: unknown;
  readonly level?: unknown;
  readonly message?: unknown;
}

export interface AgentLogIngestResult {
  readonly duplicate: boolean;
  readonly stored: number;
}

export interface LogFilters {
  readonly agents: string[];
  readonly levels: string[];
  readonly q: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly cursorTs: number | null;
  readonly cursorId: number | null;
  readonly order: "asc" | "desc";
  readonly limit: number;
}

export interface AgentLogRepository {
  ingest(agent: string, lines: unknown[], deliveryId: string | null, now: number): Promise<AgentLogIngestResult>;
  queryLogs(query: Record<string, unknown>): Promise<unknown>;
  queryAnalytics(query: Record<string, unknown>, now?: number): Promise<unknown>;
  getAdminLogs(query: Record<string, unknown>): Promise<unknown>;
}

class QueryError extends Error {
  public readonly status = 400;
  public constructor(message: string) {
    super(message);
  }
}

function listParam(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => asText(item).split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function optionalEpochMs(value: unknown): number | null   {
  const s = asText(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function parseQuery(query: Record<string, unknown>, opts: { analytics?: boolean; now?: number } = {}): LogFilters {
  const now = opts.now ?? Date.now();
  const requestedAgents = [...new Set(listParam(query["agents"] ?? query["agent"]))];
  const requestedLevels = [...new Set(listParam(query["levels"]))];
  const unknownAgents = requestedAgents.filter((a) => !AGENT_TOKENS_KEYS.has(a));
  const unknownLevels = requestedLevels.filter((l) => !LEVELS.has(l));
  if (unknownAgents.length) throw new QueryError(`unknown agent: ${unknownAgents.join(", ")}`);
  if (unknownLevels.length) throw new QueryError(`unknown level: ${unknownLevels.join(", ")}`);

  const q = asText(query["q"]).trim().slice(0, MAX_QUERY_CHARS);
  let from = optionalEpochMs(query["from"]);
  let to = optionalEpochMs(query["to"]);
  const cursorTs = optionalEpochMs(query["cursorTs"] ?? query["beforeTs"]);
  const cursorId = optionalEpochMs(query["cursorId"] ?? query["beforeId"]);
  const order: "asc" | "desc" = ["oldest", "asc"].includes(asText(query["order"] ?? query["sort"]).toLowerCase()) ? "asc" : "desc";

  if ([from, to, cursorTs, cursorId].some(Number.isNaN)) {
    throw new QueryError("timestamp and cursor values must be non-negative safe integers");
  }
  if (opts.analytics) {
    if (to == null) to = now;
    if (from == null) from = Math.max(0, to - DEFAULT_ANALYTICS_WINDOW_MS);
  }
  if (from != null && to != null && from > to) throw new QueryError("from must be earlier than or equal to to");
  if (from != null && to != null && to - from > MAX_AGE_MS) {
    throw new QueryError(`time range cannot exceed ${MAX_AGE_MS / 86_400_000} days`);
  }
  if ((cursorTs == null) !== (cursorId == null)) {
    throw new QueryError("cursorTs and cursorId must be provided together");
  }

  return { agents: requestedAgents, levels: requestedLevels, q, from, to, cursorTs, cursorId, order, limit: parsePositiveInt(query["limit"], 200, 500) };
}

function whereFor(filters: LogFilters, opts: { includeLevels?: boolean } = {}): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.agents.length) { where.push(`agent IN (${filters.agents.map(() => "?").join(",")})`); params.push(...filters.agents); }
  if ((opts.includeLevels ?? true) && filters.levels.length) { where.push(`level IN (${filters.levels.map(() => "?").join(",")})`); params.push(...filters.levels); }
  if (filters.q) { where.push("message LIKE ? ESCAPE '\\'"); params.push(`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`); }
  if (filters.from != null) { where.push("ts >= ?"); params.push(filters.from); }
  if (filters.to != null) { where.push("ts <= ?"); params.push(filters.to); }
  return { where, params };
}

function clauseFor(where: string[]): string {
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

export class SqliteAgentLogRepository extends SqliteRepository implements AgentLogRepository {
  private lastMaintenanceAt = 0;

  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim,
    private readonly retention: ArchiveRetention
  ) {
    super(database);
  }

  public async ingest(
    agent: string,
    lines: unknown[],
    deliveryId: string | null,
    now: number
  ): Promise<AgentLogIngestResult> {
    const doMaintenance = now - this.lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS;

    const result = this.transaction<AgentLogIngestResult>(() => {
      if (!this.receipts.claim(deliveryId, "/api/agent-logs/ingest", now)) {
        return { duplicate: true, stored: 0 };
      }
      let stored = 0;
      const storedTimestamps: number[] = [];
      for (const r of lines) {
        const row = r as RawLogLine;
        const ts = Number(row.ts);
        const level = asText(row.level, "info").toLowerCase();
        const message = asText(row.message).slice(0, MAX_MESSAGE_CHARS);
        if (!message) continue;
        const eventTs = Number.isFinite(ts) ? ts : now;
        stored += this.run(
          "INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES (?, ?, ?, ?, ?)",
          agent,
          eventTs,
          LEVELS.has(level) ? level : "info",
          message,
          now
        ).changes;
        storedTimestamps.push(eventTs);
      }
      this.retention.invalidateDays("agent-logs", storedTimestamps, now);
      if (doMaintenance) {
        this.retention.deleteBefore("agent-logs", "agent_logs", "ts", now - MAX_AGE_MS);
        const threshold = this.get<{ id: number }>(
          "SELECT id FROM agent_logs WHERE agent = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
          agent, MAX_ROWS_PER_AGENT
        );
        this.retention.deleteThroughId("agent-logs", "agent_logs", "ts", threshold?.id ?? null, "AND agent = ?", [agent]);
      }
      return { duplicate: false, stored };
    });

    if (doMaintenance) this.lastMaintenanceAt = now;
    return result;
  }

  public async queryLogs(query: Record<string, unknown>): Promise<unknown> {
    return this._queryLogs(query);
  }

  public async queryAnalytics(query: Record<string, unknown>, now = Date.now()): Promise<unknown> {
    return this._queryAnalytics(query, now);
  }

  private sourceSummary(): unknown[] {
    return this.all(`SELECT agent, COUNT(*) AS total, MAX(ts) AS newestEventAt, MAX(received_at) AS newestReceivedAt FROM agent_logs GROUP BY agent ORDER BY agent`);
  }

  private _queryLogs(query: Record<string, unknown>): unknown {
    const filters = parseQuery(query);
    const { where, params } = whereFor(filters);
    const matchingTotal = (this.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_logs ${clauseFor(where)}`, ...params)?.n ?? 0);

    const pageWhere = [...where];
    const pageParams = [...params];
    if (filters.cursorTs != null && filters.cursorId != null) {
      const cmp = filters.order === "asc" ? ">" : "<";
      pageWhere.push(`(ts ${cmp} ? OR (ts = ? AND id ${cmp} ?))`);
      pageParams.push(filters.cursorTs, filters.cursorTs, filters.cursorId);
    }
    const dir = filters.order === "asc" ? "ASC" : "DESC";
    const fetched = this.all<{ id: number; agent: string; ts: number; level: string; message: string; received_at: number; ingestion_delay_ms: number }>(
      `SELECT id, agent, ts, level, message, received_at, received_at - ts AS ingestion_delay_ms FROM agent_logs ${clauseFor(pageWhere)} ORDER BY ts ${dir}, id ${dir} LIMIT ?`,
      ...pageParams, filters.limit + 1
    );
    const hasMore = fetched.length > filters.limit;
    const lines = hasMore ? fetched.slice(0, filters.limit) : fetched;
    const last = lines.at(-1);

    return {
      ok: true,
      lines,
      total: this.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_logs")?.n ?? 0,
      matchingTotal,
      nextCursor: hasMore && last ? { ts: last.ts, id: last.id } : null,
      order: filters.order === "asc" ? "oldest" : "newest",
      sources: this.sourceSummary(),
      retention: { maxAgeDays: MAX_AGE_MS / (24 * 60 * 60 * 1000), maxRowsPerAgent: MAX_ROWS_PER_AGENT },
    };
  }

  private summaryFor(where: string[], params: (string | number)[]): { total: number; errors: number; errorRate: number; avgLatencyMs: number | null; p95LatencyMs: number | null; clockSkewCount: number } {
    const row = this.get<{ total: number; errors: number; avgLatencyMs: number | null; clockSkewCount: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END), 0) AS errors, ROUND(AVG(CASE WHEN received_at >= ts THEN received_at - ts END)) AS avgLatencyMs, COALESCE(SUM(CASE WHEN received_at < ts THEN 1 ELSE 0 END), 0) AS clockSkewCount FROM agent_logs ${clauseFor(where)}`,
      ...params
    );
    const p95 = this.get<{ ingestionDelayMs: number | null }>(
      `SELECT ingestionDelayMs FROM (SELECT received_at - ts AS ingestionDelayMs, ROW_NUMBER() OVER (ORDER BY received_at - ts) AS rowNumber, COUNT(*) OVER () AS rowCount FROM agent_logs ${clauseFor([...where, "received_at >= ts"])}) WHERE rowNumber = CAST((rowCount * 95 + 99) / 100 AS INTEGER) LIMIT 1`,
      ...params
    )?.ingestionDelayMs ?? null;
    const total = Number(row?.total) || 0;
    const errors = Number(row?.errors) || 0;
    return { total, errors, errorRate: total ? errors / total : 0, avgLatencyMs: row?.avgLatencyMs == null ? null : Number(row.avgLatencyMs), p95LatencyMs: p95 == null ? null : Number(p95), clockSkewCount: Number(row?.clockSkewCount) || 0 };
  }

  private chooseBucketMs(span: number): number {
    if (span <= 2 * 60 * 60 * 1000) return 5 * 60 * 1000;
    if (span <= 12 * 60 * 60 * 1000) return 15 * 60 * 1000;
    if (span <= 48 * 60 * 60 * 1000) return 60 * 60 * 1000;
    if (span <= 8 * 24 * 60 * 60 * 1000) return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
  }

  private percentChange(current: number, previous: number): number | null {
    if (!previous) return current ? null : 0;
    return (current - previous) / previous;
  }

  private formatDelay(ms: number | null): string {
    if (ms == null) return "unavailable";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    return `${(ms / 60_000).toFixed(1)} min`;
  }

  private buildInsights(opts: {
    summary: ReturnType<SqliteAgentLogRepository["summaryFor"]>;
    previous: ReturnType<SqliteAgentLogRepository["summaryFor"]> | null;
    sources: { agent: string; total: number; errors: number; avgLatencyMs: number | null }[];
    repeated: { message: string; level: string; count: number; sourceCount: number } | null;
    volumeChange: number | null;
    errorRateChange: number | null;
  }): unknown[] {
    const { summary, previous, sources, repeated, volumeChange, errorRateChange } = opts;
    const insights: unknown[] = [];
    if (summary.clockSkewCount > 0) {
      insights.push({ id: "clock-skew", tone: "warning", title: `${summary.clockSkewCount.toLocaleString()} ${summary.clockSkewCount === 1 ? "entry has" : "entries have"} a future event timestamp`, detail: "Those rows are excluded from ingestion-latency aggregates because the source clock is ahead of Hearth." });
    }
    if (previous != null && previous.total >= 10 && volumeChange != null && Math.abs(volumeChange) >= 0.25) {
      const dir = volumeChange > 0 ? "increased" : "decreased";
      insights.push({ id: "volume-change", tone: volumeChange > 0 ? "warning" : "info", title: `Log volume ${dir} ${Math.abs(volumeChange * 100).toFixed(0)}%`, detail: `Compared with the immediately preceding window (${previous.total.toLocaleString()} entries).` });
    }
    if (previous != null && previous.total >= 10 && errorRateChange != null && Math.abs(errorRateChange) >= 0.05) {
      const dir = errorRateChange > 0 ? "rose" : "fell";
      insights.push({ id: "error-share-change", tone: errorRateChange > 0 ? "critical" : "positive", title: `Error share ${dir} ${Math.abs(errorRateChange * 100).toFixed(1)} points`, detail: `The selected window is ${(summary.errorRate * 100).toFixed(1)}% error-level entries.` });
    }
    const topErrorSource = sources.filter((s) => s.errors > 0).sort((a, b) => b.errors - a.errors || b.total - a.total)[0];
    if (topErrorSource) {
      insights.push({ id: "top-error-source", tone: "critical", title: `${topErrorSource.agent} contributed the most error entries`, detail: `${topErrorSource.errors.toLocaleString()} of ${summary.errors.toLocaleString()} error-level entries in this window.`, filter: { agent: topErrorSource.agent, level: "error" } });
    }
    const slowestSource = sources.filter((s) => s.avgLatencyMs != null).sort((a, b) => (b.avgLatencyMs ?? 0) - (a.avgLatencyMs ?? 0))[0];
    if (slowestSource) {
      insights.push({ id: "slowest-source", tone: "info", title: `${slowestSource.agent} had the highest average ingestion delay`, detail: `${this.formatDelay(slowestSource.avgLatencyMs)} from agent event time to Hearth receipt.`, filter: { agent: slowestSource.agent } });
    }
    if (repeated != null && repeated.count >= 3) {
      insights.push({ id: "repeated-message", tone: repeated.level === "error" ? "critical" : repeated.level === "warn" ? "warning" : "info", title: `Repeated ${repeated.count.toLocaleString()} times: "${repeated.message}"`, detail: `${repeated.sourceCount.toLocaleString()} ${repeated.sourceCount === 1 ? "source" : "sources"} emitted this exact message.`, filter: { query: repeated.message } });
    }
    return insights.slice(0, 5);
  }

  private _queryAnalytics(query: Record<string, unknown>, now: number): unknown {
    const filters = parseQuery(query, { analytics: true, now });
    const { where, params } = whereFor(filters, { includeLevels: false });
    const from = filters.from as number;
    const to = filters.to as number;
    const span = Math.max(1, to - from + 1);
    const bucketMs = this.chooseBucketMs(span);
    const summary = this.summaryFor(where, params);

    const previousFilters = { ...filters, from: Math.max(0, from - span), to: Math.max(0, from - 1) };
    const previousAvailable = previousFilters.from >= Math.max(0, now - MAX_AGE_MS);
    const previousParts = previousAvailable ? whereFor(previousFilters, { includeLevels: false }) : null;
    const previous = previousParts ? this.summaryFor(previousParts.where, previousParts.params) : null;
    const volumeChange = previous ? this.percentChange(summary.total, previous.total) : null;
    const errorRateChange = previous ? summary.errorRate - previous.errorRate : null;

    const volumeRows = this.all<{ bucketIndex: number; level: string; count: number }>(
      `SELECT CAST((ts - ?) / ? AS INTEGER) AS bucketIndex, level, COUNT(*) AS count FROM agent_logs ${clauseFor(where)} GROUP BY bucketIndex, level ORDER BY bucketIndex`,
      from, bucketMs, ...params
    );
    const bucketCount = Math.min(500, Math.floor((to - from) / bucketMs) + 1);
    const volume = Array.from({ length: bucketCount }, (_, i) => ({ ts: from + i * bucketMs, debug: 0, info: 0, warn: 0, error: 0, total: 0 })) as { ts: number; debug: number; info: number; warn: number; error: number; total: number }[];
    for (const row of volumeRows) {
      const point = volume[Number(row.bucketIndex)];
      const count = Number(row.count) || 0;
      if (!point || !LEVELS.has(row.level)) continue;
      point[row.level as "debug" | "info" | "warn" | "error"] = count;
      point.total += count;
    }

    const levelRows = this.all<{ level: string; count: number }>(
      `SELECT level, COUNT(*) AS count FROM agent_logs ${clauseFor(where)} GROUP BY level`,
      ...params
    );
    const levelCounts = new Map(levelRows.map((r) => [r.level, Number(r.count) || 0]));
    const levels = LEVEL_ORDER.map((l) => ({ level: l, count: levelCounts.get(l) ?? 0 }));

    const sources = this.all<{ agent: string; total: number; errors: number; avgLatencyMs: number | null }>(
      `SELECT agent, COUNT(*) AS total, COALESCE(SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END), 0) AS errors, ROUND(AVG(CASE WHEN received_at >= ts THEN received_at - ts END)) AS avgLatencyMs FROM agent_logs ${clauseFor(where)} GROUP BY agent ORDER BY total DESC, agent`,
      ...params
    ).map((r) => ({ agent: r.agent, total: Number(r.total) || 0, errors: Number(r.errors) || 0, avgLatencyMs: r.avgLatencyMs == null ? null : Number(r.avgLatencyMs) }));

    const latencyRows = this.all<{ bucketIndex: number; avgLatencyMs: number | null; p95LatencyMs: number | null; count: number }>(
      `WITH delays AS (SELECT CAST((ts - ?) / ? AS INTEGER) AS bucketIndex, received_at - ts AS ingestionDelayMs FROM agent_logs ${clauseFor([...where, "received_at >= ts"])}),
       ranked AS (SELECT bucketIndex, ingestionDelayMs, ROW_NUMBER() OVER (PARTITION BY bucketIndex ORDER BY ingestionDelayMs) AS rowNumber, COUNT(*) OVER (PARTITION BY bucketIndex) AS rowCount FROM delays)
       SELECT bucketIndex, ROUND(AVG(ingestionDelayMs)) AS avgLatencyMs, MAX(CASE WHEN rowNumber = CAST((rowCount * 95 + 99) / 100 AS INTEGER) THEN ingestionDelayMs END) AS p95LatencyMs, COUNT(*) AS count FROM ranked GROUP BY bucketIndex ORDER BY bucketIndex`,
      from, bucketMs, ...params
    );
    const latencyByBucket = new Map(latencyRows.map((r) => [Number(r.bucketIndex), r]));
    const latency = volume.map((point, i) => {
      const row = latencyByBucket.get(i);
      return { ts: point.ts, avgLatencyMs: row?.avgLatencyMs == null ? null : Number(row.avgLatencyMs), p95LatencyMs: row?.p95LatencyMs == null ? null : Number(row.p95LatencyMs), count: Number(row?.count) || 0 };
    });

    const repeated = this.get<{ message: string; level: string; count: number; sourceCount: number }>(
      `SELECT message, CASE MAX(CASE level WHEN 'error' THEN 4 WHEN 'warn' THEN 3 WHEN 'info' THEN 2 ELSE 1 END) WHEN 4 THEN 'error' WHEN 3 THEN 'warn' WHEN 2 THEN 'info' ELSE 'debug' END AS level, COUNT(*) AS count, COUNT(DISTINCT agent) AS sourceCount FROM agent_logs ${clauseFor(where)} GROUP BY message HAVING COUNT(*) >= 3 ORDER BY count DESC, message LIMIT 1`,
      ...params
    );

    return {
      ok: true,
      window: { from, to, bucketMs, previousFrom: previousFilters.from, previousTo: previousFilters.to },
      summary: { ...summary, previous, volumeChange, errorRateChange },
      volume,
      levels,
      sources,
      latency,
      insights: this.buildInsights({
        summary, previous, sources,
        repeated: repeated ? { message: repeated.message, level: repeated.level, count: Number(repeated.count) || 0, sourceCount: Number(repeated.sourceCount) || 0 } : null,
        volumeChange, errorRateChange,
      }),
      retention: { maxAgeDays: MAX_AGE_MS / (24 * 60 * 60 * 1000), maxRowsPerAgent: MAX_ROWS_PER_AGENT },
    };
  }

  public async getAdminLogs(query: Record<string, unknown>): Promise<unknown> {
    const legacyLevel = asText(query["level"]).toLowerCase();
    const translated: Record<string, unknown> = {
      ...query,
      agents: query["agent"],
      levels: LEVELS.has(legacyLevel) ? LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(legacyLevel as LogLevel)).join(",") : undefined,
      cursorTs: query["beforeTs"],
      cursorId: query["beforeId"],
      order: "newest",
    };
    const result = this._queryLogs(translated);
    const counts = this.all("SELECT agent, level, COUNT(*) AS n FROM agent_logs GROUP BY agent, level");
    const newest = this.all("SELECT agent, MAX(ts) AS ts FROM agent_logs GROUP BY agent");
    return { ...(result as Record<string, unknown>), counts, newest };
  }
}
