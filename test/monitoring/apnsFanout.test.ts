// Regression coverage for the accepted "APNs partial fan-out" defect.
//
// The engine used to accept/delete a whole pending alert the instant any single
// device was accepted, so a co-targeted device that failed transiently never got
// the push. The fix records durable PER-DEVICE dispositions in the existing
// `device_dispositions` column and only removes a pending alert once every live
// target device has reached a terminal state (succeeded / pruned / permanently
// blocked), retrying only the unresolved devices and never re-sending a success.
//
// Eligibility-snapshot rule under test (production-consistent, Hearth
// f0b05fc1): there is NO frozen device snapshot. `eligibleDelivery` recomputes
// `plan.deviceRefs` from the live registry every cycle, so a device registered
// while an alert is still pending is picked up on the next cycle, while a device
// that registers after the alert has resolved never resurrects it.

import assert from "node:assert/strict";
import test from "node:test";
import type { SqliteDatabase } from "../../lib/db/connection.js";
import { SqliteAlertStateRepository } from "../../lib/db/repositories/watchtower/alertStateRepository.js";
import { SqliteMobilePushRepository } from "../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { AlertEngine } from "../../lib/monitoring/alertEngine.js";
import type { DashboardPayload, Subsystem } from "../../lib/monitoring/infraStatus.js";
import { PushDeliveryService, deviceRef } from "../../lib/monitoring/pushDelivery.js";
import type { ApnsResult } from "../../server/clients/apns.js";
import { openTestDatabase, removeDatabase, stubApns } from "../fixtures/monitoring/harness.js";

const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);
const DEVICE_C = "c".repeat(64);
const REF_A = deviceRef(DEVICE_A);
const REF_B = deviceRef(DEVICE_B);
const REF_C = deviceRef(DEVICE_C);

const ACCEPTED: ApnsResult = { ok: true, status: 200, apnsId: "ok", retryAfter: null, transport: false };
const TRANSIENT: ApnsResult = {
  ok: false,
  status: 503,
  reason: "ServiceUnavailable",
  apnsId: null,
  retryAfter: null,
  transport: false
};
const TRANSPORT_FAIL: ApnsResult = {
  ok: false,
  status: 0,
  reason: "socket hang up",
  apnsId: null,
  retryAfter: null,
  transport: true
};
const UNREGISTERED: ApnsResult = {
  ok: false,
  status: 410,
  reason: "Unregistered",
  apnsId: null,
  retryAfter: null,
  transport: false
};
const CONFIG_BLOCK: ApnsResult = {
  ok: false,
  status: 403,
  reason: "BadDeviceToken",
  apnsId: null,
  retryAfter: null,
  transport: false
};

interface StoredDisposition {
  readonly status?: "succeeded" | "pruned";
  readonly retryAt?: number;
  readonly blockScope?: string;
  readonly blockedFingerprint?: string;
}

function payload(subsystems: readonly Subsystem[], events: DashboardPayload["events"] = []): DashboardPayload {
  return {
    schema: 1,
    generatedAt: Date.now(),
    overall: { severity: "ok", issueCount: 0, summary: "" },
    subsystems,
    events
  };
}

function tile(overrides: Partial<Subsystem> & { key: string }): Subsystem {
  return {
    label: overrides.key,
    severity: "ok",
    headline: "Online",
    detail: null,
    ts: Date.now(),
    escalation: 0,
    ...overrides
  };
}

const OK_UPS = payload([tile({ key: "ups", severity: "ok", headline: "Online" })]);
const CRITICAL_UPS = payload([
  tile({ key: "ups", severity: "critical", headline: "On Battery", detail: "18 min left", escalation: 1 })
]);

/**
 * Simulates the retry backoff window elapsing without waiting real wall-clock
 * time: it clears the shared per-device backoff (leaving permanent config blocks
 * intact) and rewinds every per-device `retryAt` to the past, while preserving
 * terminal `succeeded`/`pruned`/`blocked` markers so a resolved device is never
 * resurrected.
 */
