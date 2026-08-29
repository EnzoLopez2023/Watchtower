/**
 * APPROVED WATCHTOWER BASELINE - source-controlled, operator-immutable.
 *
 * Every lineage, size, digest, schema-count and per-table value the importer
 * trusts is pinned **here, in code**. Operator-supplied inputs - the
 * decomposition manifest, the canonical-hash oracle (supplied or executed) and
 * the backup file itself - are validated against this contract *before* a target
 * database is created, opened or written.
 *
 * The point is that a self-consistent forgery must still fail: an attacker who
 * supplies a matching manifest **and** a matching backup **and** a matching
 * oracle cannot succeed, because the approved bytes, SHA-256, row counts and the
 * 54 per-table canonical hashes are not taken from any of those inputs.
 *
 * Provenance: transcribed from the coordinator artifact
 * `production-canonical-hashes.json`
 * (`hearth.sqlite-canonical-table-hashes.v1`) and the reviewed decomposition
 * manifest for Hearth 2.13.2 build 172. The executed generator remains
 * *corroboration* - it can confirm these values but is never the authority for
 * them.
 */

export interface ApprovedLineage {
  readonly repository: string;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly tree: string;
  readonly imageDigest: string;
  readonly backupCreatedUtc: string;
  readonly backupBytes: number;
  readonly backupSha256: string;
}

/** Immutable lineage of the one backup this importer will read. */
export const APPROVED_LINEAGE: ApprovedLineage = Object.freeze({
  repository: "EnzoLopez2023/Hearth",
  version: "2.13.2",
  build: 172,
  commit: "f0b05fc1dbf53e8aa26c215d8e858894a2793871",
  tree: "62cbd35861c511f7c17187c875d19ee6e353b80d",
  imageDigest: "sha256:dc4df7e0f966be5b0608e71643d316cc5eba7590b8e56cec482583ab69443140",
  backupCreatedUtc: "2026-08-28T05:36:25.317Z",
  backupBytes: 950_947_840,
  backupSha256: "dc9fb47d269b339a3dcae37279dc3116f37a0635728a2d2b2ac2c511811a5807"
});

/**
 * Whole-source schema object counts.
 * Tables exclude `sqlite_%` names; indexes count only explicit CREATE INDEX objects.
 */
export const APPROVED_SOURCE_SCHEMA_COUNTS = Object.freeze({
  tables: 101,
  explicitIndexes: 137,
  triggers: 8,
  views: 0
});

/** Schema identity of the 54 owned tables plus their explicit indexes and triggers. */
export const APPROVED_OWNED_SCHEMA_DIGEST =
  "a1dfbe309137dd2e5598e695256fa64a955de6657480340eca4e894b5c9b10f7";
export const APPROVED_OWNED_EXPLICIT_INDEX_COUNT = 60;
export const APPROVED_OWNED_TRIGGER_COUNT = 0;

/** Watchtower aggregate under the oracle's product-hash construction. */
export const APPROVED_AGGREGATE_SHA256 =
  "f2c0030206288ec8314b64eb36ff1943a18f7d1c9cd2ae62b3a330da51be9322";
export const APPROVED_OWNED_TABLE_COUNT = 54;
export const APPROVED_OWNED_ROW_TOTAL = 2_723_313;

export interface ApprovedTable {
  readonly rowCount: number;
  readonly canonicalSha256: string;
}

