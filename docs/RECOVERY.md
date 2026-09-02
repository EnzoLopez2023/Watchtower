# Watchtower recovery

Explicit backup, verification, off-host replication and disposable restore for
the Watchtower SQLite authority.

No recovery operation runs during startup or on a request path. There is no
integrity scan, repair or unbounded migration behind `/api/live`, `/api/ready` or
any route. `/api/ready` only reports secret-safe configuration booleans and the
status/timestamp of the scheduled worker's last completed pass, so deployment
diagnostics can evaluate freshness without reaching private Blob storage. The
commands below are operator-invoked. An optional scheduled worker may invoke the
same verified primitives only after its startup delay and only when
`OFFHOST_BACKUP_ENABLED=true`.

## Contract

- **Never byte-copy a live database.** `backup` uses SQLite's online backup API
  (`Database#backup`) against a read-only, `query_only` handle. A partially
  written page or an in-flight transaction can never leak into a snapshot.
- **Every snapshot is verified before it is trusted.** Bytes, SHA-256, schema
  and version identity, per-table counts and recency, `quick_check`,
  `integrity_check` and `foreign_key_check` all run against the snapshot, not the
  live file, and a failure aborts the command.
- **Off-host access is managed identity only.** No connection string, no account
  key, no SAS token — the presence of any such environment variable is a hard
  failure.
- **Restores are disposable.** A restore must land on a new path inside an
  explicitly supplied root, never on the live authority, and never inside a Git
  working tree.
- **Recovery is forward-only** after the first committed write to the new
  authority.

## Bundle layout

```
<backup-root>/
  20260828T165748142Z-c43fb541c69baebc/     # bundleId: UTC stamp + 16 hex chars
    watchtower.sqlite3                       # the snapshot
    manifest.json                            # watchtower.sqlite-backup-manifest v1
```

A bundle is assembled in `<bundleId>.partial` and renamed only after the manifest
is written, so a half-written bundle can never be mistaken for a good one.

### Manifest contents

| Field | Meaning |
| --- | --- |
| `contract` / `contractVersion` | `watchtower.sqlite-backup-manifest` / `1` |
| `bundleId`, `createdUtc` | bundle identity |
| `appVersion`, `buildId`, `sourceCommit` | build identity supplied by the caller |
| `database.file`, `database.sourcePath` | snapshot file name and the authority it came from |
| `database.bytes`, `database.sha256` | exact snapshot size and digest |
| `database.identity.userVersion` / `applicationId` | SQLite version identity |
| `database.identity.schemaObjectCounts` | tables / indexes / triggers / views |
| `database.identity.schemaSha256` | digest over every `sqlite_master` row |
| `database.identity.migrations` | applied `schema_migrations` rows, when present |
| `database.tables[]` | every user table with `rowCount` and most-recent-activity value |
| `database.checks` | `quick_check`, `integrity_check`, `foreign_key_check` results |

Recency uses the first column present from a fixed priority list
(`updated_at`, `last_updated_at`, `received_at`, `sampled_at`, `checked_at`,
`completed_at`, `created_at`, `timestamp`, `event_ts`, `flow_ts`, `start_ms`,
`detected_at`, `archived_at`, `last_seen_at`, `last_seen`, `ts`, `occurred_at`,
`granted_at`, `applied_at`). An empty table reports no recency rather than a null
maximum.

## Commands

```bash
# 1. Database-native consistent snapshot with full evidence.
npm run recovery -- backup \
  --database    /home/data/watchtower.db \
  --backup-root /home/data/backups/watchtower \
  --app-version 1.0.0 --build-id 42 --source-commit <sha>

# 2. Verify a local bundle against its own manifest.
npm run recovery -- verify --bundle /home/data/backups/watchtower/<bundleId>

# 3. Replicate off-host with mandatory read-back verification.
npm run recovery -- upload \
  --bundle    /home/data/backups/watchtower/<bundleId> \
  --account   <storage-account> \
  --container watchtower \
  --prefix    watchtower

# 4. Restore into a disposable destination and verify it.
npm run recovery -- restore \
  --bundle         /home/data/backups/watchtower/<bundleId> \
  --destination    /home/data/drills/<name>.db \
  --allowed-root   /home/data/drills \
  --protected-path /home/data/watchtower.db

# 5. Full drill in one command: backup -> verify -> disposable restore, with a
#    small preserved evidence artefact. Never contacts off-host storage.
npm run recovery -- drill \
  --database     /home/data/watchtower.db \
  --backup-root  /home/data/backups/watchtower \
  --restore-root /home/data/drills \
  --evidence     /path/to/artifacts/watchtower-recovery-drill-evidence.json
```

