import type { SqliteDatabase } from "../../connection.js";
import { unpackJson } from "../../../monitoring/payloadCodec.js";
import { asText } from "../../../monitoring/values.js";
import { SqliteRepository, type RunOutcome, type SqlValue } from "./base.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchiveStreamDefinition {
  readonly table: string;
  readonly timestampColumn: string;
  readonly receivedColumn: string;
  readonly columns: string;
  readonly normalize: (row: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The three high-volume streams that are archived to Blob storage. Everything
 * else is either small enough to keep forever or is a snapshot table with no
 * history worth exporting.
 */
export const ARCHIVE_STREAMS: Readonly<Record<string, ArchiveStreamDefinition>> = Object.freeze({
  "agent-logs": {
    table: "agent_logs",
    timestampColumn: "ts",
    receivedColumn: "ts",
    columns: "id, agent, ts, level, message, received_at",
    normalize: (row) => row
  },
  "unifi-activity": {
    table: "unifi_activity_logs",
    timestampColumn: "event_ts",
    receivedColumn: "received_at",
    columns: `
      id, upstream_id, event_ts, received_at, severity, category, subcategory,
      event_type, title, message, actor, target, raw
    `,
    normalize: (row) => ({ ...row, raw: unpackJson(row.raw) })
  },
  "unifi-flows": {
    table: "unifi_traffic_flows",
    timestampColumn: "flow_ts",
    receivedColumn: "received_at",
    columns: "*",
    normalize: (row) => ({
      ...row,
      policy_names: JSON.parse(asText(row.policy_names, "[]")) as unknown,
      policy_types: JSON.parse(asText(row.policy_types, "[]")) as unknown
    })
  }
});

export type ArchiveStreamName = "agent-logs" | "unifi-activity" | "unifi-flows";

export function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function dayLabel(dayStart: number): string {
  return new Date(dayStart).toISOString().slice(0, 10);
}

export interface ArchiveCheckpoint {
  readonly stream: string;
  readonly day_start: number;
  readonly row_count: number;
  readonly source_max_received_at: number | null;
  readonly blob_etag: string | null;
  readonly archived_at: number | null;
  readonly pruned_at: number | null;
}

export interface ArchiveStreamStats {
  readonly row_count: number;
  readonly source_max_received_at: number | null;
}

export interface ArchiveStreamSummaryRow {
  readonly stream: string;
  readonly attempted_days: number;
  readonly archived_days: number;
  readonly last_archived_at: number | null;
  readonly last_error_at: number | null;
}

export interface ArchiveLatestError {
  readonly stream: string;
  readonly day_start: number;
  readonly last_attempt_at: number;
  readonly last_error: string;
}

/**
 * Archive-aware retention. Ingest routes call these instead of a plain DELETE so
 * the hot window can never drop a row the daily Blob does not already contain.
 *
 * These three methods are SYNCHRONOUS because they are called from inside other
 * adapters' ingest transactions (agent-logs, unifi-logs). They are
 * adapter-to-adapter collaborators, not domain-facing contracts.
 */
export interface ArchiveRetention {
  /** True when Blob archival is configured; drives fail-closed pruning. */
  readonly enabled: boolean;
  /** Marks archived days dirty because late rows landed inside them. */
  invalidateDays(stream: ArchiveStreamName, timestamps: readonly number[], now?: number): void;
  /** Deletes rows older than `cutoff`, snapped back to a complete UTC day. */
  deleteBefore(
    stream: ArchiveStreamName,
    table: string,
    timestampColumn: string,
    cutoff: number
  ): RunOutcome;
  /** Deletes rows at or below `idThreshold`, snapped back to a complete UTC day. */
  deleteThroughId(
    stream: ArchiveStreamName,
    table: string,
    timestampColumn: string,
    idThreshold: number | null,
    scopeSql?: string,
    scopeParams?: readonly SqlValue[]
  ): RunOutcome;
}

// ── Async interfaces consumed by domain and workers ────────────────────────


export interface ArchiveStatusSummary {
  readonly enabled: boolean;
  readonly streams?: ArchiveStreamSummaryRow[];
  readonly latestError?: ArchiveLatestError | null;
}

/** Read contract for route/worker consumption of archive status. */
export interface ArchiveStatusReader {
  archiveSummary(): Promise<ArchiveStatusSummary>;
}

/** Async domain-facing contract for monitoring archive operations. */
export interface MonitoringArchiveRepository extends ArchiveStatusReader {
  streamStats(stream: ArchiveStreamDefinition, dayStart: number, dayEnd: number): Promise<ArchiveStreamStats>;
  snapshotStream(
    stream: ArchiveStreamDefinition,
    dayStart: number,
    dayEnd: number
  ): Promise<{ stats: ArchiveStreamStats; rows: Record<string, unknown>[] }>;
  dayBounds(
    stream: ArchiveStreamDefinition,
    eligibleEnd: number
  ): Promise<{ oldest: number | null; newest: number | null }>;
  checkpoint(stream: string, dayStart: number): Promise<ArchiveCheckpoint | undefined>;
  finalizeSuccess(input: {
    readonly streamName: string;
    readonly stream: ArchiveStreamDefinition;
    readonly dayStart: number;
    readonly dayEnd: number;
    readonly expected: ArchiveStreamStats;
    readonly blobName: string;
    readonly rowCount: number;
    readonly sha256: string;
    readonly blobEtag: string;
    readonly attemptedAt: number;
  }): Promise<boolean>;
  saveFailure(input: {
    readonly streamName: string;
    readonly dayStart: number;
    readonly dayEnd: number;
    readonly rowCount: number;
    readonly sourceMaxReceivedAt: number | null;
    readonly attemptedAt: number;
    readonly message: string;
  }): Promise<void>;
  acquireLease(token: string, acquiredAt: number, leaseMs: number): Promise<boolean>;
  renewLease(token: string, leaseUntil: number): Promise<boolean>;
  releaseLease(token: string): Promise<void>;
  summarize(): Promise<ArchiveStreamSummaryRow[]>;
  latestError(): Promise<ArchiveLatestError | undefined>;
}

export class SqliteMonitoringArchiveRepository
  extends SqliteRepository
  implements MonitoringArchiveRepository, ArchiveRetention
{
  public constructor(
    database: SqliteDatabase,
    public readonly enabled: boolean
  ) {
    super(database);
  }

  // ── Archive-aware retention (SYNCHRONOUS — called from ingest transactions) ──

  public invalidateDays(
    stream: ArchiveStreamName,
    timestamps: readonly number[],
    now: number = Date.now()
  ): void {
    if (!this.enabled || !ARCHIVE_STREAMS[stream]) return;
    const days = new Set(timestamps.map(Number).filter(Number.isFinite).map(utcDayStart));
    for (const dayStart of days) {
      this.run(
        `UPDATE monitoring_archive_checkpoints
            SET archived_at = NULL, last_attempt_at = ?, last_error = ?
          WHERE stream = ? AND day_start = ? AND archived_at IS NOT NULL`,
        now,
        "New source rows arrived after archival",
        stream,
        dayStart
      );
    }
  }

  public deleteBefore(
    stream: ArchiveStreamName,
    table: string,
    timestampColumn: string,
    cutoff: number
  ): RunOutcome {
    if (!this.enabled) {
      return this.run(`DELETE FROM ${table} WHERE ${timestampColumn} < ?`, cutoff);
    }
    return this.deleteArchivedRows(stream, table, timestampColumn, `${timestampColumn} < ?`, [
      utcDayStart(cutoff)
    ]);
  }

  public deleteThroughId(
    stream: ArchiveStreamName,
    table: string,
    timestampColumn: string,
    idThreshold: number | null,
    scopeSql = "",
    scopeParams: readonly SqlValue[] = []
  ): RunOutcome {
    if (idThreshold === null || idThreshold === undefined) return { changes: 0, lastInsertRowid: 0 };
    if (!this.enabled) {
      return this.run(
        `DELETE FROM ${table} WHERE id <= ? ${scopeSql}`,
        idThreshold,
        ...scopeParams
      );
    }
    const threshold = this.get<{ timestamp: number | null }>(
      `SELECT ${timestampColumn} AS timestamp FROM ${table} WHERE id = ? ${scopeSql}`,
      idThreshold,
      ...scopeParams
    );
    if (!Number.isFinite(threshold?.timestamp)) return { changes: 0, lastInsertRowid: 0 };
    return this.deleteArchivedRows(
      stream,
      table,
      timestampColumn,
      `${timestampColumn} < ? ${scopeSql}`,
      [utcDayStart(threshold?.timestamp as number), ...scopeParams]
    );
  }

  private deleteArchivedRows(
    stream: string,
    table: string,
    timestampColumn: string,
    whereSql: string,
    whereParams: readonly SqlValue[]
  ): RunOutcome {
    return this.transaction(() => {
      const affectedDays = this.all<{ day_start: number }>(
        `SELECT DISTINCT checkpoint.day_start
           FROM ${table}
           JOIN monitoring_archive_checkpoints checkpoint
             ON checkpoint.stream = ?
            AND checkpoint.archived_at IS NOT NULL
            AND ${table}.${timestampColumn} >= checkpoint.day_start
            AND ${table}.${timestampColumn} < checkpoint.day_end
          WHERE ${whereSql}`,
        stream,
        ...whereParams
      );
      if (!affectedDays.length) return { changes: 0, lastInsertRowid: 0 };

      const result = this.run(
        `DELETE FROM ${table}
          WHERE ${whereSql}
            AND EXISTS (
              SELECT 1 FROM monitoring_archive_checkpoints checkpoint
               WHERE checkpoint.stream = ?
                 AND checkpoint.archived_at IS NOT NULL
                 AND ${table}.${timestampColumn} >= checkpoint.day_start
                 AND ${table}.${timestampColumn} < checkpoint.day_end
            )`,
        ...whereParams,
        stream
      );
      const prunedAt = Date.now();
      for (const row of affectedDays) {
        this.run(
          `UPDATE monitoring_archive_checkpoints
              SET pruned_at = COALESCE(pruned_at, ?)
            WHERE stream = ? AND day_start = ? AND archived_at IS NOT NULL`,
          prunedAt,
          stream,
          row.day_start
        );
      }
      return result;
    });
  }

  // ── Archive run bookkeeping (ASYNC — domain/worker-facing) ────────────────

  public async streamStats(
    stream: ArchiveStreamDefinition,
    dayStart: number,
    dayEnd: number
  ): Promise<ArchiveStreamStats> {
    return this.streamStatsSync(stream, dayStart, dayEnd);
  }

  public async snapshotStream(
    stream: ArchiveStreamDefinition,
    dayStart: number,
    dayEnd: number
  ): Promise<{ stats: ArchiveStreamStats; rows: Record<string, unknown>[] }> {
    return this.transaction(() => {
      const stats = this.streamStatsSync(stream, dayStart, dayEnd);
      const rows = this.all<Record<string, unknown>>(
        `SELECT ${stream.columns}
           FROM ${stream.table}
          WHERE ${stream.timestampColumn} >= ? AND ${stream.timestampColumn} < ?
          ORDER BY ${stream.timestampColumn}, id`,
        dayStart,
        dayEnd
      ).map(stream.normalize);
      return { stats, rows };
    });
  }

  public async dayBounds(
    stream: ArchiveStreamDefinition,
    eligibleEnd: number
  ): Promise<{ oldest: number | null; newest: number | null }> {
    return (
      this.get<{ oldest: number | null; newest: number | null }>(
        `SELECT MIN(${stream.timestampColumn}) AS oldest, MAX(${stream.timestampColumn}) AS newest
           FROM ${stream.table}
          WHERE ${stream.timestampColumn} < ?`,
        eligibleEnd
      ) ?? { oldest: null, newest: null }
    );
  }

  public async checkpoint(stream: string, dayStart: number): Promise<ArchiveCheckpoint | undefined> {
    return this.get<ArchiveCheckpoint>(
      `SELECT stream, day_start, row_count, source_max_received_at, blob_etag, archived_at, pruned_at
         FROM monitoring_archive_checkpoints
        WHERE stream = ? AND day_start = ?`,
      stream,
      dayStart
    );
  }

  /**
   * Writes the success checkpoint only when the source rows are byte-for-byte
   * what was uploaded. Uses an IMMEDIATE transaction (write reservation taken
   * before the final source read) to prevent a partial archive from being recorded
   * if an ingest lands mid-upload.
   */
  public async finalizeSuccess(input: {
    readonly streamName: string;
    readonly stream: ArchiveStreamDefinition;
    readonly dayStart: number;
    readonly dayEnd: number;
    readonly expected: ArchiveStreamStats;
    readonly blobName: string;
    readonly rowCount: number;
    readonly sha256: string;
    readonly blobEtag: string;
    readonly attemptedAt: number;
  }): Promise<boolean> {
    return this.immediateTransaction(() => {
      const current = this.streamStatsSync(input.stream, input.dayStart, input.dayEnd);
      if (
        current.row_count !== input.expected.row_count ||
        current.source_max_received_at !== input.expected.source_max_received_at
      ) {
        return false;
      }
      this.run(
        `INSERT INTO monitoring_archive_checkpoints (
           stream, day_start, day_end, blob_name, row_count, source_max_received_at,
           sha256, blob_etag, archived_at, last_attempt_at, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(stream, day_start) DO UPDATE SET
           day_end = excluded.day_end,
           blob_name = excluded.blob_name,
           row_count = excluded.row_count,
           source_max_received_at = excluded.source_max_received_at,
           sha256 = excluded.sha256,
           blob_etag = excluded.blob_etag,
           archived_at = excluded.archived_at,
           last_attempt_at = excluded.last_attempt_at,
           last_error = NULL`,
        input.streamName,
        input.dayStart,
        input.dayEnd,
        input.blobName,
        input.rowCount,
        input.expected.source_max_received_at,
        input.sha256,
        input.blobEtag,
        Date.now(),
        input.attemptedAt
      );
      return true;
    });
  }

  /** Records a failed attempt without ever downgrading a pruned day's counters. */
  public async saveFailure(input: {
    readonly streamName: string;
    readonly dayStart: number;
    readonly dayEnd: number;
    readonly rowCount: number;
    readonly sourceMaxReceivedAt: number | null;
    readonly attemptedAt: number;
    readonly message: string;
  }): Promise<void> {
    this.run(
      `INSERT INTO monitoring_archive_checkpoints (
         stream, day_start, day_end, row_count, source_max_received_at,
         archived_at, last_attempt_at, last_error
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(stream, day_start) DO UPDATE SET
         day_end = excluded.day_end,
         row_count = CASE
           WHEN monitoring_archive_checkpoints.pruned_at IS NOT NULL
             THEN monitoring_archive_checkpoints.row_count
           ELSE excluded.row_count
         END,
         source_max_received_at = CASE
           WHEN monitoring_archive_checkpoints.pruned_at IS NOT NULL
             THEN monitoring_archive_checkpoints.source_max_received_at
           ELSE excluded.source_max_received_at
         END,
         archived_at = NULL,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error`,
      input.streamName,
      input.dayStart,
      input.dayEnd,
      input.rowCount,
      input.sourceMaxReceivedAt,
      input.attemptedAt,
      input.message.slice(0, 1000)
    );
  }

  // ── Cross-process lease ───────────────────────────────────────────────────

  public async acquireLease(token: string, acquiredAt: number, leaseMs: number): Promise<boolean> {
    return this.transaction(
      () =>
        this.run(
          `INSERT INTO monitoring_archive_run_lock (id, lease_token, lease_until, acquired_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             lease_token = excluded.lease_token,
             lease_until = excluded.lease_until,
             acquired_at = excluded.acquired_at
           WHERE monitoring_archive_run_lock.lease_until <= excluded.acquired_at`,
          token,
          acquiredAt + leaseMs,
          acquiredAt
        ).changes === 1
    );
  }

  public async renewLease(token: string, leaseUntil: number): Promise<boolean> {
    return (
      this.run(
        "UPDATE monitoring_archive_run_lock SET lease_until = ? WHERE id = 1 AND lease_token = ?",
        leaseUntil,
        token
      ).changes === 1
    );
  }

  public async releaseLease(token: string): Promise<void> {
    this.run("DELETE FROM monitoring_archive_run_lock WHERE id = 1 AND lease_token = ?", token);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  public async summarize(): Promise<ArchiveStreamSummaryRow[]> {
    return this.all<ArchiveStreamSummaryRow>(
      `SELECT stream,
              COUNT(*) AS attempted_days,
              SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_days,
              MAX(archived_at) AS last_archived_at,
              MAX(CASE WHEN last_error IS NOT NULL THEN last_attempt_at END) AS last_error_at
         FROM monitoring_archive_checkpoints
        GROUP BY stream`
    );
  }

  public async latestError(): Promise<ArchiveLatestError | undefined> {
    return this.get<ArchiveLatestError>(
      `SELECT stream, day_start, last_attempt_at, last_error
         FROM monitoring_archive_checkpoints
        WHERE last_error IS NOT NULL
        ORDER BY last_attempt_at DESC
        LIMIT 1`
    );
  }

  /**
   * Reports the same keys whether or not archival is configured, so a client
   * never has to branch on the shape of the response to read the status.
   */
  public async archiveSummary(): Promise<ArchiveStatusSummary> {
    if (!this.enabled) {
      return { enabled: false, streams: [], latestError: null };
    }
    return {
      enabled: true,
      streams: await this.summarize(),
      latestError: (await this.latestError()) ?? null
    };
  }

  // ── Private sync helper ───────────────────────────────────────────────────

  private streamStatsSync(
    stream: ArchiveStreamDefinition,
    dayStart: number,
    dayEnd: number
  ): ArchiveStreamStats {
    return (
      this.get<ArchiveStreamStats>(
        `SELECT COUNT(*) AS row_count, MAX(${stream.receivedColumn}) AS source_max_received_at
           FROM ${stream.table}
          WHERE ${stream.timestampColumn} >= ? AND ${stream.timestampColumn} < ?`,
        dayStart,
        dayEnd
      ) ?? { row_count: 0, source_max_received_at: null }
    );
  }
}

export const ARCHIVE_DAY_MS = DAY_MS;
