/**
 * Watchtower ownership contract.
 *
 * The authoritative list of owned tables comes from the decomposition manifest
 * supplied on the command line (no hidden production paths). The constants in
 * this module are the fail-closed guard: if the supplied manifest disagrees with
 * the reviewed ownership boundary the import refuses to run instead of silently
 * importing a different set of tables.
 */

import { readFileSync } from "node:fs";
import { ImportError } from "./errors.js";

export const PRODUCT_NAME = "Watchtower";

/** Exactly the 54 tables Watchtower owns in the Hearth monolith. */
export const EXPECTED_OWNED_TABLES: readonly string[] = Object.freeze([
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
]);

export const EXPECTED_OWNED_TABLE_COUNT = 54;

/** Total owned rows in the verified 2026-08-28 production baseline. */
export const EXPECTED_OWNED_ROW_TOTAL = 2_723_313;

/** The 11 Hearth `AppView` ids that move to Watchtower. */
export const OWNED_VIEW_IDS: readonly string[] = Object.freeze([
  "azure-command-center",
  "system-status",
  "observability",
  "power-monitor",
  "power-topology",
  "unifi-network",
  "unifi-topology",
  "unifi-config",
  "synology",
  "ip-migration",
  "protect"
]);

/**
 * API path prefixes served by the Watchtower route modules listed in the
 * manifest (`routes/azure.js`, `ups.js`, `unifi.js`, `unifiLogs.js`,
 * `protect.js`, `ip-plan.js`, `power-topology.js`, `agentLogs.js`,
 * `synology.js`, `mobile.js`, `status.js`, `networkObserver.js`).
 *
 * `/api/admin/logs` is included because it is served by `routes/agentLogs.js`.
 * The rest of `/api/admin` stays with the shared Hearth admin surface.
 */
export const OWNED_API_PATH_PREFIXES: readonly string[] = Object.freeze([
  "/api/agent-logs/",
  "/api/admin/logs",
  "/api/azure/",
  "/api/ip-plan",
  "/api/mobile/",
  "/api/network-observer",
  "/api/observability/",
  "/api/power/",
  "/api/protect",
  "/api/status",
  "/api/synology",
  "/api/unifi",
  "/api/ups"
]);

/** Shared Hearth tables that are transformed rather than copied. */
export const SHARED_SOURCE_TABLES = Object.freeze({
  users: "hearth_users",
  permissions: "hearth_permissions",
  audit: "audit_log",
  index: "hearth_index"
} as const);

/** Tables that must never be copied into an app-local database as authority. */
export const NEVER_COPIED_SHARED_TABLES: readonly string[] = Object.freeze([
  SHARED_SOURCE_TABLES.users,
  SHARED_SOURCE_TABLES.permissions,
  SHARED_SOURCE_TABLES.audit,
  SHARED_SOURCE_TABLES.index
]);

export interface SourceBaselineIdentity {
  readonly repository: string;
  readonly version: string;
  readonly build: number;
  readonly commit: string;
  readonly tree: string;
  readonly imageDigest: string;
  readonly backupBytes: number;
  readonly backupSha256: string;
  readonly backupCreatedUtc: string;
}

export interface OwnershipContract {
  readonly manifestPath: string;
  readonly manifestVersion: number;
  readonly product: string;
  readonly ownedTables: readonly string[];
  readonly ownedViewIds: readonly string[];
  readonly ownedApiPathPrefixes: readonly string[];
  readonly expectedOwnedRowTotal: number;
  readonly sourceBaseline: SourceBaselineIdentity;
  readonly sharedTableDispositions: Readonly<Record<string, string>>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportError("MANIFEST_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImportError("MANIFEST_INVALID", `${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ImportError("MANIFEST_INVALID", `${label}.${key} must be a finite number`);
  }
  return value;
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function setDifference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((value) => !other.has(value));
}

/**
 * Loads the decomposition manifest and asserts the Watchtower ownership
 * boundary matches the reviewed contract in this module.
 */