`npm run recovery` with no arguments prints usage for every command. The script
is TypeScript ESM run through `tsx`; `npm run test:data` runs the recovery suite.
Every command exits non-zero with a stable error code on failure.

### `backup`

Opens the authority read-only, runs the online backup API into a working
directory, opens the snapshot, forces `journal_mode = DELETE`, enables foreign
keys, collects schema/version identity plus per-table counts and recency, runs
all three integrity checks, hashes the file, writes the manifest, then renames
the bundle into place.

Failure codes: `SOURCE_NOT_FOUND`, `SOURCE_NOT_READABLE`, `BACKUP_FAILED`,
`BACKUP_QUICK_CHECK_FAILED`, `BACKUP_INTEGRITY_CHECK_FAILED`,
`BACKUP_FOREIGN_KEY_CHECK_FAILED`, `BACKUP_DESTINATION_UNSAFE`.

### `verify`

Re-reads the manifest, re-measures bytes, re-hashes the snapshot, re-runs all
three checks, and re-derives schema identity and per-table counts, comparing each
against the manifest.

Failure codes: `BACKUP_MANIFEST_INVALID`, `BACKUP_BYTES_MISMATCH`,
`BACKUP_SHA_MISMATCH`, `BACKUP_MANIFEST_MISMATCH`, plus the check codes above.

A manifest whose `database.file` is not a bare file name (for example
`../escape.db`) is rejected, so a hostile or corrupted manifest cannot redirect
verification or restore outside the bundle.

### `upload`

Verifies the bundle first, then uploads both objects, then **reads each one
back** and compares byte length and SHA-256 against what was sent, and finally
re-checks the snapshot digest against the bundle manifest.

Authentication is a `ManagedIdentityCredential` bearer token for
`https://storage.azure.com/.default`. `@azure/identity` is loaded through a
dynamic `import()` so the module stays importable when off-host storage is
disabled or the package is not installed (`STORAGE_DEPENDENCY_MISSING` if it is
required but absent).

Any of these environment variables being set is a hard refusal
(`STORAGE_SHARED_CREDENTIAL_REJECTED`):

```
AZURE_STORAGE_CONNECTION_STRING   AZURE_STORAGE_ACCOUNT_KEY   AZURE_STORAGE_KEY
AZURE_STORAGE_SAS_TOKEN           WATCHTOWER_BACKUP_CONNECTION_STRING
WATCHTOWER_BACKUP_ACCOUNT_KEY     WATCHTOWER_BACKUP_SAS_TOKEN
OFFHOST_BACKUP_CONNECTION_STRING  OFFHOST_BACKUP_ACCOUNT_KEY
OFFHOST_BACKUP_SAS_TOKEN
```

