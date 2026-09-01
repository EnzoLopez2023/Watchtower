import { randomUUID } from "node:crypto";
import type {
  AlertCandidateRow,
  AlertStateRepository,
  PendingAlertRow,
  PendingEventRow
} from "../db/repositories/watchtower/alertStateRepository.js";
import type { DashboardPayload, Severity, Subsystem } from "./infraStatus.js";
import type { DeliveryOutcome, DeliveryPlan, PushNotification } from "./pushDelivery.js";
import { asText } from "./values.js";

const RANK: Readonly<Record<string, number>> = { ok: 0, stale: 1, warn: 2, critical: 3 };
const AGENTS_SUBSYSTEM = "agents";
const NETWORK_OBSERVER_SUBSYSTEM = "network-observer";
const SAMPLE_POLICY_KIND = "consecutive-samples";
const SAMPLE_DEDUPE_PREFIX = "sample-confirmation:";
const DEFAULT_CONFIRMATION_SAMPLES = 3;
const MAX_CONFIRMATION_SAMPLES = 10;
const DELIVERY_CLAIM_MS = 2 * 60 * 1000;
const UNEXPECTED_RETRY_MS = 60 * 1000;

export interface AlertNote {
  readonly title: string;
  readonly body: string;
  readonly critical: boolean;
}

interface SamplePolicy {
  readonly sampleKey: string;
  readonly generationKey: string;
  readonly signature: string;
  readonly confirmable: boolean;
  readonly failureSamples: number;
  readonly recoverySamples: number;
}

/**
 * Durable per-device outcome for one pending alert, persisted as JSON in the
 * `device_dispositions` column. A device is *terminal* once it can never need
 * another send for this alert:
 *   - `status: "succeeded"` — APNs accepted (never resend: idempotency),
 *   - `status: "pruned"`    — 410 / BadDeviceToken, the token was unregistered,
 *   - `blockedFingerprint`  — a permanent provider/config/payload dead-letter,
 *     terminal only while the fingerprint is unchanged (a re-config re-arms it).
 * `retryAt` is the sole *non-terminal* failure: a transient error to retry once
 * its backoff elapses. Absence of an entry means the device has not been
 * attempted for this alert yet and is a fresh target.
 */
interface DeviceDisposition {
  readonly status?: "succeeded" | "pruned";
  readonly retryAt?: number;
  readonly blockScope?: string;
  readonly blockedFingerprint?: string;
}

type DeviceState = "eligible" | "waiting" | "terminal";

/**
 * Classifies one device for a pending alert against the live delivery plan.
 *
 * `eligible`  — send to it on this cycle.
 * `waiting`   — not terminal, but backed off (per-device retry window or the
 *               shared provider backoff has not elapsed); keep the alert pending.
 * `terminal`  — succeeded, pruned, or permanently blocked under the current
 *               provider/config/payload fingerprint; never resend.
 *
 * The `eligible` verdict is byte-for-byte the historical filter, so the live
 * eligibility snapshot is unchanged: `plan.deviceRefs` is recomputed from the
 * current device registry every cycle, and a device with no disposition is a
 * fresh target. The added `terminal` verdict is what lets a partially delivered
 * alert resolve without re-sending to devices that already succeeded.
 */
function classifyDevice(
  ref: string,
  dispositions: Record<string, DeviceDisposition>,
  plan: DeliveryPlan,
  now: number
): DeviceState {
  const disposition = dispositions[ref];
  const providerBlocked = plan.blockedFingerprintByDevice[ref];
  const globallyConfigBlocked = providerBlocked != null && providerBlocked === plan.providerFingerprint;

  if (disposition?.status === "succeeded" || disposition?.status === "pruned") return "terminal";
  if (globallyConfigBlocked) return "terminal";
  if (disposition?.blockedFingerprint) {
    const currentFingerprint =
      disposition.blockScope === "payload" ? plan.fingerprint : plan.configurationFingerprint;
    if (disposition.blockedFingerprint === currentFingerprint) return "terminal";
  }
  if ((plan.retryAfterByDevice[ref] ?? 0) > now) return "waiting";
  if (disposition?.retryAt !== undefined && disposition.retryAt !== null) {
    return disposition.retryAt <= now ? "eligible" : "waiting";
  }
  return "eligible";
}

