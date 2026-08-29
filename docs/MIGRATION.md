# Watchtower legacy import and reconciliation

How the 54 Watchtower-owned tables and the app-local identity, authorization and
audit state are moved out of the Hearth monolith into an isolated Watchtower
SQLite database, and how the result is proven correct.

## Authoritative source

Everything below reads exactly one artefact: a supplied **immutable backup** of
the Hearth production database. The live production file is never opened.

| Field | Value |
| --- | --- |
| Repository | `EnzoLopez2023/Hearth` |
| Version / build | `2.13.2` / `172` |
| Commit | `f0b05fc1dbf53e8aa26c215d8e858894a2793871` |
| Tree | `62cbd35861c511f7c17187c875d19ee6e353b80d` |
| Image digest | `sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140` |
| Backup bundle | `20260828T053625317Z-1e0918fd4eea2be7` (created `2026-08-28T05:36:25.317Z`) |
| Backup bytes | `950947840` |
| Backup SHA-256 | `dc9fb47d269b339a3dcae37279dc3116f37a0635728a2d2b2ac2c511811a5807` |

The importer verifies the byte length and SHA-256 **before** it reads anything,
opens the file read-only with `query_only = 1`, and re-hashes it after the run to
prove it was not mutated. A WAL-mode source is refused; supply a quiesced
DELETE-mode backup.

PostgreSQL branches, Drizzle schema and the Hearth local `HEAD` are explicitly
out of scope and are never consulted.

## Approved baseline: operator inputs are not trusted

`lib/db/import/approvedBaseline.ts` pins, **in source control**, every value the
importer acts on: the full lineage above, the whole-source schema counts
(101 tables / 137 explicit indexes / 8 triggers / 0 views), the owned-schema
digest, the 54 table names with their **exact per-table row counts and canonical
hashes**, the 2,723,313 aggregate row total, the aggregate hash
`f2c00302…be9322`, and the 25 owned `sqlite_sequence` values.

`lib/db/import/baselineGate.ts` admits operator-supplied inputs against it, in
this order, **before any target is created, opened or written**:

| Stage | Checked against the pinned contract |
| --- | --- |
| 1. manifest | every lineage field, owned table set, expected row total |
| 2. oracle (supplied or executed) | declared size, aggregate, table/row counts, all 54 per-table hashes and row counts |
| 3. backup file | measured bytes and SHA-256 |
| 4. opened source | schema counts, every owned table's row count, owned schema digest, index/trigger counts, `sqlite_sequence` |

Only after stage 4 may `openEmptyTarget` run. A rejection raises
`BASELINE_REJECTED` with per-field findings and **leaves no target file behind**.

**Both** entry points enforce this. `scripts/reconcile.ts` runs the same four
stages even though it creates no target, so a reconcile-only artefact cannot be
green without having been gated. For Watchtower an approved oracle is
**mandatory** on both CLIs — a run without one is refused, not quietly weakened —
and there is no operator flag to override the aggregate or any pinned value.

Every evidence manifest carries a top-level `approvedBaseline` admission block
(`gateEnforced`, `manifestAdmitted`, `oracleAdmitted`, `backupAdmitted`,
`sourceAdmitted`, plus the measured source facts). `outcome: "pass"` requires
**all** of them together with a passing reconciliation and a matched oracle, so an
ungated artefact is structurally distinguishable from a gated one.

Because none of the approved values come from the inputs, a *self-consistent*
forgery still fails: a manifest that exactly describes a forged backup, plus an
oracle generated from that same forged backup, is rejected at stage 1. The
executed generator stays what it always was — corroboration, never authority.

## Ownership boundary

The owned table list comes from the decomposition manifest supplied on the
command line — there is no hidden production path. `lib/db/import/ownership.ts`
holds the reviewed contract and refuses to run if the manifest disagrees:

- exactly **54** tables, matching the reviewed set
- exactly **11** view ids: `azure-command-center`, `system-status`,
  `observability`, `power-monitor`, `power-topology`, `unifi-network`,
  `unifi-topology`, `unifi-config`, `synology`, `ip-migration`, `protect`
