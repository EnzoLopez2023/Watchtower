// Generated from Hearth schema.sql at commit
// f0b05fc1dbf53e8aa26c215d8e858894a2793871 (tree 62cbd35861c511f7c17187c875d19ee6e353b80d).
// These are the 54 monitoring tables Watchtower owns. This compatibility DDL is
// used only by development and synthetic tests; production requires the exact
// reconciled import and verifies its immutable schema digest before workers start.
import type { SqliteDatabase } from "../../connection.js";

export const WATCHTOWER_TABLES: readonly string[] = [
  "ups_readings",
  "unifi_readings",
  "unifi_device_samples",
  "unifi_client_samples",
  "unifi_wan_samples",
  "unifi_port_samples",
  "unifi_events",
  "unifi_activity_logs",
  "unifi_traffic_flows",
  "unifi_collection_gaps",
  "unifi_ingest_health",
  "unifi_collection_compat",
  "unifi_route_baseline_meta",
  "unifi_route_baseline",
  "unifi_route_drift",
  "unifi_route_drift_history",
  "monitoring_archive_checkpoints",
  "monitoring_archive_run_lock",
  "unifi_latest",
  "network_observer_latest",
  "network_probe_samples",
  "outage_incident_evidence",
  "outage_evidence_cursors",
  "outage_incidents",
  "outage_postmortems",
  "network_isp_samples",
  "network_snmp_device_samples",
  "network_snmp_interface_samples",
  "network_snmp_interface_events",
  "protect_readings",
  "protect_latest",
  "protect_events",
  "power_diagrams",
  "power_items",
  "power_connections",
  "power_zones",
  "ip_plan",
  "agent_logs",
  "agent_ingest_receipts",
  "synology_latest",
  "synology_volume_samples",
  "synology_disk_samples",
  "synology_share_samples",
  "synology_backup_runs",
  "synology_external_devices",
  "mobile_devices",
  "mobile_alert_events",
  "mobile_alert_state",
  "mobile_alert_candidates",
  "mobile_pending_alerts",
  "mobile_push_deliveries",
  "mobile_push_attempts",
  "mobile_push_attempt_sequence",
  "mobile_push_device_backoff"
] as const;

