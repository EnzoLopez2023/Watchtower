import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase, removeDatabase, stubMediaHealth } from "../fixtures/monitoring/harness.js";
import { SqliteInfraStatusRepository } from "../../lib/db/repositories/watchtower/infraStatusRepository.js";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteUnifiRepository } from "../../lib/db/repositories/watchtower/unifiRepository.js";
import { buildInfraStatus, type Subsystem } from "../../lib/monitoring/infraStatus.js";
import { packJson } from "../../lib/monitoring/payloadCodec.js";

function harness(prefix = "infra-status") {
  const { database, path } = openTestDatabase(prefix);
  const repository = new SqliteInfraStatusRepository(database);
  const receipts = new SqliteAgentIngestReceiptRepository(database);
  const routeDrift = new SqliteUnifiRepository(database, receipts);
  return {
    database,
    build: (now: number, mediaHealth = stubMediaHealth()) =>
      buildInfraStatus({ repository, routeDrift, mediaHealth }, now),
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function subsystem(subsystems: readonly Subsystem[], key: string): Subsystem {
  const found = subsystems.find((candidate) => candidate.key === key);
  assert.ok(found, `missing subsystem ${key}`);
  return found;
}

function writeUnifiLatest(
  database: ReturnType<typeof openTestDatabase>["database"],
  receivedAt: number,
  payload: unknown
): void {
  database
    .prepare(
      `INSERT INTO unifi_latest (id, received_at, payload) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, payload = excluded.payload`
    )
    .run(receivedAt, packJson(payload));
}

test("infra status: no data reports stale rather than healthy", async () => {
  const context = harness("infra-empty");
  try {
    const status = await context.build(NOW);
    assert.equal(subsystem(status.subsystems, "internet").severity, "stale");
    assert.equal(subsystem(status.subsystems, "ups").severity, "stale");
    assert.equal(subsystem(status.subsystems, "nas").severity, "stale");
    // No Protect snapshot means no cameras exist, which is not a fault.
    assert.equal(subsystem(status.subsystems, "cameras").severity, "ok");
    // The shutdown watchdog is the one agent whose silence is critical, so an
    // empty database is loud rather than quietly "all systems OK".
    const agents = subsystem(status.subsystems, "agents");
    assert.equal(agents.severity, "critical");
    assert.equal(agents.notificationPolicy?.failureSamples, 1);
    assert.equal(status.overall.severity, "critical");
    assert.ok(status.overall.issueCount >= 1);
    assert.match(status.overall.summary, /On-site Agents/);
  } finally {
    context.close();
  }
});

test("infra status: a Sonarr-only agent failure requires stable samples", async () => {
  const context = harness("infra-sonarr-confirmation");
  try {
    writeUnifiLatest(context.database, NOW - 5_000, {
      wan: { status: "up", _health: { www: { status: "ok" } } },
      devices: []
    });

    context.database
      .prepare("INSERT INTO protect_latest (id, received_at, payload) VALUES (1, ?, ?)")
      .run(NOW - 5_000, packJson({ cameras: [] }));
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, raw)
         VALUES (?, 'tower', 'Tower', 'OL', '{}')`
      )
      .run(NOW - 5_000);
    context.database
      .prepare(
        `INSERT INTO agent_logs (agent, ts, level, message, received_at)
         VALUES ('shutdown', ?, 'info', 'heartbeat', ?)`
      )
      .run(NOW - 5_000, NOW - 5_000);
    context.database
      .prepare(
        `INSERT INTO synology_latest (nas_id, label, host, payload, received_at)
         VALUES ('nas', 'NAS', NULL, ?, ?)`
      )
      .run(packJson({ disks: [], volumes: [] }), NOW - 5_000);

    const status = await context.build(
      NOW,
      stubMediaHealth({
        schema: "marquee.media-health.v1",
        generatedAt: "2026-08-28T12:00:00.000Z",
        overall: "degraded",
        build: { app: "marquee" },
        sqlite: { ready: true, schemaVersion: 4 },
        providers: {
          plex: { configured: true, lastSuccessAt: null, lastFailureAt: null, latencyMs: 12 },
          tautulli: { configured: true, lastSuccessAt: null, lastFailureAt: null, latencyMs: 9 }
        },
        sonarr: { present: false },
        duplicates: {}
      })
    );
    const agents = subsystem(status.subsystems, "agents");

    assert.equal(agents.severity, "warn");
    assert.equal(agents.headline, "1 silent");
    assert.equal(agents.detail, "Sonarr not reporting");
    assert.equal(agents.notificationPolicy?.signature, "Sonarr");
    assert.equal(agents.notificationPolicy?.failureSamples, 3);
    assert.equal(agents.notificationPolicy?.recoverySamples, 3);
    assert.equal(agents.notificationPolicy?.generationKey, JSON.stringify({ agents: NOW }));
  } finally {
    context.close();
  }
});

test("infra status: a UniFi-only agent failure requires stable samples", async () => {
  const context = harness("infra-unifi-confirmation");
  try {
    writeUnifiLatest(context.database, NOW - 6 * 60_000, {
      wan: { status: "up", _health: { www: { status: "ok" } } },
      devices: []
    });
    context.database
      .prepare("INSERT INTO protect_latest (id, received_at, payload) VALUES (1, ?, ?)")
      .run(NOW - 5_000, packJson({ cameras: [] }));
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, raw)
         VALUES (?, 'tower', 'Tower', 'OL', '{}')`
      )
      .run(NOW - 5_000);
    context.database
      .prepare(
        `INSERT INTO agent_logs (agent, ts, level, message, received_at)
         VALUES ('shutdown', ?, 'info', 'heartbeat', ?)`
      )
      .run(NOW - 5_000, NOW - 5_000);
    context.database
      .prepare(
        `INSERT INTO synology_latest (nas_id, label, host, payload, received_at)
         VALUES ('nas', 'NAS', NULL, ?, ?)`
      )
      .run(packJson({ disks: [], volumes: [] }), NOW - 5_000);

    const agents = subsystem((await context.build(NOW)).subsystems, "agents");
    assert.equal(agents.severity, "warn");
    assert.equal(agents.detail, "UniFi Network not reporting");
    assert.equal(agents.notificationPolicy?.signature, "UniFi Network");
    assert.equal(agents.notificationPolicy?.failureSamples, 3);
    assert.equal(agents.notificationPolicy?.recoverySamples, 3);
  } finally {
    context.close();
  }
});