- expected owned row total **2,723,313**

Owned API path prefixes (derived from the Watchtower route modules in the
manifest — `azure.js`, `ups.js`, `unifi.js`, `unifiLogs.js`, `protect.js`,
`ip-plan.js`, `power-topology.js`, `agentLogs.js`, `synology.js`, `mobile.js`,
`status.js`, `networkObserver.js`):

```
/api/agent-logs/   /api/admin/logs   /api/azure/     /api/ip-plan
/api/mobile/       /api/network-observer            /api/observability/
/api/power/        /api/protect      /api/status     /api/synology
/api/unifi         /api/ups
```

`/api/admin/logs` is Watchtower-owned because `routes/agentLogs.js` serves it.
The rest of `/api/admin` (notably `/api/admin/permissions`) stays with the shared
Hearth admin surface.

### Shared tables are never copied

`hearth_users`, `hearth_permissions`, `audit_log` and `hearth_index` are never
copied into the Watchtower database as authority. They are transformed (or, for
`hearth_index`, dropped) as described below. `lib/db/import/ownership.ts` asserts
none of them appear in the owned table set, and a test asserts the target
contains no table with any of those names.

## What the import does

1. Verify the source bytes and SHA-256 against the reviewed baseline.
2. Open the source read-only (`readonly`, `fileMustExist`, `query_only = 1`,
   `defaultSafeIntegers(true)`), and assert all 54 owned tables exist.
3. Open or create an empty, non-aliasing target (see *Target safety*).
4. Recreate the **exact** `CREATE TABLE` text from `sqlite_master` for each owned
   table — no hand-written DDL, so column order, defaults, `CHECK` constraints,
   `AUTOINCREMENT` and comments are byte-identical.
5. Stream rows table by table in deterministic key order, in bounded batches.
6. Recreate every explicit index and trigger attached to an owned table (implicit
   `UNIQUE`/`PRIMARY KEY` indexes come from the table DDL itself).
7. Copy `sqlite_sequence` values explicitly for owned `AUTOINCREMENT` tables.
8. Create/verify the app-local tables and run the shared-table transform.
9. `foreign_keys = ON`, `foreign_key_check`, `journal_mode = DELETE`,
   `synchronous = FULL`, bounded `busy_timeout`.
10. Re-verify the source is byte-identical, then hash the target.

### Type and byte fidelity

Reads use `defaultSafeIntegers(true)`, so SQLite `INTEGER` arrives as `bigint`
and `REAL` arrives as `number`. Binding those JavaScript types straight back
stores the identical storage class — integer `1` never becomes real `1.0`, and
`-0.0` in a no-affinity column stays `-0.0`. BLOBs are bound as the original
bytes, including empty and embedded-NUL payloads. Unicode text round-trips as
UTF-8.

### Row identity

Every owned table is a rowid table. Tables whose primary key is an
`INTEGER PRIMARY KEY` alias copy that column directly. Tables with a `TEXT`
primary key or a unique-index-only key have their implicit `rowid` copied
explicitly, so row identity is preserved exactly and the reconciliation ordering
is total.

### Reproducibility

The 54 owned tables are byte-for-byte determined by the source alone. The derived
app-local rows carry a timestamp (`app_role_grants.granted_at`, and the
`first_seen_at` fallback for an identity with an unparseable `created_at`), which
defaults to wall-clock "now". Pass `--imported-at-utc <ISO 8601>` to pin it and
make the entire target file byte-reproducible; the value used is always recorded
in the evidence manifest as `import.importedAtUtc`.

### Memory and batching

Rows are read with a streaming `iterate()` cursor and inserted with a multi-row
`INSERT` sized to stay under SQLite's bound-parameter limit (default target 1,000
rows per batch, auto-reduced for wide tables, overridable with `--batch-rows`).
Nothing beyond one batch is held in memory, so the 1.1 M-row
`unifi_traffic_flows` table imports in constant space.

## Target safety

The importer refuses to write when any of the following hold:

