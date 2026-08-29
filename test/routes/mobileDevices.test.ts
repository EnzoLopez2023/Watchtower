import assert from "node:assert/strict";
import test from "node:test";
import { SqliteMobilePushRepository } from "../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { PushDeliveryService, deviceRef } from "../../lib/monitoring/pushDelivery.js";
import type { ApnsResult } from "../../server/clients/apns.js";
import { withAppServer } from "../helpers/appTestServer.js";
import {
  countRows,
  createTestHarness,
  openTestDatabase,
  removeDatabase,
  stubApns,
  testConfig
} from "../fixtures/monitoring/harness.js";

const DEVICE = "b".repeat(64);
const OTHER_DEVICE = "c".repeat(64);
const TOKEN = "mobile-secret";

const accepted: ApnsResult = {
  ok: true,
  status: 200,
  apnsId: "ok",
  retryAfter: null,
  transport: false
};

function post(base: URL, path: string, body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(new URL(path, base), { method: "POST", headers, body: JSON.stringify(body) });
}

test("register-device: rejects a malformed token", async () => {
  const harness = createTestHarness({ prefix: "mobile-register-bad" });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await post(base, "/api/mobile/register-device", { token: "nope" });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid device token" });
    });
  } finally {
    harness.close();
  }
});

test("register-device: is idempotent and refreshes last_seen", async () => {
  const harness = createTestHarness({ prefix: "mobile-register" });
  try {
    await withAppServer(harness.app, async (base) => {
      assert.equal((await post(base, "/api/mobile/register-device", { token: DEVICE })).status, 200);
      assert.equal(
        (await post(base, "/api/mobile/register-device", { token: DEVICE, appVersion: "2.0" })).status,
        200
      );
    });
    const rows = harness.database
      .prepare("SELECT device_token, app_version FROM mobile_devices")
      .all() as Array<{ device_token: string; app_version: string | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.app_version, "2.0");
  } finally {
    harness.close();
  }
});

test("register-device: a first registration clears a stale block, a refresh does not", async () => {
  const harness = createTestHarness({ prefix: "mobile-register-block" });
  try {
    const ref = deviceRef(DEVICE);
    const future = Date.now() + 3_600_000;
    harness.database
      .prepare(
        `INSERT INTO mobile_push_device_backoff (device_ref, retry_after, updated_at, outcome_order)
         VALUES (?, ?, ?, 1)`
      )
      .run(ref, future, Date.now());

    await withAppServer(harness.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
    });
    assert.equal(
      countRows(harness.database, "mobile_push_device_backoff", "device_ref = ?", ref),
      0,
      "a token returning from a previous life must not inherit its block"
    );

    // Re-arm the block, then refresh an already-registered device.
    harness.database
      .prepare(
        `INSERT INTO mobile_push_device_backoff (device_ref, retry_after, updated_at, outcome_order)
         VALUES (?, ?, ?, 1)`
      )
      .run(ref, future, Date.now());
    await withAppServer(harness.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
    });
    assert.equal(
      countRows(harness.database, "mobile_push_device_backoff", "device_ref = ?", ref),
      1,
      "a device must not register its way out of a provider-directed backoff"
    );
  } finally {
    harness.close();
  }
});

test("unregister-device: removes the registration and its delivery state", async () => {
  const harness = createTestHarness({ prefix: "mobile-unregister" });
  try {
    await withAppServer(harness.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
      const missing = await post(base, "/api/mobile/unregister-device", {});
      assert.equal(missing.status, 400);
      assert.equal((await post(base, "/api/mobile/unregister-device", { token: DEVICE })).status, 200);
    });
    assert.equal(
      countRows(harness.database, "mobile_devices"),
      0
    );
  } finally {
    harness.close();
  }
});

test("test-push: 503 when APNs is not configured", async () => {
  const harness = createTestHarness({
    prefix: "mobile-push-unconfigured",
    apns: stubApns({ configured: false })
  });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await post(base, "/api/mobile/test-push", {});
      assert.equal(response.status, 503);
    });
  } finally {
    harness.close();
  }
});

test("test-push: 404 when no device is registered", async () => {
  const harness = createTestHarness({ prefix: "mobile-push-none" });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await post(base, "/api/mobile/test-push", {});
      assert.equal(response.status, 404);
      const body = (await response.json()) as { status: string; registeredDeviceCount: number };
      assert.equal(body.status, "no_devices");
      assert.equal(body.registeredDeviceCount, 0);
    });
  } finally {
    harness.close();
  }
});