test("infra status: internet reads _health.www, not gateway adoption", async () => {
  const context = harness("infra-internet");
  try {
    writeUnifiLatest(context.database, NOW - 30_000, {
      wan: {
        status: "up",
        latency_ms: 14,
        _health: { wan: { status: "ok" }, www: { status: "error" } }
      },
      devices: []
    });
    const status = await context.build(NOW);
    const internet = subsystem(status.subsystems, "internet");
    assert.equal(internet.severity, "critical");
    assert.equal(internet.headline, "Offline");
  } finally {
    context.close();
  }
});

test("infra status: a total blackout is reported from the silence itself", async () => {
  const context = harness("infra-blackout");
  try {
    writeUnifiLatest(context.database, NOW - 20 * 60_000, {
      wan: { _health: { www: { status: "ok" } } },
      devices: []
    });
    const status = await context.build(NOW);
    const internet = subsystem(status.subsystems, "internet");
    assert.equal(internet.severity, "critical");
    assert.equal(internet.headline, "No contact");
    assert.match(String(internet.detail), /entirely offline/);
  } finally {
    context.close();
  }
});

test("infra status: UPS low battery outranks every runtime band", async () => {
  const context = harness("infra-ups");
  try {
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, battery_charge,
           battery_runtime, raw) VALUES (?, 'tower', 'Tower', 'OB LB DISCHRG', 12, 90, '{}')`
      )
      .run(NOW - 10_000);
    const status = await context.build(NOW);
    const ups = subsystem(status.subsystems, "ups");
    assert.equal(ups.severity, "critical");
    assert.match(ups.headline, /^LOW BATTERY: Tower/);
    assert.equal(ups.escalation, 6);
  } finally {
    context.close();
  }
});

test("infra status: an agent-reported read failure newer than the last good read is surfaced", async () => {
  const context = harness("infra-ups-unreadable");
  try {
    const diagnostics = JSON.stringify({
      units: [{ id: "tower", label: "Tower", host: "10.0.0.5" }],
      errors: { tower: { at: NOW - 60_000, error: "NUT auth rejected" } }
    });
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, battery_charge, raw, agent_diag)
         VALUES (?, 'tower', 'Tower', 'OL', 100, '{}', ?)`
      )
      .run(NOW - 20 * 60_000, diagnostics);
    const status = await context.build(NOW);
    const ups = subsystem(status.subsystems, "ups");
    assert.equal(ups.severity, "critical");
    assert.match(ups.headline, /Cannot read Tower/);
    assert.equal(ups.units?.[0]?.unreachable, true);
    assert.equal(ups.units?.[0]?.readError, "NUT auth rejected");
    assert.equal(ups.escalation, 2);
  } finally {
    context.close();
  }
});