Account names, container names and blob names are validated before any request:
accounts must be 3–24 lowercase alphanumerics, containers 3–63 lowercase
alphanumerics with single dashes, and blob names must be canonical (no leading or
trailing `/`, no `\`, no empty/`.`/`..` segments, no control characters).

Failure codes: `BLOB_CONFIGURATION_INVALID`, `BLOB_NAME_INVALID`,
`BLOB_REQUEST_FAILED` (carries the HTTP status and `x-ms-error-code`),
`BLOB_READBACK_MISMATCH`.

### `drill`

Runs `backup` → `verify` → `restore` against a real database in one invocation
and writes `watchtower.recovery-drill-evidence` v1: source identity, bundle
identity, schema/version identity and applied migrations, per-table counts and
recency, all three checks at each stage, per-step timings, and a `digestsAgree`
assertion that the same SHA-256 came out of all three stages.

The snapshot bundle and the restored copy are **removed once the evidence has
been collected** (`--keep-artifacts` retains them), so a multi-gigabyte drill
leaves behind a few kilobytes of JSON. `offhostContacted` is always `false` — the
drill needs no credentials and makes no network call.

### Partial-bundle lifecycle

A bundle is assembled in `<bundleId>.partial` and promoted by an atomic rename.
Every failure after that directory is created — snapshot open, `journal_mode`
assertion, `quick_check`/`integrity_check`/`foreign_key_check`, count/schema
collection, hashing, manifest write, rename — closes any open database handles
and removes the partial before rethrowing. The original error always propagates
unchanged; nothing is swallowed. A cleanup problem is reported on stderr rather
than replacing the failure that caused it.

`pruneStalePartials({ backupRoot, olderThanMs })` removes abandoned partials, and
is deliberately narrow: direct children of the resolved root only, names matching
the exact generated `YYYYMMDDTHHMMSSmmmZ-<16 hex>.partial` shape only, real
directories only (`lstat`, so a planted symlink is never followed or deleted),
and only past the configured age (default 6 h). Everything else — promoted
bundles, nested paths, differently shaped names, plain files — is left alone.

### `restore`

Verifies the source bundle, then validates the destination:

- must be a strict descendant of `--allowed-root`
- must not already exist
- must not be a `--protected-path`, the bundle snapshot, or the manifest's
  recorded `sourcePath` (the live authority), including via hard link
- must not have a stale `-wal`, `-shm` or `-journal` sidecar
- must not be inside a Git working tree

After copying, the restored file is re-measured, re-hashed, and re-checked
(`quick_check`, `integrity_check`, `foreign_key_check`, schema identity, per-table
counts). Any failure removes the partial file and exits non-zero, so a failed
drill never leaves a plausible-looking database behind.

Failure codes: `RESTORE_DESTINATION_UNSAFE`, `RESTORE_DESTINATION_EXISTS`,
`RESTORE_VERIFICATION_FAILED`, plus the verify codes.

## Operational notes

- SQLite runs one process, one worker, one App Service instance. The authority
  lives at an app-owned path; WAL is never enabled on Azure Files/SMB.
- Scheduled off-host recovery is disabled by default. Enabling it requires a
  Watchtower-owned storage account/container and managed identity, defers its
  first pass off startup, prevents overlapping passes, verifies upload read-back
  and a disposable restore, reaps only stale canonical `.partial` directories,
  retains a bounded local bundle set, and drains before the instance lease is
  released.
- Keep the source backup and the old read-only authority through the approved
  soak after cutover.
- Run a restore drill from off-host storage on the same cadence as the backup, so
  the read-back path is exercised and not merely configured.
- Store bundles in private, app-owned storage. No Watchtower credential grants
  access to another app's database, container or secrets.

## Verified drill (2026-08-28)

Run with `npm run recovery -- drill` against the current final-schema imported
database — the exact target produced by the combined import/reconcile run
(785,362,944 bytes, SHA-256 `1c0eb5ba…d5296a`, core migrations v1 + v2 applied).

Evidence artefact: `watchtower-recovery-drill-evidence.json`
(`watchtower.recovery-drill-evidence` v1, 12,988 bytes, SHA-256 `201cf2e2d5b52db7953cc0098e05ee702423f8a82578e41c62e4e7ae49500b8d`).

| Measure | Value |
| --- | --- |
| Source database | 785,362,944 bytes, SHA-256 `1c0eb5ba67da2bf6ff6e20aa5ab5374dd01a125d8082ea5254867017cdd5296a` |
| Bundle id | `20260828T204851034Z-9dba591cf57b12eb` |
| Snapshot | 785,362,944 bytes, SHA-256 `a8cba88420122c70226b41282fa6f05cb1d4d7d2dcd820769fc48edb1acb4099` |
| Schema identity | `443ffb5618448d6c6a2c53079b3c2d21480d19150fe35916ce992977c199333a`, `user_version` 0 |
| Schema objects | 63 tables (62 user + `sqlite_sequence`), 98 indexes, 2 triggers, 0 views |
| Applied migrations | `1:app-local-identity-audit-settings`, `2:single-instance-lease` |
| Rows | **2,723,533** = 2,723,313 owned + 220 app-local |
| App-local rows | `app_audit_log` 201, `app_feature_permissions` 10, `app_role_grants` 4, `app_identities` 3, `schema_migrations` 2 (`app_settings`, `worker_heartbeats`, `runtime_instance_lease` empty) |
| `backup` | 4,155 ms — quick/integrity/foreign-key checks all ok |
| `verify` | 3,355 ms — bytes, SHA-256, schema identity and all 62 table counts match the manifest; checks ok |
| `restore` | 7,013 ms — disposable destination, identical SHA-256, identity and counts match, checks ok |
| Total | 14,797 ms, `digestsAgree: true`, `offhostContacted: false` |

The snapshot digest differs from the source file digest by design: the online
backup API writes a freshly packed database rather than copying bytes. What must
agree — and does — is backup vs verify vs restore.

Large artefacts were removed automatically (`artifactsRemoved: true`); only the
12,988-byte evidence file was retained.

The `upload` path is covered by tests against an in-memory Blob endpoint
(bearer-token-only requests, read-back digest comparison, corrupted read-back
rejection, shared-secret refusal); it has deliberately **not** been run against a
live storage account.
