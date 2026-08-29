import type { SqliteDatabase } from "../../connection.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import { SqliteRepository } from "./base.js";

const READINGS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export interface ProtectReadingRow {
  readonly received_at: number;
  readonly num_cameras: number | null;
  readonly cameras_online: number | null;
  readonly storage_used_bytes: number | null;
  readonly storage_total_bytes: number | null;
}

export interface ProtectLatestRow {
  readonly id: number;
  readonly received_at: number;
  readonly payload: string;
}

export interface ProtectEventRow {
  readonly event_id: string;
  readonly start_ms: number;
  readonly end_ms: number | null;
  readonly type: string | null;
  readonly camera_id: string | null;
  readonly camera_name: string | null;
  readonly smart_types: string;
  readonly score: number | null;
}

export interface ProtectEventTypeCount {
  readonly type: string | null;
  readonly n: number;
}

export interface ProtectActivityRow {
  readonly camera: string;
  readonly hour: number;
  readonly n: number;
}

export interface ProtectStorageSample {
  readonly received_at: number;
  readonly used: number;
  readonly total: number | null;
}

export interface IngestProtectInput {
  readonly now: number;
  readonly numCameras: number;
  readonly camerasOnline: number;
  readonly storageUsedBytes: number | null;
  readonly storageTotalBytes: number | null;
  readonly payload: string;
  readonly events: ReadonlyArray<{
    readonly event_id: string;
    readonly start_ms: number;
    readonly end_ms: number | null;
    readonly type: string | null;
    readonly camera_id: string | null;
    readonly camera_name: string | null;
    readonly smart_types: string;
    readonly score: number | null;
  }>;
  readonly prune: boolean;
}

export interface ProtectRepository {
  ingest(input: IngestProtectInput, deliveryId: string | null): Promise<{ duplicate: boolean; receivedAt: number }>;
  setLastPruneAt(ts: number): Promise<void>;
  shouldPrune(now: number): Promise<boolean>;
  getLatest(): Promise<ProtectLatestRow | undefined>;
  getHistory(cutoff: number): Promise<ProtectReadingRow[]>;
  getEvents(cutoff: number, camera: string | undefined, type: string | undefined): Promise<ProtectEventRow[]>;
  getEventTypeCount(cutoff: number, camera: string | undefined, type: string | undefined): Promise<ProtectEventTypeCount[]>;
  getEventTotal(cutoff: number, camera: string | undefined, type: string | undefined): Promise<number>;
  getActivity(cutoff: number, tzOffsetMs: number): Promise<ProtectActivityRow[]>;
  getStorageSamples(cutoff: number): Promise<ProtectStorageSample[]>;
}

