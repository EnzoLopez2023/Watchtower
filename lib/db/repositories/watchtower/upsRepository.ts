import type { SqliteDatabase } from "../../connection.js";
import type { AgentDeliveryClaim } from "./agentIngestReceiptRepository.js";
import { SqliteRepository } from "./base.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface UpsReadingRow {
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly ups_id: string | null;
  readonly ups_label: string | null;
  readonly ups_status: string | null;
  readonly battery_charge: number | null;
  readonly battery_runtime: number | null;
  readonly battery_voltage: number | null;
  readonly ups_load: number | null;
  readonly input_voltage: number | null;
  readonly output_voltage: number | null;
  readonly output_power: number | null;
  readonly ups_temperature: number | null;
  readonly raw: string | null;
  readonly agent_diag: string | null;
}

export interface UpsHistoryPoint {
  readonly received_at: number;
  readonly ups_id: string | null;
  readonly ups_status: string | null;
  readonly battery_charge: number | null;
  readonly ups_load: number | null;
  readonly battery_runtime: number | null;
  readonly input_voltage: number | null;
  readonly output_power: number | null;
}

export interface UpsOutageReading {
  readonly received_at: number;
  readonly ups_id: string | null;
  readonly ups_label: string | null;
  readonly ups_status: string | null;
  readonly battery_charge: number | null;
  readonly battery_runtime: number | null;
}

export interface UpsRepository {
  ingest(row: UpsReadingRow, deliveryId: string | null): Promise<boolean>;
  getLatestPerUps(): Promise<UpsReadingRow[]>;
  getHistory(cutoff: number, upsId: string | null): Promise<UpsHistoryPoint[]>;
  getOutageReadings(cutoff: number): Promise<UpsOutageReading[]>;
}

export class SqliteUpsRepository extends SqliteRepository implements UpsRepository {
  public constructor(
    database: SqliteDatabase,
    private readonly receipts: AgentDeliveryClaim
  ) {
    super(database);
  }

  public async ingest(row: UpsReadingRow, deliveryId: string | null): Promise<boolean> {
    return this.transaction(() => this.ingestSync(row, deliveryId));
  }

  private ingestSync(row: UpsReadingRow, deliveryId: string | null): boolean {
    if (!this.receipts.claim(deliveryId, "/api/ups/ingest", row.received_at)) {
      return false;
    }
    this.runNamed(
      `INSERT INTO ups_readings
        (received_at, device_ts, ups_id, ups_label, ups_status, battery_charge, battery_runtime,
         battery_voltage, ups_load, input_voltage, output_voltage, output_power,
         ups_temperature, raw, agent_diag)
       VALUES
        (@received_at, @device_ts, @ups_id, @ups_label, @ups_status, @battery_charge,
         @battery_runtime, @battery_voltage, @ups_load, @input_voltage, @output_voltage,
         @output_power, @ups_temperature, @raw, @agent_diag)`,
      {
        received_at: row.received_at,
        device_ts: row.device_ts,
        ups_id: row.ups_id,
        ups_label: row.ups_label,
        ups_status: row.ups_status,
        battery_charge: row.battery_charge,
        battery_runtime: row.battery_runtime,
        battery_voltage: row.battery_voltage,
        ups_load: row.ups_load,
        input_voltage: row.input_voltage,
        output_voltage: row.output_voltage,
        output_power: row.output_power,
        ups_temperature: row.ups_temperature,
        raw: row.raw,
        agent_diag: row.agent_diag,
      }
    );
    this.run("DELETE FROM ups_readings WHERE received_at < ?", row.received_at - RETENTION_MS);
    return true;
  }

  public async getLatestPerUps(): Promise<UpsReadingRow[]> {
    return this.all<UpsReadingRow>(`
      SELECT r.* FROM ups_readings r
      JOIN (SELECT ups_id, MAX(received_at) AS m FROM ups_readings GROUP BY ups_id) x
        ON x.ups_id IS r.ups_id AND x.m = r.received_at
      ORDER BY r.received_at DESC
    `);
  }

  public async getHistory(cutoff: number, upsId: string | null): Promise<UpsHistoryPoint[]> {
    return this.all<UpsHistoryPoint>(
      `SELECT received_at, ups_id, ups_status, battery_charge, ups_load, battery_runtime,
              input_voltage, output_power
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY ups_id ORDER BY received_at DESC) AS rn
         FROM ups_readings
         WHERE received_at >= ? AND (? IS NULL OR ups_id = ?)
       )
       WHERE rn <= 2000
       ORDER BY received_at ASC`,
      cutoff,
      upsId,
      upsId
    );
  }

  public async getOutageReadings(cutoff: number): Promise<UpsOutageReading[]> {
    return this.all<UpsOutageReading>(
      `SELECT received_at, ups_id, ups_label, ups_status, battery_charge, battery_runtime
       FROM ups_readings
       WHERE received_at >= ?
       ORDER BY received_at ASC`,
      cutoff
    );
  }
}
