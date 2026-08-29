import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteOutageRepository } from "../../lib/db/repositories/watchtower/outageRepository.js";
import {
  buildIncidentSegments,
  classifyOutageSignals,
  runOutagePostmortemCycle,
  type EvidenceSignal,
} from "../../lib/monitoring/outagePostmortems.js";

process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "60";

const SCRATCH_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../../.scratch/wt/tmp"
);
mkdirSync(SCRATCH_DIR, { recursive: true });
const dbPath = join(SCRATCH_DIR, `postmortem-test-${Date.now()}.db`);
const db = openDatabase({ path: dbPath, busyTimeoutMs: 5_000 });
ensureWatchtowerSchema(db);
const repo = new SqliteOutageRepository(db);

const reset = (): void => {
  db.exec(`
    DELETE FROM outage_incident_evidence;
    DELETE FROM outage_postmortems;
    DELETE FROM outage_incidents;
    DELETE FROM mobile_alert_events;
    DELETE FROM outage_evidence_cursors;
    DELETE FROM ups_readings;
    DELETE FROM unifi_readings;
    DELETE FROM network_probe_samples;
    DELETE FROM unifi_latest;
    DELETE FROM network_observer_latest;
  `);
};

beforeEach(reset);

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

const signal = (overrides: Partial<EvidenceSignal> = {}): EvidenceSignal => ({
  source: "source",
  signal: "internet",
  state: "outage",
  occurred_at: 1_000,
  confidence: "high",
  ...overrides,
});

test("classification prioritizes real power and internet evidence over collector gaps", () => {
  const result = classifyOutageSignals([
    signal({ source: "ups:tower", signal: "power" }),
    signal({ source: "unifi:wan-reachability" }),
    signal({ source: "collector:unifi", signal: "collector" }),
  ]);
  assert.equal(result?.classification, "power");
  assert.equal(result?.confidence, "high");
  assert.deepEqual(result?.classifications, ["power", "internet"]);
});

test("classification requires corroboration and distinguishes collector_down from unknown", () => {
  const internet = classifyOutageSignals([
    signal({ source: "observer:hpz4g4:external:cloudflare" }),
    signal({ source: "observer:hpz4g4:external:google", occurred_at: 2_000 }),
  ]);
  assert.equal(internet?.classification, "internet");
  assert.equal(internet?.confidence, "high");
  assert.equal(internet?.startedAt, 1_000);

  const collectorDown = classifyOutageSignals([
    signal({ source: "collector:unifi", signal: "collector" }),
    signal({ source: "collector:network-observer", signal: "collector", state: "healthy" }),
  ]);
  assert.equal(collectorDown?.classification, "collector_down");
  assert.equal(collectorDown?.confidence, "high");

  const unknown = classifyOutageSignals([
    signal({ source: "collector:unifi", signal: "collector" }),
    signal({ source: "collector:network-observer", signal: "collector" }),
  ]);
  assert.equal(unknown?.classification, "unknown");
  assert.equal(unknown?.confidence, "medium");
});

test("recovery hold merges regression and finalizes only after stability", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "1", scope: "home", ...signal({ source: "ups:tower", signal: "power", occurred_at: 0 }) },
    { id: 2, evidence_key: "2", scope: "home", ...signal({ source: "ups:tower", signal: "power", state: "healthy", occurred_at: 100 }) },
    { id: 3, evidence_key: "3", scope: "home", ...signal({ source: "ups:tower", signal: "power", occurred_at: 200 }) },
    { id: 4, evidence_key: "4", scope: "home", ...signal({ source: "ups:tower", signal: "power", state: "healthy", occurred_at: 300 }) },
  ];
  const pending = buildIncidentSegments(evidence, 699, 400);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.status, "recovery_pending");
  assert.equal(pending[0]!.startedAt, 0);
  assert.equal(pending[0]!.recoveredAt, 300);

  const finalized = buildIncidentSegments(evidence, 700, 400);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]!.status, "finalized");
  assert.equal(finalized[0]!.finalizedAt, 700);
});

