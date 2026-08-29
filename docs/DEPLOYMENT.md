# Deployment and runtime storage contract

Watchtower is a single-process SQLite service deployed to Azure App Service
(Linux). Its one durable asset is the SQLite authority at
`/home/data/watchtower.db`. On App Service that path is only persistent when the
persistent-storage feature is enabled and `/home` is the mounted Azure Files
share. If the app ever opened its database on an image-local directory instead,
every write would land on an ephemeral layer and be lost on the next restart —
silently.

To make that failure mode impossible, the production process refuses to open the
database unless it can prove, from kernel evidence, that it is writing to the
real persistent mount. That proof is driven by a machine-readable contract that
is the single source of truth for both the runtime check and the tests.

## The contract

- **Source of truth:** `lib/deployment/contract.ts` (`DEPLOYMENT_CONTRACT`), a
  deeply frozen, validated typed constant.
- **Machine-readable mirror:** `lib/deployment/deployment.contract.json`, a
  checked-in serialization for external infrastructure-as-code and deployment
  tooling. `test/deployment/contract.test.ts` parses the JSON and asserts it is
  structurally identical to the code, so the two can never diverge.

The contract names, at minimum:

| Field | Value | Platform source |
| --- | --- | --- |
| Required App Service setting | `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `app.bicep` (emitted from `dataStorageMode`) |
| Required value (verbatim) | `true` | `dataStorageMode = 'persistent'` |
| Persistent mount point | `/home` | platform share; **no** explicit `storageMount` |
| Data directory | `/home/data` | derived from `DB_PATH` |
| Authoritative database path | `/home/data/watchtower.db` | `DB_PATH` |
| Off-host backup root | `/home/data/backups/watchtower` | `BACKUP_ROOT` |
| SQLite journal mode | `SQLITE_JOURNAL_MODE = DELETE` | `SQLITE_JOURNAL_MODE` |

Container images use the existing shared registry
`acrenzolopez01.azurecr.io`. The contract records
`mode = shared-existing` and `dedicatedRegistryAllowed = false`; Watchtower must
not create or depend on a dedicated per-app ACR.

The contract also records the platform facts the container cannot verify from
the inside. They are **deployment evidence**, asserted against the image and the
infrastructure audit rather than probed at startup:

| Field | Value | Why it matters |
| --- | --- | --- |
| `deploymentProfile` | `sqlite-one-worker` | names the single-writer topology |
| `dataStorageMode` | `persistent` | drives the storage app setting |
| `numberOfWorkers` | `1` | a second worker would mean two SQLite writers |
| `alwaysOn` | `true` | the workers and lease must not be recycled idle |
| `containerPort` | `3000` | must equal the app's `PORT` |
| `healthCheckPath` | `/api/live` | unauthenticated liveness |
| `readinessPath` | `/api/ready` | unauthenticated readiness |
| `forbiddenImageVolumePrefix` | `/home` | a Docker `VOLUME` here would shadow the share |

`server/config.ts` consumes `PRODUCTION_DATABASE_PATH` from the same contract, so
the configured production database path and the gate's authority path are one
literal.

## Production startup gate

Wired in `server/bootstrap.ts` as `enforcePersistentStorageContract(config)`,
**strictly before `openDatabase(...)`**. It is a no-op in `development` and
`test`. In `production` it fails fast — a clear, secret-safe error and a
non-zero exit — unless **all** of the following hold:

1. `WEBSITES_ENABLE_APP_SERVICE_STORAGE` is exactly `"true"` (no trimming; `"1"`,
   `"TRUE"`, `" true"` are all rejected).
2. The selected database authority resolves to `/home/data/watchtower.db`.
3. `/home` is a **real mount** — present in the kernel mount table
   (`/proc/self/mountinfo`), not merely a directory on the image layer.
4. `/home/data` **exists** on that mount and sits on a **different filesystem
   device** than the root filesystem (`fs.statSync().dev` of `/home/data` differs
   from that of `/`).
5. `/home/data` is **writable right now**, proven by an atomic
   create/write/unlink probe that cleans up after itself.

Because the gate runs before `openDatabase`, a rejected startup never creates a
SQLite file or its parent directory (`test/deployment/bootstrapOrdering.test.ts`
asserts exactly this for every rejection reason).

### How the mount is proven real

Two independent signals, both required, defeat the "a directory named
`/home/data` exists" false positive:

- **Mount-table evidence:** `/home` must appear as a mount point in
  `/proc/self/mountinfo`. A directory created by `mkdir` inside an image layer is
  not a mount and does not appear there.
- **Device distinctness:** `/home/data` must live on a different device
  (`st_dev`) than `/`. An image-layer directory shares the root device.

A Docker-created `/home/data` (same device as `/`, absent from the mount table)
fails both and is rejected — see the regression test
`rejects the Docker image-layer case` in `test/deployment/storageGate.test.ts`.

### Injectable probe

All filesystem evidence goes through a narrow injectable interface,
`PersistentStorageProbe` (`lib/deployment/persistentStorageProbe.ts`):

```ts
interface PersistentStorageProbe {
  mountPoints(): readonly string[];        // parsed from /proc/self/mountinfo
  deviceId(path: string): number | undefined; // fs.statSync().dev, or undefined if absent
  writeProbe(directory: string): { ok: boolean; code?: string }; // atomic create/write/unlink
}
```

The default export `defaultPersistentStorageProbe` is the real implementation.
Tests inject a synthetic probe to drive every branch deterministically on
macOS/Linux without root and without real mounts.

### Rejection codes

`APP_SERVICE_STORAGE_DISABLED`, `DATABASE_PATH_NOT_AUTHORITY`,
`PERSISTENT_MOUNT_ABSENT`, `DATA_DIRECTORY_ABSENT`,
`PERSISTENT_MOUNT_NOT_DISTINCT`, `MOUNT_EVIDENCE_UNAVAILABLE`,
`PERSISTENT_MOUNT_NOT_WRITABLE`, `DATABASE_PATH_SYMLINK_ESCAPE`,
`SQLITE_JOURNAL_MODE_INVALID`. Messages name only public deployment paths and
`errno`-style codes, never environment values or secrets.

### Symlink escape

The path equality check alone is satisfied by a symlink that redirects every
write to ephemeral storage. Both `/home/data` and, when it already exists,
`/home/data/watchtower.db` are resolved with `realpath` and must resolve to
themselves. An absent database file is normal on first boot and is accepted; an
existing one that resolves elsewhere is `DATABASE_PATH_SYMLINK_ESCAPE`.

### The sentinel round trip

The writability check is not a create-and-unlink. A share that accepts a write
into the page cache and never durably stores it would pass that, which is the
exact failure this gate exists to catch. Instead the probe, **before the
database is opened**:

1. `open(…, "wx+", 0o600)` — atomic exclusive create, private, readable back;
2. `write()` in a loop until every byte is written (short writes tolerated,
   a zero/invalid count is `EIO_SHORT_WRITE`);
3. `fsync()` — the durability barrier;
4. `fstat` size check, then `read()` back and byte-compare
   (`EIO_SIZE_MISMATCH`, `EIO_SHORT_READ`, `EIO_READBACK_MISMATCH`);
5. `close()` in `finally`, then `unlink` the sentinel.

The sentinel is a **private file**. Nothing is written into the database — it
has not been opened at this point, and `test/deployment/iacAlignment.test.ts`
asserts the gate module references no SQLite API at all.

## Docker image

The image intentionally does **not** create `/home/data`. On App Service the
persistent `/home` mount shadows anything the image placed at `/home`, so an
image-local `/home/data` cannot serve the mounted first boot anyway — it would
only manufacture the exact ephemeral same-layer directory the runtime gate
exists to reject. The runtime gate is the real defence; the Dockerfile must not
undercut it. (Previously the image ran `mkdir -p /home/data && chown ...`; that
line was removed.)

The data directory therefore has exactly one source: the persistent App Service
mount.

## Required deployment steps (provisioning is out of scope here)

These are recorded for the operator/IaC runbook. This repository does **not**
provision anything.

1. Set the App Service application setting
   `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` so `/home` is the persistent Azure
   Files mount.
2. Ensure `/home/data` exists on that mount before (or on) first boot. The gate
   requires the data directory to already exist on the persistent mount; it will
   not create it on an unverified filesystem. Creating it is a one-time
   deployment/runbook action on the mounted share.

## Infrastructure-as-code coordination

The infrastructure is **not** in this repository. It is owned by `azure-infra`,
and its declaration is authoritative:

| Artifact | Role |
| --- | --- |
| `new-apps/watchtower.bicepparam` | app settings: `DB_PATH`, `SQLITE_JOURNAL_MODE`, `BACKUP_ROOT`, `containerPort`, `deploymentProfile`, `dataStorageMode` |
| `new-apps/templates/app.bicep` | emits `kind: app,linux,container`, `siteConfig.numberOfWorkers = 1`, `alwaysOn = true`, and `WEBSITES_ENABLE_APP_SERVICE_STORAGE` from `dataStorageMode` |
| `scripts/audit-wave2-infrastructure.sh` | the audit that proves the deployed resource still matches the declaration |

`lib/deployment/deployment.contract.json` is this app's machine-readable mirror
of the same facts, and `test/deployment/iacAlignment.test.ts` asserts every
value against the transcribed platform declaration. **If `azure-infra` changes
the profile, the port, the paths or the journal mode, that test fails** — which
is the intended coupling: the runtime preflight and the template must describe
one deployment, not two.

Division of responsibility:

- **`azure-infra` proves** (via `audit-wave2-infrastructure.sh`): one worker,
  `alwaysOn`, the `sqlite-one-worker` profile, `dataStorageMode = persistent`,
  the emitted storage app setting, system-assigned identity and pull access to
  the existing shared `acrenzolopez01.azurecr.io` registry. There
  is deliberately **no explicit `storageMount`** — `/home` is the platform's own
  persistent share.
- **This app proves at startup**: the setting is exactly `true`, the database is
  the contract path with no symlink escape, `/home` is a real mount whose data
  directory is on a different device than `/`, the journal mode is `DELETE`, and
  the directory completes a durable write→fsync→read-back round trip — all
  before the database is opened.
- **This app proves from the image**: no Docker `VOLUME` at or below `/home`,
  and no image-local `mkdir /home/data`. Both are asserted against the
  `Dockerfile` by `test/deployment/iacAlignment.test.ts`, because a `VOLUME`
  there would mount an anonymous ephemeral volume that satisfies every runtime
  probe — a real mount, on a non-root device, writable — while silently
  discarding the database on every restart.

No infrastructure change or provisioning was performed from this repository.
