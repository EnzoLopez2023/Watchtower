# Operations runbook

## Runtime invariants

- Run exactly one process on exactly one App Service instance.
- Production SQLite is fixed at `/home/data/watchtower.db`.
- SQLite uses `journal_mode=DELETE`, `foreign_keys=ON`, `synchronous=FULL`, and
  a bounded busy timeout. WAL is prohibited on the Azure Files/SMB authority.
- Route and worker code use async repositories. Raw SQLite is confined to
  adapters, migrations, import, reconciliation, and explicit recovery tools.
- Never run integrity scans, backup, restore, archive verification, or an
  unbounded migration on startup or an HTTP request.
- Do not give Watchtower access to another product's database, storage
  container, or secrets.

## Health and build identity

`GET /api/live` is process-only. It must remain usable without opening or
querying SQLite.

`GET /api/ready` performs only a bounded `SELECT 1`, migration identity check,
journal-mode check, lifecycle check, and worker-state snapshot. It returns 503
while starting or draining and does not expose SQL, tokens, provider URLs, or
secret values.

`GET /api/version` and `GET /version.json` return the same immutable Watchtower
and source identities. Deployment must compare those values with the intended
run-unique image digest before promotion.

## Startup

1. Validate non-secret configuration and production database path.
2. Open the one SQLite connection with DELETE journal and bounded timeout.
3. Apply only bounded append-only migrations.
4. Construct repositories, routes, external clients, and workers.
5. Start workers, listen, then mark lifecycle ready.

Startup does not run `quick_check`, `integrity_check`, backup, restore, or
archive scans. Those are explicit operator commands.

Optional off-host recovery is enabled only with
`OFFHOST_BACKUP_ENABLED=true`. Its first pass is delayed until after startup and
runs database-native backup, local verification, managed-identity upload and
read-back, and disposable restore verification. It never runs on an HTTP
request and must drain before the instance lease is released.

## Shutdown

On `SIGTERM` or `SIGINT`, Watchtower marks readiness draining, stops accepting
connections, closes idle connections, aborts worker timers and outbound
requests, releases queue/archive claims, waits for active workers, closes
SQLite, and exits. The App Service stop limit must be longer than the configured
drain timeout.

## Authentication

Interactive clients acquire a Watchtower API access token through MSAL. The API
validates signature, tenant, issuer, audience, lifetime, and GUID-shaped `oid`.
Authorization is read from Watchtower's local role grants.

Agent tokens are separate per trust boundary where configured. Protect may
explicitly fall back to the UniFi token, and Network Observer may explicitly
fall back to the UniFi token, matching the production agent topology. Delivery
IDs remain mandatory for safe retry.

The mobile API keeps its existing mobile service token contract so the current
Hearth-for-iOS client continues to work. It is independent of browser Entra
authorization.

## Incident response

1. Check `/api/live`; a failure means the process is unavailable.
2. Check `/api/ready`; retain its build, schema, lifecycle, and worker evidence.
3. Inspect app-local audit and observability APIs with an administrator token.
4. For provider degradation, retain the visible failure. Do not replace it with
   cached synthetic success.
5. For suspected database damage, stop writes and run explicit recovery
   verification. Do not invoke integrity or restore through HTTP.
6. Restore to a disposable candidate, verify it, then perform an
   operator-controlled quiesced swap. Never overwrite the active database in
   place.

Production cutover, agent repointing, iOS configuration changes, and Azure
resource provisioning require a separate approved runbook and are not
performed by tests or extraction scripts.