| Refusal | Error code |
| --- | --- |
| Target path is, resolves to, or is hard-linked to the source | `TARGET_ALIASES_SOURCE` |
| Target already contains any owned table | `TARGET_NOT_EMPTY` |
| Any existing user table in the target holds rows | `TARGET_NOT_EMPTY` |
| An app-local table already holds rows | `TARGET_NOT_EMPTY` |
| A `-wal`, `-shm` or `-journal` sidecar exists next to the target | `TARGET_SIDECAR_PRESENT` |
| The target's directory is inside a Git working tree | `TARGET_IN_GIT_WORKTREE` |
| The parent directory does not exist or is not a directory | `TARGET_PATH_UNSAFE` |
| The target refuses `journal_mode = DELETE` or `foreign_keys = ON` | `TARGET_PRAGMA_REJECTED` |

**A target database is never committed to Git.** The Git-worktree guard is on by
default; `--allow-target-in-git` exists only for tests.

"Empty" deliberately admits a target where the app's own migrations have already
run: `schema_migrations` is bookkeeping, so its rows do not make a target
non-empty, while every product table must still hold zero rows.

## App-local schema: the app's own migrations, never a copy

The importer carries **no** app-local DDL. The target must be runtime-compatible
with `lib/db/migrations/core.ts` and the repositories that read it, so:

- **`--app-local-schema=migrate`** (default) runs the app's own
  `migrateDatabase()` on the target. Every core migration is applied — currently
  v1 `app-local-identity-audit-settings` and v2 `single-instance-lease` — so
  `app_settings`, `worker_heartbeats` and `runtime_instance_lease` exist exactly
  as the runtime expects, and `schema_migrations` records the real identities.
- **`--app-local-schema=require`** asserts the migrations have already been run
  and refuses to write otherwise.

Both modes then verify:

| Check | Failure |
| --- | --- |
| `schema_migrations` contains every `CORE_MIGRATIONS` version | `APP_LOCAL_SCHEMA_MISSING` |
| Each recorded name and SQL checksum equals this worktree's | `APP_LOCAL_SCHEMA_INCOMPATIBLE` |
| No migration version present that this worktree does not know | `APP_LOCAL_SCHEMA_INCOMPATIBLE` |
| Every table the migrations create exists with exactly the migration's columns | `APP_LOCAL_SCHEMA_MISSING` / `APP_LOCAL_SCHEMA_INCOMPATIBLE` |
| The four tables the importer writes are empty | `TARGET_NOT_EMPTY` |

The expected table/column shape is **derived**, not hand-written: `CORE_MIGRATIONS`
is applied to a throwaway in-memory database and the result is compared against
the target. When a migration gains a column the check follows it automatically,
so the importer can never invent or lag a column.

Two integration details worth knowing:

- `migrateDatabase` keys applied migrations by `version` in a `Map`. The importer
  reads with `defaultSafeIntegers(true)` (so INTEGER and REAL stay
  distinguishable), which would make those keys BigInt and prevent every lookup
  from matching. The importer therefore disables safe integers for the duration of
  the migration call and restores it afterwards.
- `migrateDatabase` stamps `schema_migrations.applied_at` with wall-clock time.
  When `--imported-at-utc` pins the import instant, the importer pins
  `applied_at` to the same value so the target file stays byte-reproducible.
  Migration *identity* — version, name, checksum — is never modified, so a later
  `migrateDatabase()` run over the imported file is a clean no-op.

## Identity, authorization and audit transform

### Identities (`hearth_users` → `app_identities`)

- Keyed by `(tenant_id, oid)`. The tenant comes from the required `--tenant-id`
  GUID; `oid` is `hearth_users.azure_oid`, lowercased, and must be GUID-shaped.
- `email` and `name` are carried as **non-authoritative snapshots**
  (`email_snapshot`, `display_name_snapshot`). Nothing authorizes on them.
- `first_seen_at` is `hearth_users.created_at` parsed as UTC milliseconds
  (Hearth writes `datetime('now')`, which is always UTC).
- `last_seen_at` is `max(first_seen_at, max(received_at) over that OID's imported
  audit rows)`.