export function loadOwnershipContract(manifestPath: string): OwnershipContract {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new ImportError("MANIFEST_INVALID", `Cannot read decomposition manifest at ${manifestPath}`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ImportError("MANIFEST_INVALID", `Decomposition manifest at ${manifestPath} is not valid JSON`, {
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }

  const manifest = asRecord(parsed, "manifest");
  const manifestVersion = requiredNumber(manifest, "manifestVersion", "manifest");
  const products = manifest.products;
  if (!Array.isArray(products)) {
    throw new ImportError("MANIFEST_INVALID", "manifest.products must be an array");
  }

  const product = products
    .map((entry) => asRecord(entry, "manifest.products[]"))
    .find((entry) => entry.name === PRODUCT_NAME);
  if (!product) {
    throw new ImportError("MANIFEST_INVALID", `manifest.products does not contain ${PRODUCT_NAME}`);
  }

  const tables = product.tables;
  if (!Array.isArray(tables) || tables.some((table) => typeof table !== "string")) {
    throw new ImportError("MANIFEST_INVALID", `manifest ${PRODUCT_NAME}.tables must be an array of strings`);
  }
  const views = product.views;
  if (!Array.isArray(views) || views.some((view) => typeof view !== "string")) {
    throw new ImportError("MANIFEST_INVALID", `manifest ${PRODUCT_NAME}.views must be an array of strings`);
  }

  const ownedTables = tables as string[];
  const ownedViews = views as string[];

  if (new Set(ownedTables).size !== ownedTables.length) {
    throw new ImportError("MANIFEST_OWNERSHIP_DRIFT", `manifest ${PRODUCT_NAME}.tables contains duplicates`);
  }
  if (ownedTables.length !== EXPECTED_OWNED_TABLE_COUNT) {
    throw new ImportError(
      "MANIFEST_OWNERSHIP_DRIFT",
      `manifest declares ${ownedTables.length} ${PRODUCT_NAME} tables, reviewed contract expects ${EXPECTED_OWNED_TABLE_COUNT}`
    );
  }

  const missing = setDifference(EXPECTED_OWNED_TABLES, ownedTables);
  const unexpected = setDifference(ownedTables, EXPECTED_OWNED_TABLES);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new ImportError("MANIFEST_OWNERSHIP_DRIFT", "manifest table ownership does not match the reviewed contract", {
      missing: sortedCopy(missing),
      unexpected: sortedCopy(unexpected)
    });
  }

  const missingViews = setDifference(OWNED_VIEW_IDS, ownedViews);
  const unexpectedViews = setDifference(ownedViews, OWNED_VIEW_IDS);
  if (missingViews.length > 0 || unexpectedViews.length > 0) {
    throw new ImportError("MANIFEST_OWNERSHIP_DRIFT", "manifest view ownership does not match the reviewed contract", {
      missing: sortedCopy(missingViews),
      unexpected: sortedCopy(unexpectedViews)
    });
  }

  const baselineRecord = asRecord(manifest.sourceBaseline, "manifest.sourceBaseline");
  const databaseRecord = asRecord(baselineRecord.database, "manifest.sourceBaseline.database");

  const sourceBaseline: SourceBaselineIdentity = Object.freeze({
    repository: requiredString(baselineRecord, "repository", "manifest.sourceBaseline"),
    version: requiredString(baselineRecord, "version", "manifest.sourceBaseline"),
    build: requiredNumber(baselineRecord, "build", "manifest.sourceBaseline"),
    commit: requiredString(baselineRecord, "commit", "manifest.sourceBaseline"),
    tree: requiredString(baselineRecord, "tree", "manifest.sourceBaseline"),
    imageDigest: requiredString(baselineRecord, "imageDigest", "manifest.sourceBaseline"),
    backupBytes: requiredNumber(databaseRecord, "backupBytes", "manifest.sourceBaseline.database"),
    backupSha256: requiredString(databaseRecord, "backupSha256", "manifest.sourceBaseline.database"),
    backupCreatedUtc: requiredString(databaseRecord, "backupCreatedUtc", "manifest.sourceBaseline.database")
  });

  const dispositionsRecord = asRecord(manifest.sharedTableDispositions, "manifest.sharedTableDispositions");
  for (const shared of NEVER_COPIED_SHARED_TABLES) {
    if (typeof dispositionsRecord[shared] !== "string") {
      throw new ImportError(
        "MANIFEST_INVALID",
        `manifest.sharedTableDispositions is missing a disposition for ${shared}`
      );
    }
  }

  return Object.freeze({
    manifestPath,
    manifestVersion,
    product: PRODUCT_NAME,
    ownedTables: Object.freeze([...ownedTables]),
    ownedViewIds: Object.freeze([...ownedViews]),
    ownedApiPathPrefixes: OWNED_API_PATH_PREFIXES,
    expectedOwnedRowTotal: EXPECTED_OWNED_ROW_TOTAL,
    sourceBaseline,
    sharedTableDispositions: Object.freeze({ ...dispositionsRecord } as Record<string, string>)
  });
}

/** True when an audit row path belongs to a Watchtower-owned route module. */
export function isOwnedApiPath(path: string | null): boolean {
  if (path === null) return false;
  return OWNED_API_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** True when an audit row view id is one of the 11 Watchtower views. */
export function isOwnedViewId(view: string | null): boolean {
  if (view === null) return false;
  return OWNED_VIEW_IDS.includes(view);
}
