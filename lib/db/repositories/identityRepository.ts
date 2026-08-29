import type { SqliteDatabase } from "../connection.js";

export type AppRole = "viewer" | "operator" | "admin";

export interface IdentityClaims {
  readonly tenantId: string;
  readonly oid: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface AppIdentity extends IdentityClaims {
  readonly roles: readonly AppRole[];
  readonly featurePermissions: Readonly<
    Record<string, { readonly canEdit: boolean; readonly isHidden: boolean }>
  >;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface IdentityRepository {
  upsertIdentity(claims: IdentityClaims, now?: number): Promise<AppIdentity>;
  getIdentity(tenantId: string, oid: string): Promise<AppIdentity | null>;
  listIdentities(): Promise<readonly AppIdentity[]>;
  replaceRoles(
    tenantId: string,
    oid: string,
    roles: readonly AppRole[],
    actor: Pick<IdentityClaims, "tenantId" | "oid">,
    now?: number
  ): Promise<AppIdentity>;
  setFeaturePermission(
    tenantId: string,
    oid: string,
    feature: string,
    permission: { readonly canEdit: boolean; readonly isHidden: boolean }
  ): Promise<AppIdentity>;
}

interface IdentityRow {
  tenant_id: string;
  oid: string;
  email_snapshot: string | null;
  display_name_snapshot: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

const APP_ROLES = new Set<AppRole>(["viewer", "operator", "admin"]);

function toIdentity(
  row: IdentityRow,
  roles: readonly AppRole[],
  featurePermissions: AppIdentity["featurePermissions"]
): AppIdentity {
  return {
    tenantId: row.tenant_id,
    oid: row.oid,
    ...(row.email_snapshot ? { email: row.email_snapshot } : {}),
    ...(row.display_name_snapshot ? { displayName: row.display_name_snapshot } : {}),
    roles,
    featurePermissions,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

export class SqliteIdentityRepository implements IdentityRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async upsertIdentity(claims: IdentityClaims, now = Date.now()): Promise<AppIdentity> {
    this.database
      .prepare(
        `INSERT INTO app_identities(
           tenant_id, oid, email_snapshot, display_name_snapshot, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, oid) DO UPDATE SET
           email_snapshot = coalesce(excluded.email_snapshot, app_identities.email_snapshot),
           display_name_snapshot = coalesce(
             excluded.display_name_snapshot,
             app_identities.display_name_snapshot
           ),
           last_seen_at = excluded.last_seen_at`
      )
      .run(
        claims.tenantId,
        claims.oid,
        claims.email ?? null,
        claims.displayName ?? null,
        now,
        now
      );

    const identity = await this.getIdentity(claims.tenantId, claims.oid);
    if (!identity) {
      throw new Error("Identity upsert did not persist");
    }
    return identity;
  }

  public async getIdentity(tenantId: string, oid: string): Promise<AppIdentity | null> {
    const row = this.database
      .prepare(
        `SELECT tenant_id, oid, email_snapshot, display_name_snapshot, first_seen_at, last_seen_at
         FROM app_identities WHERE tenant_id = ? AND oid = ?`
      )
      .get(tenantId, oid) as IdentityRow | undefined;
    if (!row) return null;
    return toIdentity(
      row,
      this.getRoles(tenantId, oid),
      this.getFeaturePermissions(tenantId, oid)
    );
  }

  public async listIdentities(): Promise<readonly AppIdentity[]> {
    const rows = this.database
      .prepare(
        `SELECT tenant_id, oid, email_snapshot, display_name_snapshot, first_seen_at, last_seen_at
         FROM app_identities ORDER BY display_name_snapshot, oid`
      )
      .all() as IdentityRow[];
    return rows.map((row) =>
      toIdentity(
        row,
        this.getRoles(row.tenant_id, row.oid),
        this.getFeaturePermissions(row.tenant_id, row.oid)
      )
    );
  }

  public async replaceRoles(
    tenantId: string,
    oid: string,
    roles: readonly AppRole[],
    actor: Pick<IdentityClaims, "tenantId" | "oid">,
    now = Date.now()
  ): Promise<AppIdentity> {
    const uniqueRoles = [...new Set(roles)];
    if (uniqueRoles.length === 0 || uniqueRoles.some((role) => !APP_ROLES.has(role))) {
      throw new Error("At least one valid app-local role is required");
    }
    if (actor.tenantId === tenantId && actor.oid === oid && !uniqueRoles.includes("admin")) {
      const adminCount = this.database
        .prepare("SELECT count(*) AS count FROM app_role_grants WHERE role = 'admin'")
        .get() as { count: number };
      if (adminCount.count <= 1) {
        throw new Error("The final administrator cannot remove their own admin role");
      }
    }

    this.database.transaction(() => {
      const exists = this.database
        .prepare("SELECT 1 FROM app_identities WHERE tenant_id = ? AND oid = ?")
        .get(tenantId, oid);
      if (!exists) throw new Error("Identity not found");
      this.database
        .prepare("DELETE FROM app_role_grants WHERE tenant_id = ? AND oid = ?")
        .run(tenantId, oid);
      const insert = this.database.prepare(
        `INSERT INTO app_role_grants(
           tenant_id, oid, role, granted_at, granted_by_tenant_id, granted_by_oid
         ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const role of uniqueRoles) {
        insert.run(tenantId, oid, role, now, actor.tenantId, actor.oid);
      }
    })();

    const identity = await this.getIdentity(tenantId, oid);
    if (!identity) throw new Error("Identity not found after role update");
    return identity;
  }

  public async setFeaturePermission(
    tenantId: string,
    oid: string,
    feature: string,
    permission: { readonly canEdit: boolean; readonly isHidden: boolean }
  ): Promise<AppIdentity> {
    const result = this.database
      .prepare(
        `INSERT INTO app_feature_permissions(
           tenant_id, oid, feature, can_edit, is_hidden
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, oid, feature) DO UPDATE SET
           can_edit = excluded.can_edit,
           is_hidden = excluded.is_hidden`
      )
      .run(
        tenantId,
        oid,
        feature,
        permission.canEdit ? 1 : 0,
        permission.isHidden ? 1 : 0
      );
    if (result.changes !== 1) throw new Error("Feature permission was not persisted");
    const identity = await this.getIdentity(tenantId, oid);
    if (!identity) throw new Error("Identity not found after feature permission update");
    return identity;
  }

  private getRoles(tenantId: string, oid: string): readonly AppRole[] {
    const rows = this.database
      .prepare(
        "SELECT role FROM app_role_grants WHERE tenant_id = ? AND oid = ? ORDER BY role"
      )
      .all(tenantId, oid) as Array<{ role: AppRole }>;
    return rows.map(({ role }) => role);
  }

  private getFeaturePermissions(
    tenantId: string,
    oid: string
  ): AppIdentity["featurePermissions"] {
    const rows = this.database
      .prepare(
        `SELECT feature, can_edit, is_hidden
         FROM app_feature_permissions
         WHERE tenant_id = ? AND oid = ?
         ORDER BY feature`
      )
      .all(tenantId, oid) as Array<{
      feature: string;
      can_edit: number;
      is_hidden: number;
    }>;
    return Object.fromEntries(
      rows.map((row) => [
        row.feature,
        { canEdit: row.can_edit === 1, isHidden: row.is_hidden === 1 }
      ])
    );
  }
}