### Authorization (`hearth_permissions` → `app_feature_permissions`)

- Only rows whose `feature` is one of the 11 Watchtower view ids are migrated.
- Hearth semantics are preserved exactly: a **missing** row means "visible and
  read-only", `can_edit = 1` means editable, `is_hidden = 1` means hidden. The
  importer does not materialise synthetic default rows.

### Roles (`app_role_grants`)

Hearth stored no roles — admin was `process.env.ADMIN_OID`. The import therefore
derives roles conservatively and never invents privilege:

| Role | Rule |
| --- | --- |
| `viewer` | every imported identity |
| `operator` | identity has at least one Watchtower feature with `can_edit = 1` |
| `admin` | only from an explicit `--admin-oid <guid>` that matches an imported identity |

An `--admin-oid` with no matching identity is a hard `ARGUMENT_INVALID` failure.

### Audit (`audit_log` → `app_audit_log`)

A row is Watchtower-owned when **either**:

- `view` is one of the 11 Watchtower view ids, **or**
- `path` starts with an owned API prefix.

Owned rows are inserted in ascending legacy id order with `legacy_id` preserved
(`UNIQUE`), the tenant stamped, `user_oid` preserved verbatim, and `verified`
normalised into the `0/1` CHECK domain. Text fields are held to the same bounds
the runtime audit repository applies on write (`action` 160, `view` 80, `method`
12, `path` 512, `detail` 1000, `ip` 128) so no imported row is wider than one the
application itself would produce; any truncation is counted under
`audit_field_truncated`. Rows the runtime appends later carry `legacy_id = NULL`
and coexist with the imported history. Global sign-in/sign-out rows stay with
the monolith: Watchtower has its own Entra registration and records its own auth
events from first boot.

### `hearth_index`

Never migrated as authority, and never read for content. Watchtower rebuilds
app-local indexes and uses versioned APIs for cross-app search.

## Dispositions

Any row the importer does not copy verbatim must match a **reviewed disposition**
registered in `lib/db/import/dispositions.ts`. An unregistered situation is a
hard `TRANSFORM_UNMAPPED_ROW`/`DISPOSITION_UNKNOWN` failure. Dispositions marked
"needs ack" additionally require `--allow-disposition <code>` on the command line
and otherwise fail the run with `DISPOSITION_NOT_APPROVED`.

| Code | Kind | Ack | Meaning |
| --- | --- | --- | --- |
| `hearth_index_not_migrated` | skip | no | Shared embedding index is not migrated as authority. |
| `identity_missing_oid` | reject | **yes** | `hearth_users` row without a GUID `azure_oid` cannot be keyed by `(tenant_id, oid)`. |
| `permission_not_watchtower_feature` | skip | no | Feature belongs to another extracted product. |
| `permission_orphan_identity` | reject | **yes** | Permission references a user that produced no identity. |
| `permission_default_retained` | skip | no | Missing row keeps Hearth's visible/read-only default. |
| `audit_not_watchtower_scope` | skip | no | Audit row belongs to another product. |
| `audit_global_auth_event` | skip | no | Monolith sign-in event; Watchtower records its own. |
| `audit_unmapped_actor` | retain | no | Owned audit row whose OID has no identity; OID preserved verbatim. |
| `audit_verified_flag_normalised` | retain | no | Legacy `verified` outside `0/1` normalised to `1`. |
| `audit_field_truncated` | retain | no | A legacy audit field longer than the runtime column bound is truncated to it. |

Every disposition is counted (with bounded samples) in the evidence manifest.

## Reconciliation

`scripts/reconcile.ts` compares source and target and exits non-zero on any
difference. Per owned table:

- exact row counts
- **key digest** — an order-preserving SHA-256 over the primary/business key
  tuple of every row, in deterministic key order (so a reordering or a missing
  key is caught)
- **row digest** — an order-preserving SHA-256 over every canonically encoded
  column value of every row
- **BLOB digests** — a separate SHA-256 per BLOB-affinity column over the raw
  payload bytes, plus blob count and total bytes
- `CREATE TABLE` text digest and foreign-key definition digest

