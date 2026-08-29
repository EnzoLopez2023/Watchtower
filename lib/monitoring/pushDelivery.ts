import { createHash, randomUUID } from "node:crypto";
import type { ApnsProvider, ApnsResult } from "../../server/clients/apns.js";
import type { MobilePushRepository } from "../db/repositories/watchtower/mobilePushRepository.js";

const MAX_STANDARD_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];
const TRANSPORT_RETRY_AFTER_MS = 60 * 1000;
const RATE_LIMIT_RETRY_AFTER_MS = 60 * 1000;
const SERVER_RETRY_AFTER_MS = 15 * 60 * 1000;
const TRANSIENT_STATUSES = new Set([429, 500, 503]);
const TRANSIENT_REASONS = new Set(["IdleTimeout"]);
const PAYLOAD_FAILURE_REASONS = new Set(["PayloadEmpty", "PayloadTooLarge"]);
const DEVICE_LEASE_MS = 90 * 1000;
const MAX_RETRY_AT = Number.MAX_SAFE_INTEGER;

export type BlockScope = "device" | "payload" | "configuration";

export interface PushNotification {
  readonly title: string;
  readonly body: string;
  readonly critical?: boolean;
}

export interface DeviceOutcome {
  readonly device: string;
  readonly deviceRef: string;
  readonly ok: boolean;
  readonly status: number;
  readonly reason: string | null;
  readonly apnsId: string | null;
  readonly attempts: number;
  readonly pruned: boolean;
  readonly retryable: boolean;
  readonly retryAt: number | null;
  readonly attemptedAt: number;
  readonly attemptOrder: number;
  readonly providerFingerprint: string;
  readonly blockScope: BlockScope;
}

export interface DeliveryOutcome {
  readonly deliveryId: string;
  readonly status: "sending" | "accepted" | "partial" | "failed" | "no_devices" | "no_targets";
  readonly acceptedCount: number;
  readonly failedCount: number;
  readonly registeredDeviceCount: number;
  readonly attemptedDeviceCount: number;
  readonly interruptionLevel: string;
  readonly environment: string;
  readonly expiresAt: number;
  readonly fingerprint: string;
  readonly configurationFingerprint: string;
  readonly providerFingerprint: string;
  readonly retryable: boolean;
  readonly retryAt: number | null;
  readonly results: readonly DeviceOutcome[];
}

export interface DeliveryPlan {
  readonly fingerprint: string;
  readonly configurationFingerprint: string;
  readonly providerFingerprint: string;
  readonly deviceRefs: readonly string[];
  readonly retryAfterByDevice: Readonly<Record<string, number>>;
  readonly blockedFingerprintByDevice: Readonly<Record<string, string | null>>;
}

export interface DeliverOptions {
  readonly source?: string;
  readonly alertKey?: string | null;
  readonly eligibleDeviceRefs?: readonly string[] | null;
}

export type PushDeliverer = (
  notification: PushNotification,
  options?: DeliverOptions
) => Promise<DeliveryOutcome>;

