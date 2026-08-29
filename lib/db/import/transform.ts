/**
 * Transform of the shared Hearth identity / authorization / audit tables into
 * app-local Watchtower state.
 *
 * Rules (all deterministic, all documented in docs/MIGRATION.md):
 *
 * - `hearth_users` becomes `(tenant_id, oid)` identities. `azure_oid` must be a
 *   GUID; email and display name are carried only as non-authoritative
 *   snapshots. Email is never an authorization key.
 * - `hearth_permissions` becomes `app_feature_permissions`, filtered to the 11
 *   Watchtower feature ids. Missing rows keep Hearth's default (visible,
 *   read-only) instead of being materialised.
 * - Roles are derived conservatively: every identity gets `viewer`; an identity
 *   with any Watchtower feature `can_edit = 1` also gets `operator`. `admin` is
 *   granted only from explicit `--admin-oid` input, mirroring Hearth's
 *   env-driven `ADMIN_OID` (the monolith never stored admin in the database).
 * - `audit_log` is partitioned: a row is Watchtower-owned when its `view` is one
 *   of the 11 Watchtower views or its `path` is served by a Watchtower route
 *   module. Global auth rows stay with the monolith.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { ImportError } from "./errors.js";
import type { DispositionLedger } from "./dispositions.js";
import { isOwnedApiPath, isOwnedViewId, OWNED_VIEW_IDS, SHARED_SOURCE_TABLES } from "./ownership.js";
import { tableExists } from "./schema.js";
import {
  APP_AUDIT_LOG_TABLE,
  APP_FEATURE_PERMISSIONS_TABLE,
  APP_IDENTITIES_TABLE,
  APP_ROLE_GRANTS_TABLE
} from "./appLocalSchema.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Column bounds the runtime audit repository applies on every write. Imported
 * legacy rows are held to the same limits so nothing in `app_audit_log` is wider
 * than a row the application itself would produce.
 */
export const AUDIT_FIELD_LIMITS = Object.freeze({
  action: 160,
  view: 80,
  method: 12,
  path: 512,
  detail: 1000,
  ip: 128
} as const);

export interface TransformOptions {
  readonly tenantId: string;
  readonly adminOids: readonly string[];
  readonly importedAtMs: number;
  readonly ledger: DispositionLedger;
}

export interface IdentityTransformResult {
  readonly identities: number;
  readonly roleGrants: number;
  readonly featurePermissions: number;
  readonly auditRowsConsidered: number;
  readonly auditRowsImported: number;
  readonly identityOids: readonly string[];
  readonly ownedAuditViewCounts: Readonly<Record<string, number>>;
}

interface LegacyUserRow {
  readonly id: bigint;
  readonly email: string | null;
  readonly name: string | null;
  readonly azure_oid: string | null;
  readonly created_at: string | null;
}

interface LegacyPermissionRow {
  readonly id: bigint;
  readonly user_id: bigint;
  readonly feature: string;
  readonly can_edit: bigint;
  readonly is_hidden: bigint;
}

interface LegacyAuditRow {
  readonly id: bigint;
  readonly ts: bigint;
  readonly received_at: bigint;
  readonly user_email: string | null;
  readonly user_name: string | null;
  readonly user_oid: string | null;
  readonly verified: bigint;
  readonly category: string;
  readonly action: string;
  readonly view: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly status: bigint | null;
  readonly detail: string | null;
  readonly ip: string | null;
}

export function assertTenantId(tenantId: string): string {
  const value = tenantId.trim().toLowerCase();
  if (!GUID_PATTERN.test(value)) {
    throw new ImportError("ARGUMENT_INVALID", "--tenant-id must be a GUID-shaped Entra tenant id");
  }
  return value;
}

export function assertOid(oid: string): string {
  const value = oid.trim().toLowerCase();
  if (!GUID_PATTERN.test(value)) {
    throw new ImportError("ARGUMENT_INVALID", `Expected a GUID-shaped object id, received "${oid}"`);
  }
  return value;
}

/**
 * Parses Hearth's `datetime('now')` text (`YYYY-MM-DD HH:MM:SS`, always UTC)
 * into epoch milliseconds. Returns `null` when the value is not parseable.
 */
export function parseLegacyUtcTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction ? Number(fraction.padEnd(3, "0")) : 0
  );
  return Number.isFinite(ms) ? ms : null;
}

