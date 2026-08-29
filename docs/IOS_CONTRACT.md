# Hearth-for-iOS backend contract

Watchtower preserves the current iOS backend contract; no iOS feature is moved
or redesigned in this repository.

## Authentication

All `/api/mobile/*` endpoints require the existing mobile service bearer token.
It is compared in constant time. Browser Entra tokens and mutable user identity
fields are not accepted as substitutes.

## Dashboard

`GET /api/mobile/dashboard` preserves the production
`DashboardPayload`, `Subsystem`, `UPSUnit`, `AgentUnit`, and `Severity` types.
Severity values are:

```text
ok | stale | warn | critical
```

The payload is derived from server receipt times and the same infrastructure
verdict used by the web status view. Agent clocks do not determine freshness.
Marquee-owned media status is included only through authenticated
`marquee.media-health.v1`; an unavailable contract remains visibly degraded.

Contract tests freeze field names, nullability, enum values, and representative
UPS, agent, offline-device, WAN, cellular, and summary states.

## Device registration

`POST /api/mobile/register-device` accepts an APNs hexadecimal token 32-200
characters long, optional `platform` (currently `ios`), and optional app
version. Registration is idempotent, updates `last_seen`, and clears stale
per-device backoff or provider-block state so a changed APNs configuration can
be retried.

`POST /api/mobile/unregister-device` idempotently removes the token and its
backoff state.

`POST /api/mobile/test-push` uses the same durable delivery/attempt accounting
as alert delivery and returns the actual provider outcome. Tests inject a
transport and never contact APNs.

APNs payloads retain the infrastructure thread/collapse behavior. Critical
sound and interruption level are emitted only when critical alerts are
explicitly enabled; otherwise delivery is downgraded to time-sensitive.

