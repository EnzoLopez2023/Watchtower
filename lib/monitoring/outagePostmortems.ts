import { randomUUID } from "node:crypto";
import { AGENT_FRESHNESS } from "./agentFreshness.js";
import type {
  OutageRepository,
  SyncOutageRepoContext,
  EvidenceRow,
  IncidentRow,
  PersistIncidentInput,
  UpsReadingRow,
  UnifiReadingRow,
  ProbeSampleRow,
} from "../db/repositories/watchtower/outageRepository.js";
import { packJson, unpackJson } from "./payloadCodec.js";
import { asText } from "./values.js";

const DEFAULT_SCOPE = "home";
const DEFAULT_RECOVERY_HOLD_MS = 7 * 60 * 1000;
const EVIDENCE_BATCH_SIZE = 500;
const CONTEXT_LOOKBACK_MS = 5 * 60 * 1000;
const CLOCK_LEEWAY_MS = 5 * 60 * 1000;
const MIN_SOURCE_TIMESTAMP = Date.UTC(2020, 0, 1);
const REPORT_SCHEMA_VERSION = 2;

const CLASSIFICATION_RANK: Record<string, number> = {
  unknown: 0,
  collector_down: 1,
  internet: 2,
  power: 3,
};
const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

type Signal = "power" | "internet" | "collector" | "context";
type State = "outage" | "healthy" | "unknown" | "context";
type Confidence = "low" | "medium" | "high";
type Classification = "power" | "internet" | "collector_down" | "unknown";

export interface EvidenceSignal {
  id?: number;
  evidence_key?: string;
  scope?: string;
  source: string;
  signal: string;
  state: string;
  occurred_at: number;
  confidence: string;
}

export interface IncidentSegment {
  scope: string;
  status: "open" | "recovery_pending" | "finalized";
  classification: Classification;
  confidence: Confidence;
  startedAt: number;
  lastEvidenceAt: number;
  recoveredAt: number | null;
  finalizeAfter: number | null;
  finalizedAt: number | null;
  recoveryReason: string | null;
  classifications: Classification[];
  confidenceByClassification: Record<string, string>;
  evidenceKeys: string[];
}

export interface ClassifyResult {
  classification: Classification;
  confidence: Confidence;
  startedAt: number;
  classifications: Classification[];
  confidenceByClassification: Record<string, string>;
  evidenceByClassification: Record<string, EvidenceSignal[]>;
  evidence: EvidenceSignal[];
}

function observedAt(row: { received_at: number; device_ts?: number | null }): number {
  const receivedAt = Number(row.received_at);
  const deviceAt = Number(row.device_ts);
  if (
    Number.isFinite(deviceAt) &&
    deviceAt >= MIN_SOURCE_TIMESTAMP &&
    deviceAt <= receivedAt + CLOCK_LEEWAY_MS
  ) {
    return Math.round(deviceAt);
  }
  return receivedAt;
}

function hasStatusToken(status: string | null | undefined, token: string): boolean {
  return asText(status)
    .toUpperCase()
    .split(/\s+/)
    .includes(token);
}

function cursorValue(
  sourceState: Record<string, unknown>,
  source: string,
  ctx: SyncOutageRepoContext
): { value: unknown; occurredAt: number; receivedAt: number | null; row?: unknown } {
  const stored = sourceState[source];
  if (
    stored &&
    typeof stored === "object" &&
    Object.hasOwn(stored, "value") &&
    Number.isFinite((stored as { occurredAt?: number }).occurredAt)
  ) {
    return stored as { value: unknown; occurredAt: number; receivedAt: number | null };
  }
  const latest = ctx.latestEvidenceForSource(source);
  const snapshot = {
    value: stored ?? null,
    occurredAt: latest?.occurred_at ?? MIN_SOURCE_TIMESTAMP - 1,
    receivedAt: latest?.received_at ?? null,
  };
  sourceState[source] = snapshot;
  return snapshot;
}

interface EvidenceDefinition {
  keyPrefix: string;
  source: (row: Record<string, unknown>) => string | null;
  signal: (row: Record<string, unknown>) => Signal;
  state: (row: Record<string, unknown>) => State | null;
  confidence: (row: Record<string, unknown>) => Confidence;
  summary: (row: Record<string, unknown>, state: string) => string;
  detail: (row: Record<string, unknown>) => string | null;
  raw: (row: Record<string, unknown>) => unknown;
  refreshAfterMs?: number;
}

function insertDefinedEvidence(
  ctx: SyncOutageRepoContext,
  row: Record<string, unknown>,
  definition: EvidenceDefinition,
  source: string,
  state: string
): number {
  return ctx.insertEvidence({
    evidenceKey: `${definition.keyPrefix}:${row.id as number}`,
    scope: DEFAULT_SCOPE,
    source,
    signal: definition.signal(row),
    state,
    occurredAt: observedAt(row as { received_at: number; device_ts?: number | null }),
    receivedAt: row.received_at as number,
    confidence: definition.confidence(row),
    summary: definition.summary(row, state),
    detail: definition.detail(row),
    raw: packJson(definition.raw(row)),
  });
}

function insertTransitionRows(
  ctx: SyncOutageRepoContext,
  rows: Array<Record<string, unknown>>,
  definition: EvidenceDefinition,
  sourceState: Record<string, unknown>
): number {
  let inserted = 0;
  for (const row of rows) {
    const source = definition.source(row);
    const state = definition.state(row);
    if (!source || !state) continue;
    const occurredAt = observedAt(row as { received_at: number; device_ts?: number | null });
    const current = cursorValue(sourceState, source, ctx);
    const isCurrent = occurredAt >= current.occurredAt;
    const prior = isCurrent
      ? current.value
      : (ctx.precedingEvidenceForSource(source, occurredAt)?.state ?? null);
    const refreshedAfterGap =
      isCurrent &&
      prior === state &&
      definition.refreshAfterMs != null &&
      Number.isFinite(current.receivedAt) &&
      (row.received_at as number) - (current.receivedAt as number) > definition.refreshAfterMs;
    if (isCurrent) {
      sourceState[source] = {
        value: state,
        occurredAt,
        receivedAt: row.received_at as number,
        row,
      };
    }
    if (prior === state && !refreshedAfterGap) continue;
    const changes = insertDefinedEvidence(ctx, row, definition, source, state);
    inserted += changes;
    if (
      changes &&
      !isCurrent &&
      current.row &&
      current.value !== state
    ) {
      inserted += insertDefinedEvidence(ctx, current.row as Record<string, unknown>, definition, source, current.value as string);
    }
  }
  return inserted;
}

