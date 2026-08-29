# HTTP API

All responses are JSON unless an endpoint explicitly returns a download.
Interactive endpoints require a verified Watchtower-audienced Entra access
token. Reads require `viewer`, mutations require `operator`, and app-local
identity/audit administration requires `admin`.

## Health and identity

```text
GET  /api/live
GET  /api/ready
GET  /api/version
GET  /version.json
GET  /api/me
GET  /api/settings
PUT  /api/settings/:key
POST /api/audit/events
GET  /api/admin/users
PUT  /api/admin/users/:tenantId/:oid/roles
PUT  /api/admin/users/:tenantId/:oid/features/:feature
GET  /api/admin/audit
```

## Azure

```text
GET  /api/azure/overview
GET  /api/azure/budget
GET  /api/azure/resource
GET  /api/azure/resources
GET  /api/azure/webapps
GET  /api/azure/webapps/:resourceGroup/:name
GET  /api/azure/webapps/:resourceGroup/:name/metrics
GET  /api/azure/plans
GET  /api/azure/acr
GET  /api/azure/acr/:resourceGroup/:name/runs
GET  /api/azure/acr/:resourceGroup/:name/runs/:runId
GET  /api/azure/acr/:resourceGroup/:name/repositories
GET  /api/azure/cognitive
GET  /api/azure/cognitive/:resourceGroup/:account/deployments/:name
GET  /api/azure/cost
GET  /api/azure/cost/service
POST /api/azure/cache/bust
```

Azure operations are read-only except app-local cache invalidation. Clients use
managed identity and bounded request/cache lifetimes.

## Infrastructure telemetry

```text
GET /api/status

GET /api/ups
GET /api/ups/history
GET /api/ups/outages

GET /api/unifi
GET /api/unifi/history
GET /api/unifi/wan-history
GET /api/unifi/ports/history
GET /api/unifi/events
GET /api/unifi/config
GET /api/unifi/outage-incidents
GET /api/unifi/outage-incidents/:id

GET /api/unifi/logs/activity
GET /api/unifi/logs/flows
GET /api/unifi/logs/summary

GET /api/protect
GET /api/protect/history
GET /api/protect/events
GET /api/protect/activity
GET /api/protect/storage-forecast

GET /api/network-observer
GET /api/network-observer/history
GET /api/network-observer/isp
GET /api/network-observer/snmp
GET /api/network-observer/snmp-events

GET    /api/synology
GET    /api/synology/history
GET    /api/synology/shares
GET    /api/synology/backups
GET    /api/synology/summary
GET    /api/synology/external
DELETE /api/synology/external/:nasId/:deviceId
GET    /api/synology/disks
```

History ranges, pagination limits, and result sizes are bounded. Freshness is
always calculated from server `received_at`, never trusted agent clocks.

## Observability

```text
GET /api/observability/logs
GET /api/observability/analytics
GET /api/admin/logs
```

Log search uses bounded cursor pagination. Full request bodies, credentials,
provider URLs, and tokens are never stored as log detail.

## Power topology and IP plan

```text
GET    /api/power/diagrams
POST   /api/power/diagrams
GET    /api/power/diagrams/:id
PATCH  /api/power/diagrams/:id
DELETE /api/power/diagrams/:id
POST   /api/power/diagrams/:id/duplicate
PUT    /api/power/diagrams/:id/graph
POST   /api/power/items
PATCH  /api/power/items/:id
DELETE /api/power/items/:id
POST   /api/power/items/positions
POST   /api/power/connections
PATCH  /api/power/connections/:id
DELETE /api/power/connections/:id
POST   /api/power/zones
PATCH  /api/power/zones/:id
DELETE /api/power/zones/:id

GET   /api/ip-plan
PATCH /api/ip-plan/:mac
```

Graph replacement and duplication are transactional. Live UPS links enrich
responses without changing stored topology identity.

## Service-authenticated ingest

```text
POST /api/ups/ingest
POST /api/unifi/ingest
POST /api/unifi/logs/ingest
POST /api/protect/ingest
POST /api/network-observer/ingest
POST /api/synology/ingest
POST /api/agent-logs/ingest
```

These endpoints use their agent-specific constant-time token contract rather
than browser Entra roles. See [`AGENTS.md`](AGENTS.md).

## Mobile

```text
GET  /api/mobile/dashboard
POST /api/mobile/register-device
POST /api/mobile/unregister-device
POST /api/mobile/test-push
```

These endpoints retain the existing mobile service authentication and frozen
Hearth-for-iOS contract described in [`IOS_CONTRACT.md`](IOS_CONTRACT.md).
