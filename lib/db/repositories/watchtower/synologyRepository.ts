import type { SqliteDatabase } from "../../connection.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import { SqliteRepository } from "./base.js";

const SAMPLE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SHARE_SAMPLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 3600e3;

export interface SynologyLatestRow {
  readonly nas_id: string;
  readonly label: string;
  readonly host: string | null;
  readonly payload: Buffer | string;
  readonly received_at: number;
}

export interface SynologyVolumeSample {
  readonly nas_id: string;
  readonly volume_id: string;
  readonly ts: number;
  readonly total_bytes: number | null;
  readonly used_bytes: number | null;
}

export interface SynologyDiskSample {
  readonly nas_id: string;
  readonly disk_id: string;
  readonly ts: number;
  readonly temp_c: number | null;
  readonly smart_status: string | null;
  readonly health: string | null;
  readonly bad_sectors: number | null;
}

export interface SynologyShareSample {
  readonly nas_id: string;
  readonly share_name: string;
  readonly ts: number;
  readonly used_bytes: number | null;
}

export interface SynologyBackupRun {
  readonly nas_id: string;
  readonly task_id: string;
  readonly task_name: string | null;
  readonly last_run_ts: number;
  readonly result: string | null;
}

export interface SynologyExternalDevice {
  readonly nas_id: string;
  readonly device_id: string;
  readonly kind: string | null;
  readonly name: string | null;
  readonly model: string | null;
  readonly fs: string | null;
  readonly size_bytes: number | null;
  readonly used_bytes: number | null;
  readonly first_seen: number;
  readonly last_seen: number;
}

export interface IngestVolume {
  readonly id: string;
  readonly total_bytes: number | null;
  readonly used_bytes: number | null;
}

export interface IngestDisk {
  readonly id: string;
  readonly temp_c: number | null;
  readonly smart_status: string | null;
  readonly health: string | null;
  readonly bad_sectors: number | null;
}

export interface IngestShare {
  readonly name: string;
  readonly used_bytes: number | null;
}

export interface IngestBackupTask {
  readonly id: string;
  readonly name: string | null;
  readonly last_run_ts: number;
  readonly last_result: string | null;
}

export interface IngestExternal {
  readonly id: string;
  readonly kind: string | null;
  readonly name: string | null;
  readonly model: string | null;
  readonly fs: string | null;
  readonly size_bytes: number | null;
  readonly used_bytes: number | null;
}

export interface IngestSynologyInput {
  readonly nasId: string;
  readonly label: string;
  readonly host: string | null;
  readonly payload: Buffer;
  readonly ts: number;
  readonly now: number;
  readonly volumes: readonly IngestVolume[];
  readonly disks: readonly IngestDisk[];
  readonly shares: readonly IngestShare[];
  readonly backupTasks: readonly IngestBackupTask[];
  readonly external: readonly IngestExternal[];
  readonly prune: boolean;
}

export interface ForecastResult {
  readonly days: number | null;
  readonly bytes_per_day?: number;
  readonly span_days?: number;
  readonly samples?: number;
  readonly reason?: string;
}

export interface VolumeSeries {
  readonly nas_id: string;
  readonly volume_id: string;
  readonly points: ReadonlyArray<{ ts: number; total_bytes: number | null; used_bytes: number | null }>;
  readonly forecast: ForecastResult | null;
}

export interface LatestBackupRun {
  readonly task_name: string | null;
  readonly result: string | null;
}

