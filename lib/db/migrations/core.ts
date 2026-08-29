export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "app-local-identity-audit-settings",
    sql: `
      CREATE TABLE IF NOT EXISTS app_identities (
        tenant_id            TEXT NOT NULL,
        oid                  TEXT NOT NULL,
        email_snapshot       TEXT,
        display_name_snapshot TEXT,
        first_seen_at        INTEGER NOT NULL,
        last_seen_at         INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, oid)
      );

      CREATE TABLE IF NOT EXISTS app_role_grants (
        tenant_id             TEXT NOT NULL,
        oid                   TEXT NOT NULL,
        role                  TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
        granted_at            INTEGER NOT NULL,
        granted_by_tenant_id  TEXT,
        granted_by_oid        TEXT,
        PRIMARY KEY (tenant_id, oid, role),
        FOREIGN KEY (tenant_id, oid)
          REFERENCES app_identities(tenant_id, oid)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_feature_permissions (
        tenant_id  TEXT NOT NULL,
        oid        TEXT NOT NULL,
        feature    TEXT NOT NULL,
        can_edit   INTEGER NOT NULL DEFAULT 0 CHECK (can_edit IN (0, 1)),
        is_hidden  INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
        PRIMARY KEY (tenant_id, oid, feature),
        FOREIGN KEY (tenant_id, oid)
          REFERENCES app_identities(tenant_id, oid)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at   INTEGER NOT NULL,
        received_at   INTEGER NOT NULL,
        tenant_id     TEXT,
        user_oid      TEXT,
        email_snapshot TEXT,
        name_snapshot TEXT,
        verified      INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
        category      TEXT NOT NULL,
        action        TEXT NOT NULL,
        view          TEXT,
        method        TEXT,
        path          TEXT,
        status        INTEGER,
        detail        TEXT,
        ip            TEXT,
        legacy_id     INTEGER UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_app_audit_received
        ON app_audit_log(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_audit_identity
        ON app_audit_log(tenant_id, user_oid, received_at DESC);

      CREATE TRIGGER IF NOT EXISTS app_audit_log_no_update
      BEFORE UPDATE ON app_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'app audit rows are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS app_audit_log_no_delete
      BEFORE DELETE ON app_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'app audit rows are immutable');
      END;

      CREATE TABLE IF NOT EXISTS app_settings (
        tenant_id  TEXT NOT NULL,
        oid        TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, oid, key),
        FOREIGN KEY (tenant_id, oid)
          REFERENCES app_identities(tenant_id, oid)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker     TEXT PRIMARY KEY,
        state      TEXT NOT NULL CHECK (state IN ('starting', 'healthy', 'degraded', 'stopping', 'stopped')),
        updated_at INTEGER NOT NULL,
        detail     TEXT
      );
    `
  },
  {
    version: 2,
    name: "single-instance-lease",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_instance_lease (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        lease_token TEXT NOT NULL,
        owner       TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        renewed_at  INTEGER NOT NULL
      );
    `
  }
];
