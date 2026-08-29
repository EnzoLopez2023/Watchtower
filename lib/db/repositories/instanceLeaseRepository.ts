import type { SqliteDatabase } from "../connection.js";

export interface InstanceLeaseRepository {
  acquire(token: string, owner: string, now: number, leaseMs: number): Promise<boolean>;
  renew(token: string, now: number, leaseMs: number): Promise<boolean>;
  release(token: string): Promise<void>;
}

export class SqliteInstanceLeaseRepository implements InstanceLeaseRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async acquire(
    token: string,
    owner: string,
    now: number,
    leaseMs: number
  ): Promise<boolean> {
    const result = this.database
      .prepare(
        `INSERT INTO runtime_instance_lease(
           id, lease_token, owner, lease_until, acquired_at, renewed_at
         ) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           lease_token = excluded.lease_token,
           owner = excluded.owner,
           lease_until = excluded.lease_until,
           acquired_at = excluded.acquired_at,
           renewed_at = excluded.renewed_at
         WHERE runtime_instance_lease.lease_until <= ?
            OR runtime_instance_lease.lease_token = excluded.lease_token`
      )
      .run(token, owner, now + leaseMs, now, now, now);
    return result.changes === 1;
  }

  public async renew(token: string, now: number, leaseMs: number): Promise<boolean> {
    const result = this.database
      .prepare(
        `UPDATE runtime_instance_lease
         SET lease_until = ?, renewed_at = ?
         WHERE id = 1 AND lease_token = ?`
      )
      .run(now + leaseMs, now, token);
    return result.changes === 1;
  }

  public async release(token: string): Promise<void> {
    this.database
      .prepare("DELETE FROM runtime_instance_lease WHERE id = 1 AND lease_token = ?")
      .run(token);
  }
}