Globally: `sqlite_sequence` values, owned schema/index/trigger identity,
`foreign_keys` enforcement and `foreign_key_check`, and the expected owned row
total (2,723,313).

### Canonical encoding

```
null     -> 0x00
integer  -> 0x01 | uint32be(len) | ASCII base-10 int64
real     -> 0x02 | uint32be(8)   | IEEE-754 float64 big-endian
text     -> 0x03 | uint32be(len) | UTF-8 bytes
blob     -> 0x04 | uint32be(len) | raw bytes
```

The storage-class tag makes integer `1`, real `1.0`, text `"1"` and a one-byte
BLOB four different values. The float64 bytes distinguish `-0.0` from `0.0`.
Length prefixes make column boundaries unambiguous, so `("ab","c")` and
`("a","bc")` cannot collide. Digests are folded incrementally, so a 1.1 M-row
table is verified in constant memory.

### Ordering key selection

| Table shape | Ordering |
| --- | --- |
| `INTEGER PRIMARY KEY` alias | that column |
| Declared `PRIMARY KEY` | PK columns, then `rowid` |
| Unique index only | lexicographically first non-partial unique index columns, then `rowid` |
| Neither | all columns in schema order, then `rowid` |
| `WITHOUT ROWID` | PK columns only |

`rowid` is appended as a total-order tiebreaker; because the importer preserves
rowids exactly, this strengthens the check rather than weakening it.

### When something differs

The table-level digest tells you *that* something differs; a bounded second pass
(`--max-diff-samples`, default 25) then walks both sides in key order and reports
the specific key tuples, the differing columns, and per-value descriptors (text
is truncated, BLOBs are reported as byte length + SHA-256 so nothing sensitive is
dumped into evidence).

## Independent canonical-hash oracle

Reconciliation compares two databases using code written in this repository. A
bug shared by the reader and the writer here would be invisible to it. The
coordinator therefore ships `hash-sqlite-tables.mjs`, a standalone program that
hashes every table of a SQLite file and emits
`hearth.sqlite-canonical-table-hashes.v1`.

### Division of labour

| Side | Authority | Why |
| --- | --- | --- |
| **Source** | The coordinator's executable, run by us against the read-only backup | Its digests come from a program this repository did not write, so a bug shared by our reader and writer cannot hide them |
| **Target** | Our mapping-aware reconciliation (`reconcile.ts`) | The imported database deliberately has a *different* schema — 54 owned tables plus app-local identity/authorization/audit tables, and none of the shared Hearth tables. A whole-file hasher cannot express that mapping |

`--oracle-generator <path> --oracle-out <path>` executes the generator and keeps
its output as **separate evidence**: the file it writes is retained verbatim and
is never rewritten, reshaped or folded into our manifest. Our manifest references
it by path and SHA-256. `--oracle <path>` consumes a pre-generated document
instead (recorded as `mode: "supplied"`).

The executed run records full provenance: generator path, generator SHA-256 and
byte length, the Node executable and version, working directory, exact argv, exit
code, duration, a bounded stderr tail, the output path/bytes/SHA-256, and the
source's size and SHA-256 **before and after** — a generator that touched the
source fails the run with `SOURCE_MUTATED`.

### Re-derivation as corroboration

`lib/db/import/oracle.ts` re-derives the same digests inside this repository. It
is used for the target side, and — unless `--oracle-cross-check=false` — also
re-runs on the source purely to confirm our reader reproduces theirs. It never
substitutes for the generator's own output. Its encoding is deliberately
*different* from the one in `canonical.ts`:

```
null    -> 'N' | uint64be(0)
blob    -> 'B' | uint64be(len) | raw bytes
integer -> 'I' | uint64be(len) | UTF-8 base-10 int64
real    -> 'F' | uint64be(len) | UTF-8 Number#toString ('NaN' / '-0' /
                                 'Infinity' / '-Infinity' spelled out)
text    -> 'T' | uint64be(len) | UTF-8 bytes
```

