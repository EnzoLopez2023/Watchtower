import type { SqliteDatabase } from "../connection.js";

export interface SettingsRepository {
  getAll(tenantId: string, oid: string): Promise<Readonly<Record<string, unknown>>>;
  set(tenantId: string, oid: string, key: string, value: unknown): Promise<void>;
}

const ALLOWED_KEYS = new Set(["appearance", "density", "timezone", "defaultView"]);

export class SqliteSettingsRepository implements SettingsRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getAll(
    tenantId: string,
    oid: string
  ): Promise<Readonly<Record<string, unknown>>> {
    const rows = this.database
      .prepare("SELECT key, value FROM app_settings WHERE tenant_id = ? AND oid = ?")
      .all(tenantId, oid) as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  }

  public async set(tenantId: string, oid: string, key: string, value: unknown): Promise<void> {
    if (!ALLOWED_KEYS.has(key)) throw new Error("Unsupported setting");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Setting must be JSON serializable");
    if (serialized.length > 4096) throw new Error("Setting exceeds 4096 bytes");
    this.database
      .prepare(
        `INSERT INTO app_settings(tenant_id, oid, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, oid, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(tenantId, oid, key, serialized, Date.now());
  }
}