test("test-push: reports full coverage and records a durable delivery", async () => {
  const harness = createTestHarness({ prefix: "mobile-push-ok" });
  try {
    await withAppServer(harness.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
      const response = await post(base, "/api/mobile/test-push", { title: "hello" });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        ok: boolean;
        sent: number;
        coverageComplete: boolean;
        interruptionLevel: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.sent, 1);
      assert.equal(body.coverageComplete, true);
      assert.equal(body.interruptionLevel, "time-sensitive");
    });
    const deliveries = harness.database
      .prepare("SELECT status, accepted_device_count FROM mobile_push_deliveries")
      .all() as Array<{ status: string; accepted_device_count: number }>;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "accepted");
    assert.equal(deliveries[0]?.accepted_device_count, 1);
  } finally {
    harness.close();
  }
});

test("test-push: critical alerts are gated on the entitlement flag", async () => {
  const gated = createTestHarness({ prefix: "mobile-push-gated" });
  try {
    await withAppServer(gated.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
      const response = await post(base, "/api/mobile/test-push", { critical: true });
      const body = (await response.json()) as { interruptionLevel: string };
      assert.equal(body.interruptionLevel, "time-sensitive");
    });
  } finally {
    gated.close();
  }

  const entitled = createTestHarness({
    prefix: "mobile-push-critical",
    apns: stubApns({ criticalAlerts: true })
  });
  try {
    await withAppServer(entitled.app, async (base) => {
      await post(base, "/api/mobile/register-device", { token: DEVICE });
      const response = await post(base, "/api/mobile/test-push", { critical: true });
      const body = (await response.json()) as { interruptionLevel: string };
      assert.equal(body.interruptionLevel, "critical");
    });
  } finally {
    entitled.close();
  }
});

test("test-push: mobile secret is required", async () => {
  const harness = createTestHarness({ prefix: "mobile-push-auth" });
  try {
    await withAppServer(harness.app, async (base) => {
      assert.equal((await post(base, "/api/mobile/test-push", {}, null)).status, 401);
      assert.equal((await post(base, "/api/mobile/test-push", {}, "wrong")).status, 401);
    });
  } finally {
    harness.close();
  }
});

test("test-push: 503 when the mobile secret is unset", async () => {
  const harness = createTestHarness({
    prefix: "mobile-push-nokey",
    config: testConfig({ serviceTokens: { mobile: undefined } })
  });
  try {
    await withAppServer(harness.app, async (base) => {
      assert.equal((await post(base, "/api/mobile/test-push", {}, "anything")).status, 503);
    });
  } finally {
    harness.close();
  }
});

// ── Durable delivery semantics ───────────────────────────────────────────────

function pushHarness(prefix: string, send: (token: string) => Promise<ApnsResult>) {
  const { database, path } = openTestDatabase(prefix);
  const repository = new SqliteMobilePushRepository(database);
  const apns = stubApns({ send: async (token) => send(token) });
  const push = new PushDeliveryService(repository, apns);
  return {
    database,
    repository,
    push,
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

test("push delivery: attempt order is monotonic and capped at three standard tries", async () => {
  const harness = pushHarness("push-retries", async () => ({
    ok: false,
    status: 0,
    reason: "socket hang up",
    apnsId: null,
    retryAfter: null,
    transport: true
  }));
  try {
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now(),
      deviceRef: deviceRef(DEVICE)
    });
    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.status, "failed");
    assert.equal(delivery.results[0]?.attempts, 3);

    const attempts = harness.database
      .prepare("SELECT attempt_number, attempt_order FROM mobile_push_attempts ORDER BY id")
      .all() as Array<{ attempt_number: number; attempt_order: number }>;
    assert.equal(attempts.length, 3);
    assert.deepEqual(
      attempts.map((row) => row.attempt_number),
      [1, 2, 3]
    );
    for (let index = 1; index < attempts.length; index += 1) {
      assert.ok(
        (attempts[index]?.attempt_order ?? 0) > (attempts[index - 1]?.attempt_order ?? 0),
        "attempt_order must increase monotonically"
      );
    }
  } finally {
    harness.close();
  }
});

