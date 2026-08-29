import type { SqliteDatabase } from "../connection.js";

export interface AuditEvent {
  readonly occurredAt: number;
  readonly receivedAt?: number;
  readonly tenantId?: string;
  readonly userOid?: string;
  readonly emailSnapshot?: string;
  readonly nameSnapshot?: string;
  readonly verified: boolean;
  readonly category: "auth" | "navigation" | "change" | "admin" | "system";
  readonly action: string;
  readonly view?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly ip?: string;
}

export interface StoredAuditEvent extends AuditEvent {
  readonly id: number;
  readonly receivedAt: number;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<number>;
  list(limit: number, beforeId?: number): Promise<readonly StoredAuditEvent[]>;
}

interface AuditRow {
  id: number;
  occurred_at: number;
  received_at: number;
  tenant_id: string | null;
  user_oid: string | null;
  email_snapshot: string | null;
  name_snapshot: string | null;
  verified: number;
  category: StoredAuditEvent["category"];
  action: string;
  view: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  detail: string | null;
  ip: string | null;
}

function toEvent(row: AuditRow): StoredAuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    verified: row.verified === 1,
    category: row.category,
    action: row.action,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.user_oid ? { userOid: row.user_oid } : {}),
    ...(row.email_snapshot ? { emailSnapshot: row.email_snapshot } : {}),
    ...(row.name_snapshot ? { nameSnapshot: row.name_snapshot } : {}),
    ...(row.view ? { view: row.view } : {}),
    ...(row.method ? { method: row.method } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.ip ? { ip: row.ip } : {})
  };
}

export class SqliteAuditRepository implements AuditRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async append(event: AuditEvent): Promise<number> {
    const result = this.database
      .prepare(
        `INSERT INTO app_audit_log(
           occurred_at, received_at, tenant_id, user_oid, email_snapshot, name_snapshot,
           verified, category, action, view, method, path, status, detail, ip
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.occurredAt,
        event.receivedAt ?? Date.now(),
        event.tenantId ?? null,
        event.userOid ?? null,
        event.emailSnapshot ?? null,
        event.nameSnapshot ?? null,
        event.verified ? 1 : 0,
        event.category,
        event.action.slice(0, 160),
        event.view?.slice(0, 80) ?? null,
        event.method?.slice(0, 12) ?? null,
        event.path?.slice(0, 512) ?? null,
        event.status ?? null,
        event.detail?.slice(0, 1000) ?? null,
        event.ip?.slice(0, 128) ?? null
      );
    return Number(result.lastInsertRowid);
  }

  public async list(limit: number, beforeId?: number): Promise<readonly StoredAuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = beforeId
      ? this.database
          .prepare(
            `SELECT * FROM app_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`
          )
          .all(beforeId, boundedLimit)
      : this.database
          .prepare("SELECT * FROM app_audit_log ORDER BY id DESC LIMIT ?")
          .all(boundedLimit);
    return (rows as AuditRow[]).map(toEvent);
  }
}

