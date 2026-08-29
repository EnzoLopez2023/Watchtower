const minute = 60 * 1000;

export type AgentSource =
  | "unifi"
  | "protect"
  | "ups"
  | "shutdown"
  | "synology"
  | "sonarr"
  | "network_observer";

export interface FreshnessPolicy {
  readonly label: string;
  readonly expectedCadenceMs: number;
  readonly staleAfterMs: number;
  readonly critical?: boolean;
}

// One source of truth for both subsystem freshness and the aggregate Agents
// tile. expectedCadence describes normal healthy behavior; staleAfter leaves
// enough missed cycles to avoid flapping without letting old green data linger.
export const AGENT_FRESHNESS: Readonly<Record<AgentSource, FreshnessPolicy>> = Object.freeze({
  unifi: Object.freeze({
    label: "UniFi Network",
    expectedCadenceMs: 1 * minute,
    staleAfterMs: 5 * minute
  }),
  protect: Object.freeze({
    label: "UniFi Protect",
    expectedCadenceMs: 2 * minute,
    staleAfterMs: 15 * minute
  }),
  ups: Object.freeze({
    label: "UPS",
    expectedCadenceMs: 60 * minute,
    staleAfterMs: 2 * 60 * minute
  }),
  shutdown: Object.freeze({
    label: "UPS shutdown watchdog",
    expectedCadenceMs: 10 * minute,
    staleAfterMs: 30 * minute,
    critical: true
  }),
  synology: Object.freeze({
    label: "Synology",
    expectedCadenceMs: 10 * minute,
    staleAfterMs: 30 * minute
  }),
  sonarr: Object.freeze({
    label: "Sonarr",
    expectedCadenceMs: 2 * minute,
    staleAfterMs: 10 * minute
  }),
  network_observer: Object.freeze({
    label: "Network Observer",
    expectedCadenceMs: 1 * minute,
    staleAfterMs: 5 * minute
  })
});

export const seconds = (milliseconds: number): number => Math.round(milliseconds / 1000);

export interface FreshnessFields {
  readonly lastContactAt: number | null;
  readonly expectedCadenceSeconds: number;
  readonly staleAfterSeconds: number;
}

export function freshnessFields(
  source: AgentSource,
  lastContactAt: number | null | undefined
): FreshnessFields {
  const policy = AGENT_FRESHNESS[source];
  return {
    lastContactAt: lastContactAt ?? null,
    expectedCadenceSeconds: seconds(policy.expectedCadenceMs),
    staleAfterSeconds: seconds(policy.staleAfterMs)
  };
}
