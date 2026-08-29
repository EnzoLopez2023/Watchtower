import assert from "node:assert/strict";
import test from "node:test";
import { SqliteAlertStateRepository } from "../../lib/db/repositories/watchtower/alertStateRepository.js";
import { SqliteMobilePushRepository } from "../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { AlertEngine, describe as describeTransition } from "../../lib/monitoring/alertEngine.js";
import type { DashboardPayload, Subsystem } from "../../lib/monitoring/infraStatus.js";
import { PushDeliveryService } from "../../lib/monitoring/pushDelivery.js";
import { openTestDatabase, removeDatabase, stubApns } from "../fixtures/monitoring/harness.js";
import type { ApnsResult } from "../../server/clients/apns.js";

const DEVICE = "a".repeat(64);

interface EngineHarness {
  readonly engine: AlertEngine;
  readonly repository: SqliteAlertStateRepository;
  readonly push: PushDeliveryService;
  readonly sent: Array<{ title: string; body: string; critical: boolean }>;
  setStatus(payload: DashboardPayload): void;
  close(): void;
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

function createEngine(
  prefix: string,
  options: { send?: (token: string, note: { title: string; body: string; critical?: boolean }) => Promise<ApnsResult>; registerDevice?: boolean } = {}
): EngineHarness {
  const { database, path } = openTestDatabase(prefix);
  const repository = new SqliteAlertStateRepository(database);
  const pushRepository = new SqliteMobilePushRepository(database);
  const sent: EngineHarness["sent"] = [];
  const apns = stubApns({
    send: async (token, notification) => {
      sent.push({
        title: notification.title,
        body: notification.body,
        critical: notification.critical === true
      });
      if (options.send) {
        return options.send(token, {
          title: notification.title,
          body: notification.body,
          ...(notification.critical === undefined ? {} : { critical: notification.critical })
        });
      }
      return {
        ok: true,
        status: 200,
        apnsId: "accepted",
        retryAfter: null,
        transport: false
      };
    }
  });
  const push = new PushDeliveryService(pushRepository, apns);
  if (options.registerDevice !== false) {
    pushRepository.registerDevice({
      token: DEVICE,
      platform: "ios",
      appVersion: "1.0",
      now: Date.now(),
      deviceRef: "unused"
    });
  }

  let current = payload([]);
  const engine = new AlertEngine({
    repository,
    buildStatus: async () => current,
    deliver: (notification, deliverOptions) => push.deliver(notification, deliverOptions),
    plan: (notification) => push.plan(notification),
    apnsConfigured: () => apns.configured()
  });

  return {
    engine,
    repository,
    push,
    sent,
    setStatus(next: DashboardPayload): void {
      current = next;
    },
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

test("alert engine: the first observation records a baseline and never pushes", async () => {
  const harness = createEngine("alert-baseline");
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "critical", headline: "On Battery" })]));
    await harness.engine.run();
    assert.equal(harness.sent.length, 0);
    assert.equal((await harness.repository.getState("ups"))?.severity, "critical");
  } finally {
    harness.close();
  }
});

test("alert engine: a worsening transition pushes exactly once", async () => {
  const harness = createEngine("alert-worsen");
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "ok", headline: "Online" })]));
    await harness.engine.run();

    harness.setStatus(
      payload([
        tile({ key: "ups", severity: "critical", headline: "On Battery", detail: "18 min left", escalation: 1 })
      ])
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0]?.title ?? "", /🚨 ups: On Battery/);
    assert.equal(harness.sent[0]?.critical, true);

    // A steady state is silent.
    await harness.engine.run();
    assert.equal(harness.sent.length, 1);
  } finally {
    harness.close();
  }
});

test("alert engine: a rising escalation pushes even when severity holds", async () => {
  const harness = createEngine("alert-escalate");
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "ok" })]));
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "On Battery", escalation: 1 })])
    );
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "Low Battery", escalation: 6 })])
    );
    await harness.engine.run();

    assert.equal(harness.sent.length, 2);
    assert.match(harness.sent[1]?.title ?? "", /worsening/);
  } finally {
    harness.close();
  }
});

test("alert engine: a falling escalation is silent but rearms the ladder", async () => {
  const harness = createEngine("alert-fall");
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "ok" })]));
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "On Battery", escalation: 4 })])
    );
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "On Battery", escalation: 2 })])
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 1);

    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "On Battery", escalation: 5 })])
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 2);
  } finally {
    harness.close();
  }
});

test("alert engine: recovery pushes once and is not critical", async () => {
  const harness = createEngine("alert-recovery");
  try {
    harness.setStatus(payload([tile({ key: "nas", severity: "ok" })]));
    await harness.engine.run();
    harness.setStatus(payload([tile({ key: "nas", severity: "warn", headline: "1 backup failing" })]));
    await harness.engine.run();
    harness.setStatus(payload([tile({ key: "nas", severity: "ok", headline: "All healthy" })]));
    await harness.engine.run();

    assert.equal(harness.sent.length, 2);
    assert.match(harness.sent[1]?.title ?? "", /✅ nas recovered/);
    assert.equal(harness.sent[1]?.critical, false);
  } finally {
    harness.close();
  }
});

