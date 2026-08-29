import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeApnsProvider,
  buildApnsRequestEnvelope
} from "../../server/clients/apns.js";

const DEVICE = "a".repeat(64);

test("APNs request envelope preserves the Hearth-for-iOS wire contract", () => {
  const envelope = buildApnsRequestEnvelope({
    deviceToken: DEVICE,
    authorizationToken: "provider-jwt",
    topic: "nintek.com.Hearth-for-iOS",
    criticalAlertsEnabled: false,
    expiration: 1_788_000_000,
    notification: {
      title: "UPS on Battery",
      body: "Tower UPS switched to battery power.",
      critical: true,
      collapseId: "ups",
      apnsId: "12345678-1234-1234-1234-123456789012"
    }
  });

  assert.deepEqual(envelope.headers, {
    ":method": "POST",
    ":path": `/3/device/${DEVICE}`,
    authorization: "bearer provider-jwt",
    "apns-topic": "nintek.com.Hearth-for-iOS",
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": "1788000000",
    "apns-collapse-id": "ups",
    "apns-id": "12345678-1234-1234-1234-123456789012"
  });
  assert.deepEqual(JSON.parse(envelope.payload), {
    aps: {
      alert: {
        title: "UPS on Battery",
        body: "Tower UPS switched to battery power."
      },
      sound: "default",
      "interruption-level": "time-sensitive",
      "thread-id": "hearth-infra"
    }
  });
});

test("critical sound and interruption level are emitted only with explicit entitlement", () => {
  const envelope = buildApnsRequestEnvelope({
    deviceToken: DEVICE,
    authorizationToken: "provider-jwt",
    topic: "nintek.com.Hearth-for-iOS",
    criticalAlertsEnabled: true,
    expiration: 1_788_000_000,
    notification: {
      title: "Power outage",
      body: "All UPS units are on battery.",
      critical: true,
      threadId: "hearth-infra"
    }
  });
  const payload = JSON.parse(envelope.payload) as {
    aps: { sound: unknown; "interruption-level": string };
  };
  assert.deepEqual(payload.aps.sound, { critical: 1, name: "default", volume: 1 });
  assert.equal(payload.aps["interruption-level"], "critical");
});

test("APNs delivery metadata is bounded and environment-specific", () => {
  const sandbox = new NativeApnsProvider({
    environment: "development",
    criticalAlerts: false,
    alertTtlSeconds: 1,
    topic: "nintek.com.Hearth-for-iOS"
  });
  assert.equal(sandbox.environment(), "sandbox");
  assert.equal(sandbox.criticalAlertsEnabled(), false);
  assert.equal(sandbox.alertTtlSeconds(), 60);
  assert.deepEqual(sandbox.deliveryMetadata({ critical: true, now: 1_000_000 }), {
    environment: "sandbox",
    topic: "nintek.com.Hearth-for-iOS",
    interruptionLevel: "time-sensitive",
    expiration: 1060,
    expiresAt: 1_060_000
  });

  const production = new NativeApnsProvider({
    environment: "production",
    criticalAlerts: true,
    alertTtlSeconds: 100_000,
    topic: "nintek.com.Hearth-for-iOS"
  });
  assert.equal(production.environment(), "production");
  assert.equal(production.alertTtlSeconds(), 86_400);
  assert.equal(
    production.deliveryMetadata({ critical: true, now: 1_000_000 }).interruptionLevel,
    "critical"
  );
});
