# Watchtower ownership

## Views and URLs

| Production view | Standalone URL |
| --- | --- |
| `azure-command-center` | `/azure` |
| `system-status` | `/status` |
| `observability` | `/observability` |
| `power-monitor` | `/power` |
| `power-topology` | `/power/topology` |
| `unifi-network` | `/network` |
| `unifi-topology` | `/network/topology` |
| `unifi-config` | `/network/config` |
| `synology` | `/synology` |
| `ip-migration` | `/ip-migration` |
| `protect` | `/protect` |

Admin, audit, appearance, and settings are app-local at `/admin` and
`/settings`. There is no shared portal or Hearth view switch.

## Route and worker ownership

Watchtower owns the behavior formerly implemented by:

- `routes/azure.js`, `ups.js`, `unifi.js`, `unifiLogs.js`, `protect.js`
- `routes/ip-plan.js`, `power-topology.js`, `agentLogs.js`, `synology.js`
- `routes/mobile.js`, `status.js`, `networkObserver.js`
- `lib/alertEngine.js`, `monitoringArchive.js`, `outagePostmortems.js`
- `lib/recovery/offhostWorkers.js`

Interactive endpoints require a Watchtower-audienced Entra access token and an
app-local `viewer`, `operator`, or `admin` role. Agent and mobile endpoints use
their own constant-time service authentication and are not authorized by an
email, display name, forwarded identity header, or Hearth database.

## Owned tables

Exactly these 54 production tables move to the isolated Watchtower authority:

```text
ups_readings
unifi_readings
unifi_device_samples
unifi_client_samples
unifi_wan_samples
unifi_port_samples
unifi_events
unifi_activity_logs
unifi_traffic_flows
unifi_collection_gaps
unifi_ingest_health
unifi_collection_compat
unifi_route_baseline_meta
unifi_route_baseline
unifi_route_drift
unifi_route_drift_history
monitoring_archive_checkpoints
monitoring_archive_run_lock
unifi_latest
network_observer_latest
network_probe_samples
outage_incident_evidence
outage_evidence_cursors
outage_incidents
outage_postmortems
network_isp_samples
network_snmp_device_samples
network_snmp_interface_samples
network_snmp_interface_events
protect_readings
protect_latest
protect_events
power_diagrams
power_items
power_connections
power_zones
ip_plan
agent_logs
agent_ingest_receipts
synology_latest
synology_volume_samples
synology_disk_samples
synology_share_samples
synology_backup_runs
synology_external_devices
mobile_devices
mobile_alert_events
mobile_alert_state
mobile_alert_candidates
mobile_pending_alerts
mobile_push_deliveries
mobile_push_attempts
mobile_push_attempt_sequence
mobile_push_device_backoff
```

`hearth_users`, `hearth_permissions`, and the Watchtower partition of
`audit_log` are transformed into app-local OID-keyed tables. Their shared names
never become runtime authority. `hearth_index` is not migrated.

Marquee owns Plex, Tautulli, and Sonarr status. Watchtower consumes only
Marquee's authenticated `media-health` v1 contract and never reads Marquee
tables or provider credentials.