function toNumberOrNull(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function boundedField(
  value: string | null,
  limit: number,
  onTruncate: () => void
): string | null {
  if (value === null || value.length <= limit) return value;
  onTruncate();
  return value.slice(0, limit);
}

/**
 * Runs the full shared-table transform inside a single target transaction.
 * `hearth_index` is never read.
 */
export function transformSharedTables(options: {
  readonly source: SqliteDatabase;
  readonly target: SqliteDatabase;
  readonly transform: TransformOptions;
}): IdentityTransformResult {
  const { source, target } = options;
  const { tenantId, adminOids, importedAtMs, ledger } = options.transform;

  for (const table of [SHARED_SOURCE_TABLES.users, SHARED_SOURCE_TABLES.permissions, SHARED_SOURCE_TABLES.audit]) {
    if (!tableExists(source, table)) {
      throw new ImportError("SOURCE_SCHEMA_INCOMPLETE", `Source is missing shared table ${table}`, { table });
    }
  }

  if (tableExists(source, SHARED_SOURCE_TABLES.index)) {
    const row = source.prepare(`SELECT COUNT(*) AS c FROM ${SHARED_SOURCE_TABLES.index}`).get() as {
      c: bigint | number;
    };
    const count = typeof row.c === "bigint" ? Number(row.c) : row.c;
    for (let index = 0; index < count; index += 1) ledger.record("hearth_index_not_migrated");
    if (count === 0) ledger.record("hearth_index_not_migrated", { rows: 0, note: "table present but empty" });
  }

  const users = source
    .prepare(`SELECT id, email, name, azure_oid, created_at FROM ${SHARED_SOURCE_TABLES.users} ORDER BY id`)
    .all() as LegacyUserRow[];

  const identityByLegacyId = new Map<string, { oid: string; email: string | null; name: string | null; firstSeen: number }>();

  for (const user of users) {
    const oidRaw = user.azure_oid?.trim() ?? "";
    if (!GUID_PATTERN.test(oidRaw)) {
      ledger.record("identity_missing_oid", { legacyUserId: Number(user.id), azureOid: user.azure_oid });
      continue;
    }
    identityByLegacyId.set(user.id.toString(10), {
      oid: oidRaw.toLowerCase(),
      email: user.email,
      name: user.name,
      firstSeen: parseLegacyUtcTimestamp(user.created_at) ?? importedAtMs
    });
  }

  const permissions = source
    .prepare(
      `SELECT id, user_id, feature, can_edit, is_hidden FROM ${SHARED_SOURCE_TABLES.permissions} ORDER BY id`
    )
    .all() as LegacyPermissionRow[];

  const ownedFeatures = new Set(OWNED_VIEW_IDS);
  const importablePermissions: { oid: string; feature: string; canEdit: number; isHidden: number }[] = [];

  for (const permission of permissions) {
    if (!ownedFeatures.has(permission.feature)) {
      ledger.record("permission_not_watchtower_feature", {
        legacyPermissionId: Number(permission.id),
        feature: permission.feature
      });
      continue;
    }
    const identity = identityByLegacyId.get(permission.user_id.toString(10));
    if (!identity) {
      ledger.record("permission_orphan_identity", {
        legacyPermissionId: Number(permission.id),
        legacyUserId: Number(permission.user_id),
        feature: permission.feature
      });
      continue;
    }
    importablePermissions.push({
      oid: identity.oid,
      feature: permission.feature,
      canEdit: permission.can_edit === 0n ? 0 : 1,
      isHidden: permission.is_hidden === 0n ? 0 : 1
    });
  }

  const materialised = new Set(importablePermissions.map((row) => `${row.oid}\u0000${row.feature}`));
  for (const identity of identityByLegacyId.values()) {
    for (const feature of OWNED_VIEW_IDS) {
      if (!materialised.has(`${identity.oid}\u0000${feature}`)) {
        ledger.record("permission_default_retained", { oid: identity.oid, feature });
      }
    }
  }

  const auditRows = source
    .prepare(
      `SELECT id, ts, received_at, user_email, user_name, user_oid, verified, category, action, view, method, path, status, detail, ip
       FROM ${SHARED_SOURCE_TABLES.audit} ORDER BY id`
    )
    .all() as LegacyAuditRow[];

  const knownOids = new Set([...identityByLegacyId.values()].map((identity) => identity.oid));
  const lastSeenByOid = new Map<string, number>();
  const ownedAuditViewCounts: Record<string, number> = {};
  interface BoundedAuditFields {
    readonly action: string;
    readonly view: string | null;
    readonly method: string | null;
    readonly path: string | null;
    readonly detail: string | null;
    readonly ip: string | null;
  }
  const ownedAuditRows: {
    row: LegacyAuditRow;
    verified: number;
    oid: string | null;
    bounded: BoundedAuditFields;
  }[] = [];

  for (const row of auditRows) {
    const ownedByView = isOwnedViewId(row.view);
    const ownedByPath = isOwnedApiPath(row.path);
    if (!ownedByView && !ownedByPath) {
      if (row.category === "auth") ledger.record("audit_global_auth_event", { legacyAuditId: Number(row.id) });
      else
        ledger.record("audit_not_watchtower_scope", {
          legacyAuditId: Number(row.id),
          view: row.view,
          path: row.path
        });
      continue;
    }

    let verified = row.verified === 0n ? 0 : 1;
    if (row.verified !== 0n && row.verified !== 1n) {
      ledger.record("audit_verified_flag_normalised", {
        legacyAuditId: Number(row.id),
        legacyValue: row.verified.toString(10)
      });
      verified = 1;
    }

    const oid = row.user_oid?.trim().toLowerCase() ?? null;
    if (oid === null || !knownOids.has(oid)) {
      ledger.record("audit_unmapped_actor", { legacyAuditId: Number(row.id), userOid: row.user_oid });
    } else {
      const receivedAt = Number(row.received_at);
      const previous = lastSeenByOid.get(oid) ?? 0;
      if (receivedAt > previous) lastSeenByOid.set(oid, receivedAt);
    }

    if (row.view !== null) {
      ownedAuditViewCounts[row.view] = (ownedAuditViewCounts[row.view] ?? 0) + 1;
    }

    let truncated = false;
    const noteTruncation = (): void => {
      if (truncated) return;
      truncated = true;
      ledger.record("audit_field_truncated", { legacyAuditId: Number(row.id) });
    };
    const bounded = {
      action: boundedField(row.action, AUDIT_FIELD_LIMITS.action, noteTruncation) ?? row.action,
      view: boundedField(row.view, AUDIT_FIELD_LIMITS.view, noteTruncation),
      method: boundedField(row.method, AUDIT_FIELD_LIMITS.method, noteTruncation),
      path: boundedField(row.path, AUDIT_FIELD_LIMITS.path, noteTruncation),
      detail: boundedField(row.detail, AUDIT_FIELD_LIMITS.detail, noteTruncation),
      ip: boundedField(row.ip, AUDIT_FIELD_LIMITS.ip, noteTruncation)
    };

    ownedAuditRows.push({ row, verified, oid, bounded });
  }

  ledger.assertAllApproved();

  const normalizedAdminOids = [...new Set(adminOids.map((oid) => assertOid(oid)))].sort();
  const unknownAdmins = normalizedAdminOids.filter((oid) => !knownOids.has(oid));
  if (unknownAdmins.length > 0) {
    throw new ImportError("ARGUMENT_INVALID", "--admin-oid values must match an imported identity", {
      unknownAdmins,
      knownOids: [...knownOids].sort()
    });
  }

  const canEditByOid = new Map<string, boolean>();
  for (const permission of importablePermissions) {
    if (permission.canEdit === 1) canEditByOid.set(permission.oid, true);
  }

  let roleGrants = 0;

  const write = target.transaction(() => {
    const insertIdentity = target.prepare(
      `INSERT INTO ${APP_IDENTITIES_TABLE}
        (tenant_id, oid, email_snapshot, display_name_snapshot, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertRole = target.prepare(
      `INSERT INTO ${APP_ROLE_GRANTS_TABLE} (tenant_id, oid, role, granted_at) VALUES (?, ?, ?, ?)`
    );
    const insertPermission = target.prepare(
      `INSERT INTO ${APP_FEATURE_PERMISSIONS_TABLE} (tenant_id, oid, feature, can_edit, is_hidden)
       VALUES (?, ?, ?, ?, ?)`
    );
    const insertAudit = target.prepare(
      `INSERT INTO ${APP_AUDIT_LOG_TABLE}
        (occurred_at, received_at, tenant_id, user_oid, email_snapshot, name_snapshot, verified,
         category, action, view, method, path, status, detail, ip, legacy_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const sortedIdentities = [...identityByLegacyId.values()].sort((a, b) => a.oid.localeCompare(b.oid));
    for (const identity of sortedIdentities) {
      const lastSeen = Math.max(identity.firstSeen, lastSeenByOid.get(identity.oid) ?? 0);
      insertIdentity.run(tenantId, identity.oid, identity.email, identity.name, identity.firstSeen, lastSeen);

      const roles: string[] = ["viewer"];
      if (canEditByOid.get(identity.oid) === true) roles.push("operator");
      if (normalizedAdminOids.includes(identity.oid)) roles.push("admin");
      for (const role of roles) {
        insertRole.run(tenantId, identity.oid, role, importedAtMs);
        roleGrants += 1;
      }
    }

    const sortedPermissions = [...importablePermissions].sort(
      (a, b) => a.oid.localeCompare(b.oid) || a.feature.localeCompare(b.feature)
    );
    for (const permission of sortedPermissions) {
      insertPermission.run(tenantId, permission.oid, permission.feature, permission.canEdit, permission.isHidden);
    }

    for (const owned of ownedAuditRows) {
      const row = owned.row;
      insertAudit.run(
        Number(row.ts),
        Number(row.received_at),
        tenantId,
        owned.oid,
        row.user_email,
        row.user_name,
        owned.verified,
        row.category,
        owned.bounded.action,
        owned.bounded.view,
        owned.bounded.method,
        owned.bounded.path,
        toNumberOrNull(row.status),
        owned.bounded.detail,
        owned.bounded.ip,
        Number(row.id)
      );
    }
  });

  write();

  return {
    identities: identityByLegacyId.size,
    roleGrants,
    featurePermissions: importablePermissions.length,
    auditRowsConsidered: auditRows.length,
    auditRowsImported: ownedAuditRows.length,
    identityOids: Object.freeze([...knownOids].sort()),
    ownedAuditViewCounts: Object.freeze({ ...ownedAuditViewCounts })
  };
}