Table digest = `sha256('hearth.sqlite-table-canonical.v1\0' | tableName |
columnCount | (columnName, declaredType)* | ('R' | value*)*)`, with rows ordered
by the declared primary key (or `rowid` when a table has none). Product digest =
`sha256('hearth.sqlite-product-canonical.v1\0' | productName | (tableName,
tableSha256, rowCount)*)` over the owned tables in ascending name order.

Two independently written encodings agreeing on the same 2,723,313 rows is
meaningful corroboration precisely because they share no code.

### What is checked

| Check | Failure |
| --- | --- |
| The generator exists, exits zero and writes a document | `ORACLE_GENERATOR_MISSING` / `ORACLE_GENERATOR_FAILED` |
| The generator did not modify the source (size and SHA-256 before/after) | `SOURCE_MUTATED` |
| The output path is not the source or the generator itself | `ARGUMENT_INVALID` |
| The document's contract, table entries and digest shapes are well formed | `ORACLE_INVALID` |
| The document carries the reviewed Watchtower aggregate, 54 tables and 2,723,313 rows — checked **before** any database is opened | `ORACLE_MISMATCH` |
| Every owned table's digest in the **target** equals the source-side published digest | difference `table-hash` |
| Target row counts equal the published row counts | difference `row-count` |
| Owned table count and row total | differences `table-count` / `row-total` |
| Target product aggregate equals `f2c00302…be9322` | difference `aggregate-hash` |
| Our source re-derivation reproduces the published digests (unless disabled) | `sourceCrossCheckAgrees: false` |

There is no aggregate-override flag: the pinned aggregate and the 54 pinned
per-table hashes are the only values either CLI will accept. Evidence `outcome`
can only be `pass` when the oracle corroborated the run *and* every admission
stage passed.

## Evidence manifest

Both scripts can write a versioned JSON manifest
(`watchtower.import-reconciliation` v1) containing:

- source identity: repository, version, build, commit, tree, image digest, backup
  created timestamp, path, bytes, SHA-256, and the post-run re-verification
- ownership: manifest path/version, the 54 owned tables, the 11 view ids, owned
  API prefixes, expected owned row total (2,723,313), never-copied shared tables
- target: path, bytes, SHA-256, journal mode, foreign-key state, busy timeout
- import summary: per-table row counts and durations, indexes/triggers created,
  `sqlite_sequence` values, app-local schema mode, transform counts, target
  schema identity
- every disposition with kind, rationale, approval state, count and samples
- the full reconciliation result including every difference
- `sourceOracle`: `mode` (`executed` or `supplied`), the document's contract,
  path, product, published aggregate/table count/row total, whether it
  corroborated the run, and — when executed — the full `execution` provenance
  block. The reconciliation block additionally carries every per-table
  computed-vs-published digest for the target and for the source cross-check
- `outcome` (`pass` only when reconciliation ran and passed with no failures)
- `evidenceDigest`: SHA-256 over the whole manifest with sorted keys

Because `outcome` requires a passing reconciliation, an import-only manifest
(written with `--reconcile=false`) always reports `fail`: an import that has not
been reconciled is not yet proven. The two artefacts are read together — the
import manifest carries the load detail and dispositions, the reconciliation
manifest carries the proof.

Serialisation is deterministic (sorted keys, two-space indent, trailing newline)
so two identical runs produce byte-identical evidence. Evidence is an artefact,
not a repository file.

## Running it

Both scripts are TypeScript ESM run through `tsx` (`npm run legacy:import`,
`npm run reconcile`), matching the rest of the server-side code.

```bash
# Import into an empty throwaway target, no in-process reconciliation.
npm run legacy:import -- \
  --manifest /path/to/decomposition-manifest.json \
  --source   /path/to/hearth-production-20260828.sqlite3 \
  --target   /path/to/artifacts/watchtower.sqlite3 \
  --tenant-id 52188f12-db6b-46c6-88ff-08c802f0ed3b \
  --admin-oid d6c36f6e-054c-45b8-9468-16c208628814 \
  --imported-at-utc 2026-08-28T05:36:25.317Z \
  --evidence /path/to/artifacts/import-evidence.json \
  --reconcile=false

# Reconcile and write the evidence manifest.
npm run reconcile -- \
  --manifest /path/to/decomposition-manifest.json \
  --source   /path/to/hearth-production-20260828.sqlite3 \
  --target   /path/to/artifacts/watchtower.sqlite3 \
  --oracle-generator /path/to/hash-sqlite-tables.mjs \
  --oracle-out       /path/to/artifacts/source-oracle.json \
  --evidence         /path/to/artifacts/reconciliation-evidence.json
```