/** Exact per-table row count and canonical hash for each owned table. */
export const APPROVED_TABLES: ReadonlyMap<string, ApprovedTable> = new Map<string, ApprovedTable>([
  ["agent_ingest_receipts", { rowCount: 153978, canonicalSha256: "8faa1ed82b3e0ae4928eeeac4e1522f99ab97813eb503eb0cd0724f98f792c2c" }],
  ["agent_logs", { rowCount: 48093, canonicalSha256: "f49cd9d90cffab74cf451b0e21774040f22163646789d4432547caa717a3b276" }],
  ["ip_plan", { rowCount: 98, canonicalSha256: "2680679964cf536cc2e1b41d25c2547c3bea598511eb277fd7c17f8484beefb8" }],
  ["mobile_alert_candidates", { rowCount: 0, canonicalSha256: "a87bae7d54e8e92c9ff43580708552aa793caa3e2ca6fe3ccf5b748bffefa51a" }],
  ["mobile_alert_events", { rowCount: 0, canonicalSha256: "83a80017c1f411c3c2a75e979c5e0bb14d696a60627bb31feb037958edd25119" }],
  ["mobile_alert_state", { rowCount: 7, canonicalSha256: "22c41c316ed742fb732e746d39b2a98abfb2d38eab6fc27030675ec95995d332" }],
  ["mobile_devices", { rowCount: 2, canonicalSha256: "90d1d9451cef43a5e6439db6841407f7733203793a39968010c28ee70c0b9f0c" }],
  ["mobile_pending_alerts", { rowCount: 0, canonicalSha256: "72d8e77aee020a4c54c8e35086975bdd6df5a468de1caef2536297c1ae5f8bc8" }],
  ["mobile_push_attempt_sequence", { rowCount: 1, canonicalSha256: "4cf013da0d5dd0b0b55cf4b08a28eda1519a097c7daac1989b763373ec7adf48" }],
  ["mobile_push_attempts", { rowCount: 464, canonicalSha256: "4cd3073292ee5f993b3dab40d2b8a2d8c438a9535a5061ff02ea2ccbd77009b4" }],
  ["mobile_push_deliveries", { rowCount: 406, canonicalSha256: "d073b711bf8e145c0d5fefec86b4595243d967ea1466dc7c705febb9f40eab12" }],
  ["mobile_push_device_backoff", { rowCount: 2, canonicalSha256: "09264bfb09347b1812e602c7b948e0b123a9b6c03c93b065ee23438c9d16c57e" }],
  ["monitoring_archive_checkpoints", { rowCount: 31, canonicalSha256: "4bf7f2fb770d1187bf3b49f8ac603ec04360ed316a38b512c5c3986738ae537d" }],
  ["monitoring_archive_run_lock", { rowCount: 1, canonicalSha256: "58f30677c8d46ae833514b636efa11b0d8db9c919e3b71584e82821ae9c502ed" }],
  ["network_isp_samples", { rowCount: 1212, canonicalSha256: "8604d727b0edbb4c5b75ba7431ad0982a8948ec56a18b3d8aecd94e3788a5478" }],
  ["network_observer_latest", { rowCount: 1, canonicalSha256: "b83d902ea23e9a85540d3114b5a69dc736253e501ea2dd57e6f40f374fb3b4bf" }],
  ["network_probe_samples", { rowCount: 242165, canonicalSha256: "2e17b7d128945f94f0c3fce03aa32a550b3ac800e117f22eb2cfdc76a9ed7411" }],
  ["network_snmp_device_samples", { rowCount: 132249, canonicalSha256: "a0802fbc26d3416880f52b84d0b01c4c0f578b692554895c75ae0192f06fc130" }],
  ["network_snmp_interface_events", { rowCount: 108628, canonicalSha256: "c7dbebb81b148978474ca8308570929e75f85747b1a1d76e608b5e2d0af51ea7" }],
  ["network_snmp_interface_samples", { rowCount: 439831, canonicalSha256: "e35208f14667481942c3a31e81c43d0f4464a2397e20c5dad5613cb0d6851fb8" }],
  ["outage_evidence_cursors", { rowCount: 3, canonicalSha256: "1cba8560ed69af98c2eb823de3abc88a05e769d5fac8642eed518915aac68f8a" }],
  ["outage_incident_evidence", { rowCount: 2584, canonicalSha256: "149c46d6e793f5c66b47f9818ae1539e182e408813d3099cf2decf91e21ff3e8" }],
  ["outage_incidents", { rowCount: 31, canonicalSha256: "c43d2e1ae05dc64134717bcbf8a0dd6d663e8e89916cad127162efda45dc052b" }],
  ["outage_postmortems", { rowCount: 30, canonicalSha256: "fb6d7f0f13b1056885db1c4b20ba8b8e2fdb905e8aae8ee5492c05de6ec30da3" }],
  ["power_connections", { rowCount: 28, canonicalSha256: "6adbc07c24816bd56669be9282304f95a47448d7c55eeff521ea07426a89c591" }],
  ["power_diagrams", { rowCount: 1, canonicalSha256: "780abd5b2eb2a48b9142b02dd30c3cb7497bfb0f82b6afee761a6c42965aea70" }],
  ["power_items", { rowCount: 34, canonicalSha256: "a05a222bab7783be32f90d5137e96f76ce0f160dbd1651182f0a34a27d895d41" }],
  ["power_zones", { rowCount: 0, canonicalSha256: "c3dacbf89dfc302368e0c5a52d5b3c064d97b92f1c47ffee8be648c0d4b59e50" }],
  ["protect_events", { rowCount: 108530, canonicalSha256: "0fe91f7899bda4a6c7e414aa86d9a6dffd7d45e3eb548363a4dd1e49f3d45232" }],
  ["protect_latest", { rowCount: 1, canonicalSha256: "42ef80e205d7170ec78f108dc4926c0f3cbfca2efd784240806cb25c3d6c2fcb" }],
  ["protect_readings", { rowCount: 20305, canonicalSha256: "c6aab7cd1b031b36e183dec67b26fd88aef9c0afc9cda9dcc73002ed7f7c154d" }],
  ["synology_backup_runs", { rowCount: 0, canonicalSha256: "878d2737ebbc0123fc8fa76463bbecb7bb2a618c9f04a123636bd17bea381112" }],
  ["synology_disk_samples", { rowCount: 52704, canonicalSha256: "46420e64ec970025f47bcfcec4ba75d8673e0034a72b5c1e675b17233619e63e" }],
  ["synology_external_devices", { rowCount: 8, canonicalSha256: "3b87948874a64fde46c0cf169fdb04ca4876b6e060a083354df3bfc3bd2cfd0c" }],
  ["synology_latest", { rowCount: 2, canonicalSha256: "8ecb47bd11b7c79ac08d03d6f48f648e75295b54a99a2a31afb10720c25c766e" }],
  ["synology_share_samples", { rowCount: 1573, canonicalSha256: "7f0c6239d06252dde67fa840a993f01c25b74e0e541f8074f4efb758f7be4462" }],
  ["synology_volume_samples", { rowCount: 8109, canonicalSha256: "84667e058fced86130cf98a6ee778983899df4d5deaffaa9bdfac6762d9c8bc2" }],
  ["unifi_activity_logs", { rowCount: 22304, canonicalSha256: "03628978dd9d1a2db24d33200268fec794ce970bdaa7260b88755c29e6cf9895" }],
  ["unifi_client_samples", { rowCount: 38402, canonicalSha256: "622b9f799f06276afd0cc568e9d9f259be7911a2f008338ce0b259be8c0a182e" }],
  ["unifi_collection_compat", { rowCount: 2, canonicalSha256: "5121cc81eeeb5fb304a3a6bf397ece83f70cbd42bf177d1090e9d0a79c85e328" }],
  ["unifi_collection_gaps", { rowCount: 0, canonicalSha256: "e9bd73615e96e2e25d5cb4f7f96dad252e5be0795094a2038ac38274a2fd760a" }],
  ["unifi_device_samples", { rowCount: 122976, canonicalSha256: "2a9f75752c3f4ffed7060ad43830d05b49369869a681f7b0092fc65b8c5ed2af" }],
  ["unifi_events", { rowCount: 0, canonicalSha256: "bb1771a3c86c673ca3899351b3e8cea50401fd4ebbe004832c34d2545ff11da0" }],
  ["unifi_ingest_health", { rowCount: 1, canonicalSha256: "74687a5cb883cddd2507b85aaad13fa47baab1ca378df8bd5d2d0850343ae2a1" }],
  ["unifi_latest", { rowCount: 1, canonicalSha256: "bb9cbf28701d0b82db91c00aba4ab62b0226f92d32fe1573afd4ddf64b03f7c3" }],
  ["unifi_port_samples", { rowCount: 28751, canonicalSha256: "c699e0a1fd9ba1d779961cafafbca9dd8acfe8b972e3fcfb2e216ef1c64c1ba9" }],
  ["unifi_readings", { rowCount: 41235, canonicalSha256: "44c7c3c2bbeaa36b8f1f8d3e37c66fc2d895d3d752c395db2c482d0e6eaa449a" }],
  ["unifi_route_baseline", { rowCount: 2, canonicalSha256: "d8438a10c52660931828c1c3750716f6dbe56b58434722d9ac3d24508caca069" }],
  ["unifi_route_baseline_meta", { rowCount: 1, canonicalSha256: "28c80ffe0c64958ecd77e60b1a78cc74a13f0f3126725f4db6fe6def08b9df2c" }],
  ["unifi_route_drift", { rowCount: 0, canonicalSha256: "dda26626cc48787bd2760e28ce4f316c1317eaa4f764ef387831e637d7e8a16d" }],
  ["unifi_route_drift_history", { rowCount: 2, canonicalSha256: "2a9e3d1ee82055ac0ec577db01578008c726e5aa063f661e7b8ec4e6e83ebf6c" }],
  ["unifi_traffic_flows", { rowCount: 1107802, canonicalSha256: "6d879caa8ca963a8d0a8fd30a15451ebdff4876a6b909bf0fcd7c1d4e6e2f9a7" }],
  ["unifi_wan_samples", { rowCount: 38841, canonicalSha256: "bfa86e75ad75c7bb53bad55df905e7d3f4c7ea7ee8e5e86fdf8da1ab4f918fcd" }],
  ["ups_readings", { rowCount: 1881, canonicalSha256: "96f068550a899c7ba3e22431da3da74b8f6f56fbce57bc56ca4c091084c9d5c1" }]
]);