function fastForwardRetries(database: SqliteDatabase): void {
  database
    .prepare(
      "UPDATE mobile_push_device_backoff SET retry_after = 0, lease_until = 0, lease_token = NULL WHERE blocked_fingerprint IS NULL"
    )
    .run();
  const alerts = database
    .prepare("SELECT id, device_dispositions FROM mobile_pending_alerts WHERE device_dispositions IS NOT NULL")
    .all() as Array<{ id: string; device_dispositions: string }>;
  for (const alert of alerts) {
    const parsed = JSON.parse(alert.device_dispositions) as Record<string, StoredDisposition>;
    let changed = false;
    for (const ref of Object.keys(parsed)) {
      const entry = parsed[ref];
      if (entry && typeof entry.retryAt === "number") {
        parsed[ref] = { ...entry, retryAt: 0 };
        changed = true;
      }
    }
    if (changed) {
      database
        .prepare("UPDATE mobile_pending_alerts SET device_dispositions = ? WHERE id = ?")
        .run(JSON.stringify(parsed), alert.id);
    }
  }
}

function createFanout(prefix: string) {
  const { database, path } = openTestDatabase(prefix);
  const alerts = new SqliteAlertStateRepository(database);
  const pushRepository = new SqliteMobilePushRepository(database);
  const sends: Array<{ ref: string; token: string; title: string }> = [];
  let respond: (ref: string, token: string) => ApnsResult = () => ACCEPTED;
  let status: DashboardPayload = payload([]);

  // A fresh engine + push service over the same database models a crash/restart:
  // no in-memory disposition state carries over, only the durable rows do.
  const makeEngine = (): AlertEngine => {
    const apns = stubApns({
      send: async (token, notification) => {
        const ref = deviceRef(token);
        sends.push({ ref, token, title: notification.title });
        return respond(ref, token);
      }
    });
    const push = new PushDeliveryService(pushRepository, apns);
    return new AlertEngine({
      repository: alerts,
      buildStatus: async () => status,
      deliver: (notification, options) => push.deliver(notification, options),
      plan: (notification) => push.plan(notification),
      apnsConfigured: () => apns.configured()
    });
  };

  return {
    database,
    alerts,
    sends,
    setStatus(next: DashboardPayload): void {
      status = next;
    },
    setResponder(fn: (ref: string, token: string) => ApnsResult): void {
      respond = fn;
    },
    makeEngine,
    async registerDevice(token: string, seenOffsetMs = 0): Promise<void> {
      await pushRepository.registerDevice({
        token,
        platform: "ios",
        appVersion: "1.0",
        now: Date.now() - seenOffsetMs,
        deviceRef: deviceRef(token)
      });
    },
    pendingCount(): number {
      const row = database.prepare("SELECT COUNT(*) AS c FROM mobile_pending_alerts").get() as { c: number };
      return row.c;
    },
    deviceCount(): number {
      const row = database.prepare("SELECT COUNT(*) AS c FROM mobile_devices").get() as { c: number };
      return row.c;
    },
    dispositions(): Record<string, StoredDisposition> {
      const row = database
        .prepare("SELECT device_dispositions FROM mobile_pending_alerts ORDER BY created_at LIMIT 1")
        .get() as { device_dispositions: string | null } | undefined;
      return row?.device_dispositions ? (JSON.parse(row.device_dispositions) as Record<string, StoredDisposition>) : {};
    },
    blockedFingerprint(ref: string): string | null {
      const row = database
        .prepare("SELECT blocked_fingerprint FROM mobile_push_device_backoff WHERE device_ref = ?")
        .get(ref) as { blocked_fingerprint: string | null } | undefined;
      return row?.blocked_fingerprint ?? null;
    },
    sendCount(ref: string): number {
      return sends.filter((entry) => entry.ref === ref).length;
    },
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

type Fanout = ReturnType<typeof createFanout>;

/** Records the baseline "ok" state, then drives the ups tile to critical. */
async function armWorseningAlert(fanout: Fanout): Promise<void> {
  fanout.setStatus(OK_UPS);
  await fanout.makeEngine().run();
  fanout.setStatus(CRITICAL_UPS);
}

test("apns fan-out: one success + one transient failure keeps the alert pending", async () => {
  const fanout = createFanout("fanout-partial");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? TRANSIENT : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();

    assert.equal(fanout.sends.length, 2, "both devices are attempted on the first fan-out");
    assert.equal(fanout.pendingCount(), 1, "a transient failure retains the pending alert");

    const dispositions = fanout.dispositions();
    assert.equal(dispositions[REF_A]?.status, "succeeded", "the accepted device is recorded terminal");
    assert.equal(typeof dispositions[REF_B]?.retryAt, "number", "the failed device carries a retry disposition");
    assert.equal(dispositions[REF_B]?.status, undefined, "a transient failure is not terminal");
    assert.equal((await fanout.alerts.getState("ups"))?.severity, "ok", "state advances only on full resolution");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: the retry targets only the failed device and never re-sends a success", async () => {
  const fanout = createFanout("fanout-retry-target");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? TRANSIENT : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();
    assert.equal(fanout.sendCount(REF_A), 1);
    assert.equal(fanout.sendCount(REF_B), 1);

    // The device keeps failing transiently: the alert must stay pending and only
    // the failed device may be re-attempted.
    fastForwardRetries(fanout.database);
    await fanout.makeEngine().run();

    assert.equal(fanout.sendCount(REF_A), 1, "the already-accepted device is never pushed a second time");
    assert.equal(fanout.sendCount(REF_B), 2, "only the unresolved device is retried");
    assert.equal(fanout.pendingCount(), 1, "the alert remains pending while a device is unresolved");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: resolving the last unresolved device removes the pending alert", async () => {
  const fanout = createFanout("fanout-final-resolve");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? TRANSIENT : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();
    assert.equal(fanout.pendingCount(), 1);

    // Second cycle: the previously failing device now succeeds.
    fastForwardRetries(fanout.database);
    fanout.setResponder(() => ACCEPTED);
    await fanout.makeEngine().run();

    assert.equal(fanout.sendCount(REF_A), 1, "the first-cycle success is never duplicated");
    assert.equal(fanout.sendCount(REF_B), 2, "the failed device is retried exactly once more");
    assert.equal(fanout.pendingCount(), 0, "every device resolved, so the alert is removed");
    assert.equal((await fanout.alerts.getState("ups"))?.severity, "critical", "state advances on resolution");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a 410 BadDeviceToken is terminal (pruned) and does not block resolution", async () => {
  const fanout = createFanout("fanout-pruned");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B, 1000); // last_seen in the past so a 410 prunes it
    fanout.setResponder((ref) => (ref === REF_B ? UNREGISTERED : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();

    assert.equal(fanout.pendingCount(), 0, "a pruned co-device does not keep the alert pending");
    assert.equal(fanout.deviceCount(), 1, "the dead token is pruned from the registry");
    assert.equal(fanout.sendCount(REF_A), 1);
    assert.equal((await fanout.alerts.getState("ups"))?.severity, "critical", "state advances once resolved");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a permanent provider block is terminal and does not block resolution", async () => {
  const fanout = createFanout("fanout-blocked");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? CONFIG_BLOCK : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();

    assert.equal(fanout.pendingCount(), 0, "a permanently blocked co-device does not keep the alert pending");
    assert.ok(fanout.blockedFingerprint(REF_B), "the blocked device records a provider/config dead letter");
    assert.equal(fanout.sendCount(REF_A), 1);
    assert.equal((await fanout.alerts.getState("ups"))?.severity, "critical", "state advances once resolved");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a crash/restart resumes only the unresolved device and never re-sends a success", async () => {
  const fanout = createFanout("fanout-restart");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? TRANSIENT : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run(); // A accepted, B deferred
    assert.equal(fanout.pendingCount(), 1);
    assert.equal(fanout.sendCount(REF_A), 1);

    // "Crash": drop the in-memory engine/push service and rebuild from the DB.
    fastForwardRetries(fanout.database);
    fanout.setResponder(() => ACCEPTED);
    const resumed = fanout.makeEngine();
    await resumed.run();

    assert.equal(fanout.sendCount(REF_A), 1, "the durable success survives the restart and is not re-sent");
    assert.equal(fanout.sendCount(REF_B), 2, "the resumed cycle targets only the unresolved device");
    assert.equal(fanout.pendingCount(), 0, "resolution completes after the restart");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a device exhausts the three standard tries per delivery, then is retained for retry", async () => {
  const fanout = createFanout("fanout-exhaust");
  try {
    await fanout.registerDevice(DEVICE_A);
    await fanout.registerDevice(DEVICE_B);
    fanout.setResponder((ref) => (ref === REF_B ? TRANSPORT_FAIL : ACCEPTED));

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();

    // The existing retry policy (MAX_STANDARD_ATTEMPTS = 3) is preserved exactly:
    // the transport-failing device makes three attempts inside one delivery.
    const attempts = fanout.database
      .prepare("SELECT COUNT(*) AS c FROM mobile_push_attempts WHERE device_ref = ?")
      .get(REF_B) as { c: number };
    assert.equal(attempts.c, 3, "the failed device made exactly three standard tries");

    assert.equal(fanout.pendingCount(), 1, "an exhausted-but-retryable device retains the alert");
    const dispositions = fanout.dispositions();
    assert.equal(dispositions[REF_A]?.status, "succeeded");
    assert.equal(typeof dispositions[REF_B]?.retryAt, "number", "the device is deferred with a backoff, not dropped");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a device registered while the alert is pending is picked up, not lost", async () => {
  const fanout = createFanout("fanout-late-register");
  try {
    // Only device A exists when the alert is created; it fails transiently so the
    // alert stays pending.
    await fanout.registerDevice(DEVICE_A);
    fanout.setResponder(() => TRANSIENT);

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();
    assert.equal(fanout.pendingCount(), 1, "the alert is pending after A's transient failure");
    assert.equal(fanout.sendCount(REF_C), 0, "device C did not exist yet");

    // Device C registers AFTER the pending alert was created. The live eligibility
    // snapshot must include it on the next cycle.
    await fanout.registerDevice(DEVICE_C);
    fastForwardRetries(fanout.database);
    fanout.setResponder(() => ACCEPTED);
    await fanout.makeEngine().run();

    assert.equal(fanout.sendCount(REF_C), 1, "the newly registered device receives the still-pending alert");
    assert.equal(fanout.sendCount(REF_A), 2, "the original device is retried too");
    assert.equal(fanout.pendingCount(), 0, "the alert resolves once every live device succeeds");
  } finally {
    fanout.close();
  }
});

test("apns fan-out: a device registered after the alert resolved does not resurrect it", async () => {
  const fanout = createFanout("fanout-post-resolve-register");
  try {
    await fanout.registerDevice(DEVICE_A);
    fanout.setResponder(() => ACCEPTED);

    await armWorseningAlert(fanout);
    await fanout.makeEngine().run();
    assert.equal(fanout.pendingCount(), 0, "the single-device alert resolved and was removed");
    assert.equal(fanout.sendCount(REF_A), 1);

    // A device that registers after resolution, with the subsystem still critical,
    // must not receive a stale alert: the resolved row is gone and state has
    // advanced, so no new transition fires.
    await fanout.registerDevice(DEVICE_C);
    await fanout.makeEngine().run();

    assert.equal(fanout.sendCount(REF_C), 0, "a device registered after resolution gets no stale push");
    assert.equal(fanout.pendingCount(), 0, "no pending alert is resurrected");
  } finally {
    fanout.close();
  }
});
