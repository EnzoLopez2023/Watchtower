import assert from "node:assert/strict";
import test from "node:test";
import { withAppServer } from "../helpers/appTestServer.js";
import {
  HEALTHY_MEDIA_HEALTH,
  createTestHarness,
  stubMediaHealth
} from "../fixtures/monitoring/harness.js";
import type {
  AgentUnit,
  DashboardPayload,
  Severity,
  Subsystem,
  UPSUnit
} from "../../lib/monitoring/infraStatus.js";

/**
 * GET /api/mobile/dashboard is a frozen contract: the iOS app decodes it
 * directly. Fields may be added, never renamed, retyped or removed. These
 * assertions are deliberately structural rather than snapshot-based so they fail
 * on a shape change instead of on new data.
 */

const SEVERITIES: readonly Severity[] = ["ok", "stale", "warn", "critical"];

function assertSeverity(value: unknown): asserts value is Severity {
  assert.ok(
    typeof value === "string" && SEVERITIES.includes(value as Severity),
    `severity must be one of ${SEVERITIES.join("|")}, received ${String(value)}`
  );
}

function assertNullableNumber(value: unknown, field: string): void {
  assert.ok(
    value === null || (typeof value === "number" && Number.isFinite(value)),
    `${field} must be a number or null, received ${String(value)}`
  );
}

function assertNullableString(value: unknown, field: string): void {
  assert.ok(
    value === null || typeof value === "string",
    `${field} must be a string or null, received ${String(value)}`
  );
}

function assertSubsystem(subsystem: Subsystem): void {
  assert.equal(typeof subsystem.key, "string");
  assert.equal(typeof subsystem.label, "string");
  assertSeverity(subsystem.severity);
  assert.equal(typeof subsystem.headline, "string");
  assertNullableString(subsystem.detail, `${subsystem.key}.detail`);
  assertNullableNumber(subsystem.ts, `${subsystem.key}.ts`);
  if (subsystem.escalation !== undefined) {
    assert.equal(typeof subsystem.escalation, "number");
  }
  if (subsystem.lastContactAt !== undefined) {
    assertNullableNumber(subsystem.lastContactAt, `${subsystem.key}.lastContactAt`);
  }
  // The aggregate agents tile reports a contact time without a cadence policy of
  // its own, so the freshness triple is asserted only where it is published.
  if (subsystem.expectedCadenceSeconds !== undefined) {
    assert.equal(typeof subsystem.expectedCadenceSeconds, "number");
    assert.equal(typeof subsystem.staleAfterSeconds, "number");
  }
}

function assertUpsUnit(unit: UPSUnit): void {
  assert.equal(typeof unit.ups_id, "string");
  assert.equal(typeof unit.label, "string");
  assertSeverity(unit.severity);
  assert.equal(typeof unit.headline, "string");
  assertNullableString(unit.detail, "ups.detail");
  assertNullableNumber(unit.ts, "ups.ts");
  assert.equal(typeof unit.onBattery, "boolean");
  assert.equal(typeof unit.lowBattery, "boolean");
  assertNullableNumber(unit.charge, "ups.charge");
  assertNullableNumber(unit.runtimeSeconds, "ups.runtimeSeconds");
  assertNullableNumber(unit.runtimeMinutes, "ups.runtimeMinutes");
  assertNullableNumber(unit.voltage, "ups.voltage");
  assertNullableNumber(unit.load, "ups.load");
  assertNullableNumber(unit.onBatterySince, "ups.onBatterySince");
  assert.equal(typeof unit.unreachable, "boolean");
  assertNullableString(unit.readError, "ups.readError");
  assert.equal(typeof unit.expectedCadenceSeconds, "number");
  assert.equal(typeof unit.staleAfterSeconds, "number");
}

function assertAgentUnit(agent: AgentUnit): void {
  assert.equal(typeof agent.id, "string");
  assert.equal(typeof agent.label, "string");
  assertSeverity(agent.severity);
  assert.equal(typeof agent.headline, "string");
  assert.equal(typeof agent.detail, "string");
  assertNullableNumber(agent.ts, "agent.ts");
  assert.equal(typeof agent.expectedCadenceSeconds, "number");
  assert.equal(typeof agent.staleAfterSeconds, "number");
}