export class SqliteProtectRepository extends SqliteRepository implements ProtectRepository {
  private lastPruneAt = 0;

  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim
  ) {
    super(database);
  }

  public async setLastPruneAt(ts: number): Promise<void> {
    this.lastPruneAt = ts;
  }

  public async shouldPrune(now: number): Promise<boolean> {
    return now - this.lastPruneAt >= PRUNE_INTERVAL_MS;
  }

  public async ingest(
    input: IngestProtectInput,
    deliveryId: string | null
  ): Promise<{ duplicate: boolean; receivedAt: number }> {
    return this.transaction(() => this.ingestSync(input, deliveryId));
  }

  private ingestSync(
    input: IngestProtectInput,
    deliveryId: string | null
  ): { duplicate: boolean; receivedAt: number } {
    if (!this.receipts.claim(deliveryId, "/api/protect/ingest", input.now)) {
      return { duplicate: true, receivedAt: input.now };
    }
    this.runNamed(
      `INSERT INTO protect_readings
        (received_at, num_cameras, cameras_online, storage_used_bytes, storage_total_bytes)
       VALUES (@received_at, @num_cameras, @cameras_online, @storage_used_bytes, @storage_total_bytes)`,
      {
        received_at: input.now,
        num_cameras: input.numCameras,
        cameras_online: input.camerasOnline,
        storage_used_bytes: input.storageUsedBytes,
        storage_total_bytes: input.storageTotalBytes,
      }
    );
    this.runNamed(
      `INSERT INTO protect_latest (id, received_at, payload) VALUES (1, @received_at, @payload)
       ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`,
      { received_at: input.now, payload: input.payload }
    );
    for (const e of input.events) {
      this.runNamed(
        `INSERT INTO protect_events
          (event_id, start_ms, end_ms, type, camera_id, camera_name, smart_types, score)
         VALUES (@event_id, @start_ms, @end_ms, @type, @camera_id, @camera_name, @smart_types, @score)
         ON CONFLICT(event_id) DO UPDATE SET
           end_ms      = COALESCE(excluded.end_ms, protect_events.end_ms),
           camera_name = COALESCE(excluded.camera_name, protect_events.camera_name),
           smart_types = excluded.smart_types,
           score       = COALESCE(excluded.score, protect_events.score)`,
        {
          event_id: e.event_id,
          start_ms: e.start_ms,
          end_ms: e.end_ms,
          type: e.type,
          camera_id: e.camera_id,
          camera_name: e.camera_name,
          smart_types: e.smart_types,
          score: e.score,
        }
      );
    }
    if (input.prune) {
      this.run("DELETE FROM protect_readings WHERE received_at < ?", input.now - READINGS_RETENTION_MS);
      this.run("DELETE FROM protect_events WHERE start_ms < ?", input.now - EVENTS_RETENTION_MS);
    }
    return { duplicate: false, receivedAt: input.now };
  }

  public async getLatest(): Promise<ProtectLatestRow | undefined> {
    return this.get<ProtectLatestRow>("SELECT * FROM protect_latest WHERE id = 1");
  }

  public async getHistory(cutoff: number): Promise<ProtectReadingRow[]> {
    return this.all<ProtectReadingRow>(
      `SELECT received_at, num_cameras, cameras_online, storage_used_bytes, storage_total_bytes
       FROM protect_readings
       WHERE received_at >= ?
       ORDER BY received_at ASC LIMIT 3000`,
      cutoff
    );
  }

  public async getEvents(
    cutoff: number,
    camera: string | undefined,
    type: string | undefined
  ): Promise<ProtectEventRow[]> {
    const { sql, args } = this.buildEventWhere(cutoff, camera, type);
    return this.all<ProtectEventRow>(
      `SELECT event_id, start_ms, end_ms, type, camera_id, camera_name, smart_types, score
       FROM protect_events WHERE ${sql}
       ORDER BY start_ms DESC`,
      ...args
    );
  }

  public async getEventTypeCount(
    cutoff: number,
    camera: string | undefined,
    type: string | undefined
  ): Promise<ProtectEventTypeCount[]> {
    const { sql, args } = this.buildEventWhere(cutoff, camera, type);
    return this.all<ProtectEventTypeCount>(
      `SELECT type, COUNT(*) AS n FROM protect_events WHERE ${sql} GROUP BY type ORDER BY n DESC`,
      ...args
    );
  }

  public async getEventTotal(
    cutoff: number,
    camera: string | undefined,
    type: string | undefined
  ): Promise<number> {
    const { sql, args } = this.buildEventWhere(cutoff, camera, type);
    const row = this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM protect_events WHERE ${sql}`,
      ...args
    );
    return row?.n ?? 0;
  }

  public async getActivity(cutoff: number, tzOffsetMs: number): Promise<ProtectActivityRow[]> {
    return this.all<ProtectActivityRow>(
      `SELECT
         COALESCE(camera_name, 'Unknown') AS camera,
         CAST(strftime('%H', (start_ms - ?) / 1000, 'unixepoch') AS INTEGER) AS hour,
         COUNT(*) AS n
       FROM protect_events
       WHERE start_ms >= ?
       GROUP BY camera, hour`,
      tzOffsetMs,
      cutoff
    );
  }

  public async getStorageSamples(cutoff: number): Promise<ProtectStorageSample[]> {
    return this.all<ProtectStorageSample>(
      `SELECT received_at, storage_used_bytes AS used, storage_total_bytes AS total
       FROM protect_readings
       WHERE storage_used_bytes IS NOT NULL AND received_at >= ?
       ORDER BY received_at ASC`,
      cutoff
    );
  }

  private buildEventWhere(
    cutoff: number,
    camera: string | undefined,
    type: string | undefined
  ): { sql: string; args: (string | number)[] } {
    const clauses = ["start_ms >= ?"];
    const args: (string | number)[] = [cutoff];
    if (camera !== undefined) {
      clauses.push("camera_id = ?");
      args.push(camera);
    }
    if (type !== undefined) {
      clauses.push("type = ?");
      args.push(type);
    }
    return { sql: clauses.join(" AND "), args };
  }
}