export interface SynologyRepository {
  ingest(input: IngestSynologyInput, deliveryId: string | null): Promise<{ duplicate: boolean; receivedAt: number }>;
  setLastPruneAt(ts: number): Promise<void>;
  shouldPrune(now: number): Promise<boolean>;
  getAll(): Promise<SynologyLatestRow[]>;
  getHistory(cutoff: number, nasId: string | null): Promise<VolumeSeries[]>;
  getShares(cutoff: number, nasId: string | null): Promise<{ shares: string[]; points: Record<string, unknown>[] }>;
  getBackups(cutoffSec: number): Promise<SynologyBackupRun[]>;
  getSummaryRows(): Promise<SynologyLatestRow[]>;
  getLatestBackupRuns(): Promise<LatestBackupRun[]>;
  getExternal(): Promise<{ devices: (SynologyExternalDevice & { nas_label: string; attached: boolean })[] }>;
  getExternalDevice(nasId: string, deviceId: string): Promise<SynologyExternalDevice | undefined>;
  getLastPushAt(nasId: string): Promise<number>;
  deleteExternalDevice(nasId: string, deviceId: string): Promise<void>;
  getDisks(cutoff: number, nasId: string | null): Promise<SynologyDiskSample[]>;
}

export class SqliteSynologyRepository extends SqliteRepository implements SynologyRepository {
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
    input: IngestSynologyInput,
    deliveryId: string | null
  ): Promise<{ duplicate: boolean; receivedAt: number }> {
    return this.transaction(() => this.ingestSync(input, deliveryId));
  }

  private ingestSync(
    input: IngestSynologyInput,
    deliveryId: string | null
  ): { duplicate: boolean; receivedAt: number } {
    if (!this.receipts.claim(deliveryId, "/api/synology/ingest", input.now)) {
      return { duplicate: true, receivedAt: input.now };
    }

    this.runNamed(
      `INSERT INTO synology_latest (nas_id, label, host, payload, received_at)
       VALUES (@nas_id, @label, @host, @payload, @received_at)
       ON CONFLICT(nas_id) DO UPDATE SET
         label = excluded.label, host = excluded.host,
         payload = excluded.payload, received_at = excluded.received_at`,
      {
        nas_id: input.nasId,
        label: input.label,
        host: input.host,
        payload: input.payload,
        received_at: input.now,
      }
    );

    for (const v of input.volumes) {
      this.run(
        "INSERT INTO synology_volume_samples (nas_id, volume_id, ts, total_bytes, used_bytes, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        input.nasId,
        v.id,
        input.ts,
        v.total_bytes,
        v.used_bytes,
        input.now
      );
    }

    for (const d of input.disks) {
      this.run(
        "INSERT INTO synology_disk_samples (nas_id, disk_id, ts, temp_c, smart_status, health, bad_sectors, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        input.nasId,
        d.id,
        input.ts,
        d.temp_c,
        d.smart_status,
        d.health,
        d.bad_sectors,
        input.now
      );
    }

    for (const s of input.shares) {
      if (s.used_bytes === null) continue;
      const last = this.get<{ t: number | null }>(
        "SELECT MAX(ts) AS t FROM synology_share_samples WHERE nas_id = ? AND share_name = ?",
        input.nasId,
        s.name
      );
      const lastTs = last?.t ?? 0;
      if (input.ts - lastTs < SHARE_SAMPLE_INTERVAL_MS) continue;
      this.run(
        "INSERT INTO synology_share_samples (nas_id, share_name, ts, used_bytes, received_at) VALUES (?, ?, ?, ?, ?)",
        input.nasId,
        s.name,
        input.ts,
        s.used_bytes,
        input.now
      );
    }

    for (const t of input.backupTasks) {
      this.run(
        "INSERT OR IGNORE INTO synology_backup_runs (nas_id, task_id, task_name, last_run_ts, result, received_at) VALUES (?, ?, ?, ?, ?, ?)",
        input.nasId,
        t.id,
        t.name,
        t.last_run_ts,
        t.last_result,
        input.now
      );
    }

    for (const e of input.external) {
      this.runNamed(
        `INSERT INTO synology_external_devices
          (nas_id, device_id, kind, name, model, fs, size_bytes, used_bytes, first_seen, last_seen)
         VALUES (@nas_id, @device_id, @kind, @name, @model, @fs, @size_bytes, @used_bytes, @seen, @seen)
         ON CONFLICT(nas_id, device_id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, model = excluded.model, fs = excluded.fs,
           size_bytes = excluded.size_bytes, used_bytes = excluded.used_bytes,
           last_seen = excluded.last_seen`,
        {
          nas_id: input.nasId,
          device_id: e.id,
          kind: e.kind,
          name: e.name,
          model: e.model,
          fs: e.fs,
          size_bytes: e.size_bytes,
          used_bytes: e.used_bytes,
          seen: input.now,
        }
      );
    }

    if (input.prune) {
      // Retention prunes on the server-authored received_at, never the agent's
      // `ts`: a device clock (untrusted) must not decide what stays. The `ts`
      // column is kept untouched as evidence of when the sample was measured.
      const cutoff = input.now - SAMPLE_RETENTION_MS;
      this.run("DELETE FROM synology_volume_samples WHERE received_at < ?", cutoff);
      this.run("DELETE FROM synology_disk_samples WHERE received_at < ?", cutoff);
      this.run("DELETE FROM synology_share_samples WHERE received_at < ?", cutoff);
    }

    return { duplicate: false, receivedAt: input.now };
  }

  public async getAll(): Promise<SynologyLatestRow[]> {
    return this.all<SynologyLatestRow>("SELECT * FROM synology_latest ORDER BY label");
  }

  public async getHistory(cutoff: number, nasId: string | null): Promise<VolumeSeries[]> {
    const rows = this.all<SynologyVolumeSample>(
      `SELECT nas_id, volume_id, ts, total_bytes, used_bytes
       FROM synology_volume_samples
       WHERE ts >= ? AND (? IS NULL OR nas_id = ?)
       ORDER BY ts ASC`,
      cutoff,
      nasId,
      nasId
    );

    const seriesMap = new Map<string, { nas_id: string; volume_id: string; points: { ts: number; total_bytes: number | null; used_bytes: number | null }[] }>();
    for (const r of rows) {
      const key = `${r.nas_id}::${r.volume_id}`;
      if (!seriesMap.has(key)) {
        seriesMap.set(key, { nas_id: r.nas_id, volume_id: r.volume_id, points: [] });
      }
      seriesMap.get(key)!.points.push({ ts: r.ts, total_bytes: r.total_bytes, used_bytes: r.used_bytes });
    }

    return [...seriesMap.values()].map((s) => ({
      ...s,
      forecast: forecastFull(s.points),
    }));
  }

  public async getShares(
    cutoff: number,
    nasId: string | null
  ): Promise<{ shares: string[]; points: Record<string, unknown>[] }> {
    const rows = this.all<SynologyShareSample>(
      `SELECT nas_id, share_name, ts, used_bytes
       FROM synology_share_samples
       WHERE ts >= ? AND (? IS NULL OR nas_id = ?)
       ORDER BY ts ASC`,
      cutoff,
      nasId,
      nasId
    );

    const byDay = new Map<string, Record<string, unknown>>();
    const names = new Set<string>();
    for (const r of rows) {
      const day = Math.floor(r.ts / DAY_MS) * DAY_MS;
      const key = `${r.nas_id}::${day}`;
      if (!byDay.has(key)) byDay.set(key, { ts: day, nas_id: r.nas_id });
      const entry = byDay.get(key)!;
      entry[r.share_name] = r.used_bytes;
      names.add(r.share_name);
    }
    const points = [...byDay.values()].sort((a, b) => (a["ts"] as number) - (b["ts"] as number));
    return { shares: [...names].sort(), points };
  }

  public async getBackups(cutoffSec: number): Promise<SynologyBackupRun[]> {
    return this.all<SynologyBackupRun>(
      `SELECT nas_id, task_id, task_name, last_run_ts, result
       FROM synology_backup_runs
       WHERE last_run_ts >= ?
       ORDER BY last_run_ts DESC`,
      cutoffSec
    );
  }

  public async getSummaryRows(): Promise<SynologyLatestRow[]> {
    return this.all<SynologyLatestRow>("SELECT * FROM synology_latest");
  }

  public async getLatestBackupRuns(): Promise<LatestBackupRun[]> {
    return this.all<LatestBackupRun>(
      `SELECT r.task_name, r.result FROM synology_backup_runs r
       JOIN (SELECT nas_id, task_id, MAX(last_run_ts) AS m FROM synology_backup_runs GROUP BY nas_id, task_id) x
         ON x.nas_id = r.nas_id AND x.task_id = r.task_id AND x.m = r.last_run_ts`
    );
  }

  public async getExternal(): Promise<{ devices: (SynologyExternalDevice & { nas_label: string; attached: boolean })[] }> {
    const latest = this.all<{ nas_id: string; label: string; received_at: number }>(
      "SELECT nas_id, label, received_at FROM synology_latest"
    );
    const lastPushByNas = new Map(latest.map((r) => [r.nas_id, r.received_at]));
    const labelByNas = new Map(latest.map((r) => [r.nas_id, r.label]));

    const rows = this.all<SynologyExternalDevice>(
      "SELECT * FROM synology_external_devices ORDER BY nas_id, name"
    );
    const devices = rows.map((r) => {
      const lastPush = lastPushByNas.get(r.nas_id) ?? 0;
      return {
        ...r,
        nas_label: labelByNas.get(r.nas_id) ?? r.nas_id,
        attached: lastPush > 0 && r.last_seen >= lastPush,
      };
    });
    return { devices };
  }

  public async getExternalDevice(nasId: string, deviceId: string): Promise<SynologyExternalDevice | undefined> {
    return this.get<SynologyExternalDevice>(
      "SELECT * FROM synology_external_devices WHERE nas_id = ? AND device_id = ?",
      nasId,
      deviceId
    );
  }

  public async getLastPushAt(nasId: string): Promise<number> {
    const row = this.get<{ received_at: number }>(
      "SELECT received_at FROM synology_latest WHERE nas_id = ?",
      nasId
    );
    return row?.received_at ?? 0;
  }

  public async deleteExternalDevice(nasId: string, deviceId: string): Promise<void> {
    this.run(
      "DELETE FROM synology_external_devices WHERE nas_id = ? AND device_id = ?",
      nasId,
      deviceId
    );
  }

  public async getDisks(cutoff: number, nasId: string | null): Promise<SynologyDiskSample[]> {
    return this.all<SynologyDiskSample>(
      `SELECT nas_id, disk_id, ts, temp_c, smart_status, health, bad_sectors
       FROM synology_disk_samples
       WHERE ts >= ? AND (? IS NULL OR nas_id = ?)
       ORDER BY ts ASC`,
      cutoff,
      nasId,
      nasId
    );
  }
}

export function forecastFull(
  points: ReadonlyArray<{ ts: number; total_bytes: number | null; used_bytes: number | null }>
): ForecastResult | null {
  const usable = points.filter((p) => p.used_bytes != null && p.total_bytes);
  if (usable.length < 2) return null;

  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const spanMs = last.ts - first.ts;
  if (spanMs < 3 * DAY_MS) return { days: null, reason: "not enough history yet" };

  const t0 = first.ts;
  const xs = usable.map((p) => (p.ts - t0) / DAY_MS);
  const ys = usable.map((p) => p.used_bytes as number);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
    den += ((xs[i] as number) - meanX) ** 2;
  }
  if (den === 0) return { days: null, reason: "not enough history yet" };

  const bytesPerDay = num / den;
  if (bytesPerDay <= 0) return { days: null, bytes_per_day: bytesPerDay, reason: "not filling" };

  const remaining = (last.total_bytes as number) - (last.used_bytes as number);
  return {
    days: Math.max(0, Math.round(remaining / bytesPerDay)),
    bytes_per_day: Math.round(bytesPerDay),
    span_days: Math.round(spanMs / DAY_MS),
    samples: n,
  };
}