export const WATCHTOWER_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ups_readings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at      INTEGER NOT NULL,                   -- server receipt time (epoch ms)
  device_ts        INTEGER,                            -- agent sample time (epoch ms), if sent
  ups_id           TEXT,                               -- stable per-UPS key from agent config
  ups_label        TEXT,                               -- display name, e.g. 'UPS Tower'
  ups_status       TEXT,                               -- e.g. 'OL', 'OB', 'LB', 'OL CHRG'
  battery_charge   REAL,                               -- percent
  battery_runtime  INTEGER,                            -- seconds
  battery_voltage  REAL,
  ups_load         REAL,                               -- percent
  input_voltage    REAL,
  output_voltage   REAL,
  output_power     REAL,                               -- watts
  ups_temperature  REAL,                               -- celsius
  raw              TEXT                                -- full NUT var set as JSON
);`,
  `CREATE INDEX IF NOT EXISTS idx_ups_readings_received_at ON ups_readings (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_readings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    INTEGER NOT NULL,                    -- server receipt time (epoch ms)
  device_ts      INTEGER,                             -- agent sample time (epoch ms), if sent
  wan_status     TEXT,                                -- 'up' | 'down' | 'unknown'
  wan_latency_ms REAL,                                -- gateway WAN latency
  wan_uptime     INTEGER,                             -- gateway WAN uptime (seconds)
  wan_rx_bps     REAL,                                -- WAN download rate (bits/sec)
  wan_tx_bps     REAL,                                -- WAN upload rate (bits/sec)
  internet_reachable INTEGER,                         -- actual \`_health.www\` verdict
  active_wan     TEXT,                                -- WAN | WAN2 | WAN3
  active_wan_name TEXT,
  num_clients    INTEGER,                             -- connected client count
  num_devices    INTEGER,                             -- adopted device count
  devices_online INTEGER,                             -- devices reporting online
  raw            TEXT                                 -- full normalized snapshot as JSON
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_readings_received_at ON unifi_readings (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_device_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  device_id   TEXT    NOT NULL,                       -- UniFi device id / mac
  name        TEXT,
  rx_bps      REAL,
  tx_bps      REAL,
  poe_power   REAL,                                   -- total PoE watts delivered, if a switch
  online      INTEGER,
  uptime      INTEGER,
  cpu         REAL,
  mem         REAL,
  temperature REAL
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_device_samples_dev_at ON unifi_device_samples (device_id, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_device_samples_at ON unifi_device_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_client_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  client_id   TEXT    NOT NULL,                       -- UniFi client id / mac
  name        TEXT,
  rx_bps      REAL,
  tx_bps      REAL
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_client_samples_cl_at ON unifi_client_samples (client_id, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_client_samples_at ON unifi_client_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_wan_samples (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at         INTEGER NOT NULL,
  device_ts           INTEGER,
  wan_key             TEXT    NOT NULL,
  name                TEXT,
  primary_uplink      INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 0,
  internet_reachable  INTEGER,
  latency_ms          REAL,
  availability        REAL,
  uptime_seconds      INTEGER,
  downtime_seconds    INTEGER,
  time_period_seconds INTEGER,
  monitors            BLOB
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_wan_samples_key_at
  ON unifi_wan_samples (wan_key, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_wan_samples_at
  ON unifi_wan_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_port_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  device_id   TEXT    NOT NULL,
  device_name TEXT,
  port_idx    INTEGER NOT NULL,
  port_name   TEXT,
  connected   TEXT,
  up          INTEGER,
  speed       INTEGER,
  max_speed   INTEGER,
  full_duplex INTEGER,
  poe_enabled INTEGER,
  poe_active  INTEGER,
  poe_power   REAL,
  rx_errors   INTEGER,
  tx_errors   INTEGER,
  rx_dropped  INTEGER,
  tx_dropped  INTEGER,
  stp_state   TEXT,
  fingerprint TEXT    NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_port_samples_port_at
  ON unifi_port_samples (device_id, port_idx, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_port_samples_at
  ON unifi_port_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_id  TEXT    UNIQUE,                        -- controller \`_id\`; dedup key
  event_ts     INTEGER NOT NULL,                      -- event time (epoch ms)
  received_at  INTEGER NOT NULL,                      -- server receipt time (epoch ms)
  is_alarm     INTEGER NOT NULL DEFAULT 0,            -- 1 = alarm/alert, 0 = event
  key          TEXT,                                  -- e.g. 'EVT_SW_Lost_Contact'
  subsystem    TEXT,                                  -- 'wan' | 'lan' | 'wlan' | 'vpn' | …
  message      TEXT,                                  -- human-readable message
  raw          TEXT                                   -- full event object as JSON
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_events_event_ts ON unifi_events (event_ts DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_activity_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_id  TEXT    NOT NULL UNIQUE,
  event_ts     INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  severity     TEXT,
  category     TEXT,
  subcategory  TEXT,
  event_type   TEXT,
  title        TEXT,
  message      TEXT,
  actor        TEXT,
  target       TEXT,
  normalization_version INTEGER NOT NULL DEFAULT 1,
  raw          BLOB
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_activity_ts
  ON unifi_activity_logs (event_ts DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_activity_category
  ON unifi_activity_logs (category, event_ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_activity_severity
  ON unifi_activity_logs (severity, event_ts DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_traffic_flows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_id           TEXT    NOT NULL UNIQUE,
  flow_ts               INTEGER NOT NULL,
  flow_end_ts           INTEGER,
  received_at           INTEGER NOT NULL,
  duration_ms           INTEGER,
  action                TEXT,
  direction             TEXT,
  protocol              TEXT,
  service               TEXT,
  risk                   TEXT,
  source_name            TEXT,
  source_ip              TEXT,
  source_mac             TEXT,
  source_port            INTEGER,
  source_network         TEXT,
  source_zone            TEXT,
  destination_name       TEXT,
  destination_ip         TEXT,
  destination_mac        TEXT,
  destination_port       INTEGER,
  destination_network    TEXT,
  destination_zone       TEXT,
  ingress_name           TEXT,
  egress_name            TEXT,
  bytes_rx               INTEGER,
  bytes_tx               INTEGER,
  bytes_total            INTEGER,
  packets_total          INTEGER,
  policy_names           TEXT,
  policy_types           TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_flows_ts
  ON unifi_traffic_flows (flow_ts DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_flows_action
  ON unifi_traffic_flows (action, flow_ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_flows_protocol
  ON unifi_traffic_flows (protocol, flow_ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_flows_source_ip
  ON unifi_traffic_flows (source_ip, flow_ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_flows_destination_ip
  ON unifi_traffic_flows (destination_ip, flow_ts DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_collection_gaps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  stream            TEXT    NOT NULL,
  from_ts           INTEGER NOT NULL,
  to_ts             INTEGER NOT NULL,
  source_from_ts    INTEGER,
  clock_untrusted   INTEGER NOT NULL DEFAULT 0,
  resolved_at       INTEGER,
  kind              TEXT    NOT NULL DEFAULT 'unreadable',
  reason            TEXT    NOT NULL,
  first_reported_at INTEGER NOT NULL,
  last_reported_at  INTEGER NOT NULL,
  report_count      INTEGER NOT NULL DEFAULT 1
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_collection_gaps_at
  ON unifi_collection_gaps (from_ts DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_ingest_health (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  skew_ms         INTEGER,
  skew_trusted    INTEGER NOT NULL DEFAULT 1,
  gaps_untrusted  INTEGER NOT NULL DEFAULT 0,
  last_untrusted_at INTEGER,
  updated_at      INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS unifi_collection_compat (
  stream         TEXT PRIMARY KEY,
  status         TEXT    NOT NULL,
  page_base      INTEGER,
  filter_variant TEXT,
  evidence       TEXT,
  negotiated_at  INTEGER,
  held           INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS unifi_route_baseline_meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  established_at INTEGER NOT NULL,
  last_observed_at INTEGER
);`,
  `CREATE TABLE IF NOT EXISTS unifi_route_baseline (
  route_id       TEXT PRIMARY KEY,
  route_name     TEXT,
  returned_index INTEGER NOT NULL,
  fingerprint    TEXT NOT NULL,
  payload        BLOB NOT NULL,
  established_at INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS unifi_route_drift (
  drift_key     TEXT PRIMARY KEY,
  route_id      TEXT,
  route_name    TEXT,
  drift_type    TEXT NOT NULL,
  detail        TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  baseline      BLOB,
  current       BLOB
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_route_drift_seen
  ON unifi_route_drift (last_seen_at DESC);`,
  `CREATE TABLE IF NOT EXISTS unifi_route_drift_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  drift_key     TEXT NOT NULL,
  route_id      TEXT,
  route_name    TEXT,
  drift_type    TEXT NOT NULL,
  detail        TEXT NOT NULL,
  detected_at   INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  resolved_at   INTEGER,
  baseline      BLOB,
  current       BLOB
);`,
  `CREATE INDEX IF NOT EXISTS idx_unifi_route_drift_history_at
  ON unifi_route_drift_history (detected_at DESC);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_unifi_route_drift_open
  ON unifi_route_drift_history (drift_key)
  WHERE resolved_at IS NULL;`,
  `CREATE TABLE IF NOT EXISTS monitoring_archive_checkpoints (
  stream                  TEXT    NOT NULL,
  day_start               INTEGER NOT NULL,
  day_end                 INTEGER NOT NULL,
  blob_name               TEXT,
  row_count               INTEGER NOT NULL DEFAULT 0,
  source_max_received_at  INTEGER,
  sha256                   TEXT,
  blob_etag                TEXT,
  archived_at             INTEGER,
  pruned_at               INTEGER, -- local rows were removed; base Blob must never be replaced from a partial snapshot
  last_attempt_at         INTEGER NOT NULL,
  last_error              TEXT,
  PRIMARY KEY (stream, day_start)
);`,
  `CREATE INDEX IF NOT EXISTS idx_monitoring_archive_status
  ON monitoring_archive_checkpoints (stream, archived_at, day_start DESC);`,
  `CREATE TABLE IF NOT EXISTS monitoring_archive_run_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token  TEXT    NOT NULL,
  lease_until  INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS unifi_latest (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  received_at INTEGER NOT NULL,
  payload     TEXT    NOT NULL                        -- { wan, devices, clients } full detail
);`,
  `CREATE TABLE IF NOT EXISTS network_observer_latest (
  observer_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  payload     BLOB    NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS network_probe_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  INTEGER NOT NULL,
  device_ts    INTEGER,
  observer_id  TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  target_id    TEXT    NOT NULL,
  target_label TEXT,
  ok           INTEGER NOT NULL,
  latency_ms   REAL,
  status_code  INTEGER,
  error        TEXT,
  detail       BLOB
);`,
  `CREATE INDEX IF NOT EXISTS idx_network_probe_target_at
  ON network_probe_samples (kind, target_id, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_network_probe_at
  ON network_probe_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS outage_incident_evidence (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_key  TEXT    NOT NULL UNIQUE,
  scope         TEXT    NOT NULL DEFAULT 'home',
  source        TEXT    NOT NULL,
  signal        TEXT    NOT NULL CHECK(signal IN ('power','internet','collector','context')),
  state         TEXT    NOT NULL CHECK(state IN ('outage','healthy','unknown','context')),
  occurred_at   INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,
  confidence    TEXT    NOT NULL CHECK(confidence IN ('low','medium','high')),
  summary       TEXT    NOT NULL,
  detail        TEXT,
  raw           BLOB,
  incident_id   TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_outage_evidence_scope_at
  ON outage_incident_evidence (scope, occurred_at, id);`,
  `CREATE INDEX IF NOT EXISTS idx_outage_evidence_incident
  ON outage_incident_evidence (incident_id, occurred_at, id);`,
  `CREATE TABLE IF NOT EXISTS outage_evidence_cursors (
  stream      TEXT PRIMARY KEY,
  last_row_id INTEGER NOT NULL DEFAULT 0,
  source_state BLOB NOT NULL,
  updated_at  INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS outage_incidents (
  id                  TEXT PRIMARY KEY,
  scope               TEXT    NOT NULL DEFAULT 'home',
  status              TEXT    NOT NULL CHECK(status IN ('open','recovery_pending','finalized')),
  classification      TEXT    NOT NULL CHECK(classification IN ('power','internet','collector_down','unknown')),
  confidence          TEXT    NOT NULL CHECK(confidence IN ('low','medium','high')),
  started_at          INTEGER NOT NULL,
  last_evidence_at    INTEGER NOT NULL,
  recovered_at        INTEGER,
  finalize_after      INTEGER,
  finalized_at        INTEGER,
  recovery_reason     TEXT CHECK(recovery_reason IN ('healthy_transition','stale_evidence_invalidated')),
  classifications     TEXT    NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_outage_incidents_started
  ON outage_incidents (started_at DESC);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_outage_incidents_open_scope
  ON outage_incidents (scope)
  WHERE status IN ('open','recovery_pending');`,
  `CREATE TABLE IF NOT EXISTS outage_postmortems (
  id                TEXT PRIMARY KEY,
  incident_id       TEXT    NOT NULL UNIQUE REFERENCES outage_incidents(id) ON DELETE CASCADE,
  schema_version    INTEGER NOT NULL DEFAULT 2,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  notification_staged_at INTEGER,
  executive_summary TEXT    NOT NULL,
  report            BLOB    NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_outage_postmortems_created
  ON outage_postmortems (created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS network_isp_samples (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     INTEGER NOT NULL,
  observer_id     TEXT    NOT NULL,
  unifi_host_id   TEXT    NOT NULL,
  site_id         TEXT    NOT NULL,
  metric_time     INTEGER NOT NULL,
  metric_type     TEXT,
  isp_name        TEXT,
  isp_asn         TEXT,
  latency_ms      REAL,
  max_latency_ms  REAL,
  packet_loss_pct REAL,
  download_kbps   REAL,
  upload_kbps     REAL,
  uptime_pct      REAL,
  downtime        REAL,
  raw             BLOB
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_network_isp_metric
  ON network_isp_samples (observer_id, unifi_host_id, site_id, metric_time);`,
  `CREATE INDEX IF NOT EXISTS idx_network_isp_at
  ON network_isp_samples (metric_time DESC);`,
  `CREATE TABLE IF NOT EXISTS network_snmp_device_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  device_ts   INTEGER,
  observer_id TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  label       TEXT,
  host        TEXT,
  ok          INTEGER NOT NULL,
  uptime_s    INTEGER,
  cpu_pct     REAL,
  mem_pct     REAL,
  temp_c      REAL,
  error       TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_device_at
  ON network_snmp_device_samples (device_id, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_device_received_at
  ON network_snmp_device_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS network_snmp_interface_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at  INTEGER NOT NULL,
  device_ts    INTEGER,
  observer_id  TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  if_index     INTEGER NOT NULL,
  name         TEXT,
  admin_up     INTEGER,
  oper_up      INTEGER,
  speed_bps    INTEGER,
  in_octets    INTEGER,
  out_octets   INTEGER,
  in_bps       REAL,
  out_bps      REAL,
  in_errors    INTEGER,
  out_errors   INTEGER,
  in_discards  INTEGER,
  out_discards INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_interface_at
  ON network_snmp_interface_samples (device_id, if_index, received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_interface_received_at
  ON network_snmp_interface_samples (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS network_snmp_interface_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at           INTEGER NOT NULL,
  device_ts             INTEGER,
  observer_id           TEXT    NOT NULL,
  device_id             TEXT    NOT NULL,
  device_label          TEXT,
  if_index               INTEGER NOT NULL,
  name                   TEXT,
  previous_admin_up      INTEGER,
  admin_up               INTEGER,
  previous_oper_up       INTEGER,
  oper_up                INTEGER,
  previous_speed_bps     INTEGER,
  speed_bps              INTEGER,
  in_errors_delta        INTEGER NOT NULL DEFAULT 0,
  out_errors_delta       INTEGER NOT NULL DEFAULT 0,
  in_discards_delta      INTEGER NOT NULL DEFAULT 0,
  out_discards_delta     INTEGER NOT NULL DEFAULT 0,
  in_bps                 REAL,
  out_bps                REAL
);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_event_at
  ON network_snmp_interface_events (received_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_network_snmp_event_interface_at
  ON network_snmp_interface_events (device_id, if_index, received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS protect_readings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    INTEGER NOT NULL,                    -- server receipt time (epoch ms)
  num_cameras    INTEGER,                             -- total cameras
  cameras_online INTEGER,                             -- cameras reporting CONNECTED
  storage_used_bytes  INTEGER,
  storage_total_bytes INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_protect_readings_received_at ON protect_readings (received_at DESC);`,
  `CREATE TABLE IF NOT EXISTS protect_latest (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  received_at INTEGER NOT NULL,
  payload     TEXT    NOT NULL                        -- { nvr, cameras } full detail
);`,
  `CREATE TABLE IF NOT EXISTS protect_events (
  event_id    TEXT    PRIMARY KEY,                    -- Protect's own event id
  start_ms    INTEGER NOT NULL,                       -- event start (epoch ms)
  end_ms      INTEGER,                                -- null while still in progress
  type        TEXT,                                   -- motion|smartDetectZone|ring|sensorOpened…
  camera_id   TEXT,
  camera_name TEXT,                                   -- denormalized: survives a camera rename
  smart_types TEXT,                                   -- JSON array: person|vehicle|animal|package
  score       INTEGER                                 -- detection confidence, when reported
);`,
  `CREATE INDEX IF NOT EXISTS idx_protect_events_start ON protect_events (start_ms DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_protect_events_camera ON protect_events (camera_id, start_ms DESC);`,
  `CREATE TABLE IF NOT EXISTS power_diagrams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);`,
  `CREATE TABLE IF NOT EXISTS power_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id  INTEGER NOT NULL REFERENCES power_diagrams(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'device' CHECK(kind IN ('device','power_strip','ups','outlet')),
  subtype     TEXT,                                   -- cosmetic device category, null = generic
  plug_count  INTEGER NOT NULL DEFAULT 0,
  plug_labels TEXT,                                   -- JSON array of strings|null
  plug_types  TEXT,                                   -- JSON array of 'battery'|'surge'|null, per plug
  watts       INTEGER,                                -- draw (consumer) or capacity (provider)
  link_live   INTEGER NOT NULL DEFAULT 0,             -- UPS: show live Power Monitor data
  ups_id      TEXT,                                   -- UPS: which real unit (ups_readings.ups_id)
  pos_x       REAL    NOT NULL DEFAULT 0,
  pos_y       REAL    NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);`,
  `CREATE INDEX IF NOT EXISTS idx_power_items_diagram ON power_items (diagram_id);`,
  `CREATE TABLE IF NOT EXISTS power_connections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id        INTEGER NOT NULL REFERENCES power_diagrams(id) ON DELETE CASCADE,
  source_item_id    INTEGER NOT NULL REFERENCES power_items(id) ON DELETE CASCADE,
  source_plug_index INTEGER NOT NULL,
  target_item_id    INTEGER NOT NULL REFERENCES power_items(id) ON DELETE CASCADE,
  label             TEXT,
  color             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_item_id, source_plug_index),
  UNIQUE(target_item_id)
);`,
  `CREATE INDEX IF NOT EXISTS idx_power_connections_diagram ON power_connections (diagram_id);`,
  `CREATE TABLE IF NOT EXISTS power_zones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  diagram_id  INTEGER NOT NULL REFERENCES power_diagrams(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL DEFAULT 'Zone',
  pos_x       REAL    NOT NULL DEFAULT 0,
  pos_y       REAL    NOT NULL DEFAULT 0,
  width       REAL    NOT NULL DEFAULT 320,
  height      REAL    NOT NULL DEFAULT 220,
  color       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);`,
  `CREATE INDEX IF NOT EXISTS idx_power_zones_diagram ON power_zones (diagram_id);`,
  `CREATE TABLE IF NOT EXISTS ip_plan (
  mac               TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  group_code        TEXT    NOT NULL,          -- GW|INF|NET|SRV|CAM|MED|VOX|IOT|PRN|DYN
  group_label       TEXT    NOT NULL,
  group_order       INTEGER NOT NULL,
  original_ip       TEXT,                      -- address at the time the plan was written
  target_ip         TEXT,                      -- null = stays on DHCP, no action
  sort_order        INTEGER NOT NULL,
  already_reserved  INTEGER NOT NULL DEFAULT 0,
  marked_done       INTEGER NOT NULL DEFAULT 0,
  marked_at         INTEGER,
  notes             TEXT,
  first_verified_at INTEGER
);`,
  `CREATE INDEX IF NOT EXISTS idx_ip_plan_order ON ip_plan (group_order, sort_order);`,
  `CREATE TABLE IF NOT EXISTS agent_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT    NOT NULL,               -- unifi|ups|shutdown|synology|sonarr
  ts          INTEGER NOT NULL,               -- agent clock, epoch ms
  level       TEXT    NOT NULL,               -- debug|info|warn|error
  message     TEXT    NOT NULL,
  received_at INTEGER NOT NULL                -- server clock, epoch ms
);`,
  `CREATE INDEX IF NOT EXISTS idx_agent_logs_ts    ON agent_logs (ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs (agent, ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_agent_logs_received ON agent_logs (received_at);`,
  `CREATE INDEX IF NOT EXISTS idx_agent_logs_agent_id ON agent_logs (agent, id DESC);`,
  `CREATE TABLE IF NOT EXISTS agent_ingest_receipts (
  delivery_id TEXT PRIMARY KEY,
  endpoint    TEXT    NOT NULL,
  received_at INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_agent_ingest_receipts_at
  ON agent_ingest_receipts (received_at);`,
  `CREATE TABLE IF NOT EXISTS synology_latest (
  nas_id      TEXT    PRIMARY KEY,            -- stable id from agent config
  label       TEXT    NOT NULL,
  host        TEXT,
  payload     BLOB    NOT NULL,               -- gzipped JSON, see payloadCodec
  received_at INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS synology_volume_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nas_id      TEXT    NOT NULL,
  volume_id   TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  total_bytes INTEGER,
  used_bytes  INTEGER,
  received_at INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_syno_vol_samples
  ON synology_volume_samples (nas_id, volume_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS synology_disk_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nas_id       TEXT    NOT NULL,
  disk_id      TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  temp_c       INTEGER,
  smart_status TEXT,
  health       TEXT,
  bad_sectors  INTEGER,
  received_at  INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_syno_disk_samples
  ON synology_disk_samples (nas_id, disk_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS synology_share_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nas_id      TEXT    NOT NULL,
  share_name  TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  used_bytes  INTEGER,
  received_at INTEGER NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_syno_share_samples
  ON synology_share_samples (nas_id, share_name, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS synology_backup_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nas_id      TEXT    NOT NULL,
  task_id     TEXT    NOT NULL,
  task_name   TEXT,
  last_run_ts INTEGER NOT NULL,            -- epoch seconds, from DSM
  result      TEXT,
  received_at INTEGER NOT NULL,
  UNIQUE (nas_id, task_id, last_run_ts)
);`,
  `CREATE INDEX IF NOT EXISTS idx_syno_backup_runs
  ON synology_backup_runs (nas_id, last_run_ts DESC);`,
  `CREATE TABLE IF NOT EXISTS synology_external_devices (
  nas_id       TEXT    NOT NULL,
  device_id    TEXT    NOT NULL,
  kind         TEXT,                        -- usb | esata | expansion
  name         TEXT,
  model        TEXT,
  fs           TEXT,
  size_bytes   INTEGER,
  used_bytes   INTEGER,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (nas_id, device_id)
);`,
  `CREATE TABLE IF NOT EXISTS mobile_devices (
  device_token TEXT PRIMARY KEY,           -- APNs hex device token
  platform     TEXT NOT NULL DEFAULT 'ios',
  app_version  TEXT,
  created_at   INTEGER NOT NULL,           -- epoch ms
  last_seen    INTEGER NOT NULL            -- epoch ms, refreshed on re-register
);`,
  `CREATE TABLE IF NOT EXISTS mobile_alert_events (
  id          TEXT PRIMARY KEY,
  fired_at    INTEGER NOT NULL,             -- epoch ms
  status      TEXT NOT NULL DEFAULT 'accepted', -- pending | accepted
  claim_until INTEGER,                      -- epoch ms; permits recovery after a crashed sender
  claim_token TEXT,                         -- lease owner; prevents stale-worker completion
  title       TEXT,                         -- retained only while a one-shot awaits acceptance
  body        TEXT,
  critical    INTEGER NOT NULL DEFAULT 1,
  last_seen   INTEGER,                      -- epoch ms; active conditions stay deduplicated
  delivery_key TEXT,                        -- unique occurrence key for APNs collapse
  retry_after INTEGER,                      -- epoch ms; provider-directed retry schedule
  blocked_fingerprint TEXT,                 -- legacy aggregate disposition
  device_dispositions TEXT                  -- JSON keyed by one-way device reference
);`,
  `CREATE TABLE IF NOT EXISTS mobile_alert_state (
  subsystem  TEXT PRIMARY KEY,             -- infraStatus subsystem key (ups, nas, ...)
  severity   TEXT NOT NULL,                -- ok | stale | warn | critical
  changed_at INTEGER NOT NULL,             -- epoch ms of last change
  stage      TEXT
);`,
  `CREATE TABLE IF NOT EXISTS mobile_alert_candidates (
  subsystem          TEXT PRIMARY KEY,
  target_severity    TEXT NOT NULL,
  target_stage       TEXT NOT NULL,
  signature          TEXT NOT NULL,
  consecutive_count INTEGER NOT NULL,
  first_seen         INTEGER NOT NULL,
  last_seen          INTEGER NOT NULL,
  last_sample_key    TEXT NOT NULL,
  reconcile          INTEGER NOT NULL DEFAULT 0
);`,
  `CREATE TABLE IF NOT EXISTS mobile_pending_alerts (
  id                  TEXT PRIMARY KEY,
  dedupe_key          TEXT NOT NULL UNIQUE,
  subsystem           TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  critical            INTEGER NOT NULL DEFAULT 0,
  target_severity     TEXT NOT NULL,
  target_stage        TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  retry_after         INTEGER,
  blocked_fingerprint TEXT,
  device_dispositions TEXT,
  claim_until         INTEGER,
  claim_token         TEXT
);`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_pending_alerts_created
  ON mobile_pending_alerts (created_at);`,
  `CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
  id                      TEXT PRIMARY KEY,
  source                  TEXT NOT NULL,     -- subsystem | event | test
  alert_key               TEXT,
  created_at              INTEGER NOT NULL,  -- epoch ms
  expires_at              INTEGER NOT NULL,  -- epoch ms
  completed_at            INTEGER,
  registered_device_count INTEGER NOT NULL,
  accepted_device_count   INTEGER NOT NULL DEFAULT 0,
  failed_device_count     INTEGER NOT NULL DEFAULT 0,
  apns_environment        TEXT NOT NULL,
  apns_topic              TEXT NOT NULL,
  critical_requested      INTEGER NOT NULL DEFAULT 0,
  interruption_level      TEXT NOT NULL,     -- time-sensitive | critical
  status                  TEXT NOT NULL      -- sending | accepted | partial | failed | no_devices | no_targets
);`,
  `CREATE TABLE IF NOT EXISTS mobile_push_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id    TEXT NOT NULL,
  device_ref     TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  attempt_order  INTEGER,                     -- DB-monotonic order across concurrent sends
  attempted_at   INTEGER NOT NULL,            -- epoch ms
  duration_ms    INTEGER NOT NULL,
  status         INTEGER NOT NULL,            -- APNs HTTP status; 0 = transport failure
  apns_id        TEXT,
  reason         TEXT,
  transient      INTEGER NOT NULL DEFAULT 0,
  accepted       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (delivery_id, device_ref, attempt_number)
);`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_push_deliveries_created
  ON mobile_push_deliveries (created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_mobile_push_attempts_delivery
  ON mobile_push_attempts (delivery_id, device_ref, attempt_number);`,
  `CREATE TABLE IF NOT EXISTS mobile_push_attempt_sequence (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS mobile_push_device_backoff (
  device_ref   TEXT PRIMARY KEY,
  retry_after  INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  outcome_order INTEGER NOT NULL DEFAULT 0,
  lease_until  INTEGER,
  lease_token  TEXT,
  blocked_fingerprint TEXT                 -- provider/config block; a changed config may replace its lease
);`
];

