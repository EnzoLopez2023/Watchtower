/**
 * The ingest contract every on-site collector must satisfy.
 *
 * Keeping it as data rather than prose means the server tests can iterate every
 * agent — token isolation, delivery-receipt idempotency, payload bounds — without
 * a hand-maintained list drifting away from the routes.
 */
export type AgentId =
  | "unifi"
  | "unifi-logs"
  | "ups"
  | "protect"
  | "synology"
  | "network-observer"
  | "agent-logs";

export interface AgentIngestContract {
  readonly id: AgentId;
  /** Ingest path, mounted on the service surface before the Entra gate. */
  readonly path: string;
  /**
   * Environment variables holding the accepted shared secret, in precedence
   * order. A later entry is a documented fallback (Protect and the network
   * observer share the UniFi secret because they run on the same trusted host).
   */
  readonly tokenEnv: readonly string[];
  /** Extra headers accepted besides `Authorization: Bearer`. */
  readonly tokenHeaders: readonly string[];
  /** Maximum body accepted by the route's own JSON parser. */
  readonly maxBodyBytes: number;
  /** Cap on the largest repeated array in one push, when the route has one. */
  readonly maxArrayItems?: number;
  /** Truncation applied to individual log messages, when the route has one. */
  readonly maxMessageChars?: number;
  /** True when the route coalesces repeat pushes into a single snapshot row. */
  readonly snapshot: boolean;
}

const FIFTY_MB = 50 * 1024 * 1024;

export const DELIVERY_ID_HEADER = "x-hearth-delivery-id";
export const DELIVERY_ID_BODY_FIELD = "delivery_id";
export const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const DELIVERY_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const AGENT_INGEST_CONTRACTS: readonly AgentIngestContract[] = Object.freeze([
  Object.freeze({
    id: "unifi",
    path: "/api/unifi/ingest",
    tokenEnv: ["UNIFI_INGEST_TOKEN"],
    tokenHeaders: ["x-unifi-token"],
    maxBodyBytes: FIFTY_MB,
    snapshot: true
  }),
  Object.freeze({
    id: "unifi-logs",
    path: "/api/unifi/logs/ingest",
    tokenEnv: ["UNIFI_INGEST_TOKEN"],
    tokenHeaders: [],
    maxBodyBytes: FIFTY_MB,
    maxArrayItems: 5000,
    snapshot: false
  }),
  Object.freeze({
    id: "ups",
    path: "/api/ups/ingest",
    tokenEnv: ["UPS_INGEST_TOKEN"],
    tokenHeaders: ["x-ups-token"],
    maxBodyBytes: FIFTY_MB,
    snapshot: false
  }),
  Object.freeze({
    id: "protect",
    path: "/api/protect/ingest",
    tokenEnv: ["PROTECT_INGEST_TOKEN", "UNIFI_INGEST_TOKEN"],
    tokenHeaders: ["x-protect-token", "x-unifi-token"],
    maxBodyBytes: FIFTY_MB,
    snapshot: true
  }),
  Object.freeze({
    id: "synology",
    path: "/api/synology/ingest",
    tokenEnv: ["SYNOLOGY_INGEST_TOKEN"],
    tokenHeaders: [],
    maxBodyBytes: FIFTY_MB,
    snapshot: true
  }),
  Object.freeze({
    id: "network-observer",
    path: "/api/network-observer/ingest",
    tokenEnv: ["NETWORK_OBSERVER_INGEST_TOKEN", "UNIFI_INGEST_TOKEN"],
    tokenHeaders: [],
    maxBodyBytes: FIFTY_MB,
    snapshot: true
  }),
  Object.freeze({
    id: "agent-logs",
    path: "/api/agent-logs/ingest",
    tokenEnv: [
      "AGENT_LOG_INGEST_TOKEN",
      "UNIFI_INGEST_TOKEN",
      "UPS_INGEST_TOKEN",
      "SYNOLOGY_INGEST_TOKEN",
      "SONARR_INGEST_TOKEN"
    ],
    tokenHeaders: [],
    maxBodyBytes: FIFTY_MB,
    maxArrayItems: 500,
    maxMessageChars: 2000,
    snapshot: false
  })
]);

/** Log-shipping agents and the secret each one presents. */
export const AGENT_LOG_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  unifi: "UNIFI_INGEST_TOKEN",
  ups: "UPS_INGEST_TOKEN",
  // The shutdown watchdog is not a collector, but its lines are the ones you most
  // want afterwards. It shares the UPS secret because it lives on the same
  // trusted host and watches the same hardware.
  shutdown: "UPS_INGEST_TOKEN",
  synology: "SYNOLOGY_INGEST_TOKEN",
  sonarr: "SONARR_INGEST_TOKEN"
});

export function contractFor(id: AgentId): AgentIngestContract {
  const contract = AGENT_INGEST_CONTRACTS.find((candidate) => candidate.id === id);
  if (!contract) throw new Error(`Unknown agent ingest contract: ${id}`);
  return contract;
}