/**
 * A pending alert is resolved — and only then removed — once at least one device
 * has actually received it and every live target device has reached a terminal
 * state. Requiring a success mirrors production, which removes an alert solely on
 * `acceptedCount > 0`: a fan-out where every device pruned/blocked without a
 * single acceptance is retained so a device registered later can still receive
 * it, rather than being silently discarded.
 */
function alertResolved(
  dispositions: Record<string, DeviceDisposition>,
  plan: DeliveryPlan,
  now: number
): boolean {
  const hasSuccess = Object.values(dispositions).some((entry) => entry.status === "succeeded");
  if (!hasSuccess) return false;
  return plan.deviceRefs.every((ref) => classifyDevice(ref, dispositions, plan, now) === "terminal");
}

export interface AlertEngineDependencies {
  readonly repository: AlertStateRepository;
  readonly buildStatus: () => Promise<DashboardPayload>;
  readonly deliver: (
    notification: PushNotification,
    options: { source: string; alertKey: string; eligibleDeviceRefs: readonly string[] }
  ) => Promise<DeliveryOutcome>;
  readonly plan: (notification: PushNotification) => Promise<DeliveryPlan>;
  readonly apnsConfigured: () => boolean;
  readonly log?: (message: string) => void;
}

const escalationOf = (subsystem: Subsystem): number => Number(subsystem.escalation) || 0;

function confirmationSamples(value: number | undefined): number {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CONFIRMATION_SAMPLES
    ? value
    : DEFAULT_CONFIRMATION_SAMPLES;
}

function notificationPolicyOf(subsystem: Subsystem): SamplePolicy | null {
  const policy =
    subsystem.key === NETWORK_OBSERVER_SUBSYSTEM || subsystem.key === AGENTS_SUBSYSTEM
      ? subsystem.notificationPolicy
      : undefined;
  if (policy?.kind !== SAMPLE_POLICY_KIND) return null;
  const sampleKey = asText(policy.sampleKey);
  const signature = asText(policy.signature);
  if (!sampleKey || !signature) return null;
  return {
    sampleKey,
    generationKey: String(policy.generationKey ?? sampleKey),
    signature,
    confirmable: policy.confirmable !== false,
    failureSamples: confirmationSamples(policy.failureSamples),
    recoverySamples: confirmationSamples(policy.recoverySamples)
  };
}

function sampleDedupeKey(candidate: {
  subsystem: string;
  targetSeverity: string;
  targetStage: string;
  signature: string;
}): string {
  return (
    `${SAMPLE_DEDUPE_PREFIX}${candidate.subsystem}:${candidate.targetSeverity}:` +
    `${candidate.targetStage}:${candidate.signature}`
  );
}

/**
 * True only when every member of the previous generation is present in the
 * current one with a strictly newer observation, which is what proves the
 * observer produced a fresh sample rather than repeating the last one.
 */
function generationAdvanced(previousKey: string, currentKey: string): boolean {
  if (previousKey === currentKey) return false;
  try {
    const previous = JSON.parse(previousKey) as Record<string, unknown>;
    const current = JSON.parse(currentKey) as Record<string, unknown>;
    const previousMembers = Object.keys(previous).sort();
    const currentMembers = Object.keys(current).sort();
    return (
      previousMembers.length > 0 &&
      previousMembers.length === currentMembers.length &&
      previousMembers.every((member, index) => {
        const previousValue = Number(previous[member]);
        const currentValue = Number(current[member]);
        return (
          member === currentMembers[index] &&
          Number.isFinite(previousValue) &&
          Number.isFinite(currentValue) &&
          currentValue > previousValue
        );
      })
    );
  } catch {
    return true;
  }
}

/**
 * Human wording for a transition on one subsystem. `escalated` means the severity
 * held but the situation got measurably worse.
 */
