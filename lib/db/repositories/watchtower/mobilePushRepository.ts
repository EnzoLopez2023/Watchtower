import type { SqliteDatabase } from "../../connection.js";
import { SqliteRepository } from "./base.js";

export interface DeviceBackoffRow {
  readonly device_ref: string;
  readonly retry_after: number;
  readonly lease_until: number | null;
  readonly blocked_fingerprint: string | null;
}

export interface DeviceOutcomeRecord {
  readonly deviceRef: string;
  readonly pruned: boolean;
  readonly retryable: boolean;
  readonly retryAt: number | null;
  readonly attemptedAt: number;
  readonly attemptOrder: number;
  readonly blockedFingerprint: string | null;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly source: string;
  readonly alertKey: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly registeredDeviceCount: number;
  readonly apnsEnvironment: string;
  readonly apnsTopic: string;
  readonly criticalRequested: boolean;
  readonly interruptionLevel: string;
  readonly status: string;
}

export interface AttemptRecord {
  readonly deliveryId: string;
  readonly deviceRef: string;
  readonly attemptNumber: number;
  readonly attemptOrder: number;
  readonly attemptedAt: number;
  readonly durationMs: number;
  readonly status: number;
  readonly apnsId: string | null;
  readonly reason: string | null;
  readonly transient: boolean;
  readonly accepted: boolean;
}

/** Durable state for the APNs fan-out. Raw device tokens never leave this layer. */
export interface MobilePushRepository {
  listDeviceTokens(): Promise<string[]>;
  deviceExists(token: string): Promise<boolean>;
  registerDevice(input: {
    token: string;
    platform: string;
    appVersion: string | null;
    now: number;
    deviceRef: string;
  }): Promise<{ returning: boolean }>;
  unregisterDevice(token: string, deviceRef: string): Promise<{ removed: number }>;
  deleteDeviceIfNotSeenAfter(token: string, cutoff: number): Promise<number>;
  listDeviceBackoffs(): Promise<DeviceBackoffRow[]>;
  reserveDevice(input: {
    deviceRef: string;
    now: number;
    leaseUntil: number;
    leaseToken: string;
    providerFingerprint: string;
  }): Promise<boolean>;
  nextAttemptOrder(): Promise<number>;
  recordDeviceOutcome(outcome: DeviceOutcomeRecord, leaseToken: string): Promise<void>;
  retainFailedOutcomeLease(input: {
    deviceRef: string;
    leaseToken: string;
    leaseUntil: number;
    blockedFingerprint: string | null;
  }): Promise<number>;
  insertDelivery(record: DeliveryRecord): Promise<void>;
  finishDelivery(input: {
    id: string;
    completedAt: number;
    acceptedDeviceCount: number;
    failedDeviceCount: number;
    status: string;
  }): Promise<void>;
  insertAttempt(record: AttemptRecord): Promise<void>;
}

export class SqliteMobilePushRepository extends SqliteRepository implements MobilePushRepository {
  public constructor(database: SqliteDatabase) {
    super(database);
  }

  public async listDeviceTokens(): Promise<string[]> {
    return this.all<{ device_token: string }>("SELECT device_token FROM mobile_devices").map(
      (row) => row.device_token
    );
  }

  public async deviceExists(token: string): Promise<boolean> {
    return this.deviceExistsSync(token);
  }

  private deviceExistsSync(token: string): boolean {
    return this.get<{ one: number }>("SELECT 1 AS one FROM mobile_devices WHERE device_token = ?", token) !== undefined;
  }

