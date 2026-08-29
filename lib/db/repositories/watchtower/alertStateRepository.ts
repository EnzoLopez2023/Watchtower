import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";

export interface AlertStateRow {
  readonly subsystem: string;
  readonly severity: string;
  readonly stage: string | null;
}

export interface AlertCandidateRow {
  readonly subsystem: string;
  readonly targetSeverity: string;
  readonly targetStage: string;
  readonly signature: string;
  readonly consecutiveCount: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly lastSampleKey: string;
  readonly reconcile: number;
}

export interface AlertCandidateInput {
  readonly subsystem: string;
  readonly targetSeverity: string;
  readonly targetStage: string;
  readonly signature: string;
  readonly consecutiveCount: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly lastSampleKey: string;
  readonly reconcile: number;
}

export interface PendingAlertRow {
  readonly id: string;
  readonly dedupe_key: string;
  readonly subsystem: string;
  readonly title: string;
  readonly body: string;
  readonly critical: number;
  readonly target_severity: string;
  readonly target_stage: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly device_dispositions: string | null;
  readonly claim_until: number | null;
  readonly claim_token: string | null;
}

export interface PendingEventRow {
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly critical: number;
  readonly delivery_key: string | null;
  readonly device_dispositions: string | null;
}

export interface StagedAlert {
  readonly id: string;
  readonly dedupeKey: string;
  readonly subsystem: string;
  readonly title: string;
  readonly body: string;
  readonly critical: boolean;
  readonly targetSeverity: string;
  readonly targetStage: string;
  readonly now: number;
}

export interface StagedEvent {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly critical: boolean;
  readonly deliveryKey: string;
}

export interface AlertStateRepository {
  listState(): Promise<AlertStateRow[]>;
  getState(subsystem: string): Promise<AlertStateRow | undefined>;
  upsertState(subsystem: string, severity: string, changedAt: number, stage: string): Promise<number>;
  reconcileUnnotifiedState(
    subsystem: string,
    severity: string,
    changedAt: number,
    stage: string
  ): Promise<void>;
  getCandidate(subsystem: string): Promise<AlertCandidateRow | undefined>;
  upsertCandidate(candidate: AlertCandidateInput): Promise<void>;
  deleteCandidate(subsystem: string): Promise<void>;
  markCandidateForReconciliation(subsystem: string): Promise<void>;
  clearSamplePolicyState(subsystem: string, now: number): Promise<void>;
  deleteCancelablePendingAlerts(subsystem: string, now: number): Promise<void>;
  stagePendingAlert(alert: StagedAlert): Promise<void>;
  stagePendingAlertOnce(alert: StagedAlert): Promise<void>;
  listPendingAlerts(now: number): Promise<PendingAlertRow[]>;
  claimPendingAlert(id: string, now: number, claimUntil: number, claimToken: string): Promise<boolean>;
  getClaimedPendingAlert(id: string, claimToken: string): Promise<PendingAlertRow | undefined>;
  getClaimedSampleAlert(subsystem: string, now: number): Promise<PendingAlertRow | undefined>;
  deleteClaimedPendingAlert(id: string, claimToken: string): Promise<number>;
  deferPendingAlert(id: string, claimToken: string, dispositions: string): Promise<boolean>;
  acceptPendingAlert(
    pendingId: string,
    claimToken: string,
    acceptedAt: number,
    sampleDedupeKeyOf: (candidate: AlertCandidateRow) => string
  ): Promise<boolean>;
  syncEventQueue(events: readonly StagedEvent[], now: number): Promise<void>;
  listPendingEvents(now: number): Promise<PendingEventRow[]>;
  claimPendingEvent(
    id: string,
    now: number,
    claimUntil: number,
    claimToken: string,
    deliveryKey: string
  ): Promise<boolean>;
  acceptEvent(id: string, claimToken: string, firedAt: number): Promise<number>;
  releaseEvent(id: string, claimToken: string, dispositions: string): Promise<void>;
  countDevices(): Promise<number>;
}

const SAMPLE_DEDUPE_PREFIX = "sample-confirmation:";