/**
 * Columns production added with one-shot `ALTER TABLE` statements after its
 * baseline `schema.sql` was written.
 */
export const WATCHTOWER_COLUMN_ADDITIONS: readonly string[] = [
  "ALTER TABLE ups_readings ADD COLUMN agent_diag TEXT"
];

/** Rows production seeds alongside the DDL. */
export const WATCHTOWER_SEED_SQL: readonly string[] = [
  "INSERT OR IGNORE INTO mobile_push_attempt_sequence (id, value) VALUES (1, 0)"
];

/**
 * Idempotently materializes a column-compatible development/test schema.
 * Production never calls this function; it opens an existing imported authority.
 */
export function ensureWatchtowerSchema(database: SqliteDatabase): void {
  database.exec(WATCHTOWER_SCHEMA_SQL.join(";\n") + ";");
  for (const statement of WATCHTOWER_COLUMN_ADDITIONS) {
    const match = /^ALTER TABLE ([a-z0-9_]+) ADD COLUMN ([a-z0-9_]+)/i.exec(statement);
    if (!match) throw new Error(`Invalid Watchtower column addition: ${statement}`);
    const [, table, column] = match;
    const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) database.exec(statement);
  }
  database.exec(WATCHTOWER_SEED_SQL.join(";\n") + ";");
}
