# Database evolution evidence gate

Watchtower starts on isolated SQLite because the complete production workload
is proven on SQLite and the product split must be measured independently of an
engine change.

No PostgreSQL package, schema, compatibility abstraction, dual-write path, or
runtime backend switch belongs in this repository today.

A Watchtower-only database proposal may begin only after a representative soak
captures objective evidence that SQLite is the limiting factor. At minimum:

- sustained write rate, transaction duration, busy/locked error rate, and
  p50/p95/p99 route latency
- database and backup growth, archive throughput, restore duration, and
  recovery point/recovery time results
- queue claim contention and worker deadline misses under measured peak load
- one-process/one-instance availability requirements that SQLite cannot meet
- a tested migration, rollback boundary, backup/restore drill, and cost model
- proof that the issue cannot be addressed safely through indexing, bounded
  retention, batching, archival, or query repair

Approval must be product-local. It must not recreate a shared database or make
another product's availability, schema, credentials, or deployment a
Watchtower runtime dependency. Any future migration is a separate reviewed
program after the split and baseline soak are complete.
