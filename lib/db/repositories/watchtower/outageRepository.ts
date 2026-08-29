import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";

// ── Async repository interface (consumed by domain and workers) ────────────

export interface OutageRepository {
  insertEvidence(input: InsertEvidenceInput): Promise<number>;
  latestEvidenceForSource(source: string): Promise<LatestEvidence | undefined>;
  precedingEvidenceForSource(source: string, beforeOccurredAt: number): Promise<PrecedingEvidence | undefined>;
  latestCollectorEvidenceForSource(scope: string, source: string): Promise<{ state: string } | undefined>;
  getAllScopeEvidence(scope: string): Promise<EvidenceRow[]>;
  getEvidenceForIncident(incidentId: string): Promise<EvidenceRow[]>;
  linkEvidence(incidentId: string, evidenceKey: string): Promise<void>;
  relinkIncidentEvidence(newIncidentId: string, oldIncidentId: string): Promise<void>;
  unlinkIncidentEvidence(incidentId: string): Promise<void>;
  unlinkCanonicalEvidence(scope: string, collectorsScope: string): Promise<void>;
  getEvidenceCursor(stream: string): Promise<EvidenceCursor | undefined>;
  saveEvidenceCursor(stream: string, lastRowId: number, sourceState: Buffer, updatedAt: number): Promise<void>;
  insertIncident(input: PersistIncidentInput): Promise<void>;
  updateIncident(input: PersistIncidentInput): Promise<void>;
  deleteIncident(id: string): Promise<void>;
  getIncidentById(id: string): Promise<(IncidentRow & { report_id?: string; executive_summary?: string; report?: Buffer | string | null }) | undefined>;
  getOpenIncident(scope: string): Promise<IncidentRow | undefined>;
  incidentOverlaps(scope: string, finalizeAfterOrLastAt: number, startedAt: number): Promise<IncidentRow[]>;
  getAllIncidentsForScopes(scopes: readonly string[]): Promise<IncidentRow[]>;
  listIncidents(limit: number): Promise<Array<IncidentRow & { report_id: string | null; executive_summary: string | null }>>;
  upsertReport(input: {
    id: string; incidentId: string; schemaVersion: number;
    createdAt: number; updatedAt: number; executiveSummary: string; report: Buffer;
  }): Promise<void>;
  getPostmortemByIncident(incidentId: string): Promise<PostmortemRow | undefined>;
  markNotificationStaged(now: number, incidentId: string): Promise<void>;
  reconcileReportCreatedAt(reportId: string, createdAt: number, stagedAt: number | null): Promise<void>;
  reassignReport(reportId: string, incidentId: string): Promise<void>;
  stageReadyNotification(input: {
    id: string; firedAt: number; title: string; body: string; lastSeen: number; deliveryKey: string;
  }): Promise<void>;
  cancelPendingReadyNotification(id: string): Promise<void>;
  loadUpsReadings(lastRowId: number, limit: number): Promise<UpsReadingRow[]>;
  loadUnifiReadings(lastRowId: number, limit: number): Promise<UnifiReadingRow[]>;
  loadProbeSamples(lastRowId: number, limit: number): Promise<ProbeSampleRow[]>;
  getUnifiLatest(): Promise<CollectorFreshnessRow | undefined>;
  getNetworkObserverLatest(): Promise<CollectorFreshnessRow | undefined>;
  getUpsUnits(): Promise<UpsUnitRow[]>;
  /**
   * Runs `work` inside a single SQLite transaction. `work` must be
   * synchronous; pass a `SyncOutageRepoContext` so inner helpers can call SQL
   * without surfacing a Promise inside the transaction.
   */
  inTransactionWithContext<T>(work: (ctx: SyncOutageRepoContext) => T): Promise<T>;
}

/**
 * Synchronous view of the repository, valid only inside a `inTransactionWithContext`
 * callback. Provides the same operations as `OutageRepository` but without Promises,
 * because better-sqlite3 transactions cannot contain async calls.
 */