  /**
   * A registration is the device asserting it exists and wants pushes. If no row
   * was there a moment ago, any per-device block still on file belongs to a
   * previous life of that token and must not be inherited. An ordinary refresh
   * leaves live backoff state alone, so a device cannot register its way out of a
   * provider-directed backoff.
   */
  public async registerDevice(input: {
    token: string;
    platform: string;
    appVersion: string | null;
    now: number;
    deviceRef: string;
  }): Promise<{ returning: boolean }> {
    return this.transaction(() => {
      const returning = this.deviceExistsSync(input.token);
      this.runNamed(
        `INSERT INTO mobile_devices (device_token, platform, app_version, created_at, last_seen)
         VALUES (@device_token, @platform, @app_version, @now, @now)
         ON CONFLICT(device_token) DO UPDATE SET
           platform = @platform, app_version = @app_version, last_seen = @now`,
        {
          device_token: input.token,
          platform: input.platform,
          app_version: input.appVersion,
          now: input.now
        }
      );
      if (!returning) {
        this.run("DELETE FROM mobile_push_device_backoff WHERE device_ref = ?", input.deviceRef);
      }
      return { returning };
    });
  }

  public async unregisterDevice(token: string, deviceRef: string): Promise<{ removed: number }> {
    return this.transaction(() => {
      const removed = this.run("DELETE FROM mobile_devices WHERE device_token = ?", token).changes;
      this.run("DELETE FROM mobile_push_device_backoff WHERE device_ref = ?", deviceRef);
      return { removed };
    });
  }

  public async deleteDeviceIfNotSeenAfter(token: string, cutoff: number): Promise<number> {
    return this.run(
      "DELETE FROM mobile_devices WHERE device_token = ? AND last_seen <= ?",
      token,
      cutoff
    ).changes;
  }

  public async listDeviceBackoffs(): Promise<DeviceBackoffRow[]> {
    return this.all<DeviceBackoffRow>(
      `SELECT device_ref, retry_after, lease_until, blocked_fingerprint
         FROM mobile_push_device_backoff`
    );
  }

  public async reserveDevice(input: {
    deviceRef: string;
    now: number;
    leaseUntil: number;
    leaseToken: string;
    providerFingerprint: string;
  }): Promise<boolean> {
    const reserved = this.database
      .prepare(
        `INSERT INTO mobile_push_device_backoff (
           device_ref, retry_after, updated_at, outcome_order, lease_until, lease_token,
           blocked_fingerprint
         )
         VALUES (@device_ref, 0, 0, 0, @lease_until, @lease_token, NULL)
         ON CONFLICT(device_ref) DO UPDATE SET
           lease_until = excluded.lease_until,
           lease_token = excluded.lease_token,
           blocked_fingerprint = NULL
         WHERE mobile_push_device_backoff.retry_after <= @now
           AND (
             (
               mobile_push_device_backoff.blocked_fingerprint IS NULL
               AND COALESCE(mobile_push_device_backoff.lease_until, 0) < @now
             )
             OR (
               mobile_push_device_backoff.blocked_fingerprint IS NOT NULL
               AND mobile_push_device_backoff.blocked_fingerprint != @provider_fingerprint
             )
           )
         RETURNING device_ref`
      )
      .get({
        device_ref: input.deviceRef,
        now: input.now,
        lease_until: input.leaseUntil,
        lease_token: input.leaseToken,
        provider_fingerprint: input.providerFingerprint
      });
    return reserved !== undefined;
  }

  /** DB-monotonic attempt ordering across concurrent senders. */
  public async nextAttemptOrder(): Promise<number> {
    const row = this.database
      .prepare("UPDATE mobile_push_attempt_sequence SET value = value + 1 WHERE id = 1 RETURNING value")
      .get() as { value: number } | undefined;
    const order = Number(row?.value);
    if (!Number.isSafeInteger(order) || order <= 0) {
      throw new Error("Could not allocate a valid APNs attempt order");
    }
    return order;
  }