test("push delivery: a 410 Unregistered response prunes the dead token", async () => {
  const harness = pushHarness("push-410", async () => ({
    ok: false,
    status: 410,
    reason: "Unregistered",
    apnsId: null,
    retryAfter: null,
    transport: false
  }));
  try {
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now() - 1000,
      deviceRef: deviceRef(DEVICE)
    });
    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.results[0]?.pruned, true);
    assert.equal(
      countRows(harness.database, "mobile_devices"),
      0
    );
  } finally {
    harness.close();
  }
});

test("push delivery: a device re-registered after invalidation is retried, not pruned", async () => {
  const invalidatedAt = Date.now() - 60_000;
  const harness = pushHarness("push-410-rereg", async () => ({
    ok: false,
    status: 410,
    reason: "Unregistered",
    apnsId: null,
    retryAfter: null,
    transport: false,
    invalidatedAt
  }));
  try {
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now(),
      deviceRef: deviceRef(DEVICE)
    });
    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.results[0]?.pruned, false);
    assert.equal(delivery.results[0]?.retryable, true);
    assert.equal(
      countRows(harness.database, "mobile_devices"),
      1
    );
  } finally {
    harness.close();
  }
});

test("push delivery: a configuration rejection records a blocked fingerprint dead letter", async () => {
  const harness = pushHarness("push-blocked", async () => ({
    ok: false,
    status: 403,
    reason: "BadDeviceToken",
    apnsId: null,
    retryAfter: null,
    transport: false
  }));
  try {
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now(),
      deviceRef: deviceRef(DEVICE)
    });
    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.results[0]?.retryable, false);
    assert.equal(delivery.results[0]?.blockScope, "configuration");

    const backoff = harness.database
      .prepare("SELECT blocked_fingerprint FROM mobile_push_device_backoff WHERE device_ref = ?")
      .get(deviceRef(DEVICE)) as { blocked_fingerprint: string | null } | undefined;
    assert.equal(backoff?.blocked_fingerprint, delivery.providerFingerprint);

    // A blocked device is excluded from the next plan under the same config.
    const plan = await harness.push.plan({ title: "t", body: "b" });
    assert.equal(plan.blockedFingerprintByDevice[deviceRef(DEVICE)], delivery.providerFingerprint);

    // Re-registration is the operator's unblock path.
    harness.repository.unregisterDevice(DEVICE, deviceRef(DEVICE));
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now(),
      deviceRef: deviceRef(DEVICE)
    });
    const cleared = await harness.push.plan({ title: "t", body: "b" });
    assert.equal(cleared.blockedFingerprintByDevice[deviceRef(DEVICE)], undefined);
  } finally {
    harness.close();
  }
});

test("push delivery: a leased device is not attempted twice concurrently", async () => {
  const harness = pushHarness("push-lease", async () => accepted);
  try {
    for (const token of [DEVICE, OTHER_DEVICE]) {
      harness.repository.registerDevice({
        token,
        platform: "ios",
        appVersion: null,
        now: Date.now(),
        deviceRef: deviceRef(token)
      });
    }
    // Hold a live lease on one device so only the other is reserved.
    harness.database
      .prepare(
        `INSERT INTO mobile_push_device_backoff (device_ref, retry_after, updated_at, outcome_order, lease_until, lease_token)
         VALUES (?, 0, ?, 0, ?, 'other-worker')`
      )
      .run(deviceRef(DEVICE), Date.now(), Date.now() + 60_000);

    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.registeredDeviceCount, 2);
    assert.equal(delivery.attemptedDeviceCount, 1);
    assert.equal(delivery.results[0]?.deviceRef, deviceRef(OTHER_DEVICE));
  } finally {
    harness.close();
  }
});

test("push delivery: provider guidance sets the deferred retry window", async () => {
  const harness = pushHarness("push-retry-after", async () => ({
    ok: false,
    status: 429,
    reason: "TooManyRequests",
    apnsId: null,
    retryAfter: "120",
    transport: false
  }));
  try {
    harness.repository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: null,
      now: Date.now(),
      deviceRef: deviceRef(DEVICE)
    });
    const before = Date.now();
    const delivery = await harness.push.deliver({ title: "t", body: "b" });
    assert.equal(delivery.retryable, true);
    assert.ok((delivery.retryAt ?? 0) >= before + 120_000);
  } finally {
    harness.close();
  }
});