test("compound incidents recover only after every service dimension is healthy", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "power-down", scope: "home", ...signal({ source: "ups:tower", signal: "power", occurred_at: 0 }) },
    { id: 2, evidence_key: "wan-down", scope: "home", ...signal({ source: "unifi:wan-reachability", occurred_at: 50 }) },
    { id: 3, evidence_key: "power-up", scope: "home", ...signal({ source: "ups:tower", signal: "power", state: "healthy", occurred_at: 100 }) },
    { id: 4, evidence_key: "wan-up", scope: "home", ...signal({ source: "unifi:wan-reachability", state: "healthy", occurred_at: 200 }) },
  ];
  const segments = buildIncidentSegments(evidence, 700, 400);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0]!.classifications, ["power", "internet"]);
  assert.equal(segments[0]!.recoveredAt, 200);
  assert.equal(segments[0]!.finalizedAt, 600);
});

test("collector gaps remain isolated from power and internet incident timing", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "unifi-collector-up", scope: "home", ...signal({ source: "collector:unifi", signal: "collector", state: "healthy", occurred_at: 0 }) },
    { id: 2, evidence_key: "collector-down", scope: "home", ...signal({ source: "collector:network-observer", signal: "collector", occurred_at: 100 }) },
    { id: 3, evidence_key: "wan-down", scope: "home", ...signal({ source: "unifi:wan-reachability", occurred_at: 200 }) },
    { id: 4, evidence_key: "wan-up", scope: "home", ...signal({ source: "unifi:wan-reachability", state: "healthy", occurred_at: 300 }) },
    { id: 5, evidence_key: "collector-up", scope: "home", ...signal({ source: "collector:network-observer", signal: "collector", state: "healthy", occurred_at: 900 }) },
  ];
  const segments = buildIncidentSegments(evidence, 1_500, 400);
  const internet = segments.find((s) => s.classification === "internet");
  const collector = segments.find((s) => s.classification === "collector_down");
  assert.equal(internet?.startedAt, 200);
  assert.equal(internet?.recoveredAt, 300);
  assert.deepEqual(internet?.classifications, ["internet"]);
  assert.equal(collector?.startedAt, 100);
  assert.equal(collector?.recoveredAt, 900);
  assert.equal(collector?.scope, "home:collectors");
});

test("a stale observer invalidates its failed probes without keeping internet open", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "unifi-collector-healthy", scope: "home", ...signal({ source: "collector:unifi", signal: "collector", state: "healthy", occurred_at: 0 }) },
    { id: 2, evidence_key: "wan-outage", scope: "home", ...signal({ source: "unifi:wan-reachability", occurred_at: 0 }) },
    { id: 3, evidence_key: "external-one-outage", scope: "home", ...signal({ source: "observer:hpz4g4:external:one", occurred_at: 1 }) },
    { id: 4, evidence_key: "external-two-outage", scope: "home", ...signal({ source: "observer:hpz4g4:external:two", occurred_at: 2 }) },
    { id: 5, evidence_key: "wan-healthy", scope: "home", ...signal({ source: "unifi:wan-reachability", state: "healthy", occurred_at: 10 }) },
    { id: 6, evidence_key: "observer-stale", scope: "home", ...signal({ source: "collector:network-observer", signal: "collector", occurred_at: 300 }) },
  ];
  const segments = buildIncidentSegments(evidence, 1_000, 400);
  const internet = segments.find((s) => s.classification === "internet");
  assert.equal(internet?.status, "finalized");
  assert.equal(internet?.recoveredAt, 300);
  assert.equal(internet?.finalizedAt, 700);
  assert.equal(internet?.recoveryReason, "stale_evidence_invalidated");
});

test("application probe failures are recovery-tail context, not internet outage state", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "external-one-down", scope: "home", ...signal({ source: "observer:hpz4g4:external:one", occurred_at: 0 }) },
    { id: 2, evidence_key: "external-two-down", scope: "home", ...signal({ source: "observer:hpz4g4:external:two", occurred_at: 0 }) },
    { id: 3, evidence_key: "http-down", scope: "home", ...signal({ source: "observer:hpz4g4:http:hearth", signal: "context", occurred_at: 50 }) },
    { id: 4, evidence_key: "external-one-up", scope: "home", ...signal({ source: "observer:hpz4g4:external:one", state: "healthy", occurred_at: 100 }) },
    { id: 5, evidence_key: "external-two-up", scope: "home", ...signal({ source: "observer:hpz4g4:external:two", state: "healthy", occurred_at: 100 }) },
    { id: 6, evidence_key: "http-up", scope: "home", ...signal({ source: "observer:hpz4g4:http:hearth", signal: "context", state: "healthy", occurred_at: 900 }) },
  ];
  const segments = buildIncidentSegments(evidence, 1_000, 400);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.recoveredAt, 100);
  assert.equal(segments[0]!.finalizedAt, 500);
});