function processEvidenceStream(
  repo: OutageRepository,
  stream: string,
  loadRows: (ctx: SyncOutageRepoContext, lastRowId: number, limit: number) => Array<Record<string, unknown>>,
  processRows: (ctx: SyncOutageRepoContext, rows: Array<Record<string, unknown>>, sourceState: Record<string, unknown>) => number,
  now: number
): Promise<{ inserted: number; hasMore: boolean }> {
  return repo.inTransactionWithContext((ctx) => {
    const cursor = ctx.getEvidenceCursor(stream);
    const sourceState: Record<string, unknown> = cursor
      ? (unpackJson<Record<string, unknown>>(cursor.source_state) ?? {})
      : {};
    const rows = loadRows(ctx, cursor?.last_row_id ?? 0, EVIDENCE_BATCH_SIZE);
    const inserted = processRows(ctx, rows, sourceState);
    const lastRowId = (rows[rows.length - 1] as { id?: number } | undefined)?.id ?? cursor?.last_row_id ?? 0;
    if (rows.length || !cursor) {
      ctx.saveEvidenceCursor(stream, lastRowId, packJson(sourceState), now);
    }
    return { inserted, hasMore: rows.length === EVIDENCE_BATCH_SIZE };
  });
}

async function syncUpsEvidence(repo: OutageRepository, now: number): Promise<{ inserted: number; hasMore: boolean }> {
  return processEvidenceStream(
    repo,
    "ups-readings",
    (ctx, lastRowId, limit) => ctx.loadUpsReadings(lastRowId, limit) as unknown as Array<Record<string, unknown>>,
    (ctx, rows, sourceState) =>
      insertTransitionRows(ctx, rows, {
        keyPrefix: "ups",
        source: (row) => `ups:${((row as unknown) as UpsReadingRow).ups_id ?? "tower"}`,
        signal: () => "power",
        state: (row) => {
          const r = (row as unknown) as UpsReadingRow;
          if (hasStatusToken(r.ups_status, "OB")) return "outage";
          if (hasStatusToken(r.ups_status, "OL")) return "healthy";
          return null;
        },
        confidence: () => "high",
        summary: (row, state) => {
          const r = (row as unknown) as UpsReadingRow;
          return `${r.ups_label ?? r.ups_id ?? "UPS"} ${state === "outage" ? "entered battery mode" : "confirmed utility power"}`;
        },
        detail: (row) => {
          const r = (row as unknown) as UpsReadingRow;
          return [
            r.ups_status ? `NUT ${r.ups_status}` : null,
            r.battery_charge == null ? null : `${Math.round(r.battery_charge)}% charge`,
            r.battery_runtime == null ? null : `${Math.round(r.battery_runtime / 60)} min runtime`,
            r.input_voltage == null ? null : `${Math.round(r.input_voltage)} V input`,
          ].filter(Boolean).join(" · ") || null;
        },
        raw: (row) => row,
        refreshAfterMs: AGENT_FRESHNESS.ups.staleAfterMs,
      }, sourceState),
    now
  );
}

async function syncWanEvidence(repo: OutageRepository, now: number): Promise<{ inserted: number; hasMore: boolean }> {
  return processEvidenceStream(
    repo,
    "unifi-readings",
    (ctx, lastRowId, limit) => ctx.loadUnifiReadings(lastRowId, limit) as unknown as Array<Record<string, unknown>>,
    (ctx, rows, sourceState) => {
      let inserted = insertTransitionRows(ctx, rows, {
        keyPrefix: "unifi-wan",
        source: () => "unifi:wan-reachability",
        signal: () => "internet",
        state: (row) => (((row as unknown) as UnifiReadingRow).internet_reachable === 0 ? "outage" : "healthy"),
        confidence: () => "high",
        summary: (_row, state) =>
          state === "outage"
            ? "UniFi reported internet unreachable"
            : "UniFi confirmed internet reachability",
        detail: (row) => {
          const r = (row as unknown) as UnifiReadingRow;
          return [
            r.active_wan_name ?? r.active_wan,
            r.wan_latency_ms == null ? null : `${Math.round(r.wan_latency_ms)} ms`,
          ].filter(Boolean).join(" · ") || null;
        },
        raw: (row) => row,
        refreshAfterMs: AGENT_FRESHNESS.unifi.staleAfterMs,
      }, sourceState);

      for (const row of rows) {
        const r = (row as unknown) as UnifiReadingRow;
        const active = r.active_wan ?? "__none__";
        const source = "unifi:routed-wan";
        const occurredAt = observedAt(r);
        const current = cursorValue(sourceState, source, ctx);
        const isCurrent = occurredAt >= current.occurredAt;
        const preceding = isCurrent
          ? null
          : ctx.precedingEvidenceForSource(source, occurredAt);
        const prior = isCurrent
          ? current.value
          : (unpackJson<{ active_wan?: string }>(preceding?.raw)?.active_wan ?? "__none__");
        if (isCurrent) {
          sourceState[source] = { value: active, occurredAt, receivedAt: r.received_at };
        }
        if (prior === active) continue;
        const changes = ctx.insertEvidence({
          evidenceKey: `unifi-route:${r.id}`,
          scope: DEFAULT_SCOPE,
          source,
          signal: "context",
          state: "context",
          occurredAt,
          receivedAt: r.received_at,
          confidence: "high",
          summary: r.active_wan
            ? `Routed WAN changed to ${r.active_wan_name ?? r.active_wan}`
            : "UniFi reported no routed WAN",
          detail: r.wan_latency_ms == null ? null : `${Math.round(r.wan_latency_ms)} ms`,
          raw: packJson(row),
        });
        inserted += changes;
      }
      return inserted;
    },
    now
  );
}