export class SqliteAlertStateRepository extends SqliteRepository implements AlertStateRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  public async listState(): Promise<AlertStateRow[]> {
    return this.all<AlertStateRow>("SELECT subsystem, severity, stage FROM mobile_alert_state");
  }

  public async getState(subsystem: string): Promise<AlertStateRow | undefined> {
    return this.get<AlertStateRow>(
      "SELECT subsystem, severity, stage FROM mobile_alert_state WHERE subsystem = ?",
      subsystem
    );
  }

  public async upsertState(
    subsystem: string,
    severity: string,
    changedAt: number,
    stage: string
  ): Promise<number> {
    return this.upsertStateSync(
    subsystem,
    severity,
    changedAt,
    stage
  );
  }

  private upsertStateSync(
    subsystem: string,
    severity: string,
    changedAt: number,
    stage: string
  ): number {
    return this.runNamed(
      `INSERT INTO mobile_alert_state (subsystem, severity, changed_at, stage)
       VALUES (@subsystem, @severity, @changed_at, @stage)
       ON CONFLICT(subsystem) DO UPDATE SET
         severity = @severity,
         changed_at = @changed_at,
         stage = @stage
       WHERE mobile_alert_state.changed_at <= @changed_at`,
      { subsystem, severity, changed_at: changedAt, stage }
    ).changes;
  }

  public async reconcileUnnotifiedState(
    subsystem: string,
    severity: string,
    changedAt: number,
    stage: string
  ): Promise<void> {
    this.transaction(() => {
      const persisted = this.upsertStateSync(subsystem, severity, changedAt, stage);
      if (persisted > 0) {
        this.runNamed(
          `DELETE FROM mobile_pending_alerts
            WHERE subsystem = @subsystem
              AND created_at <= @changed_at
              AND (target_severity != @severity OR target_stage != @stage)`,
          { subsystem, changed_at: changedAt, severity, stage }
        );
      }
    });
  }

  public async getCandidate(subsystem: string): Promise<AlertCandidateRow | undefined> {
    return this.getCandidateSync(subsystem);
  }

  private getCandidateSync(subsystem: string): AlertCandidateRow | undefined {
    return this.get<AlertCandidateRow>(
      `SELECT subsystem,
              target_severity AS targetSeverity,
              target_stage AS targetStage,
              signature,
              consecutive_count AS consecutiveCount,
              first_seen AS firstSeen,
              last_seen AS lastSeen,
              last_sample_key AS lastSampleKey,
              reconcile
         FROM mobile_alert_candidates
        WHERE subsystem = ?`,
      subsystem
    );
  }

  public async upsertCandidate(candidate: AlertCandidateInput): Promise<void> {
    this.runNamed(
      `INSERT INTO mobile_alert_candidates (
         subsystem, target_severity, target_stage, signature, consecutive_count,
         first_seen, last_seen, last_sample_key, reconcile
       ) VALUES (
         @subsystem, @targetSeverity, @targetStage, @signature, @consecutiveCount,
         @firstSeen, @lastSeen, @lastSampleKey, @reconcile
       )
       ON CONFLICT(subsystem) DO UPDATE SET
         target_severity = excluded.target_severity,
         target_stage = excluded.target_stage,
         signature = excluded.signature,
         consecutive_count = excluded.consecutive_count,
         first_seen = excluded.first_seen,
         last_seen = excluded.last_seen,
         last_sample_key = excluded.last_sample_key,
         reconcile = excluded.reconcile`,
      { ...candidate }
    );
  }

  public async deleteCandidate(subsystem: string): Promise<void> {
    return this.deleteCandidateSync(subsystem);
  }

  private deleteCandidateSync(subsystem: string): void {
    this.run("DELETE FROM mobile_alert_candidates WHERE subsystem = ?", subsystem);
  }

  public async markCandidateForReconciliation(subsystem: string): Promise<void> {
    return this.markCandidateForReconciliationSync(subsystem);
  }

  private markCandidateForReconciliationSync(subsystem: string): void {
    this.run("UPDATE mobile_alert_candidates SET reconcile = 1 WHERE subsystem = ?", subsystem);
  }

  public async clearSamplePolicyState(subsystem: string, now: number): Promise<void> {
    this.transaction(() => {
      this.deleteCandidateSync(subsystem);
      this.deleteCancelablePendingAlertsSync(subsystem, now);
    });
  }

  public async deleteCancelablePendingAlerts(subsystem: string, now: number): Promise<void> {
    return this.deleteCancelablePendingAlertsSync(subsystem, now);
  }

  private deleteCancelablePendingAlertsSync(subsystem: string, now: number): void {
    this.runNamed(
      `DELETE FROM mobile_pending_alerts
        WHERE subsystem = @subsystem
          AND (claim_token IS NULL OR COALESCE(claim_until, 0) < @now)`,
      { subsystem, now }
    );
  }

  public async stagePendingAlert(alert: StagedAlert): Promise<void> {
    this.runNamed(
      `INSERT INTO mobile_pending_alerts (
         id, dedupe_key, subsystem, title, body, critical,
         target_severity, target_stage, created_at, updated_at
       ) VALUES (
         @id, @dedupe_key, @subsystem, @title, @body, @critical,
         @target_severity, @target_stage, @created_at, @updated_at
       )
       ON CONFLICT(dedupe_key) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         critical = excluded.critical,
         target_severity = excluded.target_severity,
         target_stage = excluded.target_stage,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
      this.stagedParameters(alert)
    );
  }

  public async stagePendingAlertOnce(alert: StagedAlert): Promise<void> {
    this.runNamed(
      `INSERT INTO mobile_pending_alerts (
         id, dedupe_key, subsystem, title, body, critical,
         target_severity, target_stage, created_at, updated_at
       ) VALUES (
         @id, @dedupe_key, @subsystem, @title, @body, @critical,
         @target_severity, @target_stage, @created_at, @updated_at
       )
       ON CONFLICT(dedupe_key) DO NOTHING`,
      this.stagedParameters(alert)
    );
  }

  public async listPendingAlerts(now: number): Promise<PendingAlertRow[]> {
    return this.all<PendingAlertRow>(
      `SELECT * FROM mobile_pending_alerts
        WHERE COALESCE(claim_until, 0) < ?
        ORDER BY created_at`,
      now
    );
  }

  public async claimPendingAlert(
    id: string,
    now: number,
    claimUntil: number,
    claimToken: string
  ): Promise<boolean> {
    return (
      this.runNamed(
        `UPDATE mobile_pending_alerts
            SET claim_until = @claim_until, claim_token = @claim_token
          WHERE id = @id AND COALESCE(claim_until, 0) < @now`,
        { id, now, claim_until: claimUntil, claim_token: claimToken }
      ).changes > 0
    );
  }

  public async getClaimedPendingAlert(id: string, claimToken: string): Promise<PendingAlertRow | undefined> {
    return this.getClaimedPendingAlertSync(id, claimToken);
  }

  private getClaimedPendingAlertSync(id: string, claimToken: string): PendingAlertRow | undefined {
    return this.get<PendingAlertRow>(
      "SELECT * FROM mobile_pending_alerts WHERE id = ? AND claim_token = ?",
      id,
      claimToken
    );
  }

  public async getClaimedSampleAlert(subsystem: string, now: number): Promise<PendingAlertRow | undefined> {
    return this.get<PendingAlertRow>(
      `SELECT * FROM mobile_pending_alerts
        WHERE subsystem = ?
          AND dedupe_key LIKE 'sample-confirmation:%'
          AND claim_token IS NOT NULL
          AND COALESCE(claim_until, 0) >= ?
        ORDER BY created_at DESC
        LIMIT 1`,
      subsystem,
      now
    );
  }

  public async deleteClaimedPendingAlert(id: string, claimToken: string): Promise<number> {
    return this.deleteClaimedPendingAlertSync(id, claimToken);
  }

  private deleteClaimedPendingAlertSync(id: string, claimToken: string): number {
    return this.run(
      "DELETE FROM mobile_pending_alerts WHERE id = ? AND claim_token = ?",
      id,
      claimToken
    ).changes;
  }

  public async deferPendingAlert(id: string, claimToken: string, dispositions: string): Promise<boolean> {
    return (
      this.runNamed(
        `UPDATE mobile_pending_alerts
            SET claim_until = 0, claim_token = NULL, device_dispositions = @device_dispositions
          WHERE id = @id AND claim_token = @claim_token`,
        { id, claim_token: claimToken, device_dispositions: dispositions }
      ).changes > 0
    );
  }

  public async acceptPendingAlert(
    pendingId: string,
    claimToken: string,
    acceptedAt: number,
    sampleDedupeKeyOf: (candidate: AlertCandidateRow) => string
  ): Promise<boolean> {
    return this.transaction(() => {
      const claimed = this.getClaimedPendingAlertSync(pendingId, claimToken);
      if (!claimed) return false;
      if (this.deleteClaimedPendingAlertSync(claimed.id, claimToken) === 0) return false;
      this.run(
        "DELETE FROM mobile_pending_alerts WHERE subsystem = ? AND created_at < ?",
        claimed.subsystem,
        claimed.created_at
      );
      this.upsertStateSync(claimed.subsystem, claimed.target_severity, acceptedAt, claimed.target_stage);
      if (claimed.dedupe_key.startsWith(SAMPLE_DEDUPE_PREFIX)) {
        const candidate = this.getCandidateSync(claimed.subsystem);
        if (candidate && sampleDedupeKeyOf(candidate) === claimed.dedupe_key) {
          this.deleteCandidateSync(claimed.subsystem);
        } else if (candidate) {
          this.markCandidateForReconciliationSync(claimed.subsystem);
        }
      }
      return true;
    });
  }

  /**
   * One-shot events are staged before any network work, so the payload survives a
   * failed send or a crash. Stable-ID conditions re-arm as soon as they disappear.
   */
  public async syncEventQueue(events: readonly StagedEvent[], now: number): Promise<void> {
    this.transaction(() => {
      for (const event of events) {
        this.runNamed(
          `INSERT INTO mobile_alert_events (
             id, fired_at, status, claim_until, claim_token, title, body, critical,
             last_seen, delivery_key
           )
           VALUES (
             @id, @fired_at, 'pending', 0, NULL, @title, @body, @critical,
             @last_seen, @delivery_key
           )
           ON CONFLICT(id) DO UPDATE SET
             last_seen = excluded.last_seen,
             title = CASE WHEN mobile_alert_events.status = 'pending'
               THEN excluded.title ELSE mobile_alert_events.title END,
             body = CASE WHEN mobile_alert_events.status = 'pending'
               THEN excluded.body ELSE mobile_alert_events.body END,
             critical = CASE WHEN mobile_alert_events.status = 'pending'
               THEN excluded.critical ELSE mobile_alert_events.critical END`,
          {
            id: event.id,
            fired_at: now,
            title: event.title,
            body: event.body,
            critical: event.critical ? 1 : 0,
            last_seen: now,
            delivery_key: event.deliveryKey
          }
        );
      }
      this.run(
        "DELETE FROM mobile_alert_events WHERE status = 'accepted' AND COALESCE(last_seen, 0) < ?",
        now
      );
    });
  }

  public async listPendingEvents(now: number): Promise<PendingEventRow[]> {
    return this.all<PendingEventRow>(
      `SELECT id, title, body, critical, delivery_key, device_dispositions
         FROM mobile_alert_events
        WHERE status = 'pending'
          AND COALESCE(claim_until, 0) < ?
          AND title IS NOT NULL
        ORDER BY fired_at`,
      now
    );
  }

  public async claimPendingEvent(
    id: string,
    now: number,
    claimUntil: number,
    claimToken: string,
    deliveryKey: string
  ): Promise<boolean> {
    return (
      this.runNamed(
        `UPDATE mobile_alert_events
            SET claim_until = @claim_until,
                claim_token = @claim_token,
                delivery_key = COALESCE(delivery_key, @delivery_key)
          WHERE id = @id
            AND status = 'pending'
            AND COALESCE(claim_until, 0) < @now`,
        { id, now, claim_until: claimUntil, claim_token: claimToken, delivery_key: deliveryKey }
      ).changes > 0
    );
  }

  public async acceptEvent(id: string, claimToken: string, firedAt: number): Promise<number> {
    return this.run(
      `UPDATE mobile_alert_events
          SET fired_at = ?, status = 'accepted', claim_until = NULL, claim_token = NULL,
              title = NULL, body = NULL
        WHERE id = ? AND status = 'pending' AND claim_token = ?`,
      firedAt,
      id,
      claimToken
    ).changes;
  }

  public async releaseEvent(id: string, claimToken: string, dispositions: string): Promise<void> {
    this.runNamed(
      `UPDATE mobile_alert_events
          SET claim_until = 0, claim_token = NULL, device_dispositions = @device_dispositions
        WHERE id = @id AND status = 'pending' AND claim_token = @claim_token`,
      { id, claim_token: claimToken, device_dispositions: dispositions }
    );
  }

  public async countDevices(): Promise<number> {
    return this.get<{ count: number }>("SELECT COUNT(*) AS count FROM mobile_devices")?.count ?? 0;
  }

  private stagedParameters(alert: StagedAlert): Record<string, string | number | null> {
    return {
      id: alert.id,
      dedupe_key: alert.dedupeKey,
      subsystem: alert.subsystem,
      title: alert.title,
      body: alert.body,
      critical: alert.critical ? 1 : 0,
      target_severity: alert.targetSeverity,
      target_stage: alert.targetStage,
      created_at: alert.now,
      updated_at: alert.now
    };
  }
}