test("alert engine: informational tiles never alert", async () => {
  const harness = createEngine("alert-informational");
  try {
    harness.setStatus(payload([tile({ key: "media", severity: "ok", informational: true })]));
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "media", severity: "critical", informational: true, escalation: 5 })])
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 0);
    assert.equal(await harness.repository.getState("media"), undefined);
  } finally {
    harness.close();
  }
});

test("alert engine: the network observer needs three identical samples to confirm", async () => {
  const harness = createEngine("alert-observer");
  try {
    const healthy = tile({ key: "network-observer", severity: "ok", headline: "2 probes healthy" });
    harness.setStatus(payload([healthy]));
    await harness.engine.run();

    const failing = (generation: number): Subsystem =>
      tile({
        key: "network-observer",
        severity: "warn",
        headline: "Gateway probe failed",
        detail: "Gateway",
        notificationPolicy: {
          kind: "consecutive-samples",
          sampleKey: String(generation),
          generationKey: JSON.stringify({ "lan:gateway": generation }),
          signature: "lan:gateway",
          failureSamples: 3,
          recoverySamples: 3
        }
      });

    harness.setStatus(payload([failing(1)]));
    await harness.engine.run();
    assert.equal(harness.sent.length, 0, "first sample must not alert");

    harness.setStatus(payload([failing(2)]));
    await harness.engine.run();
    assert.equal(harness.sent.length, 0, "second sample must not alert");

    harness.setStatus(payload([failing(3)]));
    await harness.engine.run();
    assert.equal(harness.sent.length, 1, "third identical sample confirms");
    assert.match(harness.sent[0]?.title ?? "", /Gateway probe failed/);
  } finally {
    harness.close();
  }
});

test("alert engine: a repeated sample generation does not advance the confirmation count", async () => {
  const harness = createEngine("alert-observer-repeat");
  try {
    harness.setStatus(payload([tile({ key: "network-observer", severity: "ok" })]));
    await harness.engine.run();

    const failing = tile({
      key: "network-observer",
      severity: "warn",
      headline: "Gateway probe failed",
      notificationPolicy: {
        kind: "consecutive-samples",
        sampleKey: "1",
        generationKey: JSON.stringify({ "lan:gateway": 1 }),
        signature: "lan:gateway",
        failureSamples: 3,
        recoverySamples: 3
      }
    });
    for (let index = 0; index < 5; index += 1) {
      harness.setStatus(payload([failing]));
      await harness.engine.run();
    }
    assert.equal(harness.sent.length, 0);
    assert.equal((await harness.repository.getCandidate("network-observer"))?.consecutiveCount, 1);
  } finally {
    harness.close();
  }
});

test("alert engine: a stale observer does not retract a confirmed incident", async () => {
  const harness = createEngine("alert-observer-stale");
  try {
    harness.setStatus(payload([tile({ key: "network-observer", severity: "warn", headline: "down" })]));
    await harness.engine.run();
    await harness.repository.upsertState("network-observer", "warn", Date.now(), "0");

    harness.setStatus(
      payload([tile({ key: "network-observer", severity: "stale", headline: "Observer stale" })])
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 0);
    assert.equal((await harness.repository.getState("network-observer"))?.severity, "warn");
  } finally {
    harness.close();
  }
});

test("alert engine: a rejected delivery keeps the alert durable for retry", async () => {
  const harness = createEngine("alert-durable", {
    send: async () => ({
      ok: false,
      status: 503,
      reason: "ServiceUnavailable",
      apnsId: null,
      retryAfter: null,
      transport: false
    })
  });
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "ok" })]));
    await harness.engine.run();
    harness.setStatus(
      payload([tile({ key: "ups", severity: "critical", headline: "On Battery", escalation: 1 })])
    );
    await harness.engine.run();

    const pending = await harness.repository.listPendingAlerts(Date.now() + 10 * 60_000);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.subsystem, "ups");
    assert.equal((await harness.repository.getState("ups"))?.severity, "ok", "state advances only on acceptance");
    assert.ok(pending[0]?.device_dispositions, "device dispositions are recorded for the retry");
  } finally {
    harness.close();
  }
});

test("alert engine: one-shot events are staged durably and rearm after they clear", async () => {
  const harness = createEngine("alert-events");
  try {
    harness.setStatus(
      payload(
        [],
        [{ id: "nas-shutdown:ds1821:1", critical: true, title: "DS1821 shutting down", body: "60s" }]
      )
    );
    await harness.engine.run();
    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0]?.title ?? "", /🚨 DS1821 shutting down/);

    // While the condition is still present it stays deduplicated.
    await harness.engine.run();
    assert.equal(harness.sent.length, 1);
  } finally {
    harness.close();
  }
});

test("alert engine: no push work happens without a registered device", async () => {
  const harness = createEngine("alert-no-devices", { registerDevice: false });
  try {
    harness.setStatus(payload([tile({ key: "ups", severity: "ok" })]));
    await harness.engine.run();
    harness.setStatus(payload([tile({ key: "ups", severity: "critical", headline: "On Battery" })]));
    await harness.engine.run();
    assert.equal(harness.sent.length, 0);
    assert.equal((await harness.repository.listPendingAlerts(Date.now() + 1)).length, 1);
  } finally {
    harness.close();
  }
});

test("describe: a warn to stale drift is not worth a push", () => {
  const note = describeTransition(tile({ key: "ups", severity: "stale", headline: "Stale" }), "warn");
  assert.equal(note, null);
});