export function describe(
  subsystem: Subsystem,
  oldSeverity: string | undefined,
  escalated = false
): AlertNote | null {
  const now = RANK[subsystem.severity] ?? 0;
  const before = RANK[oldSeverity ?? ""] ?? 0;
  const worsened = now > before;
  const recovered = now === 0 && before >= (RANK.warn ?? 2);

  if (
    subsystem.key === NETWORK_OBSERVER_SUBSYSTEM &&
    subsystem.severity === "stale" &&
    before < (RANK.warn ?? 2)
  ) {
    const body = subsystem.detail ? `${subsystem.headline} — ${subsystem.detail}` : subsystem.headline;
    return { title: `⚠️ ${subsystem.label}: ${subsystem.headline}`, body, critical: false };
  }
  if (recovered) {
    return { title: `✅ ${subsystem.label} recovered`, body: subsystem.headline, critical: false };
  }
  if ((worsened || escalated) && now >= (RANK.warn ?? 2)) {
    const icon = subsystem.severity === "critical" ? "🚨" : "⚠️";
    const body = subsystem.detail ? `${subsystem.headline} — ${subsystem.detail}` : subsystem.headline;
    const title =
      escalated && !worsened
        ? `${icon} ${subsystem.label} worsening: ${subsystem.headline}`
        : `${icon} ${subsystem.label}: ${subsystem.headline}`;
    return { title, body, critical: subsystem.severity === "critical" };
  }
  return null;
}

function parseDeviceDispositions(raw: string | null): Record<string, DeviceDisposition> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, DeviceDisposition>)
      : {};
  } catch {
    return {};
  }
}

interface EligibleDelivery {
  readonly dispositions: Record<string, DeviceDisposition>;
  readonly eligibleDeviceRefs: string[];
  readonly plan: DeliveryPlan;
}

export class AlertEngine {
  private running = false;

  public constructor(private readonly dependencies: AlertEngineDependencies) {}