async function fetchDashboard(
  harness: ReturnType<typeof createTestHarness>,
  token = "mobile-secret"
): Promise<{ status: number; payload: DashboardPayload }> {
  return withAppServer(harness.app, async (base) => {
    const response = await fetch(new URL("/api/mobile/dashboard", base), {
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: response.status, payload: (await response.json()) as DashboardPayload };
  });
}

test("mobile dashboard: frozen top-level contract", async () => {
  const harness = createTestHarness({ prefix: "mobile-contract" });
  try {
    const { status, payload } = await fetchDashboard(harness);
    assert.equal(status, 200);
    assert.equal(payload.schema, 1);
    assert.equal(typeof payload.generatedAt, "number");
    assertSeverity(payload.overall.severity);
    assert.equal(typeof payload.overall.issueCount, "number");
    assert.equal(typeof payload.overall.summary, "string");
    assert.ok(Array.isArray(payload.subsystems));
    assert.ok(Array.isArray(payload.events));
    assert.deepEqual(Object.keys(payload).sort(), [
      "events",
      "generatedAt",
      "overall",
      "schema",
      "subsystems"
    ]);
    assert.deepEqual(Object.keys(payload.overall).sort(), ["issueCount", "severity", "summary"]);
  } finally {
    harness.close();
  }
});

test("mobile dashboard: every subsystem matches the Subsystem contract", async () => {
  const harness = createTestHarness({ prefix: "mobile-subsystems" });
  try {
    const { payload } = await fetchDashboard(harness);
    assert.ok(payload.subsystems.length > 0);
    for (const subsystem of payload.subsystems) assertSubsystem(subsystem);

    const keys = payload.subsystems.map((subsystem) => subsystem.key);
    for (const required of ["internet", "ups", "nas", "cameras", "devices", "agents", "media"]) {
      assert.ok(keys.includes(required), `missing subsystem ${required}`);
    }
  } finally {
    harness.close();
  }
});

test("mobile dashboard: UPSUnit and AgentUnit contracts hold with real rows", async () => {
  const harness = createTestHarness({ prefix: "mobile-units" });
  try {
    const now = Date.now();
    harness.database
      .prepare(
        `INSERT INTO ups_readings (received_at, ups_id, ups_label, ups_status, battery_charge,
           battery_runtime, battery_voltage, ups_load, raw)
         VALUES (?, 'tower', 'UPS Tower', 'OB DISCHRG', 64, 480, 12.1, 31, '{}')`
      )
      .run(now - 1000);

    const { payload } = await fetchDashboard(harness);
    const ups = payload.subsystems.find((subsystem) => subsystem.key === "ups");
    assert.ok(ups?.units && ups.units.length === 1);
    for (const unit of ups.units) assertUpsUnit(unit);
    assert.equal(ups.units[0]?.onBattery, true);
    assert.equal(ups.severity, "critical");

    const agents = payload.subsystems.find((subsystem) => subsystem.key === "agents");
    assert.ok(agents?.agents && agents.agents.length > 0);
    for (const agent of agents.agents) assertAgentUnit(agent);
  } finally {
    harness.close();
  }
});

test("mobile dashboard: media tile comes from Marquee and never from a shared table", async () => {
  const harness = createTestHarness({
    prefix: "mobile-media",
    mediaHealth: stubMediaHealth(HEALTHY_MEDIA_HEALTH)
  });
  try {
    const { payload } = await fetchDashboard(harness);
    const media = payload.subsystems.find((subsystem) => subsystem.key === "media");
    assert.ok(media);
    assert.equal(media.severity, "ok");
    assert.equal(media.informational, true);
    assert.equal(media.media?.source, "marquee");
    assert.equal(media.media?.overall, "healthy");
    assert.equal(media.media?.sonarrPresent, true);

    // Sonarr liveness is reported from the contract, not from an owned table.
    const agents = payload.subsystems.find((subsystem) => subsystem.key === "agents");
    const sonarr = agents?.agents?.find((agent) => agent.label === "Sonarr");
    assert.ok(sonarr);
    assert.equal(sonarr.severity, "ok");
  } finally {
    harness.close();
  }
});

test("mobile dashboard: an unreachable Marquee fails visibly instead of inventing success", async () => {
  const harness = createTestHarness({
    prefix: "mobile-media-down",
    mediaHealth: stubMediaHealth(new Error("marquee offline"))
  });
  try {
    const { payload } = await fetchDashboard(harness);
    const media = payload.subsystems.find((subsystem) => subsystem.key === "media");
    assert.ok(media);
    assert.equal(media.severity, "warn");
    assert.equal(media.informational, undefined);
    assert.equal(media.media?.overall, "unreachable");
    assert.match(String(media.detail), /unavailable/i);
    assert.ok(payload.overall.issueCount >= 1);

    const agents = payload.subsystems.find((subsystem) => subsystem.key === "agents");
    const sonarr = agents?.agents?.find((agent) => agent.label === "Sonarr");
    assert.equal(sonarr?.severity, "warn");
    assert.equal(sonarr?.headline, "Silent");
  } finally {
    harness.close();
  }
});

test("mobile dashboard: token is required and is not derived from any header identity", async () => {
  const harness = createTestHarness({ prefix: "mobile-auth" });
  try {
    await withAppServer(harness.app, async (base) => {
      const missing = await fetch(new URL("/api/mobile/dashboard", base));
      assert.equal(missing.status, 401);

      const wrong = await fetch(new URL("/api/mobile/dashboard", base), {
        headers: { authorization: "Bearer nope" }
      });
      assert.equal(wrong.status, 401);

      const impersonated = await fetch(new URL("/api/mobile/dashboard", base), {
        headers: { "x-ms-client-principal-name": "admin@example.test" }
      });
      assert.equal(impersonated.status, 401);

      const header = await fetch(new URL("/api/mobile/dashboard", base), {
        headers: { "x-hearth-token": "mobile-secret" }
      });
      assert.equal(header.status, 200);
    });
  } finally {
    harness.close();
  }
});

test("mobile dashboard: 503 when the mobile secret is unset", async () => {
  const { testConfig } = await import("../fixtures/monitoring/harness.js");
  const harness = createTestHarness({
    prefix: "mobile-unconfigured",
    config: testConfig({ serviceTokens: { mobile: undefined } })
  });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/mobile/dashboard", base), {
        headers: { authorization: "Bearer anything" }
      });
      assert.equal(response.status, 503);
    });
  } finally {
    harness.close();
  }
});