/** `sqlite_sequence` values the approved source carries for owned tables. */
export const APPROVED_SEQUENCES: ReadonlyMap<string, string> = new Map<string, string>([
  ["agent_logs", "92103"],
  ["mobile_push_attempts", "464"],
  ["network_isp_samples", "2075"],
  ["network_probe_samples", "242165"],
  ["network_snmp_device_samples", "132249"],
  ["network_snmp_interface_events", "108628"],
  ["network_snmp_interface_samples", "439831"],
  ["outage_incident_evidence", "2584"],
  ["power_connections", "70"],
  ["power_diagrams", "2"],
  ["power_items", "36"],
  ["power_zones", "1"],
  ["protect_readings", "20305"],
  ["synology_disk_samples", "52704"],
  ["synology_share_samples", "1573"],
  ["synology_volume_samples", "8109"],
  ["unifi_activity_logs", "41505"],
  ["unifi_client_samples", "754696"],
  ["unifi_device_samples", "153336"],
  ["unifi_port_samples", "28751"],
  ["unifi_readings", "41235"],
  ["unifi_route_drift_history", "12"],
  ["unifi_traffic_flows", "18705321"],
  ["unifi_wan_samples", "38841"],
  ["ups_readings", "1881"]
]);

/** The 54 approved owned table names, ascending. */
export const APPROVED_OWNED_TABLES: readonly string[] = Object.freeze([...APPROVED_TABLES.keys()]);