  public async run(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { repository, buildStatus } = this.dependencies;
      const status = await buildStatus();
      if (signal?.aborted) return;
      const now = Date.now();
      await repository.syncEventQueue(
        (status.events ?? []).map((event) => ({
          id: event.id,
          title: event.title,
          body: event.body,
          critical: event.critical !== false,
          deliveryKey: randomUUID()
        })),
        now
      );

      const deliveryReady =
        this.dependencies.apnsConfigured() && (await repository.countDevices()) > 0;
      const previousStates = new Map(
        (await repository.listState()).map((row) => [row.subsystem, row] as const)
      );

      for (const subsystem of status.subsystems) {
        if (subsystem.informational) continue;
        const previous = previousStates.get(subsystem.key);
        const observerIsStale =
          subsystem.key === NETWORK_OBSERVER_SUBSYSTEM && subsystem.severity === "stale";
        if (observerIsStale) {
          // A stale observer is an interruption in the sample stream, not evidence
          // that a confirmed incident recovered or became less severe.
          await repository.clearSamplePolicyState(subsystem.key, now);
          if (previous && (RANK[previous.severity] ?? 0) >= (RANK.warn ?? 2)) continue;
        }

        const policy = observerIsStale ? null : notificationPolicyOf(subsystem);
        if (policy) {
          await this.applyNotificationPolicy(subsystem, policy, now);
          continue;
        }
        if (subsystem.key === NETWORK_OBSERVER_SUBSYSTEM && !observerIsStale) {
          await repository.clearSamplePolicyState(subsystem.key, now);
        }

        const escalation = escalationOf(subsystem);
        const stage = String(escalation);
        if (previous === undefined) {
          await repository.upsertState(subsystem.key, subsystem.severity, now, stage);
          continue;
        }

        const oldSeverity = previous.severity;
        // NULL stage means a row written before escalation tracking existed;
        // treat it as the current level so the backfill cannot fire a phantom.
        const oldEscalation = previous.stage === null ? escalation : Number(previous.stage) || 0;
        const severityChanged = oldSeverity !== subsystem.severity;
        const escalated = !severityChanged && escalation > oldEscalation;

        if (!severityChanged && !escalated) {
          // Still persist, so a level that drifts down rearms the alert if it
          // climbs back up.
          if (previous.stage !== stage) {
            await repository.reconcileUnnotifiedState(subsystem.key, subsystem.severity, now, stage);
          }
          continue;
        }

        const note = describe(subsystem, oldSeverity, escalated);
        if (note) {
          await repository.stagePendingAlert({
            id: randomUUID(),
            dedupeKey: `${subsystem.key}:${subsystem.severity}:${stage}`,
            subsystem: subsystem.key,
            title: note.title,
            body: note.body,
            critical: note.critical,
            targetSeverity: subsystem.severity,
            targetStage: stage,
            now
          });
        } else {
          // Improvements that do not warrant a push still have to rearm the
          // baseline, or a later worsening can be hidden by stale state.
          await repository.reconcileUnnotifiedState(subsystem.key, subsystem.severity, now, stage);
        }
      }

      // Drain subsystem transitions first, then one-shots. Every lease starts
      // immediately before its own network call.
      if (!deliveryReady || signal?.aborted) return;
      for (const pending of await repository.listPendingAlerts(Date.now())) {
        if (signal?.aborted) return;
        const notification: PushNotification = {
          title: pending.title,
          body: pending.body,
          critical: pending.critical !== 0
        };
        const claimNow = Date.now();
        const plan = await this.eligibleDelivery(pending.device_dispositions, notification, claimNow);
        if (!plan.eligibleDeviceRefs.length) continue;
        const claimToken = randomUUID();
        if (
          !await repository.claimPendingAlert(
            pending.id,
            claimNow,
            claimNow + DELIVERY_CLAIM_MS,
            claimToken
          )
        ) {
          continue;
        }
        if (!(await this.samplePendingIsCurrent(pending))) {
          await repository.deleteClaimedPendingAlert(pending.id, claimToken);
          continue;
        }
        await this.deliverClaimedAlert(pending, claimToken, plan);
      }

      if (signal?.aborted) return;
      for (const pending of await repository.listPendingEvents(Date.now())) {
        if (signal?.aborted) return;
        const claimNow = Date.now();
        const notification: PushNotification = {
          title: `🚨 ${pending.title ?? ""}`,
          body: pending.body ?? "",
          critical: pending.critical !== 0
        };
        const plan = await this.eligibleDelivery(pending.device_dispositions, notification, claimNow);
        if (!plan.eligibleDeviceRefs.length) continue;
        const claimToken = randomUUID();
        const deliveryKey = pending.delivery_key ?? randomUUID();
        if (
          !await repository.claimPendingEvent(
            pending.id,
            claimNow,
            claimNow + DELIVERY_CLAIM_MS,
            claimToken,
            deliveryKey
          )
        ) {
          continue;
        }
        await this.deliverClaimedEvent({ ...pending, delivery_key: deliveryKey }, claimToken, plan);
      }
    } catch (error) {
      this.log(`Alert check failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      this.running = false;
    }
  }

  private log(message: string): void {
    this.dependencies.log?.(message);
  }

  private async applyNotificationPolicy(
    subsystem: Subsystem,
    policy: SamplePolicy,
    now: number
  ): Promise<void> {
    const { repository } = this.dependencies;
    const previous = await repository.getState(subsystem.key);
    const escalation = escalationOf(subsystem);
    const stage = String(escalation);

    if (!previous) {
      await repository.clearSamplePolicyState(subsystem.key, now);
      await repository.upsertState(subsystem.key, subsystem.severity, now, stage);
      return;
    }
    if (!policy.confirmable) {
      await repository.clearSamplePolicyState(subsystem.key, now);
      return;
    }

    const target = {
      subsystem: subsystem.key,
      targetSeverity: subsystem.severity as string,
      targetStage: stage,
      signature: policy.signature
    };
    const existing = await repository.getCandidate(subsystem.key);
    const matching =
      existing !== undefined &&
      existing.targetSeverity === target.targetSeverity &&
      existing.targetStage === target.targetStage &&
      existing.signature === target.signature;
    const claimed = await repository.getClaimedSampleAlert(subsystem.key, now);
    const contradictsClaim = claimed !== undefined && sampleDedupeKey(target) !== claimed.dedupe_key;
    const sameAsAccepted = previous.severity === subsystem.severity && previous.stage === stage;
    const continuingReconciliation =
      sameAsAccepted && matching && existing !== undefined && existing.reconcile === 1;
    if (sameAsAccepted && !contradictsClaim && !continuingReconciliation) {
      await repository.clearSamplePolicyState(subsystem.key, now);
      return;
    }

    const oldEscalation = previous.stage === null ? escalation : Number(previous.stage) || 0;
    const severityChanged = previous.severity !== subsystem.severity;
    const escalated = !severityChanged && escalation > oldEscalation;
    const comparisonSeverity =
      sameAsAccepted && claimed ? claimed.target_severity : previous.severity;
    const signatureCorrection = sameAsAccepted && comparisonSeverity === subsystem.severity;
    const note = describe(subsystem, comparisonSeverity, escalated || signatureCorrection);
    if (!note) {
      await repository.clearSamplePolicyState(subsystem.key, now);
      // Silence does not prove a confirmed incident recovered.
      if (
        !(
          subsystem.severity === "stale" &&
          (RANK[previous.severity] ?? 0) >= (RANK.warn ?? 2)
        )
      ) {
        await repository.upsertState(subsystem.key, subsystem.severity, now, stage);
      }
      return;
    }

    if (
      matching &&
      existing !== undefined &&
      !generationAdvanced(existing.lastSampleKey, policy.generationKey)
    ) {
      return;
    }
    if (!matching) await repository.deleteCancelablePendingAlerts(subsystem.key, now);

    const candidate = {
      ...target,
      consecutiveCount: matching && existing !== undefined ? existing.consecutiveCount + 1 : 1,
      firstSeen: matching && existing !== undefined ? existing.firstSeen : now,
      lastSeen: now,
      lastSampleKey: policy.generationKey,
      reconcile: contradictsClaim || continuingReconciliation ? 1 : 0
    };
    await repository.upsertCandidate(candidate);

    const requiredSamples =
      subsystem.severity === "ok" ? policy.recoverySamples : policy.failureSamples;
    if (candidate.consecutiveCount < requiredSamples) return;

    await repository.stagePendingAlertOnce({
      id: randomUUID(),
      dedupeKey: sampleDedupeKey(candidate),
      subsystem: subsystem.key,
      title: note.title,
      body: note.body,
      critical: note.critical,
      targetSeverity: subsystem.severity,
      targetStage: stage,
      now
    });
  }

  private async samplePendingIsCurrent(pending: PendingAlertRow): Promise<boolean> {
    if (!pending.dedupe_key.startsWith(SAMPLE_DEDUPE_PREFIX)) return true;
    const candidate = await this.dependencies.repository.getCandidate(pending.subsystem);
    return candidate !== undefined && sampleDedupeKey(candidate) === pending.dedupe_key;
  }

  private async eligibleDelivery(
    rawDispositions: string | null,
    notification: PushNotification,
    now: number
  ): Promise<EligibleDelivery> {
    const dispositions = parseDeviceDispositions(rawDispositions);
    const plan = await this.dependencies.plan(notification);
    const eligibleDeviceRefs = plan.deviceRefs.filter(
      (ref) => classifyDevice(ref, dispositions, plan, now) === "eligible"
    );
    return { dispositions, eligibleDeviceRefs, plan };
  }

  /**
   * Folds one delivery's per-device results into the durable disposition map.
   * Acceptances and prunes are recorded as *terminal* rather than deleted, so a
   * retained alert never resends to a device that already succeeded and a pruned
   * device does not block the alert's resolution.
   */
  private mergedDispositions(
    dispositions: Record<string, DeviceDisposition>,
    delivery: DeliveryOutcome
  ): Record<string, DeviceDisposition> {
    const merged: Record<string, DeviceDisposition> = { ...dispositions };
    for (const result of delivery.results) {
      if (result.ok) {
        merged[result.deviceRef] = { status: "succeeded" };
      } else if (result.pruned) {
        merged[result.deviceRef] = { status: "pruned" };
      } else if (result.retryable) {
        merged[result.deviceRef] = { retryAt: result.retryAt ?? 0 };
      } else {
        const blockScope = result.blockScope === "payload" ? "payload" : "configuration";
        merged[result.deviceRef] = {
          blockScope,
          blockedFingerprint:
            blockScope === "payload" ? delivery.fingerprint : delivery.configurationFingerprint
        };
      }
    }
    return merged;
  }

  private unexpectedDispositions(
    dispositions: Record<string, DeviceDisposition>,
    eligibleDeviceRefs: readonly string[]
  ): Record<string, DeviceDisposition> {
    const retryAt = Date.now() + UNEXPECTED_RETRY_MS;
    const merged: Record<string, DeviceDisposition> = { ...dispositions };
    for (const ref of eligibleDeviceRefs) merged[ref] = { retryAt };
    return merged;
  }

  private async deliverClaimedAlert(
    pending: PendingAlertRow,
    claimToken: string,
    plan: EligibleDelivery
  ): Promise<void> {
    const { repository } = this.dependencies;
    const notification: PushNotification = {
      title: pending.title,
      body: pending.body,
      critical: pending.critical !== 0
    };
    try {
      const delivery = await this.dependencies.deliver(notification, {
        source: "subsystem",
        alertKey: `pending:${pending.id}`,
        eligibleDeviceRefs: plan.eligibleDeviceRefs
      });
      const merged = this.mergedDispositions(plan.dispositions, delivery);
      if (alertResolved(merged, plan.plan, Date.now())) {
        const accepted = await repository.acceptPendingAlert(
          pending.id,
          claimToken,
          Date.now(),
          sampleDedupeKey
        );
        if (!accepted) {
          this.log(`Alert ${pending.id} was accepted after its delivery lease changed`);
        }
      } else {
        await this.deferClaimedAlert(pending, claimToken, JSON.stringify(merged));
        this.log(
          delivery.acceptedCount > 0
            ? `Alert ${pending.id} partially delivered; retained for unresolved devices (delivery ${delivery.deliveryId})`
            : `Alert not accepted by APNs; retained for retry (delivery ${delivery.deliveryId})`
        );
      }
    } catch (error) {
      await this.deferClaimedAlert(
        pending,
        claimToken,
        JSON.stringify(this.unexpectedDispositions(plan.dispositions, plan.eligibleDeviceRefs))
      );
      throw error;
    }
  }

  private async deferClaimedAlert(
    pending: PendingAlertRow,
    claimToken: string,
    dispositions: string
  ): Promise<boolean> {
    const { repository } = this.dependencies;
    const claimed = await repository.getClaimedPendingAlert(pending.id, claimToken);
    if (!claimed) return false;
    if (!(await this.samplePendingIsCurrent(claimed))) {
      return await repository.deleteClaimedPendingAlert(claimed.id, claimToken) > 0;
    }
    return await repository.deferPendingAlert(claimed.id, claimToken, dispositions);
  }

  private async deliverClaimedEvent(
    event: PendingEventRow,
    claimToken: string,
    plan: EligibleDelivery
  ): Promise<void> {
    const { repository } = this.dependencies;
    const notification: PushNotification = {
      title: `🚨 ${event.title ?? ""}`,
      body: event.body ?? "",
      critical: event.critical !== 0
    };
    try {
      const delivery = await this.dependencies.deliver(notification, {
        source: "event",
        alertKey: `event:${event.delivery_key ?? event.id}`,
        eligibleDeviceRefs: plan.eligibleDeviceRefs
      });
      const merged = this.mergedDispositions(plan.dispositions, delivery);
      if (alertResolved(merged, plan.plan, Date.now())) {
        if (await repository.acceptEvent(event.id, claimToken, Date.now()) === 0) {
          this.log(`Event ${event.id} was accepted after its delivery lease changed`);
        }
      } else {
        await repository.releaseEvent(event.id, claimToken, JSON.stringify(merged));
        this.log(
          delivery.acceptedCount > 0
            ? `Event ${event.id} partially delivered; retained for unresolved devices (delivery ${delivery.deliveryId})`
            : `Event not accepted by APNs; retained for retry (delivery ${delivery.deliveryId})`
        );
      }
    } catch (error) {
      await repository.releaseEvent(
        event.id,
        claimToken,
        JSON.stringify(this.unexpectedDispositions(plan.dispositions, plan.eligibleDeviceRefs))
      );
      throw error;
    }
  }
}

export type { AlertCandidateRow, Severity };