async function syncProbeEvidence(repo: OutageRepository, now: number): Promise<{ inserted: number; hasMore: boolean }> {
  return processEvidenceStream(
    repo,
    "network-probes",
    (ctx, lastRowId, limit) => ctx.loadProbeSamples(lastRowId, limit) as unknown as Array<Record<string, unknown>>,
    (ctx, rows, sourceState) =>
      insertTransitionRows(ctx, rows, {
        keyPrefix: "observer-probe",
        source: (row) => {
          const r = (row as unknown) as ProbeSampleRow;
          return `observer:${r.observer_id}:${r.kind}:${r.target_id}`;
        },
        signal: (row) => (((row as unknown) as ProbeSampleRow).kind === "http" ? "context" : "internet"),
        state: (row) => (((row as unknown) as ProbeSampleRow).ok === 1 ? "healthy" : "outage"),
        confidence: (row) => (((row as unknown) as ProbeSampleRow).kind === "external" ? "high" : "medium"),
        summary: (row, state) => {
          const r = (row as unknown) as ProbeSampleRow;
          return `${r.target_label ?? r.target_id} ${state === "outage" ? "probe failed" : "probe recovered"}`;
        },
        detail: (row) => {
          const r = (row as unknown) as ProbeSampleRow;
          return [
            r.kind.toUpperCase(),
            r.latency_ms == null ? null : `${Math.round(r.latency_ms)} ms`,
            r.status_code == null ? null : `HTTP ${r.status_code}`,
            r.error,
          ].filter(Boolean).join(" · ") || null;
        },
        raw: (row) => row,
        refreshAfterMs: AGENT_FRESHNESS.network_observer.staleAfterMs,
      }, sourceState),
    now
  );
}

async function syncCollectorState(
  repo: OutageRepository,
  opts: { source: string; label: string; receivedAt: number | null; staleAfterMs: number },
  now: number
): Promise<number> {
  if (!Number.isFinite(opts.receivedAt)) return 0;
  const stale = now - (opts.receivedAt as number) > opts.staleAfterMs;
  const state = stale ? "outage" : "healthy";
  if ((await repo.latestCollectorEvidenceForSource(DEFAULT_SCOPE, opts.source))?.state === state) return 0;
  const occurredAt = stale ? (opts.receivedAt as number) + opts.staleAfterMs : (opts.receivedAt as number);
  return repo.insertEvidence({
    evidenceKey: `collector:${opts.source}:${state}:${opts.receivedAt}`,
    scope: DEFAULT_SCOPE,
    source: opts.source,
    signal: "collector",
    state,
    occurredAt,
    receivedAt: now,
    confidence: "high",
    summary: stale ? `${opts.label} stopped reporting` : `${opts.label} reporting resumed`,
    detail: stale
      ? `No server receipt within ${Math.round(opts.staleAfterMs / 1000)} seconds`
      : "Fresh server receipt",
    raw: packJson({ last_received_at: opts.receivedAt, stale_after_ms: opts.staleAfterMs }),
  });
}

async function syncCollectorEvidence(repo: OutageRepository, now: number): Promise<number> {
  const unifi = await repo.getUnifiLatest();
  const observer = await repo.getNetworkObserverLatest();
  let inserted =
    await syncCollectorState(repo, {
      source: "collector:unifi",
      label: "UniFi collector",
      receivedAt: unifi?.received_at == null ? null : Number(unifi.received_at),
      staleAfterMs: AGENT_FRESHNESS.unifi.staleAfterMs,
    }, now) +
    await syncCollectorState(repo, {
      source: "collector:network-observer",
      label: "Independent network observer",
      receivedAt: observer?.received_at == null ? null : Number(observer.received_at),
      staleAfterMs: AGENT_FRESHNESS.network_observer.staleAfterMs,
    }, now);
  for (const unit of await repo.getUpsUnits()) {
    inserted += await syncCollectorState(repo, {
      source: `collector:ups:${unit.ups_id}`,
      label: `${unit.ups_id} UPS collector`,
      receivedAt: Number(unit.received_at),
      staleAfterMs: AGENT_FRESHNESS.ups.staleAfterMs,
    }, now);
  }
  return inserted;
}

export function classifyOutageSignals(signals: EvidenceSignal[]): ClassifyResult | null {
  const active = signals.filter((s) => s.state === "outage");
  const serviceCandidates: Array<{
    classification: Classification;
    confidence: Confidence;
    evidence: EvidenceSignal[];
    startedAt: number;
  }> = [];

  const power = active.filter((s) => s.signal === "power");
  if (power.length) {
    serviceCandidates.push({
      classification: "power",
      confidence: "high",
      evidence: power,
      startedAt: Math.min(...power.map((s) => s.occurred_at)),
    });
  }

  const wan = active.filter((s) => s.source === "unifi:wan-reachability");
  if (wan.length) {
    serviceCandidates.push({
      classification: "internet",
      confidence: "high",
      evidence: wan,
      startedAt: Math.min(...wan.map((s) => s.occurred_at)),
    });
  } else {
    const external = active.filter(
      (s) => s.signal === "internet" && s.source.includes(":external:")
    );
    const supporting = active.filter(
      (s) => s.signal === "internet" && s.source.includes(":dns:")
    );
    if (external.length >= 2) {
      serviceCandidates.push({
        classification: "internet",
        confidence: "high",
        evidence: external,
        startedAt: Math.min(...external.map((s) => s.occurred_at)),
      });
    } else if (external.length && supporting.length) {
      const ev = [...external, ...supporting];
      serviceCandidates.push({
        classification: "internet",
        confidence: "medium",
        evidence: ev,
        startedAt: Math.min(...ev.map((s) => s.occurred_at)),
      });
    }
  }

  if (serviceCandidates.length) {
    serviceCandidates.sort(
      (a, b) => CLASSIFICATION_RANK[b.classification]! - CLASSIFICATION_RANK[a.classification]!
    );
    const primary = serviceCandidates[0]!;
    return {
      ...primary,
      classifications: serviceCandidates.map((c) => c.classification),
      confidenceByClassification: Object.fromEntries(
        serviceCandidates.map((c) => [c.classification, c.confidence])
      ),
      evidenceByClassification: Object.fromEntries(
        serviceCandidates.map((c) => [c.classification, c.evidence])
      ),
      evidence: serviceCandidates.flatMap((c) => c.evidence),
      startedAt: Math.min(...serviceCandidates.map((c) => c.startedAt)),
    };
  }

  const collectors = active.filter((s) => s.signal === "collector");
  const collectorHealthy = signals.filter((s) => s.signal === "collector" && s.state === "healthy");
  if (collectors.length === 1 && collectorHealthy.length) {
    return {
      classification: "collector_down",
      confidence: "high",
      evidence: collectors,
      startedAt: collectors[0]!.occurred_at,
      classifications: ["collector_down"],
      confidenceByClassification: { collector_down: "high" },
      evidenceByClassification: { collector_down: collectors },
    };
  }
  if (collectors.length) {
    const conf: Confidence = collectors.length > 1 ? "medium" : "low";
    return {
      classification: "unknown",
      confidence: conf,
      evidence: collectors,
      startedAt: Math.min(...collectors.map((s) => s.occurred_at)),
      classifications: ["unknown"],
      confidenceByClassification: { unknown: conf },
      evidenceByClassification: { unknown: collectors },
    };
  }
  return null;
}

