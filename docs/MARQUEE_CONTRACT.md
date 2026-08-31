# Marquee media-health contract

Watchtower does not read Plex, Tautulli, Sonarr, or Marquee SQLite data. It
consumes:

```http
GET /api/contracts/v1/media-health
Accept: application/json
Authorization: Bearer <Marquee-audienced workload access token>
```

The token is acquired with the App Service system-assigned managed identity for
the Marquee workload API's `.default` scope. Marquee validates the Watchtower
service principal and app role. `MARQUEE_CLIENT_ID` is not a managed-identity
selector; it is used only with the local-development
`MARQUEE_CLIENT_SECRET` flow. A static shared token is not supported.

The bounded response has schema id `marquee.media-health.v1` and includes:

- immutable Marquee build identity and generation time
- `healthy`, `degraded`, or `unavailable` overall state
- bounded SQLite readiness/schema identity
- Plex and Tautulli configured state and last observation
- Sonarr presence, freshness, cadence, and compact health metrics
- duplicate scan/delete/savings summary

It must not include provider URLs, tokens, paths, raw snapshots, user data, SQL
errors, or mutation controls.

Watchtower enforces a timeout and 256 KiB response limit. Token failure,
timeout, non-2xx response, malformed JSON, or contract mismatch is surfaced as
degraded/unavailable. Watchtower never falls back to direct providers, a shared
database, stale Hearth tables, or invented success.