test("infra status: a configured UPS that never reported is critical, not absent", async () => {
  const context = harness("infra-ups-never");
  try {
    const diagnostics = JSON.stringify({
      units: [
        { id: "tower", label: "Tower", host: "10.0.0.5" },
        { id: "rack", label: "Rack", host: "10.0.0.6" }
      ],
      errors: {}
    });
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, raw, agent_diag)
         VALUES (?, 'tower', 'Tower', 'OL', '{}', ?)`
      )
      .run(NOW - 10_000, diagnostics);
    const status = await context.build(NOW);
    const ups = subsystem(status.subsystems, "ups");
    const rack = ups.units?.find((unit) => unit.ups_id === "rack");
    assert.ok(rack);
    assert.equal(rack.severity, "critical");
    assert.equal(rack.headline, "Never reported");
  } finally {
    context.close();
  }
});

test("infra status: a port forward bound to a backup WAN raises a one-shot event", async () => {
  const context = harness("infra-pf");
  try {
    writeUnifiLatest(context.database, NOW - 10_000, {
      wan: { _health: { www: { status: "ok" } } },
      devices: [],
      config: {
        port_forwards: [
          { id: "pf1", name: "Plex", enabled: true, interface: "wan", dst_port: 32400, fwd_ip: "10.0.0.9" },
          { id: "pf2", name: "SSH", enabled: true, interface: "both", dst_port: 22, fwd_ip: "10.0.0.4" }
        ]
      }
    });
    const status = await context.build(NOW);
    assert.equal(status.events.length, 1);
    assert.equal(status.events[0]?.id, "pf-wan-drift:pf2:both");
    assert.equal(status.events[0]?.critical, false);
  } finally {
    context.close();
  }
});

test("infra status: a NAS Safe Mode deadline fires once per outage", async () => {
  const context = harness("infra-nas-shutdown");
  try {
    const onBatterySince = NOW - 60_000;
    const diagnostics = JSON.stringify({
      units: [{ id: "tower", label: "Tower", host: "10.0.0.5" }],
      errors: {}
    });
    context.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, battery_runtime, raw, agent_diag)
         VALUES (?, 'tower', 'Tower', 'OB DISCHRG', 600, '{}', ?)`
      )
      .run(onBatterySince, diagnostics);
    context.database
      .prepare(
        "INSERT INTO synology_latest (nas_id, label, host, payload, received_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        "ds1821",
        "DS1821",
        "10.0.0.20",
        packJson({
          disks: [],
          volumes: [],
          ups: { enabled: true, shutdown_enabled: true, shutdown_seconds: 120, server: "10.0.0.5" }
        }),
        NOW - 10_000
      );

    const status = await context.build(NOW);
    const event = status.events.find((candidate) => candidate.id.startsWith("nas-shutdown:"));
    assert.ok(event);
    assert.equal(event.id, `nas-shutdown:ds1821:${onBatterySince}`);
    assert.equal(event.critical, true);
    assert.match(event.body, /Enters Safe Mode in 60s/);
  } finally {
    context.close();
  }
});

test("infra status: network observer publishes a consecutive-sample policy", async () => {
  const context = harness("infra-observer");
  try {
    context.database
      .prepare("INSERT INTO network_observer_latest (observer_id, received_at, payload) VALUES (?, ?, ?)")
      .run(
        "pi-observer",
        NOW - 5_000,
        packJson({
          probes: [
            { kind: "lan", id: "gateway", label: "Gateway", ok: false, ts: NOW - 5_000 },
            { kind: "wan", id: "1.1.1.1", label: "Cloudflare", ok: true, ts: NOW - 5_000 }
          ]
        })
      );
    const status = await context.build(NOW);
    const observer = subsystem(status.subsystems, "network-observer");
    assert.equal(observer.severity, "warn");
    assert.equal(observer.headline, "Gateway probe failed");
    assert.equal(observer.notificationPolicy?.kind, "consecutive-samples");
    assert.equal(observer.notificationPolicy?.signature, "lan:gateway");
    assert.equal(observer.notificationPolicy?.failureSamples, 3);
    assert.equal(observer.notificationPolicy?.recoverySamples, 3);
  } finally {
    context.close();
  }
});

test("infra status: a stale observer carries no notification policy", async () => {
  const context = harness("infra-observer-stale");
  try {
    context.database
      .prepare("INSERT INTO network_observer_latest (observer_id, received_at, payload) VALUES (?, ?, ?)")
      .run("pi-observer", NOW - 60 * 60_000, packJson({ probes: [] }));
    const status = await context.build(NOW);
    const observer = subsystem(status.subsystems, "network-observer");
    assert.equal(observer.severity, "stale");
    assert.equal(observer.notificationPolicy, undefined);
  } finally {
    context.close();
  }
});

test("infra status: unhealthy Synology disks are critical and escalate per disk", async () => {
  const context = harness("infra-nas");
  try {
    context.database
      .prepare(
        "INSERT INTO synology_latest (nas_id, label, host, payload, received_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        "ds1821",
        "DS1821",
        "10.0.0.20",
        packJson({
          disks: [
            { name: "Disk 1", smart_status: "normal", health: "normal", bad_sectors: 0 },
            { name: "Disk 2", smart_status: "critical", health: "abnormal", bad_sectors: 4 }
          ],
          volumes: [{ name: "volume1", used_pct: 96 }]
        }),
        NOW - 10_000
      );
    const status = await context.build(NOW);
    const nas = subsystem(status.subsystems, "nas");
    assert.equal(nas.severity, "critical");
    assert.equal(nas.escalation, 10);
    assert.match(String(nas.detail), /1 disk unhealthy/);
    assert.match(String(nas.detail), /96% full/);
  } finally {
    context.close();
  }
});
