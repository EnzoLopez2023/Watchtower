import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";
import type { IpPlanSeedRow } from "../../../monitoring/ipPlanSeed.js";

export interface IpPlanRepository {
  seed(rows: readonly IpPlanSeedRow[]): Promise<void>;
  getAllRows(): Promise<IpPlanRow[]>;
  getByMac(mac: string): Promise<IpPlanRow | undefined>;
  updateMark(mac: string, markedDone: boolean, markedAt: number | null): Promise<void>;
  updateNotes(mac: string, notes: string | null): Promise<void>;
  setFirstVerified(mac: string, now: number): Promise<void>;
  getUnifiLatest(): Promise<UnifiLatestRow | undefined>;
}

export interface IpPlanRow {
  readonly mac: string;
  readonly name: string;
  readonly group_code: string;
  readonly group_label: string;
  readonly group_order: number;
  readonly original_ip: string | null;
  readonly target_ip: string | null;
  readonly sort_order: number;
  readonly already_reserved: number;
  readonly marked_done: number;
  readonly marked_at: number | null;
  readonly notes: string | null;
  readonly first_verified_at: number | null;
}

export interface UnifiLatestRow {
  readonly received_at: number;
  readonly payload: unknown;
}

export class SqliteIpPlanRepository extends SqliteRepository implements IpPlanRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  public async seed(rows: readonly IpPlanSeedRow[]): Promise<void> {
    try {
      this.transaction(() => {
        for (const r of rows) {
          this.runNamed(
            `INSERT INTO ip_plan (mac, name, group_code, group_label, group_order, original_ip, target_ip, sort_order, already_reserved)
             VALUES (@mac, @name, @group_code, @group_label, @group_order, @original_ip, @target_ip, @sort_order, @already_reserved)
             ON CONFLICT(mac) DO UPDATE SET
               name = excluded.name, group_code = excluded.group_code, group_label = excluded.group_label,
               group_order = excluded.group_order, original_ip = excluded.original_ip, target_ip = excluded.target_ip,
               sort_order = excluded.sort_order, already_reserved = excluded.already_reserved`,
            {
              mac: r.mac, name: r.name, group_code: r.group_code, group_label: r.group_label,
              group_order: r.group_order, original_ip: r.original_ip, target_ip: r.target_ip,
              sort_order: r.sort_order, already_reserved: r.already_reserved ? 1 : 0,
            }
          );
        }
      });
    } catch (err) {
      console.error("ip_plan seed failed:", (err as Error).message);
    }
  }

  public async getAllRows(): Promise<IpPlanRow[]> {
    return this.all<IpPlanRow>("SELECT * FROM ip_plan ORDER BY group_order, sort_order");
  }

  public async getByMac(mac: string): Promise<IpPlanRow | undefined> {
    return this.get<IpPlanRow>("SELECT * FROM ip_plan WHERE mac = ?", mac);
  }

  public async updateMark(mac: string, markedDone: boolean, markedAt: number | null): Promise<void> {
    this.runNamed("UPDATE ip_plan SET marked_done = @marked_done, marked_at = @marked_at WHERE mac = @mac", {
      mac, marked_done: markedDone ? 1 : 0, marked_at: markedAt,
    });
  }

  public async updateNotes(mac: string, notes: string | null): Promise<void> {
    this.runNamed("UPDATE ip_plan SET notes = @notes WHERE mac = @mac", { mac, notes });
  }

  public async setFirstVerified(mac: string, now: number): Promise<void> {
    this.run("UPDATE ip_plan SET first_verified_at = ? WHERE mac = ? AND first_verified_at IS NULL", now, mac);
  }

  public async getUnifiLatest(): Promise<UnifiLatestRow | undefined> {
    return this.get<UnifiLatestRow>("SELECT received_at, payload FROM unifi_latest WHERE id = 1");
  }
}