export interface SyncOutageRepoContext {
  insertEvidence(input: InsertEvidenceInput): number;
  latestEvidenceForSource(source: string): LatestEvidence | undefined;
  precedingEvidenceForSource(source: string, beforeOccurredAt: number): PrecedingEvidence | undefined;
  latestCollectorEvidenceForSource(scope: string, source: string): { state: string } | undefined;
  getAllScopeEvidence(scope: string): EvidenceRow[];
  getEvidenceForIncident(incidentId: string): EvidenceRow[];
  linkEvidence(incidentId: string, evidenceKey: string): void;
  relinkIncidentEvidence(newIncidentId: string, oldIncidentId: string): void;
  unlinkIncidentEvidence(incidentId: string): void;
  unlinkCanonicalEvidence(scope: string, collectorsScope: string): void;
  getEvidenceCursor(stream: string): EvidenceCursor | undefined;
  saveEvidenceCursor(stream: string, lastRowId: number, sourceState: Buffer, updatedAt: number): void;
  insertIncident(input: PersistIncidentInput): void;
  updateIncident(input: PersistIncidentInput): void;
  deleteIncident(id: string): void;
  getIncidentById(id: string): (IncidentRow & { report_id?: string; executive_summary?: string; report?: Buffer | string | null }) | undefined;
  getOpenIncident(scope: string): IncidentRow | undefined;
  incidentOverlaps(scope: string, finalizeAfterOrLastAt: number, startedAt: number): IncidentRow[];
  getAllIncidentsForScopes(scopes: readonly string[]): IncidentRow[];
  listIncidents(limit: number): Array<IncidentRow & { report_id: string | null; executive_summary: string | null }>;
  upsertReport(input: {
    id: string; incidentId: string; schemaVersion: number;
    createdAt: number; updatedAt: number; executiveSummary: string; report: Buffer;
  }): void;
  getPostmortemByIncident(incidentId: string): PostmortemRow | undefined;
  markNotificationStaged(now: number, incidentId: string): void;
  reconcileReportCreatedAt(reportId: string, createdAt: number, stagedAt: number | null): void;
  reassignReport(reportId: string, incidentId: string): void;
  stageReadyNotification(input: {
    id: string; firedAt: number; title: string; body: string; lastSeen: number; deliveryKey: string;
  }): void;
  cancelPendingReadyNotification(id: string): void;
  loadUpsReadings(lastRowId: number, limit: number): UpsReadingRow[];
  loadUnifiReadings(lastRowId: number, limit: number): UnifiReadingRow[];
  loadProbeSamples(lastRowId: number, limit: number): ProbeSampleRow[];
  getUnifiLatest(): CollectorFreshnessRow | undefined;
  getNetworkObserverLatest(): CollectorFreshnessRow | undefined;
  getUpsUnits(): UpsUnitRow[];
}

export interface EvidenceRow {
  readonly id: number;
  readonly evidence_key: string;
  readonly scope: string;
  readonly source: string;
  readonly signal: string;
  readonly state: string;
  readonly occurred_at: number;
  readonly received_at: number;
  readonly confidence: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly raw: Buffer | null;
  readonly incident_id: string | null;
}

export interface InsertEvidenceInput {
  readonly evidenceKey: string;
  readonly scope: string;
  readonly source: string;
  readonly signal: string;
  readonly state: string;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly confidence: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly raw: Buffer;
}

export interface EvidenceCursor {
  readonly last_row_id: number;
  readonly source_state: Buffer | string | null;
}