test("pre-corroboration application context is retained in the incident timeline", () => {
  const evidence: EvidenceSignal[] = [
    { id: 1, evidence_key: "dns-down", scope: "home", ...signal({ source: "observer:hpz4g4:dns:resolver", occurred_at: 100 }) },
    { id: 2, evidence_key: "http-down-before-open", scope: "home", ...signal({ source: "observer:hpz4g4:http:hearth", signal: "context", occurred_at: 100 }) },
    { id: 3, evidence_key: "external-down", scope: "home", ...signal({ source: "observer:hpz4g4:external:cloudflare", occurred_at: 100 }) },
  ];
  const [incident] = buildIncidentSegments(evidence, 200, 400);
  assert.ok(incident?.evidenceKeys.includes("http-down-before-open"));
});

test("persistence backdates monotonically and finalizes exactly once across reruns", async () => {
  const base = Date.now() - 10 * 60 * 1000;
  const insert = db.prepare(
    `INSERT INTO outage_incident_evidence (
      evidence_key, scope, source, signal, state, occurred_at, received_at,
      confidence, summary
    ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
  );
  insert.run("power-start", "outage", base, base, "UPS entered battery mode");
  await runOutagePostmortemCycle(repo, base + 1);
  insert.run("power-recovered", "healthy", base + 60_000, base + 60_000, "UPS confirmed utility power");

  await runOutagePostmortemCycle(repo, base + 121_000);
  const firstReportUpdatedAt = (db
    .prepare("SELECT updated_at FROM outage_postmortems")
    .get() as { updated_at: number } | undefined)?.updated_at;  await runOutagePostmortemCycle(repo, base + 121_000);
  assert.equal(
(    db.prepare("SELECT COUNT(*) AS n FROM outage_incidents").get() as { n: number } | undefined)?.n,
    1
  );
  assert.equal(
(    db.prepare("SELECT COUNT(*) AS n FROM outage_postmortems").get() as { n: number } | undefined)?.n,
    1
  );
  assert.equal(
    (db
      .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
      .get() as { n: number } | undefined)?.n,    1
  );
  assert.equal(
(    db.prepare("SELECT updated_at FROM outage_postmortems").get() as { updated_at: number } | undefined)?.updated_at,
    firstReportUpdatedAt
  );

  insert.run("power-start-late", "outage", base - 30_000, base + 122_000, "Replayed UPS evidence");
  await runOutagePostmortemCycle(repo, base + 123_000);
  const incident = db
    .prepare("SELECT * FROM outage_incidents")
    .get() as { started_at: number } | undefined;
  assert.equal(incident?.started_at, base - 30_000);
  assert.equal(
(    db.prepare("SELECT COUNT(*) AS n FROM outage_postmortems").get() as { n: number } | undefined)?.n,
    1
  );
  assert.equal(
    (db
      .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
      .get() as { n: number } | undefined)?.n,    1
  );

  insert.run("second-power-start", "outage", base + 4 * 60_000, base + 4 * 60_000, "Second outage");
  await runOutagePostmortemCycle(repo, base + 4 * 60_000 + 10_000);
  assert.equal(
    (db
      .prepare("SELECT COUNT(*) AS n FROM outage_incidents WHERE status IN ('open','recovery_pending')")
      .get() as { n: number } | undefined)?.n,    1
  );
});

test("source cursors preserve old replay timestamps and do not fabricate moving-window transitions", async () => {
  const now = Date.now();
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  db.prepare(
    "INSERT INTO ups_readings (received_at, device_ts, ups_id, ups_label, ups_status) VALUES (?, ?, 'tower', 'UPS Tower', ?)"
  ).run(now, tenDaysAgo, "OB");
  db.prepare(
    "INSERT INTO ups_readings (received_at, device_ts, ups_id, ups_label, ups_status) VALUES (?, ?, 'tower', 'UPS Tower', ?)"
  ).run(now + 1, tenDaysAgo + 60_000, "OL");
  await runOutagePostmortemCycle(repo, now + 70_000);
  assert.equal(
    (db
      .prepare(
        "SELECT MIN(occurred_at) AS at FROM outage_incident_evidence WHERE source = 'ups:tower'"
      )
      .get() as { at: number } | undefined)?.at,    tenDaysAgo
  );

  const insertProbe = db.prepare(
    "INSERT INTO network_probe_samples (received_at, device_ts, observer_id, kind, target_id, ok) VALUES (?, ?, 'hpz4g4', 'external', 'cloudflare', 1)"
  );
  insertProbe.run(now, now);
  await runOutagePostmortemCycle(repo, now + 1);
  const firstCount = (db
    .prepare(
      "SELECT COUNT(*) AS n FROM outage_incident_evidence WHERE source LIKE '%external:cloudflare'"
    )
    .get() as { n: number } | undefined)?.n ?? 0;  insertProbe.run(now + 1_000, now + 1_000);
  await runOutagePostmortemCycle(repo, now + 1_001);
  assert.equal(
    (db
      .prepare(
        "SELECT COUNT(*) AS n FROM outage_incident_evidence WHERE source LIKE '%external:cloudflare'"
      )
      .get() as { n: number } | undefined)?.n,    firstCount
  );
});

test("an incomplete UPS reading cannot recover an on-battery incident", async () => {
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO ups_readings (received_at, device_ts, ups_id, ups_label, ups_status) VALUES (?, ?, 'tower', 'UPS Tower', ?)"
  );
  insert.run(now, now, "OB");
  insert.run(now + 1_000, now + 1_000, null);
  insert.run(now + 2_000, now + 2_000, "OL CHRG");
  await runOutagePostmortemCycle(repo, now + 3_000);
  const states = db
    .prepare(
      "SELECT state, occurred_at FROM outage_incident_evidence WHERE source = 'ups:tower' ORDER BY occurred_at"
    )
    .all() as { state: string; occurred_at: number }[];
  assert.deepEqual(states, [
    { state: "outage", occurred_at: now },
    { state: "healthy", occurred_at: now + 2_000 },
  ]);
});

test("stale UPS telemetry closes power state as an evidence gap", async () => {
  const now = Date.now();
  const lastSeen = now - 3 * 60 * 60 * 1000;
  db.prepare(
    "INSERT INTO ups_readings (received_at, device_ts, ups_id, ups_label, ups_status) VALUES (?, ?, 'tower', 'UPS Tower', 'OB')"
  ).run(lastSeen, lastSeen);

  await runOutagePostmortemCycle(repo, now);
  const incident = db
    .prepare("SELECT * FROM outage_incidents WHERE classification = 'power'")
    .get() as { status: string; recovery_reason: string; recovered_at: number } | undefined;
  assert.equal(incident?.status, "finalized");
  assert.equal(incident?.recovery_reason, "stale_evidence_invalidated");
  assert.equal(incident?.recovered_at, lastSeen + 2 * 60 * 60 * 1000);
});

test("a persisted recovery deadline survives configuration changes and restart-equivalent cycles", async () => {
  const base = Date.now();
  const savedHold = process.env["OUTAGE_RECOVERY_HOLD_SECONDS"];
  process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "60";
  try {
    db.prepare(
      `INSERT INTO outage_incident_evidence (
        evidence_key, scope, source, signal, state, occurred_at, received_at,
        confidence, summary
      ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
    ).run("restart-down", "outage", base, base, "Power down");
    db.prepare(
      `INSERT INTO outage_incident_evidence (
        evidence_key, scope, source, signal, state, occurred_at, received_at,
        confidence, summary
      ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
    ).run("restart-up", "healthy", base + 1_000, base + 1_000, "Power up");
    await runOutagePostmortemCycle(repo, base + 2_000);
    const pending = db.prepare("SELECT * FROM outage_incidents").get() as { finalize_after: number } | undefined;
    assert.equal(pending?.finalize_after, base + 61_000);

    process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "600";
    await runOutagePostmortemCycle(repo, base + 62_000);
    const finalized = db
      .prepare("SELECT * FROM outage_incidents")
      .get() as { status: string; finalize_after: number } | undefined;
    assert.equal(finalized?.status, "finalized");
    assert.equal(finalized?.finalize_after, base + 61_000);
  } finally {
    process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = savedHold ?? "60";
  }
});

test("a delayed restart still stages the ready notification for a persisted pending incident", async () => {
  const base = Date.now();
  const savedHold = process.env["OUTAGE_RECOVERY_HOLD_SECONDS"];
  process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "60";
  try {
    const insert = db.prepare(
      `INSERT INTO outage_incident_evidence (
        evidence_key, scope, source, signal, state, occurred_at, received_at,
        confidence, summary
      ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
    );
    insert.run("delayed-down", "outage", base, base, "Power down");
    insert.run("delayed-up", "healthy", base + 1_000, base + 1_000, "Power up");
    await runOutagePostmortemCycle(repo, base + 2_000);
    assert.equal(
      (db
        .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
        .get() as { n: number } | undefined)?.n,      0
    );

    await runOutagePostmortemCycle(repo, base + 4 * 60_000);
    assert.equal(
      (db
        .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
        .get() as { n: number } | undefined)?.n,      1
    );
  } finally {
    process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = savedHold ?? "60";
  }
});

test("an outage beginning exactly at the prior recovery deadline is a new incident", async () => {
  const base = Date.now();
  const savedHold = process.env["OUTAGE_RECOVERY_HOLD_SECONDS"];
  process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "60";
  try {
    const insert = db.prepare(
      `INSERT INTO outage_incident_evidence (
        evidence_key, scope, source, signal, state, occurred_at, received_at,
        confidence, summary
      ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
    );
    insert.run("boundary-down-1", "outage", base, base, "First outage");
    insert.run("boundary-up-1", "healthy", base + 1_000, base + 1_000, "First recovery");
    insert.run("boundary-down-2", "outage", base + 61_000, base + 61_000, "Second outage");
    insert.run("boundary-up-2", "healthy", base + 62_000, base + 62_000, "Second recovery");
    await runOutagePostmortemCycle(repo, base + 123_000);
    assert.equal(
(      db.prepare("SELECT COUNT(*) AS n FROM outage_incidents").get() as { n: number } | undefined)?.n,
      2
    );
    assert.equal(
(      db.prepare("SELECT COUNT(*) AS n FROM outage_postmortems").get() as { n: number } | undefined)?.n,
      2
    );
  } finally {
    process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = savedHold ?? "60";
  }
});

test("late replay revises finalized recovery in place without a second notification", async () => {
  const base = Date.now();
  const savedHold = process.env["OUTAGE_RECOVERY_HOLD_SECONDS"];
  process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = "60";
  try {
    const insert = db.prepare(
      `INSERT INTO outage_incident_evidence (
        evidence_key, scope, source, signal, state, occurred_at, received_at,
        confidence, summary
      ) VALUES (?, 'home', 'ups:tower', 'power', ?, ?, ?, 'high', ?)`
    );
    insert.run("replay-down", "outage", base, base, "Power down");
    await runOutagePostmortemCycle(repo, base + 500);
    insert.run("replay-up", "healthy", base + 1_000, base + 1_000, "Power up");
    await runOutagePostmortemCycle(repo, base + 62_000);
    assert.equal(
(      db.prepare("SELECT COUNT(*) AS n FROM outage_postmortems").get() as { n: number } | undefined)?.n,
      1
    );
    assert.equal(
      (db
        .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
        .get() as { n: number } | undefined)?.n,      1
    );

    insert.run("replay-late-down", "outage", base + 30_000, base + 70_000, "Late replayed regression");
    insert.run("replay-late-up", "healthy", base + 70_000, base + 70_001, "Late replayed recovery");
    await runOutagePostmortemCycle(repo, base + 80_000);
    const incident = db.prepare("SELECT * FROM outage_incidents").get() as { started_at: number; status: string } | undefined;
    assert.ok(incident != null && incident.started_at <= base);
    assert.equal(
(      db.prepare("SELECT COUNT(*) AS n FROM outage_postmortems").get() as { n: number } | undefined)?.n,
      1
    );
    assert.equal(
      (db
        .prepare("SELECT COUNT(*) AS n FROM mobile_alert_events WHERE id LIKE 'postmortem:%'")
        .get() as { n: number } | undefined)?.n,      1
    );
  } finally {
    process.env["OUTAGE_RECOVERY_HOLD_SECONDS"] = savedHold ?? "60";
  }
});
