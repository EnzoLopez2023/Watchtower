import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";
import { asText } from "../../../monitoring/values.js";

export interface LatestSnapshotRow {
  readonly received_at: number;
  readonly payload: unknown;
}

export interface UpsReadingRow {
  readonly received_at: number;
  readonly ups_id: string | null;
  readonly ups_label: string | null;
  readonly ups_status: string | null;
  readonly battery_charge: number | null;
  readonly battery_runtime: number | null;
  readonly battery_voltage: number | null;
  readonly ups_load: number | null;
  readonly agent_diag: string | null;
}

export interface SynologySnapshotRow {
  readonly nas_id: string;
  readonly label: string | null;
  readonly received_at: number;
  readonly payload: unknown;
}

export interface ObserverSnapshotRow {
  readonly observer_id: string;
  readonly received_at: number;
  readonly payload: unknown;
}

/**
 * Read model behind the shared infrastructure verdict. Every query is a direct
 * table read against the owned monitoring tables — no self-HTTP fan-out — so one
 * slow upstream cannot take the whole status endpoint down.
 */
export interface InfraStatusRepository {
  unifiLatest(): Promise<LatestSnapshotRow | undefined>;
  protectLatest(): Promise<LatestSnapshotRow | undefined>;
  latestUpsReadings(): Promise<UpsReadingRow[]>;
  upsDiagnostics(since: number, limit: number): Promise<Array<{ agent_diag: string | null }>>;
  newestUpsDiagnostic(): Promise<string | null>;
  onBatterySince(upsId: string | null): Promise<number | null>;
  synologyLatest(): Promise<SynologySnapshotRow[]>;
  latestBackupRunResults(): Promise<Array<{ result: string | null }>>;
  observerLatest(): Promise<ObserverSnapshotRow | undefined>;
  agentContact(): Promise<AgentContactTimestamps>;
}

export interface AgentContactTimestamps {
  readonly unifi: number | null;
  readonly protect: number | null;
  readonly ups: number | null;
  readonly shutdown: number | null;
  readonly synology: number | null;
  readonly networkObserver: number | null;
}

export class SqliteInfraStatusRepository extends SqliteRepository implements InfraStatusRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  public async unifiLatest(): Promise<LatestSnapshotRow | undefined> {
    return this.get<LatestSnapshotRow>("SELECT received_at, payload FROM unifi_latest WHERE id = 1");
  }

  public async protectLatest(): Promise<LatestSnapshotRow | undefined> {
    return this.get<LatestSnapshotRow>(
      "SELECT received_at, payload FROM protect_latest WHERE id = 1"
    );
  }

  /** Latest row per UPS. `IS` rather than `=` so a legacy NULL ups_id still matches. */
  public async latestUpsReadings(): Promise<UpsReadingRow[]> {
    return this.all<UpsReadingRow>(
      `SELECT r.received_at, r.ups_id, r.ups_label, r.ups_status, r.battery_charge,
              r.battery_runtime, r.battery_voltage, r.ups_load, r.agent_diag
         FROM ups_readings r
         JOIN (SELECT ups_id, MAX(received_at) AS m FROM ups_readings GROUP BY ups_id) x
           ON x.ups_id IS r.ups_id AND x.m = r.received_at
        ORDER BY r.received_at DESC`
    );
  }

  public async upsDiagnostics(since: number, limit: number): Promise<Array<{ agent_diag: string | null }>> {
    return this.all<{ agent_diag: string | null }>(
      `SELECT agent_diag FROM ups_readings
        WHERE agent_diag IS NOT NULL AND received_at > ?
        ORDER BY received_at DESC LIMIT ?`,
      since,
      limit
    );
  }

  public async newestUpsDiagnostic(): Promise<string | null> {
    return (
      this.get<{ payload: string | null }>(
        "SELECT agent_diag AS payload FROM ups_readings ORDER BY received_at DESC LIMIT 1"
      )?.payload ?? null
    );
  }

  public async onBatterySince(upsId: string | null): Promise<number | null> {
    const rows = this.all<{ received_at: number; ups_status: string | null }>(
      `SELECT received_at, ups_status FROM ups_readings
        WHERE ups_id IS ? ORDER BY received_at DESC LIMIT 500`,
      upsId
    );
    let since: number | null = null;
    for (const row of rows) {
      const tokens = asText(row.ups_status)
        .toUpperCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!tokens.includes("OB")) break;
      since = row.received_at;
    }
    return since;
  }

  public async synologyLatest(): Promise<SynologySnapshotRow[]> {
    return this.all<SynologySnapshotRow>(
      "SELECT nas_id, label, received_at, payload FROM synology_latest"
    );
  }

  /** Only failures among each task's most recent run count as outstanding. */
  public async latestBackupRunResults(): Promise<Array<{ result: string | null }>> {
    return this.all<{ result: string | null }>(
      `SELECT r.result FROM synology_backup_runs r
         JOIN (SELECT nas_id, task_id, MAX(last_run_ts) AS m
                 FROM synology_backup_runs GROUP BY nas_id, task_id) x
           ON x.nas_id = r.nas_id AND x.task_id = r.task_id AND x.m = r.last_run_ts`
    );
  }

  public async observerLatest(): Promise<ObserverSnapshotRow | undefined> {
    return this.get<ObserverSnapshotRow>(
      `SELECT observer_id, received_at, payload
         FROM network_observer_latest
        ORDER BY received_at DESC
        LIMIT 1`
    );
  }

  public async agentContact(): Promise<AgentContactTimestamps> {
    const scalar = (sql: string): number | null => {
      try {
        return this.get<{ t: number | null }>(sql)?.t ?? null;
      } catch {
        return null;
      }
    };
    return {
      unifi: scalar("SELECT received_at AS t FROM unifi_latest WHERE id = 1"),
      protect: scalar("SELECT received_at AS t FROM protect_latest WHERE id = 1"),
      ups: scalar("SELECT MAX(received_at) AS t FROM ups_readings"),
      shutdown: scalar("SELECT MAX(received_at) AS t FROM agent_logs WHERE agent = 'shutdown'"),
      synology: scalar("SELECT MAX(received_at) AS t FROM synology_latest"),
      networkObserver: scalar("SELECT MAX(received_at) AS t FROM network_observer_latest")
    };
  }
}