export interface IncidentRow {
  readonly id: string;
  readonly scope: string;
  readonly status: string;
  readonly classification: string;
  readonly confidence: string;
  readonly started_at: number;
  readonly last_evidence_at: number;
  readonly recovered_at: number | null;
  readonly finalize_after: number | null;
  readonly finalized_at: number | null;
  readonly recovery_reason: string | null;
  readonly classifications: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PersistIncidentInput {
  readonly id: string;
  readonly scope: string;
  readonly status: string;
  readonly classification: string;
  readonly confidence: string;
  readonly startedAt: number;
  readonly lastEvidenceAt: number;
  readonly recoveredAt: number | null;
  readonly finalizeAfter: number | null;
  readonly finalizedAt: number | null;
  readonly recoveryReason: string | null;
  readonly classifications: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PostmortemRow {
  readonly id: string;
  readonly incident_id: string;
  readonly schema_version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly notification_staged_at: number | null;
  readonly executive_summary: string;
  readonly report: Buffer | string | null;
}

export interface UpsReadingRow {
  readonly id: number;
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly ups_id: string | null;
  readonly ups_label: string | null;
  readonly ups_status: string | null;
  readonly battery_charge: number | null;
  readonly battery_runtime: number | null;
  readonly input_voltage: number | null;
}

export interface UnifiReadingRow {
  readonly id: number;
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly internet_reachable: number | null;
  readonly active_wan: string | null;
  readonly active_wan_name: string | null;
  readonly wan_latency_ms: number | null;
}

export interface ProbeSampleRow {
  readonly id: number;
  readonly received_at: number;
  readonly device_ts: number | null;
  readonly observer_id: string;
  readonly kind: string;
  readonly target_id: string;
  readonly target_label: string | null;
  readonly ok: number;
  readonly latency_ms: number | null;
  readonly status_code: number | null;
  readonly error: string | null;
}

export interface CollectorFreshnessRow {
  readonly received_at: number | null;
}

export interface UpsUnitRow {
  readonly ups_id: string;
  readonly received_at: number;
}

export interface PrecedingEvidence {
  readonly state: string;
  readonly raw: Buffer | string | null;
}

export interface LatestEvidence {
  readonly occurred_at: number;
  readonly received_at: number;
}

export class SqliteOutageRepository extends SqliteRepository implements OutageRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  // ── Evidence ─────────────────────────────────────────────────────────────

  public async insertEvidence(input: InsertEvidenceInput): Promise<number> {
    return this.syncContext.insertEvidence(input);
  }

  public async latestEvidenceForSource(source: string): Promise<LatestEvidence | undefined> {
    return this.syncContext.latestEvidenceForSource(source);
  }

  public async precedingEvidenceForSource(
    source: string,
    beforeOccurredAt: number
  ): Promise<PrecedingEvidence | undefined> {
    return this.syncContext.precedingEvidenceForSource(source, beforeOccurredAt);
  }

  public async latestCollectorEvidenceForSource(
    scope: string,
    source: string
  ): Promise<{ state: string } | undefined> {
    return this.syncContext.latestCollectorEvidenceForSource(scope, source);
  }

  public async getAllScopeEvidence(scope: string): Promise<EvidenceRow[]> {
    return this.syncContext.getAllScopeEvidence(scope);
  }

  public async getEvidenceForIncident(incidentId: string): Promise<EvidenceRow[]> {
    return this.syncContext.getEvidenceForIncident(incidentId);
  }

  public async linkEvidence(incidentId: string, evidenceKey: string): Promise<void> {
    this.syncContext.linkEvidence(incidentId, evidenceKey);
  }

  public async relinkIncidentEvidence(newIncidentId: string, oldIncidentId: string): Promise<void> {
    this.syncContext.relinkIncidentEvidence(newIncidentId, oldIncidentId);
  }

  public async unlinkIncidentEvidence(incidentId: string): Promise<void> {
    this.syncContext.unlinkIncidentEvidence(incidentId);
  }

  public async unlinkCanonicalEvidence(scope: string, collectorsScope: string): Promise<void> {
    this.syncContext.unlinkCanonicalEvidence(scope, collectorsScope);
  }

  // ── Cursors ───────────────────────────────────────────────────────────────

  public async getEvidenceCursor(stream: string): Promise<EvidenceCursor | undefined> {
    return this.syncContext.getEvidenceCursor(stream);
  }

  public async saveEvidenceCursor(
    stream: string,
    lastRowId: number,
    sourceState: Buffer,
    updatedAt: number
  ): Promise<void> {
    this.syncContext.saveEvidenceCursor(stream, lastRowId, sourceState, updatedAt);
  }

  // ── Incidents ─────────────────────────────────────────────────────────────

  public async insertIncident(input: PersistIncidentInput): Promise<void> {
    this.syncContext.insertIncident(input);
  }

  public async updateIncident(input: PersistIncidentInput): Promise<void> {
    this.syncContext.updateIncident(input);
  }

  public async deleteIncident(id: string): Promise<void> {
    this.syncContext.deleteIncident(id);
  }

  public async getIncidentById(id: string): Promise<(IncidentRow & { report_id?: string; executive_summary?: string; report?: Buffer | string | null }) | undefined> {
    return this.syncContext.getIncidentById(id);
  }

  public async getOpenIncident(scope: string): Promise<IncidentRow | undefined> {
    return this.syncContext.getOpenIncident(scope);
  }

  public async incidentOverlaps(
    scope: string,
    finalizeAfterOrLastAt: number,
    startedAt: number
  ): Promise<IncidentRow[]> {
    return this.syncContext.incidentOverlaps(scope, finalizeAfterOrLastAt, startedAt);
  }

  public async getAllIncidentsForScopes(scopes: readonly string[]): Promise<IncidentRow[]> {
    return this.syncContext.getAllIncidentsForScopes(scopes);
  }

  public async listIncidents(limit: number): Promise<Array<IncidentRow & { report_id: string | null; executive_summary: string | null }>> {
    return this.syncContext.listIncidents(limit);
  }

  // ── Postmortems ───────────────────────────────────────────────────────────

  public async upsertReport(input: {
    id: string;
    incidentId: string;
    schemaVersion: number;
    createdAt: number;
    updatedAt: number;
    executiveSummary: string;
    report: Buffer;
  }): Promise<void> {
    this.syncContext.upsertReport(input);
  }

  public async getPostmortemByIncident(incidentId: string): Promise<PostmortemRow | undefined> {
    return this.syncContext.getPostmortemByIncident(incidentId);
  }

  public async markNotificationStaged(now: number, incidentId: string): Promise<void> {
    this.syncContext.markNotificationStaged(now, incidentId);
  }

  public async reconcileReportCreatedAt(reportId: string, createdAt: number, stagedAt: number | null): Promise<void> {
    this.syncContext.reconcileReportCreatedAt(reportId, createdAt, stagedAt);
  }

  public async reassignReport(reportId: string, incidentId: string): Promise<void> {
    this.syncContext.reassignReport(reportId, incidentId);
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  public async stageReadyNotification(input: {
    id: string;
    firedAt: number;
    title: string;
    body: string;
    lastSeen: number;
    deliveryKey: string;
  }): Promise<void> {
    this.syncContext.stageReadyNotification(input);
  }

  public async cancelPendingReadyNotification(id: string): Promise<void> {
    this.syncContext.cancelPendingReadyNotification(id);
  }

  // ── Source data ───────────────────────────────────────────────────────────

  public async loadUpsReadings(lastRowId: number, limit: number): Promise<UpsReadingRow[]> {
    return this.syncContext.loadUpsReadings(lastRowId, limit);
  }

  public async loadUnifiReadings(lastRowId: number, limit: number): Promise<UnifiReadingRow[]> {
    return this.syncContext.loadUnifiReadings(lastRowId, limit);
  }

  public async loadProbeSamples(lastRowId: number, limit: number): Promise<ProbeSampleRow[]> {
    return this.syncContext.loadProbeSamples(lastRowId, limit);
  }

  public async getUnifiLatest(): Promise<CollectorFreshnessRow | undefined> {
    return this.syncContext.getUnifiLatest();
  }

  public async getNetworkObserverLatest(): Promise<CollectorFreshnessRow | undefined> {
    return this.syncContext.getNetworkObserverLatest();
  }

  public async getUpsUnits(): Promise<UpsUnitRow[]> {
    return this.syncContext.getUpsUnits();
  }

  // ── Transaction with synchronous context ─────────────────────────────────

  public async inTransactionWithContext<T>(work: (ctx: SyncOutageRepoContext) => T): Promise<T> {
    return this.transaction(() => work(this.syncContext));
  }

  // ── Utilities (pass-through; no SQL, no Promise wrapping needed) ──────────



  // ── Private synchronous context ───────────────────────────────────────────

  private readonly syncContext: SyncOutageRepoContext = {
    insertEvidence: (input) =>
      this.runNamed(
        `INSERT INTO outage_incident_evidence (
           evidence_key, scope, source, signal, state, occurred_at, received_at,
           confidence, summary, detail, raw
         ) VALUES (
           @evidenceKey, @scope, @source, @signal, @state, @occurredAt, @receivedAt,
           @confidence, @summary, @detail, @raw
         ) ON CONFLICT(evidence_key) DO NOTHING`,
        input as unknown as Record<string, string | number | Buffer | null>
      ).changes,

    latestEvidenceForSource: (source) =>
      this.get<LatestEvidence>(
        `SELECT occurred_at, received_at FROM outage_incident_evidence
          WHERE source = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        source
      ),

    precedingEvidenceForSource: (source, beforeOccurredAt) =>
      this.get<PrecedingEvidence>(
        `SELECT state, raw FROM outage_incident_evidence
          WHERE source = ? AND occurred_at < ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        source,
        beforeOccurredAt
      ),

    latestCollectorEvidenceForSource: (scope, source) =>
      this.get<{ state: string }>(
        `SELECT state FROM outage_incident_evidence
          WHERE scope = ? AND source = ? AND signal = 'collector'
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        scope,
        source
      ),

    getAllScopeEvidence: (scope) =>
      this.all<EvidenceRow>(
        `SELECT id, evidence_key, scope, source, signal, state, occurred_at,
                received_at, confidence, summary, detail
           FROM outage_incident_evidence
          WHERE scope = ?
          ORDER BY occurred_at, id`,
        scope
      ),

    getEvidenceForIncident: (incidentId) =>
      this.all<EvidenceRow>(
        `SELECT id, evidence_key, scope, source, signal, state, occurred_at,
                received_at, confidence, summary, detail
           FROM outage_incident_evidence
          WHERE incident_id = ?
          ORDER BY occurred_at, id`,
        incidentId
      ),

    linkEvidence: (incidentId, evidenceKey) => {
      this.run(
        "UPDATE outage_incident_evidence SET incident_id = ? WHERE evidence_key = ?",
        incidentId,
        evidenceKey
      );
    },

    relinkIncidentEvidence: (newIncidentId, oldIncidentId) => {
      this.run(
        "UPDATE outage_incident_evidence SET incident_id = ? WHERE incident_id = ?",
        newIncidentId,
        oldIncidentId
      );
    },

    unlinkIncidentEvidence: (incidentId) => {
      this.run(
        "UPDATE outage_incident_evidence SET incident_id = NULL WHERE incident_id = ?",
        incidentId
      );
    },

    unlinkCanonicalEvidence: (scope, collectorsScope) => {
      this.run(
        `UPDATE outage_incident_evidence SET incident_id = NULL
          WHERE incident_id IN (
            SELECT id FROM outage_incidents WHERE scope IN (?, ?)
          )`,
        scope,
        collectorsScope
      );
    },

    getEvidenceCursor: (stream) =>
      this.get<EvidenceCursor>(
        "SELECT last_row_id, source_state FROM outage_evidence_cursors WHERE stream = ?",
        stream
      ),

    saveEvidenceCursor: (stream, lastRowId, sourceState, updatedAt) => {
      this.run(
        `INSERT INTO outage_evidence_cursors (stream, last_row_id, source_state, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stream) DO UPDATE SET
           last_row_id = excluded.last_row_id,
           source_state = excluded.source_state,
           updated_at = excluded.updated_at`,
        stream,
        lastRowId,
        sourceState,
        updatedAt
      );
    },

    insertIncident: (input) => {
      this.runNamed(
        `INSERT INTO outage_incidents (
           id, scope, status, classification, confidence, started_at, last_evidence_at,
           recovered_at, finalize_after, finalized_at, recovery_reason, classifications,
           created_at, updated_at
         ) VALUES (
           @id, @scope, @status, @classification, @confidence, @startedAt, @lastEvidenceAt,
           @recoveredAt, @finalizeAfter, @finalizedAt, @recoveryReason, @classifications,
           @createdAt, @updatedAt
         )`,
        input as unknown as Record<string, string | number | null>
      );
    },

    updateIncident: (input) => {
      this.runNamed(
        `UPDATE outage_incidents SET
           status = @status,
           classification = @classification,
           confidence = @confidence,
           started_at = MIN(started_at, @startedAt),
           last_evidence_at = MAX(last_evidence_at, @lastEvidenceAt),
           recovered_at = @recoveredAt,
           finalize_after = @finalizeAfter,
           finalized_at = @finalizedAt,
           recovery_reason = @recoveryReason,
           classifications = @classifications,
           updated_at = @updatedAt
         WHERE id = @id`,
        input as unknown as Record<string, string | number | null>
      );
    },

    deleteIncident: (id) => {
      this.run("DELETE FROM outage_incidents WHERE id = ?", id);
    },

    getIncidentById: (id) =>
      this.get<IncidentRow & { report_id?: string; executive_summary?: string; report?: Buffer | string | null }>(
        `SELECT i.*, p.id AS report_id, p.executive_summary, p.report
           FROM outage_incidents i
           LEFT JOIN outage_postmortems p ON p.incident_id = i.id
          WHERE i.id = ?`,
        id
      ),

    getOpenIncident: (scope) =>
      this.get<IncidentRow>(
        `SELECT * FROM outage_incidents WHERE scope = ? AND status IN ('open','recovery_pending') LIMIT 1`,
        scope
      ),

    incidentOverlaps: (scope, finalizeAfterOrLastAt, startedAt) =>
      this.all<IncidentRow>(
        `SELECT * FROM outage_incidents
          WHERE scope = ?
            AND started_at < ?
            AND (
              COALESCE(finalize_after, recovered_at, last_evidence_at) > ?
              OR started_at = ?
            )
          ORDER BY started_at, created_at, id`,
        scope,
        finalizeAfterOrLastAt,
        startedAt,
        startedAt
      ),

    getAllIncidentsForScopes: (scopes) => {
      if (!scopes.length) return [];
      const placeholders = scopes.map(() => "?").join(", ");
      return this.all<IncidentRow>(
        `SELECT id FROM outage_incidents WHERE scope IN (${placeholders})`,
        ...scopes
      );
    },

    listIncidents: (limit) =>
      this.all<IncidentRow & { report_id: string | null; executive_summary: string | null }>(
        `SELECT i.*, p.id AS report_id, p.executive_summary
           FROM outage_incidents i
           LEFT JOIN outage_postmortems p ON p.incident_id = i.id
          ORDER BY i.started_at DESC
          LIMIT ?`,
        limit
      ),

    upsertReport: (input) => {
      this.runNamed(
        `INSERT INTO outage_postmortems (
           id, incident_id, schema_version, created_at, updated_at,
           executive_summary, report
         ) VALUES (
           @id, @incidentId, @schemaVersion, @createdAt, @updatedAt,
           @executiveSummary, @report
         ) ON CONFLICT(incident_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at,
           executive_summary = excluded.executive_summary,
           report = excluded.report`,
        input
      );
    },

    getPostmortemByIncident: (incidentId) =>
      this.get<PostmortemRow>(
        "SELECT id, created_at, notification_staged_at, report FROM outage_postmortems WHERE incident_id = ?",
        incidentId
      ),

    markNotificationStaged: (now, incidentId) => {
      this.run(
        "UPDATE outage_postmortems SET notification_staged_at = ? WHERE incident_id = ? AND notification_staged_at IS NULL",
        now,
        incidentId
      );
    },

    reconcileReportCreatedAt: (reportId, createdAt, stagedAt) => {
      this.run(
        `UPDATE outage_postmortems
            SET created_at = MIN(created_at, ?),
                notification_staged_at = CASE
                  WHEN ? IS NULL THEN notification_staged_at
                  WHEN notification_staged_at IS NULL THEN ?
                  ELSE MIN(notification_staged_at, ?)
                END
          WHERE id = ?`,
        createdAt,
        stagedAt,
        stagedAt,
        stagedAt,
        reportId
      );
    },

    reassignReport: (reportId, incidentId) => {
      this.run("UPDATE outage_postmortems SET incident_id = ? WHERE id = ?", incidentId, reportId);
    },

    stageReadyNotification: (input) => {
      this.runNamed(
        `INSERT INTO mobile_alert_events (
           id, fired_at, status, claim_until, claim_token, title, body, critical,
           last_seen, delivery_key
         ) VALUES (
           @id, @firedAt, 'pending', 0, NULL, @title, @body, 0,
           @lastSeen, @deliveryKey
         ) ON CONFLICT(id) DO NOTHING`,
        input
      );
    },

    cancelPendingReadyNotification: (id) => {
      this.run("DELETE FROM mobile_alert_events WHERE id = ? AND status = 'pending'", id);
    },

    loadUpsReadings: (lastRowId, limit) =>
      this.all<UpsReadingRow>(
        `SELECT id, received_at, device_ts, ups_id, ups_label, ups_status,
                battery_charge, battery_runtime, input_voltage
           FROM ups_readings WHERE id > ? ORDER BY id LIMIT ?`,
        lastRowId,
        limit
      ),

    loadUnifiReadings: (lastRowId, limit) =>
      this.all<UnifiReadingRow>(
        `SELECT id, received_at, device_ts, internet_reachable, active_wan, active_wan_name,
                wan_latency_ms
           FROM unifi_readings WHERE id > ? AND internet_reachable IS NOT NULL ORDER BY id LIMIT ?`,
        lastRowId,
        limit
      ),

    loadProbeSamples: (lastRowId, limit) =>
      this.all<ProbeSampleRow>(
        `SELECT id, received_at, device_ts, observer_id, kind, target_id,
                target_label, ok, latency_ms, status_code, error
           FROM network_probe_samples
          WHERE id > ? AND kind IN ('external','dns','http')
          ORDER BY id LIMIT ?`,
        lastRowId,
        limit
      ),

    getUnifiLatest: () =>
      this.get<CollectorFreshnessRow>("SELECT received_at FROM unifi_latest WHERE id = 1"),

    getNetworkObserverLatest: () =>
      this.get<CollectorFreshnessRow>(
        "SELECT MAX(received_at) AS received_at FROM network_observer_latest"
      ),

    getUpsUnits: () =>
      this.all<UpsUnitRow>(
        `SELECT COALESCE(ups_id, 'tower') AS ups_id, MAX(received_at) AS received_at
           FROM ups_readings GROUP BY COALESCE(ups_id, 'tower')`
      ),
  };
}