  public async recordDeviceOutcome(outcome: DeviceOutcomeRecord, leaseToken: string): Promise<void> {
    this.transaction(() => {
      if (outcome.pruned) {
        this.run(
          "DELETE FROM mobile_push_device_backoff WHERE device_ref = ? AND lease_token = ?",
          outcome.deviceRef,
          leaseToken
        );
        return;
      }
      this.runNamed(
        `UPDATE mobile_push_device_backoff
            SET retry_after = @retry_after,
                updated_at = @attempted_at,
                outcome_order = @attempt_order,
                blocked_fingerprint = @blocked_fingerprint
          WHERE device_ref = @device_ref
            AND outcome_order < @attempt_order`,
        {
          device_ref: outcome.deviceRef,
          retry_after: outcome.retryable ? (outcome.retryAt ?? 0) : 0,
          attempted_at: outcome.attemptedAt,
          attempt_order: outcome.attemptOrder,
          blocked_fingerprint: outcome.blockedFingerprint
        }
      );
      this.run(
        `UPDATE mobile_push_device_backoff SET lease_until = 0, lease_token = NULL
          WHERE device_ref = ? AND lease_token = ?`,
        outcome.deviceRef,
        leaseToken
      );
    });
  }

  public async retainFailedOutcomeLease(input: {
    deviceRef: string;
    leaseToken: string;
    leaseUntil: number;
    blockedFingerprint: string | null;
  }): Promise<number> {
    return this.runNamed(
      `UPDATE mobile_push_device_backoff
          SET lease_until = MAX(COALESCE(lease_until, 0), @lease_until),
              blocked_fingerprint = COALESCE(@blocked_fingerprint, blocked_fingerprint)
        WHERE device_ref = @device_ref AND lease_token = @lease_token`,
      {
        device_ref: input.deviceRef,
        lease_token: input.leaseToken,
        lease_until: input.leaseUntil,
        blocked_fingerprint: input.blockedFingerprint
      }
    ).changes;
  }

  public async insertDelivery(record: DeliveryRecord): Promise<void> {
    this.runNamed(
      `INSERT INTO mobile_push_deliveries (
         id, source, alert_key, created_at, expires_at, registered_device_count,
         apns_environment, apns_topic, critical_requested, interruption_level, status
       ) VALUES (
         @id, @source, @alert_key, @created_at, @expires_at, @registered_device_count,
         @apns_environment, @apns_topic, @critical_requested, @interruption_level, @status
       )`,
      {
        id: record.id,
        source: record.source,
        alert_key: record.alertKey,
        created_at: record.createdAt,
        expires_at: record.expiresAt,
        registered_device_count: record.registeredDeviceCount,
        apns_environment: record.apnsEnvironment,
        apns_topic: record.apnsTopic,
        critical_requested: record.criticalRequested ? 1 : 0,
        interruption_level: record.interruptionLevel,
        status: record.status
      }
    );
  }

  public async finishDelivery(input: {
    id: string;
    completedAt: number;
    acceptedDeviceCount: number;
    failedDeviceCount: number;
    status: string;
  }): Promise<void> {
    this.runNamed(
      `UPDATE mobile_push_deliveries
          SET completed_at = @completed_at,
              accepted_device_count = @accepted_device_count,
              failed_device_count = @failed_device_count,
              status = @status
        WHERE id = @id`,
      {
        id: input.id,
        completed_at: input.completedAt,
        accepted_device_count: input.acceptedDeviceCount,
        failed_device_count: input.failedDeviceCount,
        status: input.status
      }
    );
  }

  public async insertAttempt(record: AttemptRecord): Promise<void> {
    this.runNamed(
      `INSERT INTO mobile_push_attempts (
         delivery_id, device_ref, attempt_number, attempt_order, attempted_at, duration_ms,
         status, apns_id, reason, transient, accepted
       ) VALUES (
         @delivery_id, @device_ref, @attempt_number, @attempt_order, @attempted_at, @duration_ms,
         @status, @apns_id, @reason, @transient, @accepted
       )`,
      {
        delivery_id: record.deliveryId,
        device_ref: record.deviceRef,
        attempt_number: record.attemptNumber,
        attempt_order: record.attemptOrder,
        attempted_at: record.attemptedAt,
        duration_ms: record.durationMs,
        status: record.status,
        apns_id: record.apnsId,
        reason: record.reason,
        transient: record.transient ? 1 : 0,
        accepted: record.accepted ? 1 : 0
      }
    );
  }
}
