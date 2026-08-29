# Agent ingest and delivery contract

Watchtower owns the receiving side of UniFi, UPS/shutdown watchdog, Protect,
Network Observer, Synology, and unified agent-log delivery. Existing agent
installations are not repointed by this repository.

## Authentication boundaries

| Agent | Primary environment credential | Explicit fallback |
| --- | --- | --- |
| UniFi telemetry and logs | `UNIFI_INGEST_TOKEN` | none |
| UPS and shutdown watchdog | `UPS_INGEST_TOKEN` | none |
| Protect | `PROTECT_INGEST_TOKEN` | `UNIFI_INGEST_TOKEN` |
| Network Observer | `NETWORK_OBSERVER_INGEST_TOKEN` | `UNIFI_INGEST_TOKEN` |
| Synology | `SYNOLOGY_INGEST_TOKEN` | none |
| Unified logs | `AGENT_LOG_INGEST_TOKEN` | compatible per-agent token |

Tokens are server-only, compared in constant time, and never returned by
configuration, health, errors, logs, backup manifests, or the frontend.

## Delivery identity

Retryable deliveries carry `x-hearth-delivery-id` or the equivalent
`delivery_id` field. The retained production grammar is:

```text
^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$
```

The receiver claims `agent_ingest_receipts` inside the same transaction as
domain writes. A replay commits no domain writes and returns successful
`duplicate: true`, allowing durable sender queues to remove the delivery.
Receipts are kept for 90 days and pruned opportunistically at a bounded
interval.

The legacy header name remains wire-compatible; it does not imply access to a
Hearth service or database.

## Payload and time semantics

- UniFi activity pushes are capped at 1,000 entries, flow pushes at 2,000, and
  gap reports at 200.
- Network Observer pushes are capped at 5,000 probes.
- Unified log pushes are capped at 500 lines and 2,000 characters per message.
- Large latest snapshots use gzip JSON BLOBs. Readers detect gzip magic bytes
  and retain plaintext JSON compatibility for older rows.
- `received_at` is assigned by Watchtower and controls freshness, retention,
  alert timing, and outage evidence ordering. Agent time is retained as
  evidence but is never silently trusted.

UniFi private API collection records negotiated compatibility by stream.
Unsupported or ambiguous variants create a held gap and fail closed; a
checkpoint does not advance across unread history. Unreadable and held gaps
remain distinct, and resolved holds remain auditable.

## Sender behavior

Senders must use a durable local queue, stable delivery ID, bounded exponential
backoff, and explicit dead-letter retention. They may delete a queued delivery
only after Watchtower acknowledges either the first transaction or a duplicate
receipt. An HTTP timeout is an unknown outcome and must be retried with the same
delivery ID.

No test in this repository installs, stops, repoints, or calls a production
agent.