`--oracle-out` is the generator's own artefact. Keep it alongside the evidence
manifest; it is the source-side proof and is not reproducible from our files.

`npm run legacy:import -- --help` lists every option. Both scripts exit
non-zero on any failure or difference. `npm run test:data` runs the import and
recovery suites (`node:test` via `tsx`).

## Verified baseline run (2026-08-28)

Real read-only run against the verified immutable production backup:

| Measure | Result |
| --- | --- |
| Source | 950,947,840 bytes, SHA-256 `dc9fb47d…1a5807`, unchanged after the run |
| Tables imported | 54 / 54 |
| Rows imported | **2,723,313** (exactly the expected owned total) |
| Explicit indexes / triggers | 60 / 0 |
| `sqlite_sequence` entries | 25 |
| Identities / feature permissions / audit rows | 3 / 10 / 201 |
| Import duration | **9.5–10.5 s** across runs |
| Target | 785,362,944 bytes, SHA-256 `1c0eb5ba…d5296a` (reproduced byte-identically across runs with `--imported-at-utc 2026-08-28T05:36:25.317Z`) |
| App-local schema | `migrate` — core migrations `1:app-local-identity-audit-settings` and `2:single-instance-lease` applied, identities match `CORE_MIGRATIONS` |
| Reconciliation | **pass**, 0 differences, 44.6 s (60.3 s wall including the executed source oracle) |
| Schema / sequences / foreign keys | matched / matched / enforced, 0 violations |
| Source oracle | **executed** — `hash-sqlite-tables.mjs` SHA-256 `0f42cee1ff182527869e2f0b4339a0e075590391b4d180820028a3cbed10bec1`, exit 0 in 14.2 s, source SHA-256 unchanged before/after |
| Source oracle artefact | `watchtower-source-oracle.json`, 170,576 bytes, SHA-256 `14327542e0a554230b08f7c32c9544e1b37831541c51436ff31a88d84baef39c` — byte-for-byte equal to the coordinator's published `production-canonical-hashes.json` across all 101 tables and all 6 products |
| Oracle result | **matched** — published aggregate `f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322`; all 54 target per-table digests equal the published source digests; source cross-check agrees |

Disposition counts for the run (all pre-approved, none required an
acknowledgement): `audit_global_auth_event` 72, `audit_not_watchtower_scope` 409,
`permission_default_retained` 23, `permission_not_watchtower_feature` 12,
`hearth_index_not_migrated` 1 (the table is present and empty). No audit field
needed truncation — the widest legacy values are `action` 28, `view` 20,
`method` 5, `path` 40, `ip` 21 characters.

Runtime compatibility was verified directly against the imported file: all seven
core tables carry exactly the migration columns, `schema_migrations` identities
match `CORE_MIGRATIONS`, a fresh `migrateDatabase()` run is a no-op,
`SqliteIdentityRepository.listIdentities()` returns the 3 imported identities with
their role grants, `SqliteAuditRepository.list()` reads the 201 legacy rows, and
`SqliteAuditRepository.append()` writes a new row alongside them.

The 201 owned audit rows are 174 navigation plus 27 change rows; the 481
remaining rows (including all 72 global auth rows) stay with the monolith. The 10
feature permissions are the Watchtower subset of the 22 `hearth_permissions`
rows.

## Cutover

No long-running dual write. Quiesce the Watchtower domain in the monolith, take a
final immutable backup, run the import, run reconciliation to zero differences,
then promote Watchtower's database as authority and record its first committed
write. Keep the source backup and the read-only monolith through the approved
soak. Recovery is forward-only after that first write.
