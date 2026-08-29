/**
 * Agent-facing re-export of the ingest contract.
 *
 * The canonical definition lives in `lib/monitoring/agentContract.ts` so the
 * server tests and the collectors are provably reading the same table.
 */
export * from "../lib/monitoring/agentContract.js";
