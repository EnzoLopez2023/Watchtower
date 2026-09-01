# Watchtower

Watchtower is the standalone infrastructure monitoring, observability, alerting,
and operations application extracted from Hearth production `2.13.2` build
`172`.

It owns Azure visibility, system status, observability, UPS and power topology,
UniFi network/config/topology, Synology, IP migration, Protect, agent ingest,
outage evidence and postmortems, monitoring archive, APNs alert delivery, and
the existing Hearth-for-iOS backend contract.

## Development

Requirements: Node.js 24 and a local SQLite database.

```sh
cp .env.example .env
npm install
npm run dev:server
npm run dev
```

The frontend is served by Vite on port 5173 and proxies `/api` to the Express
server on port 3000. Production uses one process and one instance with the
SQLite authority fixed at `/home/data/watchtower.db`.

## Validation

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run audit:deps
npm run check:no-postgres
npm run check:icons
```

Database import and recovery are explicit operator commands:

```sh
npm run legacy:import -- --help
npm run reconcile -- --help
npm run recovery -- --help
```

See [`docs/SOURCE_LINEAGE.md`](docs/SOURCE_LINEAGE.md),
[`docs/OWNERSHIP.md`](docs/OWNERSHIP.md), and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) before migration or deployment.
