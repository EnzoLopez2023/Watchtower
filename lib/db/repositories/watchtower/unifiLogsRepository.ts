import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository, type RunOutcome, type SqlValue } from "./base.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import {
  ACTIVITY_NORMALIZATION_VERSION,
  activityPresentation
} from "../../../monitoring/unifiActivity.js";
import type { ArchiveRetention } from "./monitoringArchiveRepository.js";
import { unpackJson } from "../../../monitoring/payloadCodec.js";

// ── Archive status types (mirrors Hearth's monitoringArchiveStatus shape) ────

export interface ArchiveStreamRow {
  readonly stream: string;
  readonly attempted_days: number;
  readonly archived_days: number;
  readonly last_archived_at: number | null;
  readonly last_error_at: number | null;
}

export interface ArchiveLatestErrorRow {
  readonly stream: string;
  readonly day_start: number;
  readonly last_attempt_at: number;
  readonly last_error: string;
}

const BACKFILL_BATCH_SIZE = 500;

export interface BackfillResult {
  updated: number;
  invalid: number;
  timestamps: number[];
  /** Batches executed in this pass. */
  batches: number;
  /** True when the pass stopped early (batch cap or abort) with work left. */
  incomplete: boolean;
}

export interface BackfillOptions {
  batchSize?: number;
  /** Upper bound on batch transactions per call. */
  maxBatches?: number;
  /** Checked between batches so a caller can abort without a partial write. */
  shouldStop?: () => boolean;
}

export interface ArchiveStatusSummary {
  readonly enabled: boolean;
  readonly streams?: ArchiveStreamRow[];
  readonly latestError?: ArchiveLatestErrorRow | null;
}

export interface ArchiveStatusProvider extends ArchiveRetention {
  archiveSummary(): ArchiveStatusSummary;
}

// ── Ingest health / gap types ─────────────────────────────────────────────────

export interface IngestHealthRow {
  skew_ms: number | null;
  skew_trusted: 0 | 1;
  last_untrusted_at: number | null;
  updated_at: number | null;
  gaps_untrusted: number;
}

export interface CollectionGapRow {
  readonly stream: string;
  readonly from_ts: number;
  readonly to_ts: number;
  readonly source_from_ts: number;
  readonly clock_untrusted: 0 | 1;
  readonly resolved_at: number | null;
  readonly kind: string;
  readonly reason: string;
  readonly first_reported_at: number;
  readonly last_reported_at: number;
  readonly report_count: number;
}

export interface CompatRow {
  readonly stream: string;
  readonly status: string;
  readonly page_base: number | null;
  readonly filter_variant: string | null;
  readonly evidence: string | null;
  readonly negotiated_at: number | null;
  readonly held: 0 | 1;
  readonly updated_at: number;
}

// ── Activity / flow pagination types ─────────────────────────────────────────

export interface PageConfig {
  readonly table: string;
  readonly tsColumn: string;
  readonly columns: string;
  readonly retention: { hotDays: number; maxRows: number };
  addFilters(
    where: string[],
    params: SqlValue[],
    query: string,
    category?: string,
    severity?: string,
    action?: string,
    protocol?: string,
    policy?: string
  ): void;
}

export interface PageRequest {
  readonly from: number | null;
  readonly to: number | null;
  readonly beforeTs: number | null;
  readonly beforeId: number | null;
  readonly limit: number;
}

export interface PageResult<T> {
  readonly ok: true;
  readonly rows: T[];
  readonly matchingTotal: number;
  readonly total: number;
  readonly oldestAt: number | null;
  readonly newestAt: number | null;
  readonly nextCursor: { ts: number; id: number } | null;
  readonly retention: { hotDays: number; maxRows: number };
}

export interface NormalizedGap {
  readonly stream: string;
  readonly from_ts: number;
  readonly to_ts: number;
  readonly source_from_ts: number;
  readonly clock_untrusted: 0 | 1;
  readonly kind: "hold" | "unreadable";
  readonly reason: string;
}

// ── Ingest contract ───────────────────────────────────────────────────────────