function strongerClassification(left: Classification, right: Classification): Classification {
  return CLASSIFICATION_RANK[right]! > CLASSIFICATION_RANK[left]! ? right : left;
}

function strongerConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[right]! > CONFIDENCE_RANK[left]! ? right : left;
}

function collectorForServiceSource(source: string): string | null {
  if (source.startsWith("observer:")) return "collector:network-observer";
  if (source.startsWith("unifi:")) return "collector:unifi";
  if (source.startsWith("ups:")) return `collector:ups:${source.slice(4)}`;
  return null;
}

function applyServiceEvidence(
  state: Map<string, EvidenceSignal>,
  staleCollectors: Map<string, number>,
  suppressed: Map<string, EvidenceSignal>,
  item: EvidenceSignal
): boolean {
  if (item.signal === "collector") {
    if (item.state === "outage") {
      staleCollectors.set(item.source, item.occurred_at);
      for (const source of state.keys()) {
        if (collectorForServiceSource(source) === item.source) state.delete(source);
      }
    } else if (item.state === "healthy") {
      const staleSince = staleCollectors.get(item.source);
      staleCollectors.delete(item.source);
      for (const [source, latest] of suppressed) {
        if (
          collectorForServiceSource(source) === item.source &&
          latest.occurred_at >= (staleSince ?? 0)
        ) {
          state.set(source, latest);
          suppressed.delete(source);
        }
      }
    }
    return true;
  }
  const collector = collectorForServiceSource(item.source);
  if (collector && staleCollectors.has(collector)) {
    suppressed.set(item.source, item);
    return true;
  }
  state.set(item.source, item);
  return false;
}

function buildLaneSegments(
  evidence: EvidenceSignal[],
  now: number,
  recoveryHoldMs: number,
  scopeFor: (scope: string) => string,
  serviceLane = false
): IncidentSegment[] {
  const ordered = [...evidence].sort(
    (a, b) => a.occurred_at - b.occurred_at || (a.id ?? 0) - (b.id ?? 0)
  );
  const state = new Map<string, EvidenceSignal>();
  const staleCollectors = new Map<string, number>();
  const suppressed = new Map<string, EvidenceSignal>();
  const segments: Array<IncidentSegment & { classificationsSet: Set<Classification>; confByClassMap: Map<string, Confidence> }> = [];
  let current: (IncidentSegment & { classificationsSet: Set<Classification>; confByClassMap: Map<string, Confidence> }) | null = null;

  const closeCurrent = (finalizedAt: number): void => {
    if (!current) return;
    current.status = "finalized";
    current.finalizedAt = finalizedAt;
    current.classifications = [...current.classificationsSet].sort(
      (a, b) => CLASSIFICATION_RANK[b]! - CLASSIFICATION_RANK[a]!
    );
    current.confidenceByClassification = Object.fromEntries(current.confByClassMap);
    segments.push(current);
    current = null;
  };

  for (const item of ordered) {
    if (current?.recoveredAt != null && item.occurred_at >= (current.finalizeAfter ?? Infinity)) {
      closeCurrent(current.finalizeAfter!);
    }

    let controlOnly = false;
    if (serviceLane) {
      controlOnly = applyServiceEvidence(state, staleCollectors, suppressed, item);
    } else {
      state.set(item.source, item);
    }

    const assessment = classifyOutageSignals([...state.values()]);
    if (assessment) {
      if (!current) {
        const contextual = [...state.values()].filter(
          (s) => s.signal === "context" && s.occurred_at >= assessment.startedAt - CONTEXT_LOOKBACK_MS
        );
        const supporting = [...state.values()].filter(
          (s) =>
            s.state === "outage" &&
            s.signal !== "collector" &&
            s.occurred_at >= assessment.startedAt - CONTEXT_LOOKBACK_MS
        );
        current = {
          scope: scopeFor(("scope" in item ? (item as unknown as EvidenceRow).scope : null) ?? DEFAULT_SCOPE),
          status: "open",
          classification: assessment.classification,
          confidence: assessment.confidence,
          startedAt: assessment.startedAt,
          lastEvidenceAt: item.occurred_at,
          recoveredAt: null,
          finalizeAfter: null,
          finalizedAt: null,
          recoveryReason: null,
          classifications: [],
          confidenceByClassification: {},
          evidenceKeys: [
            ...new Set([
              ...assessment.evidence,
              ...contextual,
              ...supporting,
            ].map((e) => e.evidence_key).filter((k): k is string => k != null)),
          ],
          classificationsSet: new Set([assessment.classification]),
          confByClassMap: new Map([[assessment.classification, assessment.confidence]]),
        };
      } else if (current.recoveredAt != null) {
        current.recoveredAt = null;
        current.finalizeAfter = null;
        current.status = "open";
        current.recoveryReason = null;
      }
      current.startedAt = Math.min(current.startedAt, assessment.startedAt);
      if (!controlOnly) {
        current.lastEvidenceAt = Math.max(current.lastEvidenceAt, item.occurred_at);
      }
      for (const cls of assessment.classifications) {
        current.classificationsSet.add(cls);
        current.confByClassMap.set(
          cls,
          strongerConfidence(
            current.confByClassMap.get(cls) ?? "low",
            assessment.confidenceByClassification[cls] as Confidence ?? "low"
          )
        );
      }
      current.classification = strongerClassification(
        current.classification,
        assessment.classification
      );
      current.confidence = current.confByClassMap.get(current.classification) ?? "low";
      if (
        !controlOnly &&
        item.evidence_key != null &&
        !current.evidenceKeys.includes(item.evidence_key)
      ) {
        current.evidenceKeys.push(item.evidence_key);
      }
    } else if (current) {
      current.lastEvidenceAt = Math.max(current.lastEvidenceAt, item.occurred_at);
      if (!controlOnly && item.evidence_key != null) {
        current.evidenceKeys.push(item.evidence_key);
      }
      if (current.recoveredAt == null) {
        current.recoveredAt = item.occurred_at;
        current.finalizeAfter = item.occurred_at + recoveryHoldMs;
        current.status = "recovery_pending";
        current.recoveryReason =
          controlOnly && item.signal === "collector" && item.state === "outage"
            ? "stale_evidence_invalidated"
            : "healthy_transition";
      }
    }
  }

  if (current) {
    if (current.recoveredAt != null && now >= (current.finalizeAfter ?? Infinity)) {
      closeCurrent(current.finalizeAfter!);
    } else {
      current.classifications = [...current.classificationsSet].sort(
        (a, b) => CLASSIFICATION_RANK[b]! - CLASSIFICATION_RANK[a]!
      );
      current.confidenceByClassification = Object.fromEntries(current.confByClassMap);
      segments.push(current);
    }
  }

  return segments.map((seg) => ({
    scope: seg.scope,
    status: seg.status,
    classification: seg.classification,
    confidence: seg.confidence,
    startedAt: seg.startedAt,
    lastEvidenceAt: seg.lastEvidenceAt,
    recoveredAt: seg.recoveredAt,
    finalizeAfter: seg.finalizeAfter,
    finalizedAt: seg.finalizedAt,
    recoveryReason: seg.recoveryReason,
    classifications: seg.classifications,
    confidenceByClassification: seg.confidenceByClassification,
    evidenceKeys: seg.evidenceKeys,
  }));
}