/** One-way reference so provider outcomes stay diagnosable without a credential. */
export function deviceRef(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function collapseId(alertKey: string): string {
  return createHash("sha256").update(alertKey).digest("hex");
}

function retryAfterMs(value: string | null, now: number): number {
  if (value === null || value === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function deferredRetryAt(result: ApnsResult, now: number): number {
  const providerDelay = retryAfterMs(result.retryAfter, now);
  if (result.status === 500 || result.status === 503) {
    return now + Math.max(SERVER_RETRY_AFTER_MS, providerDelay);
  }
  if (result.status === 429) {
    return now + Math.max(RATE_LIMIT_RETRY_AFTER_MS, providerDelay);
  }
  return now + Math.max(TRANSPORT_RETRY_AFTER_MS, providerDelay);
}

const isTransient = (result: ApnsResult): boolean =>
  result.transport === true ||
  TRANSIENT_STATUSES.has(result.status) ||
  (result.reason !== undefined && TRANSIENT_REASONS.has(result.reason));

const isDeadDevice = (result: ApnsResult): boolean =>
  result.status === 410 || result.reason === "Unregistered";

interface EmergencyBlock {
  readonly retryAfter: number;
  readonly providerFingerprint: string | null;
}

interface ReservedDevice {
  readonly token: string;
  readonly ref: string;
  readonly leaseToken: string;
}

/**
 * Durable APNs fan-out and audit.
 *
 * The fail-closed block for a device lives in TWO places: the
 * `mobile_push_device_backoff` row and the in-process emergency map. The map
 * exists precisely for the case where the database write itself failed, so both
 * halves are cleared through one method.
 */
export class PushDeliveryService {
  private readonly emergencyBlocks = new Map<string, EmergencyBlock>();

  public constructor(
    private readonly repository: MobilePushRepository,
    private readonly apns: ApnsProvider,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  public clearDeviceDeliveryBlock(ref: string): boolean {
    return this.emergencyBlocks.delete(ref);
  }

  public providerConfigurationFingerprint(metadata: {
    environment: string;
    topic: string;
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          environment: metadata.environment,
          topic: metadata.topic,
          identity: this.apns.identityFingerprint()
        })
      )
      .digest("hex");
  }

  public async plan(notification: PushNotification): Promise<DeliveryPlan> {
    const devices = await this.repository.listDeviceTokens();
    const metadata = this.apns.deliveryMetadata({ critical: notification.critical === true });
    const providerFingerprint = this.providerConfigurationFingerprint(metadata);
    const retryAfterByDevice: Record<string, number> = {};
    const blockedFingerprintByDevice: Record<string, string | null> = {};

    for (const row of await this.repository.listDeviceBackoffs()) {
      const configurationChanged =
        row.blocked_fingerprint !== null && row.blocked_fingerprint !== providerFingerprint;
      retryAfterByDevice[row.device_ref] = configurationChanged
        ? row.retry_after
        : Math.max(row.retry_after, row.lease_until ?? 0);
      blockedFingerprintByDevice[row.device_ref] = row.blocked_fingerprint;
    }
    for (const token of devices) {
      const ref = deviceRef(token);
      const emergency = this.activeEmergencyBlock(ref, providerFingerprint, Date.now());
      if (!emergency) continue;
      retryAfterByDevice[ref] = Math.max(retryAfterByDevice[ref] ?? 0, emergency.retryAfter);
      if (emergency.providerFingerprint) {
        blockedFingerprintByDevice[ref] = emergency.providerFingerprint;
      }
    }

    return {
      fingerprint: this.deliveryFingerprint(devices, notification, metadata),
      configurationFingerprint: this.configurationFingerprint(devices, metadata),
      providerFingerprint,
      deviceRefs: devices.map(deviceRef).sort(),
      retryAfterByDevice,
      blockedFingerprintByDevice
    };
  }

  public deliver: PushDeliverer = async (notification, options = {}) => {
    const source = options.source ?? "alert";
    const alertKey = options.alertKey ?? null;
    const createdAt = Date.now();
    const deliveryId = randomUUID();
    const registeredDevices = (await this.repository.listDeviceTokens()).map((token) => ({
      token,
      ref: deviceRef(token)
    }));
    const eligible =
      options.eligibleDeviceRefs === null || options.eligibleDeviceRefs === undefined
        ? null
        : new Set(options.eligibleDeviceRefs);
    const candidates = registeredDevices.filter(
      (device) => eligible === null || eligible.has(device.ref)
    );
    const metadata = this.apns.deliveryMetadata({
      critical: notification.critical === true,
      now: createdAt
    });
    const registeredTokens = registeredDevices.map((device) => device.token);
    const fingerprint = this.deliveryFingerprint(registeredTokens, notification, metadata);
    const configFingerprint = this.configurationFingerprint(registeredTokens, metadata);
    const providerFingerprint = this.providerConfigurationFingerprint(metadata);

    const devices: ReservedDevice[] = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const leaseNow = Date.now();
      if (this.activeEmergencyBlock(candidate.ref, providerFingerprint, leaseNow)) continue;
      try {
        const reserved = await this.repository.reserveDevice({
          deviceRef: candidate.ref,
          now: leaseNow,
          leaseUntil: leaseNow + DEVICE_LEASE_MS,
          leaseToken,
          providerFingerprint
        });
        if (reserved) devices.push({ ...candidate, leaseToken });
      } catch (error) {
        // Do not bypass Retry-After when the reservation cannot be proven.
        this.log(
          `Push device reservation failed for ${candidate.ref}: ${
            error instanceof Error ? error.message : "unknown"
          }`
        );
      }
    }

    const stableCollapseId = collapseId(alertKey ?? deliveryId);
    const emptyStatus = registeredDevices.length ? "no_targets" : "no_devices";

    await this.audit("delivery insert", async () =>
      this.repository.insertDelivery({
        id: deliveryId,
        source,
        alertKey,
        createdAt,
        expiresAt: metadata.expiresAt,
        registeredDeviceCount: registeredDevices.length,
        apnsEnvironment: metadata.environment,
        apnsTopic: metadata.topic,
        criticalRequested: notification.critical === true,
        interruptionLevel: metadata.interruptionLevel,
        status: devices.length ? "sending" : emptyStatus
      })
    );

    if (!devices.length) {
      await this.audit("no-device completion", async () =>
        this.repository.finishDelivery({
          id: deliveryId,
          completedAt: Date.now(),
          acceptedDeviceCount: 0,
          failedDeviceCount: 0,
          status: emptyStatus
        })
      );
      return {
        deliveryId,
        status: emptyStatus,
        acceptedCount: 0,
        failedCount: 0,
        registeredDeviceCount: registeredDevices.length,
        attemptedDeviceCount: 0,
        interruptionLevel: metadata.interruptionLevel,
        environment: metadata.environment,
        expiresAt: metadata.expiresAt,
        fingerprint,
        configurationFingerprint: configFingerprint,
        providerFingerprint,
        retryable: false,
        retryAt: null,
        results: []
      };
    }

    const context = {
      deliveryId,
      expiration: metadata.expiration,
      collapseId: stableCollapseId,
      providerFingerprint
    };
    const settled = await Promise.allSettled(
      devices.map((device) => this.deliverToDevice(device, notification, context))
    );
    const results = await Promise.all(
      settled.map(async (entry, index) => {
        if (entry.status === "fulfilled") return entry.value;
        const device = devices[index];
        return this.unexpectedDeviceOutcome(
          device as ReservedDevice,
          providerFingerprint,
          entry.reason
        );
      })
    );

    const acceptedCount = results.filter((result) => result.ok).length;
    const failedCount = results.length - acceptedCount;
    const attemptedDeviceCount = results.filter((result) => result.attempts > 0).length;
    const status =
      acceptedCount === results.length ? "accepted" : acceptedCount > 0 ? "partial" : "failed";
    const retryableResults = results.filter((result) => result.retryable);
    const retryable = acceptedCount === 0 && retryableResults.length > 0;
    const retryAt = retryable
      ? Math.max(...retryableResults.map((result) => result.retryAt ?? 0))
      : null;

    await this.audit("delivery completion", async () =>
      this.repository.finishDelivery({
        id: deliveryId,
        completedAt: Date.now(),
        acceptedDeviceCount: acceptedCount,
        failedDeviceCount: failedCount,
        status
      })
    );

    return {
      deliveryId,
      status,
      acceptedCount,
      failedCount,
      registeredDeviceCount: registeredDevices.length,
      attemptedDeviceCount,
      interruptionLevel: metadata.interruptionLevel,
      environment: metadata.environment,
      expiresAt: metadata.expiresAt,
      fingerprint,
      configurationFingerprint: configFingerprint,
      providerFingerprint,
      retryable,
      retryAt,
      results
    };
  };

  private configurationFingerprint(
    devices: readonly string[],
    metadata: { environment: string; topic: string }
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: this.providerConfigurationFingerprint(metadata),
          devices: devices.map(deviceRef).sort()
        })
      )
      .digest("hex");
  }

  private deliveryFingerprint(
    devices: readonly string[],
    notification: PushNotification,
    metadata: { environment: string; topic: string }
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          configuration: this.configurationFingerprint(devices, metadata),
          title: notification.title ?? "",
          body: notification.body ?? "",
          critical: notification.critical === true
        })
      )
      .digest("hex");
  }

  private activeEmergencyBlock(
    ref: string,
    providerFingerprint: string,
    now: number
  ): EmergencyBlock | null {
    const block = this.emergencyBlocks.get(ref);
    if (!block) return null;
    if (block.providerFingerprint && block.providerFingerprint !== providerFingerprint) {
      this.clearDeviceDeliveryBlock(ref);
      return null;
    }
    if (block.retryAfter <= now) {
      this.clearDeviceDeliveryBlock(ref);
      return null;
    }
    return block;
  }

  private async audit<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      // Delivery must not become a failure just because its observability write
      // failed after APNs accepted it.
      this.log(`Push audit ${label} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }

  private async deliverToDevice(
    device: ReservedDevice,
    notification: PushNotification,
    context: {
      deliveryId: string;
      expiration: number;
      collapseId: string;
      providerFingerprint: string;
    }
  ): Promise<DeviceOutcome> {
    let result: ApnsResult = {
      ok: false,
      status: 0,
      reason: "not attempted",
      apnsId: null,
      retryAfter: null,
      transport: true
    };
    let retryDelay = 0;
    let attempts = 0;
    let standardAttempts = 0;
    let providerRefreshUsed = false;
    let lastAttemptedAt = 0;
    let lastAttemptOrder = 0;

    for (let attempt = 1; attempt <= MAX_STANDARD_ATTEMPTS + 1; attempt += 1) {
      if (retryDelay > 0) await sleep(retryDelay);

      attempts = attempt;
      const attemptedAt = Date.now();
      const attemptOrder = await this.repository.nextAttemptOrder();
      lastAttemptedAt = attemptedAt;
      lastAttemptOrder = attemptOrder;
      const requestedApnsId = randomUUID();
      try {
        result = await this.apns.send(device.token, {
          title: notification.title,
          body: notification.body,
          ...(notification.critical === undefined ? {} : { critical: notification.critical }),
          expiration: context.expiration,
          collapseId: context.collapseId,
          apnsId: requestedApnsId
        });
      } catch (error) {
        // send is intentionally non-throwing; retain a transport-shaped outcome
        // if a future implementation violates that boundary.
        result = {
          ok: false,
          status: 0,
          reason: error instanceof Error ? error.message : "unknown",
          apnsId: requestedApnsId,
          retryAfter: null,
          transport: true
        };
      }

      const expiredProviderToken = !result.ok && result.reason === "ExpiredProviderToken";
      const canRefreshProviderToken = expiredProviderToken && !providerRefreshUsed;
      const transient = !result.ok && (isTransient(result) || canRefreshProviderToken);
      await this.audit("attempt insert", async () =>
        this.repository.insertAttempt({
          deliveryId: context.deliveryId,
          deviceRef: device.ref,
          attemptNumber: attempt,
          attemptOrder,
          attemptedAt,
          durationMs: Date.now() - attemptedAt,
          status: Number(result.status) || 0,
          apnsId: result.apnsId ?? requestedApnsId,
          reason: result.reason ?? null,
          transient,
          accepted: result.ok
        })
      );

      // Retry ambiguous transport failures immediately. 429/5xx responses carry
      // explicit provider guidance and are deferred through the durable queue
      // rather than hammered inside one poll.
      if (result.ok) break;
      if (canRefreshProviderToken) {
        providerRefreshUsed = true;
        retryDelay = 0;
        continue;
      }
      standardAttempts += 1;
      if (!transient || result.transport !== true || standardAttempts === MAX_STANDARD_ATTEMPTS) {
        break;
      }
      retryDelay = RETRY_DELAYS_MS[standardAttempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
    }

    const deadDevice = !result.ok && isDeadDevice(result);
    const invalidationCutoff = Math.min(result.invalidatedAt ?? lastAttemptedAt, lastAttemptedAt);
    const pruneChanges = deadDevice
      ? await this.audit("dead-device prune", async () =>
          this.repository.deleteDeviceIfNotSeenAfter(device.token, invalidationCutoff)
        )
      : null;
    const pruned = pruneChanges === 1;
    if (pruned) {
      this.log(`Pruned dead APNs device ${device.ref} (${result.reason ?? result.status})`);
    }
    const reRegistered = deadDevice && !pruned;
    const retryable = !result.ok && (isTransient(result) || reRegistered);

    const outcome: DeviceOutcome = {
      device: device.ref,
      deviceRef: device.ref,
      ok: result.ok,
      status: Number(result.status) || 0,
      reason: result.reason ?? null,
      apnsId: result.apnsId ?? null,
      attempts,
      pruned,
      retryable,
      retryAt: retryable ? deferredRetryAt(result, Date.now()) : null,
      attemptedAt: lastAttemptedAt,
      attemptOrder: lastAttemptOrder,
      providerFingerprint: context.providerFingerprint,
      blockScope: pruned
        ? "device"
        : result.reason !== undefined && PAYLOAD_FAILURE_REASONS.has(result.reason)
          ? "payload"
          : "configuration"
    };

    try {
      await this.repository.recordDeviceOutcome(
        {
          deviceRef: outcome.deviceRef,
          pruned: outcome.pruned,
          retryable: outcome.retryable,
          retryAt: outcome.retryAt,
          attemptedAt: outcome.attemptedAt,
          attemptOrder: outcome.attemptOrder,
          blockedFingerprint:
            !outcome.ok && !outcome.retryable && outcome.blockScope === "configuration"
              ? outcome.providerFingerprint
              : null
        },
        device.leaseToken
      );
      this.clearDeviceDeliveryBlock(device.ref);
    } catch (error) {
      const configurationBlocked =
        !outcome.ok && !outcome.retryable && outcome.blockScope === "configuration";
      const failClosedUntil = configurationBlocked
        ? MAX_RETRY_AT
        : Math.max(outcome.retryAt ?? 0, Date.now() + DEVICE_LEASE_MS);
      if (outcome.retryable || configurationBlocked) {
        this.emergencyBlocks.set(device.ref, {
          retryAfter: failClosedUntil,
          providerFingerprint: configurationBlocked ? outcome.providerFingerprint : null
        });
      }
      try {
        const retained = await this.repository.retainFailedOutcomeLease({
          deviceRef: device.ref,
          leaseToken: device.leaseToken,
          leaseUntil: failClosedUntil,
          blockedFingerprint: configurationBlocked ? outcome.providerFingerprint : null
        });
        if (retained !== 1) throw new Error("device lease ownership changed before fallback");
      } catch (leaseError) {
        this.log(
          `Push fail-closed lease failed for ${device.ref}: ${
            leaseError instanceof Error ? leaseError.message : "unknown"
          }`
        );
      }
      this.log(
        `Push device outcome failed for ${device.ref}: ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }
    return outcome;
  }

  private async unexpectedDeviceOutcome(
    device: ReservedDevice,
    providerFingerprint: string,
    error: unknown
  ): Promise<DeviceOutcome> {
    const attemptedAt = Date.now();
    const retryAt = attemptedAt + DEVICE_LEASE_MS;
    this.emergencyBlocks.set(device.ref, { retryAfter: retryAt, providerFingerprint: null });
    try {
      await this.repository.retainFailedOutcomeLease({
        deviceRef: device.ref,
        leaseToken: device.leaseToken,
        leaseUntil: retryAt,
        blockedFingerprint: null
      });
    } catch (leaseError) {
      this.log(
        `Push fail-closed lease failed for ${device.ref}: ${
          leaseError instanceof Error ? leaseError.message : "unknown"
        }`
      );
    }
    this.log(
      `Push delivery worker failed for ${device.ref}: ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
    return {
      device: device.ref,
      deviceRef: device.ref,
      ok: false,
      status: 0,
      reason: "Internal delivery failure",
      apnsId: null,
      attempts: 0,
      pruned: false,
      retryable: true,
      retryAt,
      attemptedAt,
      attemptOrder: 0,
      providerFingerprint,
      blockScope: "configuration"
    };
  }
}