export interface UnifiLogsIngestInput {
  readonly deliveryId: string | null;
  readonly now: number;
  readonly maintenance: boolean;
  readonly normalizedActivity: ReadonlyArray<Readonly<Record<string, SqlValue>>>;
  readonly activityTimestamps: readonly number[];
  readonly normalizedFlows: ReadonlyArray<Readonly<Record<string, SqlValue>>>;
  readonly flowTimestamps: readonly number[];
  readonly normalizedGaps: readonly NormalizedGap[];
  readonly holdSettles: ReadonlyArray<{
    readonly stream: string;
    readonly keepSourceFromTs: number | null;
  }>;
  readonly normalizedCompat: ReadonlyArray<{
    readonly stream: string;
    readonly status: string;
    readonly page_base: number | null;
    readonly filter_variant: string | null;
    readonly evidence: string | null;
    readonly negotiated_at: number | null;
    readonly held: 0 | 1;
  }>;
  readonly ingestHealth: {
    readonly skew_ms: number | null;
    readonly skew_trusted: 0 | 1;
    readonly gaps_untrusted: number;
    readonly last_untrusted_at: number | null;
  };
}

export interface UnifiLogsIngestResult {
  readonly duplicate: boolean;
  readonly activityStored: number;
  readonly flowsStored: number;
  readonly gapsStored: number;
  readonly gapsUntrusted: number;
  readonly gapsDropped: number;
}

export interface UnifiLogsRepository {
  ingest(input: UnifiLogsIngestInput): Promise<UnifiLogsIngestResult>;
  runBackfill(options?: BackfillOptions): Promise<BackfillResult>;
  readPage<T>(
    config: PageConfig,
    request: PageRequest,
    filterArgs: {
      query: string;
      category?: string;
      severity?: string;
      action?: string;
      protocol?: string;
      policy?: string;
    }
  ): Promise<PageResult<T>>;
  summarizeActivity(): Promise<{ count: number; oldestAt: number | null; newestAt: number | null }>;
  summarizeFlows(): Promise<{ count: number; oldestAt: number | null; newestAt: number | null }>;
  activityCategories(): Promise<string[]>;
  activitySeverities(): Promise<string[]>;
  flowActions(): Promise<string[]>;
  flowProtocols(): Promise<string[]>;
  listGaps(): Promise<CollectionGapRow[]>;
  getIngestHealthStatus(): Promise<IngestHealthRow | null>;
  listCompat(): Promise<CompatRow[]>;
}

// ── Repository ────────────────────────────────────────────────────────────────