export function buildIncidentSegments(
  evidence: EvidenceSignal[],
  now: number,
  recoveryHoldMs = DEFAULT_RECOVERY_HOLD_MS
): IncidentSegment[] {
  const service = buildLaneSegments(evidence, now, recoveryHoldMs, (scope) => scope, true);
  const collector = buildLaneSegments(
    evidence.filter((item) => item.signal === "collector"),
    now,
    recoveryHoldMs,
    (scope) => `${scope}:collectors`
  );
  return [...service, ...collector].sort((a, b) => a.startedAt - b.startedAt);
}

function parseClassifications(value: string | null | undefined): Classification[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? (parsed as Classification[]) : [];
  } catch {
    return [];
  }
}

function qualifyingSources(
  evidence: EvidenceRow[],
  classification: Classification
): Set<string> {
  const state = new Map<string, EvidenceSignal>();
  const staleCollectors = new Map<string, number>();
  const suppressed = new Map<string, EvidenceSignal>();
  const sources = new Set<string>();
  const serviceClassification = classification === "power" || classification === "internet";
  for (const item of [...evidence].sort(
    (a, b) => a.occurred_at - b.occurred_at || a.id - b.id
  )) {
    if (serviceClassification) {
      applyServiceEvidence(state, staleCollectors, suppressed, item);
    } else {
      state.set(item.source, item);
    }
    const assessment = classifyOutageSignals([...state.values()]);
    for (const causal of assessment?.evidenceByClassification?.[classification] ?? []) {
      sources.add(causal.source);
    }
  }
  return sources;
}

function signalRecoveryAt(
  evidence: EvidenceRow[],
  signal: string,
  sources: Set<string> | null
): number | null {
  const affected = new Map<string, { outageAt: number; recoveryAt: number | null }>();
  for (const item of evidence.filter(
    (r) => r.signal === signal && (!sources || sources.has(r.source))
  )) {
    if (item.state === "outage") {
      affected.set(item.source, { outageAt: item.occurred_at, recoveryAt: null });
    } else if (item.state === "healthy" && affected.has(item.source)) {
      const cur = affected.get(item.source)!;
      if (item.occurred_at >= cur.outageAt) cur.recoveryAt = item.occurred_at;
    }
  }
  if (!affected.size || [...affected.values()].some((v) => v.recoveryAt == null)) return null;
  return Math.max(...[...affected.values()].map((v) => v.recoveryAt!));
}

function sourceLabels(evidence: EvidenceRow[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.state === "outage" && item.signal !== "context")
        .map((item) => {
          if (item.signal === "power") return "UPS power telemetry";
          if (item.source === "unifi:wan-reachability") return "UniFi WAN reachability";
          if (item.source.includes(":external:")) return "independent external probes";
          if (item.source.includes(":dns:")) return "independent DNS probes";
          if (item.source.includes(":http:")) return "independent HTTP probes";
          if (item.signal === "collector") return "collector receipt-time monitoring";
          return item.source;
        })
    ),
  ];
}

function reportCause(
  classification: Classification,
  evidence: EvidenceRow[],
  causalInternetSources: Set<string>
): string {
  if (classification === "power") {
    return "UPS telemetry confirms loss of utility input. Retained evidence does not identify the upstream utility cause.";
  }
  if (classification === "internet") {
    const wan = evidence.some(
      (item) => item.state === "outage" && item.source === "unifi:wan-reachability"
    );
    const independent = evidence.some(
      (item) =>
        item.state === "outage" &&
        causalInternetSources.has(item.source) &&
        (item.source.includes(":external:") || item.source.includes(":dns:"))
    );
    const basis =
      wan && independent
        ? "UniFi WAN reachability and independent probes confirm loss of internet reachability."
        : independent
          ? "Independent probes confirm loss of internet reachability."
          : wan
            ? "UniFi WAN reachability confirms loss of internet reachability."
            : "Retained network telemetry confirms loss of internet reachability.";
    return `${basis} Retained evidence does not identify the provider-side physical cause.`;
  }
  if (classification === "collector_down") {
    return "One collector stopped reporting while an independent witness remained healthy.";
  }
  return "Telemetry loss was recorded, but retained evidence does not prove a more specific service cause.";
}

