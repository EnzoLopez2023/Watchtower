# Architecture

```text
React 19 routed SPA
  -> MSAL Watchtower access token
  -> Express 5 API
       -> app-local authorization/audit/settings
       -> async domain repositories
            -> one better-sqlite3 connection
                 -> /home/data/watchtower.db (DELETE journal)
       -> bounded Azure ARM clients (managed identity)
       -> Marquee media-health v1 (Entra workload identity)
       -> APNs HTTP/2
       -> app-owned Azure Blob archive/recovery

On-prem agents
  -> distinct service-token ingest routes
  -> transactional delivery receipts + telemetry
  -> alert/outage/archive workers
```

The frontend has real URLs and lazy feature boundaries. It does not contain the
Hearth global view registry. Shared UI is app-local and limited to navigation,
auth, theme, loading/error presentation, and infrastructure primitives.

Express construction is separate from listening. Public health/version,
service-authenticated mobile/agent routes, interactive Entra routes, and SPA
assets have distinct middleware boundaries.

The database adapter is synchronous internally but exposes async repository
interfaces. This prevents SQLite from leaking into route/domain code and
preserves a stable boundary for testing without creating a dual backend.

Background workers are managed as one lifecycle. A renewable SQLite-backed
instance lease prevents a second Watchtower process from writing the authority.
Startup failure rolls back already-started workers. Shutdown aborts work and
stops workers in reverse order so the instance lease remains held until domain
workers release their claims.

High-volume monitoring history archives only complete UTC days. A local row is
eligible for archive-aware pruning only after the app-owned off-host object has
been written, read back, hashed, and checkpointed. Recovery is an explicit
operator path and never an HTTP or startup side effect.