const UNTRUSTED_GAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SqliteUnifiLogsRepository extends SqliteRepository implements UnifiLogsRepository {
  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim,
    private readonly archive: ArchiveRetention
  ) {
    super(database);
  }

  // ── Ingest (transactional write) ──────────────────────────────────────────

  public async ingest(input: UnifiLogsIngestInput): Promise<UnifiLogsIngestResult> {
    return this.transaction(() => this.ingestSync(input));
  }

  private ingestSync(input: UnifiLogsIngestInput): UnifiLogsIngestResult {
    const {
      deliveryId, now, maintenance,
      normalizedActivity, activityTimestamps,
      normalizedFlows, flowTimestamps,
      normalizedGaps, holdSettles, normalizedCompat, ingestHealth,
    } = input;

    if (!this.receipts.claim(deliveryId, "/api/unifi/logs/ingest", now)) {
      return { duplicate: true, activityStored: 0, flowsStored: 0, gapsStored: 0, gapsUntrusted: 0, gapsDropped: 0 };
    }

    let activityStored = 0;
    let flowsStored = 0;
    let gapsStored = 0;
    const gapsDropped = 0;

    for (const row of normalizedActivity) {
      activityStored += this.insertActivitySync(row).changes;
    }
    for (const row of normalizedFlows) {
      flowsStored += this.insertFlowSync(row).changes;
    }

    let gapsUntrusted = 0;
    for (const gap of normalizedGaps) {
      gapsStored += this.recordGapSync(gap, now).changes;
      gapsUntrusted += gap.clock_untrusted;
    }

    for (const settle of holdSettles) {
      if (settle.keepSourceFromTs != null) {
        this.settleHoldsSync(settle.stream, settle.keepSourceFromTs, now);
      } else {
        this.settleAllHoldsSync(settle.stream, now);
      }
    }

    this.recordIngestHealthSync({ ...ingestHealth, now });

    for (const compat of normalizedCompat) {
      this.recordCompatSync({ ...compat, now });
    }

    this.archive.invalidateDays("unifi-activity", [...activityTimestamps], now);
    this.archive.invalidateDays("unifi-flows", [...flowTimestamps], now);

    if (maintenance) {
      const activityCapId = this.activityRowCapIdSync(249_999);
      const flowCapId = this.flowRowCapIdSync(499_999);
      this.pruneActivitySync(now - 90 * 24 * 60 * 60 * 1000, activityCapId);
      this.pruneFlowsSync(now - 14 * 24 * 60 * 60 * 1000, flowCapId);
      this.pruneGapsSync(now - 365 * 24 * 60 * 60 * 1000);
    }

    return { duplicate: false, activityStored, flowsStored, gapsStored, gapsUntrusted, gapsDropped };
  }

  // ── Backfill ──────────────────────────────────────────────────────────────

  /**
   * Re-derives the presentation columns for activity rows written by an older
   * normalizer. Batched by id so a large table is rewritten in bounded
   * transactions instead of one long write that would block ingest.
   */
  public async runBackfill(options: BackfillOptions = {}): Promise<BackfillResult> {
    const result = this.backfillSync(options);
    if (result.updated) {
      this.archive.invalidateDays("unifi-activity", result.timestamps);
    }
    return result;
  }

  private backfillSync(options: BackfillOptions): BackfillResult {
    const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const shouldStop = options.shouldStop;
    let cursor = 0;
    let updated = 0;
    let invalid = 0;
    let batches = 0;
    let incomplete = false;
    const touched = new Set<number>();

    for (;;) {
      // Between batches, never mid-transaction: an abort leaves committed work
      // intact and the remaining rows still flagged for a later pass.
      if (batches >= maxBatches || shouldStop?.()) {
        incomplete = true;
        break;
      }
      const rows = this.all<{ id: number; event_ts: number; raw: unknown }>(
        `SELECT id, event_ts, raw
           FROM unifi_activity_logs
          WHERE normalization_version < ?
            AND id > ?
          ORDER BY id
          LIMIT ?`,
        ACTIVITY_NORMALIZATION_VERSION,
        cursor,
        batchSize
      );
      if (!rows.length) break;

      this.transaction(() => {
        for (const row of rows) {
          const presentation = activityPresentation(unpackJson(row.raw));
          if (!presentation) {
            // Record the attempt so an unparseable row is not rescanned forever.
            this.run(
              "UPDATE unifi_activity_logs SET normalization_version = ? WHERE id = ?",
              ACTIVITY_NORMALIZATION_VERSION,
              row.id
            );
            invalid += 1;
            continue;
          }
          this.runNamed(
            `UPDATE unifi_activity_logs
                SET severity = @severity,
                    category = @category,
                    subcategory = @subcategory,
                    event_type = @event_type,
                    title = @title,
                    message = @message,
                    actor = @actor,
                    target = @target,
                    normalization_version = @normalization_version
              WHERE id = @id`,
            {
              id: row.id,
              ...presentation,
              normalization_version: ACTIVITY_NORMALIZATION_VERSION
            }
          );
          touched.add(row.event_ts);
          updated += 1;
        }
      });

      batches += 1;
      cursor = rows[rows.length - 1]?.id ?? cursor;
    }

    return { updated, invalid, timestamps: [...touched], batches, incomplete };
  }

  // ── unifi_activity_logs ───────────────────────────────────────────────────

  private insertActivitySync(params: Readonly<Record<string, SqlValue>>): RunOutcome {
    return this.runNamed(
      `INSERT INTO unifi_activity_logs (
         upstream_id, event_ts, received_at, severity, category, subcategory,
         event_type, title, message, actor, target, normalization_version, raw
       ) VALUES (
         @upstream_id, @event_ts, @received_at, @severity, @category, @subcategory,
         @event_type, @title, @message, @actor, @target, @normalization_version, @raw
       )
       ON CONFLICT(upstream_id) DO NOTHING`,
      params
    );
  }

  private activityRowCapIdSync(offset: number): number | undefined {
    return this.get<{ id: number }>(
      "SELECT id FROM unifi_activity_logs ORDER BY id DESC LIMIT 1 OFFSET ?",
      offset
    )?.id;
  }

  // ── unifi_traffic_flows ───────────────────────────────────────────────────

  private insertFlowSync(params: Readonly<Record<string, SqlValue>>): RunOutcome {
    return this.runNamed(
      `INSERT INTO unifi_traffic_flows (
         upstream_id, flow_ts, flow_end_ts, received_at, duration_ms,
         action, direction, protocol, service, risk,
         source_name, source_ip, source_mac, source_port, source_network, source_zone,
         destination_name, destination_ip, destination_mac, destination_port,
         destination_network, destination_zone, ingress_name, egress_name,
         bytes_rx, bytes_tx, bytes_total, packets_total, policy_names, policy_types
       ) VALUES (
         @upstream_id, @flow_ts, @flow_end_ts, @received_at, @duration_ms,
         @action, @direction, @protocol, @service, @risk,
         @source_name, @source_ip, @source_mac, @source_port, @source_network, @source_zone,
         @destination_name, @destination_ip, @destination_mac, @destination_port,
         @destination_network, @destination_zone, @ingress_name, @egress_name,
         @bytes_rx, @bytes_tx, @bytes_total, @packets_total, @policy_names, @policy_types
       )
       ON CONFLICT(upstream_id) DO NOTHING`,
      params
    );
  }

  private flowRowCapIdSync(offset: number): number | undefined {
    return this.get<{ id: number }>(
      "SELECT id FROM unifi_traffic_flows ORDER BY id DESC LIMIT 1 OFFSET ?",
      offset
    )?.id;
  }

  // ── unifi_collection_gaps ─────────────────────────────────────────────────

  private recordGapSync(gap: NormalizedGap, now: number): RunOutcome {
    return this.runNamed(
      `INSERT INTO unifi_collection_gaps (
         stream, from_ts, to_ts, source_from_ts, clock_untrusted, kind, reason,
         first_reported_at, last_reported_at, report_count
       ) VALUES (
         @stream, @from_ts, @to_ts, @source_from_ts, @clock_untrusted, @kind, @reason, @now, @now, 1
       )
       ON CONFLICT(stream, kind, source_from_ts) DO UPDATE SET
         clock_untrusted = excluded.clock_untrusted,
         resolved_at = NULL,
         from_ts = MIN(unifi_collection_gaps.from_ts, excluded.from_ts),
         to_ts = MAX(unifi_collection_gaps.to_ts, excluded.to_ts),
         reason = excluded.reason,
         last_reported_at = MAX(unifi_collection_gaps.last_reported_at, excluded.last_reported_at),
         report_count = unifi_collection_gaps.report_count + 1`,
      { ...gap, now }
    );
  }

  private pruneGapsSync(cutoff: number): RunOutcome {
    return this.run("DELETE FROM unifi_collection_gaps WHERE to_ts < ?", cutoff);
  }

  private settleHoldsSync(stream: string, keepSourceFromTs: number, now: number): void {
    this.runNamed(
      `UPDATE unifi_collection_gaps SET resolved_at = @now
        WHERE stream = @stream AND kind = 'hold' AND resolved_at IS NULL AND source_from_ts <> @keep`,
      { stream, keep: keepSourceFromTs, now }
    );
  }

  private settleAllHoldsSync(stream: string, now: number): void {
    this.runNamed(
      `UPDATE unifi_collection_gaps SET resolved_at = @now
        WHERE stream = @stream AND kind = 'hold' AND resolved_at IS NULL`,
      { stream, now }
    );
  }

  public async listGaps(): Promise<CollectionGapRow[]> {
    return this.all<CollectionGapRow>(
      `SELECT stream, from_ts, to_ts, source_from_ts, clock_untrusted, resolved_at, kind, reason,
              first_reported_at, last_reported_at, report_count
         FROM unifi_collection_gaps
        ORDER BY (resolved_at IS NULL) DESC, from_ts DESC
        LIMIT 200`
    );
  }

  private countUntrustedGapsSync(since: number): number {
    return (
      this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM unifi_collection_gaps WHERE clock_untrusted = 1 AND resolved_at IS NULL AND last_reported_at >= ?",
        since
      )?.n ?? 0
    );
  }

  // ── unifi_ingest_health ───────────────────────────────────────────────────

  private recordIngestHealthSync(params: {
    skew_ms: number | null;
    skew_trusted: 0 | 1;
    gaps_untrusted: number;
    last_untrusted_at: number | null;
    now: number;
  }): void {
    this.runNamed(
      `INSERT INTO unifi_ingest_health (
         id, skew_ms, skew_trusted, gaps_untrusted, last_untrusted_at, updated_at
       ) VALUES (1, @skew_ms, @skew_trusted, @gaps_untrusted, @last_untrusted_at, @now)
       ON CONFLICT(id) DO UPDATE SET
         skew_ms = excluded.skew_ms,
         skew_trusted = excluded.skew_trusted,
         gaps_untrusted = excluded.gaps_untrusted,
         last_untrusted_at = COALESCE(excluded.last_untrusted_at, unifi_ingest_health.last_untrusted_at),
         updated_at = excluded.updated_at`,
      params
    );
  }

  public async getIngestHealthStatus(): Promise<IngestHealthRow | null> {
    const row = this.get<Omit<IngestHealthRow, "gaps_untrusted">>(
      "SELECT skew_ms, skew_trusted, last_untrusted_at, updated_at FROM unifi_ingest_health WHERE id = 1"
    );
    const untrusted = this.countUntrustedGapsSync(Date.now() - UNTRUSTED_GAP_WINDOW_MS);
    if (!row && untrusted === 0) return null;
    return {
      skew_ms: row?.skew_ms ?? null,
      skew_trusted: row?.skew_trusted ?? 1,
      last_untrusted_at: row?.last_untrusted_at ?? null,
      updated_at: row?.updated_at ?? null,
      gaps_untrusted: untrusted,
    };
  }

  // ── unifi_collection_compat ───────────────────────────────────────────────

  private recordCompatSync(params: {
    stream: string;
    status: string;
    page_base: number | null;
    filter_variant: string | null;
    evidence: string | null;
    negotiated_at: number | null;
    held: 0 | 1;
    now: number;
  }): void {
    this.runNamed(
      `INSERT INTO unifi_collection_compat (
         stream, status, page_base, filter_variant, evidence, negotiated_at, held, updated_at
       ) VALUES (
         @stream, @status, @page_base, @filter_variant, @evidence, @negotiated_at, @held, @now
       )
       ON CONFLICT(stream) DO UPDATE SET
         status = excluded.status,
         page_base = excluded.page_base,
         filter_variant = excluded.filter_variant,
         evidence = excluded.evidence,
         negotiated_at = excluded.negotiated_at,
         held = excluded.held,
         updated_at = excluded.updated_at`,
      params
    );
  }

  public async listCompat(): Promise<CompatRow[]> {
    return this.all<CompatRow>(
      `SELECT stream, status, page_base, filter_variant, evidence, negotiated_at, held, updated_at
         FROM unifi_collection_compat
        ORDER BY stream`
    );
  }

  // ── Pagination query ──────────────────────────────────────────────────────

  public async readPage<T>(
    config: PageConfig,
    request: PageRequest,
    filterArgs: {
      query: string;
      category?: string;
      severity?: string;
      action?: string;
      protocol?: string;
      policy?: string;
    }
  ): Promise<PageResult<T>> {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (request.from != null) {
      where.push(`${config.tsColumn} >= ?`);
      params.push(request.from);
    }
    if (request.to != null) {
      where.push(`${config.tsColumn} <= ?`);
      params.push(request.to);
    }
    config.addFilters(
      where, params,
      filterArgs.query,
      filterArgs.category,
      filterArgs.severity,
      filterArgs.action,
      filterArgs.protocol,
      filterArgs.policy
    );

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const matchingTotal =
      this.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${config.table} ${whereClause}`,
        ...params
      )?.n ?? 0;

    const pageWhere = [...where];
    const pageParams = [...params];
    if (request.beforeTs != null && request.beforeId != null) {
      pageWhere.push(`(${config.tsColumn} < ? OR (${config.tsColumn} = ? AND id < ?))`);
      pageParams.push(request.beforeTs, request.beforeTs, request.beforeId);
    }

    const pageWhereClause = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";
    const fetched = this.all<T>(
      `SELECT ${config.columns}
         FROM ${config.table}
        ${pageWhereClause}
        ORDER BY ${config.tsColumn} DESC, id DESC
        LIMIT ?`,
      ...pageParams,
      request.limit + 1
    );
    const hasMore = fetched.length > request.limit;
    const rows = hasMore ? fetched.slice(0, request.limit) : fetched;
    const last = rows[rows.length - 1] as Record<string, unknown> | undefined;

    const stats = this.get<{ total: number; oldest: number | null; newest: number | null }>(
      `SELECT COUNT(*) AS total, MIN(${config.tsColumn}) AS oldest, MAX(${config.tsColumn}) AS newest
         FROM ${config.table}`
    );

    return {
      ok: true,
      rows,
      matchingTotal,
      total: stats?.total ?? 0,
      oldestAt: stats?.oldest ?? null,
      newestAt: stats?.newest ?? null,
      nextCursor:
        hasMore && last
          ? { ts: last[config.tsColumn] as number, id: last["id"] as number }
          : null,
      retention: config.retention,
    };
  }

  // ── Summary queries ───────────────────────────────────────────────────────

  public async summarizeActivity(): Promise<{ count: number; oldestAt: number | null; newestAt: number | null }> {
    return (
      this.get<{ count: number; oldestAt: number | null; newestAt: number | null }>(
        "SELECT COUNT(*) AS count, MIN(event_ts) AS oldestAt, MAX(event_ts) AS newestAt FROM unifi_activity_logs"
      ) ?? { count: 0, oldestAt: null, newestAt: null }
    );
  }

  public async summarizeFlows(): Promise<{ count: number; oldestAt: number | null; newestAt: number | null }> {
    return (
      this.get<{ count: number; oldestAt: number | null; newestAt: number | null }>(
        "SELECT COUNT(*) AS count, MIN(flow_ts) AS oldestAt, MAX(flow_ts) AS newestAt FROM unifi_traffic_flows"
      ) ?? { count: 0, oldestAt: null, newestAt: null }
    );
  }

  public async activityCategories(): Promise<string[]> {
    return this.all<{ value: string }>(
      `SELECT DISTINCT category AS value FROM unifi_activity_logs
        WHERE category IS NOT NULL AND category <> ''
        ORDER BY category LIMIT 100`
    ).map((r) => r.value);
  }

  public async activitySeverities(): Promise<string[]> {
    return this.all<{ value: string }>(
      `SELECT DISTINCT severity AS value FROM unifi_activity_logs
        WHERE severity IS NOT NULL AND severity <> ''
        ORDER BY severity LIMIT 50`
    ).map((r) => r.value);
  }

  public async flowActions(): Promise<string[]> {
    return this.all<{ value: string }>(
      `SELECT DISTINCT action AS value FROM unifi_traffic_flows
        WHERE action IS NOT NULL AND action <> ''
        ORDER BY action LIMIT 50`
    ).map((r) => r.value);
  }

  public async flowProtocols(): Promise<string[]> {
    return this.all<{ value: string }>(
      `SELECT DISTINCT protocol AS value FROM unifi_traffic_flows
        WHERE protocol IS NOT NULL AND protocol <> ''
        ORDER BY protocol LIMIT 100`
    ).map((r) => r.value);
  }

  // ── Maintenance pruning (archive-aware) ───────────────────────────────────

  private pruneActivitySync(cutoff: number, rowCapId: number | undefined): void {
    this.archive.deleteBefore("unifi-activity", "unifi_activity_logs", "event_ts", cutoff);
    this.archive.deleteThroughId("unifi-activity", "unifi_activity_logs", "event_ts", rowCapId ?? null);
  }

  private pruneFlowsSync(cutoff: number, rowCapId: number | undefined): void {
    this.archive.deleteBefore("unifi-flows", "unifi_traffic_flows", "flow_ts", cutoff);
    this.archive.deleteThroughId("unifi-flows", "unifi_traffic_flows", "flow_ts", rowCapId ?? null);
  }
}