export function buildPostmortemReport(
  incident: IncidentRow & { transitionedToFinal?: boolean },
  evidence: EvidenceRow[],
  recoveryHoldMs = DEFAULT_RECOVERY_HOLD_MS
): Record<string, unknown> {
  const classifications = parseClassifications(incident.classifications);
  const recoveredAt = incident.recovered_at;
  const durationMs =
    recoveredAt == null ? null : Math.max(0, recoveredAt - incident.started_at);
  const causalPowerSources = qualifyingSources(evidence, "power");
  const causalInternetSources = qualifyingSources(evidence, "internet");
  const causalSources = new Set(
    [...new Set([...classifications, incident.classification as Classification])]
      .flatMap((cls) => [...qualifyingSources(evidence, cls)])
  );
  const powerRestoredAt = signalRecoveryAt(evidence, "power", causalPowerSources);
  const internetRestoredAt = signalRecoveryAt(evidence, "internet", causalInternetSources);
  const sources = sourceLabels(evidence);
  const classificationSources = sourceLabels(
    evidence.filter((item) => causalSources.has(item.source))
  );
  const includesPower = classifications.includes("power");
  const includesInternet = classifications.includes("internet");
  const directServiceRecovery =
    (!includesPower || powerRestoredAt != null) &&
    (!includesInternet || internetRestoredAt != null);
  const staleEvidenceInvalidated = incident.recovery_reason === "stale_evidence_invalidated";
  const qualifiedRecoverySummary = staleEvidenceInvalidated
    ? "Active outage evidence cleared after stale collector evidence was invalidated; direct recovery was not observed for every causal source."
    : "A healthy source transition reduced evidence below the outage threshold; direct recovery was not observed for every causal source.";
  const executiveSummary = [
    includesPower && includesInternet
      ? "A power interruption and an internet interruption occurred within one compound incident."
      : includesPower
        ? "A power interruption affected the home infrastructure."
        : includesInternet
          ? "An internet interruption affected external connectivity."
          : incident.classification === "collector_down"
            ? "A telemetry collector stopped reporting while independent evidence remained healthy."
            : "Monitoring recorded an outage that could not be classified more specifically.",
    recoveredAt == null
      ? "The incident remains open."
      : directServiceRecovery
        ? `Service recovered and remained stable for ${Math.round(recoveryHoldMs / 60000)} minutes before this report was finalized.`
        : `${qualifiedRecoverySummary} The resulting state remained stable for ${Math.round(recoveryHoldMs / 60000)} minutes before finalization.`,
    classificationSources.length
      ? `Classification is based on ${classificationSources.join(", ")}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const contributing = classifications
    .filter((cls) => cls !== (incident.classification as Classification))
    .map((cls) => ({
      classification: cls,
      summary:
        cls === "internet"
          ? "Internet reachability was impaired during the same incident."
          : cls === "collector_down"
            ? "A collector reporting gap occurred during the incident."
            : "Additional outage evidence was observed during the incident.",
    }));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    incidentId: incident.id,
    scope: incident.scope,
    executiveSummary,
    classification: incident.classification,
    confidence: incident.confidence,
    classifications,
    impact: {
      summary:
        includesPower && includesInternet
          ? "Utility-powered infrastructure transferred to battery protection and external connectivity was unavailable."
          : includesPower
            ? "Utility-powered infrastructure transferred to battery protection."
            : includesInternet
              ? "External connectivity was unavailable."
              : incident.classification === "collector_down"
                ? "Monitoring visibility was reduced; independent service evidence did not prove a service outage."
                : "The affected service scope could not be established from retained evidence.",
      scope: incident.scope,
    },
    timing: {
      startedAt: incident.started_at,
      powerRestoredAt,
      internetRestoredAt,
      recoveredAt,
      stableAt:
        incident.finalize_after ??
        (recoveredAt == null ? null : recoveredAt + recoveryHoldMs),
      durationMs,
      recoveryHoldMs,
    },
    timeline: evidence.map((item) => ({
      at: item.occurred_at,
      receivedAt: item.received_at,
      source: item.source,
      signal: item.signal,
      state: item.state,
      confidence: item.confidence,
      summary: item.summary,
      detail: item.detail,
    })),
    detection: {
      summary: classificationSources.length
        ? `Detected and classified from ${classificationSources.join(", ")}.`
        : "Detected from retained monitoring transitions.",
      notificationOutcome:
        "Alert delivery is not automatically attributed to incident evidence; no delivery claim is made.",
    },
    cause: {
      rootCause: reportCause(incident.classification as Classification, evidence, causalInternetSources),
      contributingFactors: contributing,
    },
    recovery: {
      summary:
        recoveredAt == null
          ? "Recovery has not been confirmed."
          : directServiceRecovery
            ? "Recovery was confirmed by healthy source transitions and the stable-recovery hold completed without regression."
            : qualifiedRecoverySummary,
    },
    whatWorked: sources.map((src) => `${src} provided retained, timestamped evidence.`),
    whatFailed:
      incident.classification === "collector_down"
        ? ["A collector exceeded its receipt-time freshness threshold."]
        : ["No monitoring component failure was proven by the incident evidence."],
    correctiveActions: [
      {
        priority: "P1",
        owner: "Infrastructure",
        action:
          "Review provider and equipment records for the incident window to identify the physical cause not present in Hearth telemetry.",
      },
      {
        priority: "P2",
        owner: "Hearth",
        action:
          "Link push-delivery audit rows to incident identifiers so future reports can state notification outcomes directly.",
      },
    ],
    dataGaps: [
      "Monitoring establishes observed service state, not the upstream utility or ISP physical cause.",
      "Push-delivery audit rows are not yet causally linked to incident identifiers.",
      ...(!directServiceRecovery && recoveredAt != null
        ? [
            staleEvidenceInvalidated
              ? "Direct recovery was not observed for every causal source; collector freshness limited the retained recovery evidence."
              : "Direct recovery was not observed for every causal source; corroboration fell below the outage threshold after a healthy transition.",
          ]
        : []),
    ],
    methodology: {
      deterministic: true,
      generatedAt: incident.finalized_at ?? incident.finalize_after ?? recoveredAt,
      sources,
      note: "Source-observed timestamps are used when plausible; server receipt time remains preserved for provenance and freshness.",
    },
  };
}

function outageRecoveryHoldMs(): number {
  const value = Number(process.env["OUTAGE_RECOVERY_HOLD_SECONDS"]);
  if (Number.isSafeInteger(value) && value >= 60 && value <= 60 * 60) return value * 1000;
  return DEFAULT_RECOVERY_HOLD_MS;
}

function reconcileIncidentReports(
  ctx: SyncOutageRepoContext,
  canonicalId: string,
  incidents: IncidentRow[]
): void {
  if (incidents.length < 2) return;
  const reports = incidents
    .map((inc) => ctx.getPostmortemByIncident(inc.id))
    .filter((r): r is NonNullable<ReturnType<typeof ctx.getPostmortemByIncident>> => r != null)
    .sort(
      (a, b) =>
        a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
    );
  if (!reports.length) return;

  const canonicalReport = reports.find((r) => r.incident_id === canonicalId);
  const retained = canonicalReport ?? reports[0]!;
  if (retained.incident_id !== canonicalId) {
    ctx.reassignReport(retained.id, canonicalId);
  }
  const stagedAts = reports
    .map((r) => r.notification_staged_at)
    .filter((v): v is number => v != null);
  const stagedAt = stagedAts.length ? Math.min(...stagedAts) : null;
  ctx.reconcileReportCreatedAt(retained.id, reports[0]!.created_at, stagedAt);
}

function persistSegment(
  ctx: SyncOutageRepoContext,
  segment: IncidentSegment,
  now: number
): IncidentRow & { transitionedToFinal: boolean } {
  const mutable =
    segment.status === "finalized"
      ? null
      : ctx.getOpenIncident(segment.scope);
  const candidatesById = new Map(
    ctx.incidentOverlaps(
      segment.scope,
      segment.finalizeAfter ?? segment.lastEvidenceAt,
      segment.startedAt
    ).map((inc) => [inc.id, inc])
  );
  if (mutable) candidatesById.set(mutable.id, mutable);
  const candidates = [...candidatesById.values()].sort(
    (a, b) => a.started_at - b.started_at || a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
  );
  const existing = candidates[0];
  const id = existing?.id ?? randomUUID();
  const classifications = [...segment.classifications];
  const classification = segment.classification;
  const confidence = segment.confidence;

  const existingHoldMs =
    existing?.recovered_at != null && existing?.finalize_after != null
      ? existing.finalize_after - existing.recovered_at
      : null;
  const finalizedRecoveryChanged =
    existing?.status === "finalized" && existing.recovered_at !== segment.recoveredAt;
  const preserveFinal = existing?.status === "finalized" && !finalizedRecoveryChanged;

  let recoveredAt = preserveFinal ? existing.recovered_at : segment.recoveredAt;
  let finalizeAfter = preserveFinal ? existing.finalize_after : segment.finalizeAfter;
  let finalizedAt = preserveFinal ? existing.finalized_at : segment.finalizedAt;
  let recoveryReason: string | null = preserveFinal
    ? existing.recovery_reason ?? segment.recoveryReason
    : segment.recoveryReason;
  let status = preserveFinal ? ("finalized" as const) : segment.status;

  if (finalizedRecoveryChanged) {
    recoveredAt = segment.recoveredAt;
    finalizeAfter =
      recoveredAt == null
        ? null
        : recoveredAt + (existingHoldMs ?? outageRecoveryHoldMs());
    status =
      recoveredAt == null
        ? "open"
        : now >= (finalizeAfter ?? Infinity)
          ? "finalized"
          : "recovery_pending";
    finalizedAt = status === "finalized" ? finalizeAfter : null;
    recoveryReason = segment.recoveryReason;
  }

  if (
    existing &&
    existing.status === "recovery_pending" &&
    segment.recoveredAt != null &&
    existing.recovered_at === segment.recoveredAt &&
    existing.finalize_after != null
  ) {
    recoveredAt = existing.recovered_at;
    finalizeAfter = existing.finalize_after;
    status =
      now >= finalizeAfter ? "finalized" : "recovery_pending";
    finalizedAt = status === "finalized" ? finalizeAfter : null;
    recoveryReason = existing.recovery_reason ?? segment.recoveryReason;
  }

  if (recoveredAt == null) recoveryReason = null;

  const record: PersistIncidentInput = {
    id,
    scope: segment.scope,
    status,
    classification,
    confidence,
    startedAt: Math.min(existing?.started_at ?? segment.startedAt, segment.startedAt),
    lastEvidenceAt: Math.max(
      existing?.last_evidence_at ?? segment.lastEvidenceAt,
      segment.lastEvidenceAt
    ),
    recoveredAt,
    finalizeAfter,
    finalizedAt,
    recoveryReason,
    classifications: JSON.stringify(classifications),
    createdAt: candidates.length
      ? Math.min(...candidates.map((inc) => inc.created_at))
      : now,
    updatedAt: now,
  };

  const changed =
    !existing ||
    existing.status !== record.status ||
    existing.classification !== record.classification ||
    existing.confidence !== record.confidence ||
    existing.started_at !== record.startedAt ||
    existing.last_evidence_at !== record.lastEvidenceAt ||
    existing.recovered_at !== record.recoveredAt ||
    existing.finalize_after !== record.finalizeAfter ||
    existing.finalized_at !== record.finalizedAt ||
    existing.recovery_reason !== record.recoveryReason ||
    existing.classifications !== record.classifications;

  if (!existing) {
    ctx.insertIncident(record);
  } else {
    reconcileIncidentReports(ctx, id, candidates);
    for (const absorbed of candidates.slice(1)) {
      ctx.relinkIncidentEvidence(id, absorbed.id);
      ctx.cancelPendingReadyNotification(`postmortem:${absorbed.id}`);
      ctx.deleteIncident(absorbed.id);
    }
    if (changed) ctx.updateIncident(record);
  }

  for (const evidenceKey of segment.evidenceKeys) {
    ctx.linkEvidence(id, evidenceKey);
  }

  const saved = ctx.getIncidentById(id);
  return {
    ...(saved as IncidentRow),
    transitionedToFinal:
      candidates.length > 0 &&
      candidates.some((inc) => inc.status !== "finalized") &&
      record.status === "finalized",
  };
}

function finalizeReport(
  ctx: SyncOutageRepoContext,
  incident: IncidentRow & { transitionedToFinal?: boolean },
  now: number
): string {
  const evidence = ctx.getEvidenceForIncident(incident.id);
  const persistedHoldMs =
    incident.recovered_at != null && incident.finalize_after != null
      ? incident.finalize_after - incident.recovered_at
      : outageRecoveryHoldMs();
  const report = buildPostmortemReport(incident, evidence, persistedHoldMs);
  const existing = ctx.getPostmortemByIncident(incident.id);
  const reportId = existing?.id ?? randomUUID();
  const existingReport = existing?.report
    ? unpackJson(existing.report)
    : null;
  if (!existingReport || JSON.stringify(existingReport) !== JSON.stringify(report)) {
    ctx.upsertReport({
      id: reportId,
      incidentId: incident.id,
      schemaVersion: REPORT_SCHEMA_VERSION,
      createdAt: existing?.created_at ?? incident.finalized_at ?? now,
      updatedAt: now,
      executiveSummary: report.executiveSummary as string,
      report: packJson(report),
    });
  }
  if (existing?.notification_staged_at == null) {
    const ENGINE_INTERVAL_MS = 30 * 1000;
    const justFinalized =
      incident.finalized_at != null &&
      now >= incident.finalized_at &&
      now - incident.finalized_at <= ENGINE_INTERVAL_MS * 2;
    const finalizedAfterTrackingBegan =
      incident.transitionedToFinal === true &&
      incident.finalized_at != null &&
      incident.finalized_at >= incident.created_at;
    if (finalizedAfterTrackingBegan && (incident.transitionedToFinal || justFinalized)) {
      ctx.stageReadyNotification({
        id: `postmortem:${incident.id}`,
        firedAt: now,
        title: "Outage post-mortem ready",
        body: (report.executiveSummary as string).slice(0, 500),
        lastSeen: now,
        deliveryKey: randomUUID(),
      });
    }
    ctx.markNotificationStaged(now, incident.id);
  }
  return reportId;
}

async function persistSegments(
  repo: OutageRepository,
  segments: IncidentSegment[],
  now: number,
  reconcileMissing: boolean
): Promise<Array<IncidentRow & { transitionedToFinal: boolean }>> {
  return repo.inTransactionWithContext((ctx) => {
    if (reconcileMissing) {
      ctx.unlinkCanonicalEvidence(DEFAULT_SCOPE, `${DEFAULT_SCOPE}:collectors`);
    }
    const incidents: Array<IncidentRow & { transitionedToFinal: boolean }> = [];
    for (const segment of segments) {
      const incident = persistSegment(ctx, segment, now);
      if (incident.status === "finalized") finalizeReport(ctx, incident, now);
      incidents.push(incident);
    }
    if (reconcileMissing) {
      const retained = new Set(incidents.map((inc) => inc.id));
      const obsolete = ctx
        .getAllIncidentsForScopes([DEFAULT_SCOPE, `${DEFAULT_SCOPE}:collectors`])
        .filter((inc) => !retained.has(inc.id));
      for (const inc of obsolete) {
        ctx.unlinkIncidentEvidence(inc.id);
        ctx.cancelPendingReadyNotification(`postmortem:${inc.id}`);
        ctx.deleteIncident(inc.id);
      }
    }
    return incidents;
  });
}

let cycleRunning = false;

export interface CycleResult {
  skipped?: boolean;
  reason?: string;
  evidenceInserted?: number;
  evidenceBacklog?: boolean;
  segments?: number;
  incidents?: number;
}

export async function runOutagePostmortemCycle(repo: OutageRepository, now = Date.now()): Promise<CycleResult> {
  if (cycleRunning) return { skipped: true, reason: "already-running" };
  cycleRunning = true;
  try {
    const upsResult = await syncUpsEvidence(repo, now);
    const wanResult = await syncWanEvidence(repo, now);
    const probeResult = await syncProbeEvidence(repo, now);
    const streamResults = [upsResult, wanResult, probeResult];
    const evidenceInserted =
      streamResults.reduce((sum, r) => sum + r.inserted, 0) +
      await syncCollectorEvidence(repo, now);
    const evidence = await repo.getAllScopeEvidence(DEFAULT_SCOPE);
    const segments = buildIncidentSegments(evidence, now, outageRecoveryHoldMs());
    const evidenceBacklog = streamResults.some((r) => r.hasMore);
    const incidents = await persistSegments(repo, segments, now, !evidenceBacklog);
    return {
      skipped: false,
      evidenceInserted,
      evidenceBacklog,
      segments: segments.length,
      incidents: incidents.length,
    };
  } finally {
    cycleRunning = false;
  }
}

function deserializeIncident(
  row: IncidentRow & { report_id?: string | null; executive_summary?: string | null; report?: unknown },
  now = Date.now()
): Record<string, unknown> {
  const report =
    row.status === "finalized" && row.report
      ? unpackJson(row.report as Buffer | string)
      : null;
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    classification: row.classification,
    confidence: row.confidence,
    startedAt: row.started_at,
    lastEvidenceAt: row.last_evidence_at,
    recoveredAt: row.recovered_at,
    finalizeAfter: row.finalize_after,
    finalizedAt: row.finalized_at,
    recoveryReason: row.recovery_reason,
    classifications: parseClassifications(row.classifications),
    pendingSeconds:
      row.status === "recovery_pending" && row.finalize_after != null
        ? Math.max(0, Math.ceil((row.finalize_after - now) / 1000))
        : null,
    reportId: row.status === "finalized" ? (row.report_id ?? null) : null,
    executiveSummary: row.status === "finalized" ? (row.executive_summary ?? null) : null,
    report,
  };
}

export async function listOutageIncidents(
  repo: OutageRepository,
  limit = 25,
  now = Date.now()
): Promise<Record<string, unknown>[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return (await repo.listIncidents(safeLimit)).map((row) => deserializeIncident(row, now));
}

export async function getOutageIncident(
  repo: OutageRepository,
  id: string,
  now = Date.now()
): Promise<Record<string, unknown> | null> {
  const row = await repo.getIncidentById(id);
  if (!row) return null;
  const evidence = await repo.getEvidenceForIncident(id);
  return {
    ...deserializeIncident(row, now),
    evidence: evidence.map((item) => ({
      evidenceKey: item.evidence_key,
      source: item.source,
      signal: item.signal,
      state: item.state,
      occurredAt: item.occurred_at,
      receivedAt: item.received_at,
      confidence: item.confidence,
      summary: item.summary,
      detail: item.detail,
    })),
  };
}
