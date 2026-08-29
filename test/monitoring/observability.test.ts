import assert from "node:assert/strict";
import test from "node:test";
import { withAppServer } from "../helpers/appTestServer.js";
import type { SqliteDatabase } from "../../lib/db/connection.js";
import { canEditFeatures, countRows, createTestHarness } from "../fixtures/monitoring/harness.js";
import { AGENT_INGEST_CONTRACTS } from "../../lib/monitoring/agentContract.js";
import { AlertEngineWorker } from "../../server/workers/watchtower/alertEngineWorker.js";
import { WorkerManager } from "../../server/workers/manager.js";

const NOW = Date.now();

/** Reads guarded by viewer, writes by operator, observability by admin. */
const VIEWER_READS = [
  "/api/status",
  "/api/unifi",
  "/api/unifi/history",
  "/api/unifi/config",
  "/api/unifi/logs/summary",
  "/api/ups",
  "/api/ups/outages",
  "/api/protect",
  "/api/synology",
  "/api/network-observer",
  "/api/power/diagrams",
  "/api/ip-plan"
] as const;

const ADMIN_READS = [
  "/api/observability/logs",
  "/api/observability/analytics",
  "/api/admin/logs"
] as const;

function seedLogs(database: SqliteDatabase): void {
  const insert = database.prepare(
    "INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES (?, ?, ?, ?, ?)"
  );
  insert.run("unifi", NOW - 1000, "info", "collector started", NOW - 1000);
  insert.run("unifi", NOW - 900, "error", "controller unreachable", NOW - 900);
  insert.run("ups", NOW - 800, "warn", "battery test skipped", NOW - 800);
}

test("observability endpoints require the admin role", async () => {
  const viewer = createTestHarness({ prefix: "observability-viewer", roles: ["viewer"] });
  try {
    seedLogs(viewer.database);
    await withAppServer(viewer.app, async (base) => {
      for (const path of ADMIN_READS) {
        const response = await fetch(new URL(path, base));
        assert.equal(response.status, 403, `${path} must reject a viewer`);
      }
    });
  } finally {
    viewer.close();
  }

  const admin = createTestHarness({ prefix: "observability-admin", roles: ["viewer", "operator", "admin"] });
  try {
    seedLogs(admin.database);
    await withAppServer(admin.app, async (base) => {
      for (const path of ADMIN_READS) {
        const response = await fetch(new URL(path, base));
        assert.equal(response.status, 200, `${path} must serve an admin`);
      }
    });
  } finally {
    admin.close();
  }
});

test("observability logs expose the shipped agent lines with their levels", async () => {
  const harness = createTestHarness({ prefix: "observability-logs", roles: ["admin"] });
  try {
    seedLogs(harness.database);
    await withAppServer(harness.app, async (base) => {
      const response = await fetch(new URL("/api/observability/logs?agent=unifi", base));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { lines?: Array<{ agent: string; level: string }> };
      const rows = body.lines ?? [];
      assert.ok(rows.length >= 2);
      assert.ok(rows.every((row) => row.agent === "unifi"));

      const analytics = await fetch(new URL("/api/observability/analytics", base));
      assert.equal(analytics.status, 200);
      const analyticsBody = (await analytics.json()) as Record<string, unknown>;
      assert.ok(Object.keys(analyticsBody).length > 0);
    });
  } finally {
    harness.close();
  }
});

test("interactive reads reject an unauthenticated caller", async () => {
  const harness = createTestHarness({ prefix: "observability-anon" });
  try {
    await withAppServer(harness.app, async (base) => {
      for (const path of VIEWER_READS) {
        const response = await fetch(new URL(path, base));
        assert.equal(response.status, 403, `${path} must not be public`);
      }
    });
  } finally {
    harness.close();
  }
});

test("interactive reads serve a viewer", async () => {
  const harness = createTestHarness({ prefix: "observability-reader", roles: ["viewer"] });
  try {
    await withAppServer(harness.app, async (base) => {
      for (const path of VIEWER_READS) {
        const response = await fetch(new URL(path, base));
        assert.ok(
          response.status === 200,
          `${path} returned ${response.status}: ${await response.text()}`
        );
      }
    });
  } finally {
    harness.close();
  }
});

test("interactive writes require the operator role", async () => {
  const viewer = createTestHarness({ prefix: "observability-write-viewer", roles: ["viewer"] });
  try {
    await withAppServer(viewer.app, async (base) => {
      const create = await fetch(new URL("/api/power/diagrams", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rack" })
      });
      assert.equal(create.status, 403);
      const bust = await fetch(new URL("/api/azure/cache/bust", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prefix: "webapps" })
      });
      assert.equal(bust.status, 403);
    });
  } finally {
    viewer.close();
  }

  // The operator role is a ceiling, not a grant: the write also needs the
  // imported per-view canEdit row, so the harness supplies one.
  const operator = createTestHarness({
    prefix: "observability-write-operator",
    roles: ["viewer", "operator"],
    featurePermissions: canEditFeatures("power-topology")
  });
  try {
    await withAppServer(operator.app, async (base) => {
      const create = await fetch(new URL("/api/power/diagrams", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rack" })
      });
      assert.ok(create.status === 200 || create.status === 201, `unexpected ${create.status}`);
    });
  } finally {
    operator.close();
  }
});

test("service ingest is mounted ahead of the interactive gate and never uses a role", async () => {
  const harness = createTestHarness({ prefix: "observability-service-split" });
  try {
    await withAppServer(harness.app, async (base) => {
      // No identity is present at all, yet a correctly-signed collector push works.
      const response = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer ups-secret" },
        body: JSON.stringify({ ts: NOW, vars: { "ups.status": "OL" } })
      });
      assert.equal(response.status, 200);
    });
    assert.equal(countRows(harness.database, "ups_readings"), 1);
  } finally {
    harness.close();
  }
});

test("ingest routes carry the 50 MB allowance and other routes do not", async () => {
  const harness = createTestHarness({ prefix: "observability-limits", roles: ["viewer", "operator"] });
  try {
    await withAppServer(harness.app, async (base) => {
      const oversized = JSON.stringify({ name: "x".repeat(3 * 1024 * 1024) });
      const rejected = await fetch(new URL("/api/power/diagrams", base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized
      });
      assert.equal(rejected.status, 413, "interactive routes stay on the 2 MB global limit");

      const large = {
        ts: NOW,
        ups_id: "tower",
        vars: { "ups.status": "OL", note: "y".repeat(3 * 1024 * 1024) }
      };
      const accepted = await fetch(new URL("/api/ups/ingest", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer ups-secret" },
        body: JSON.stringify(large)
      });
      assert.equal(accepted.status, 200, "ingest accepts a production-sized payload");
    });
  } finally {
    harness.close();
  }
});

test("every declared agent contract is reachable on the service surface", async () => {
  const harness = createTestHarness({ prefix: "observability-contracts" });
  try {
    await withAppServer(harness.app, async (base) => {
      for (const contract of AGENT_INGEST_CONTRACTS) {
        // Log shipping resolves its secret from the declared agent name, so an
        // unnamed push is rejected as malformed before authentication.
        const body = contract.id === "agent-logs" ? { agent: "unifi" } : {};
        const response = await fetch(new URL(contract.path, base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        assert.notEqual(response.status, 404, `${contract.path} is not mounted`);
        assert.equal(response.status, 401, `${contract.path} must demand its own secret`);
      }
    });
  } finally {
    harness.close();
  }
});

test("the alert engine worker starts and stops through the managed worker API", async () => {
  const harness = createTestHarness({ prefix: "observability-worker" });
  try {
    const worker = new AlertEngineWorker({
      engine: harness.container.services.alertEngine,
      pollSeconds: 60
    });
    const manager = new WorkerManager([worker]);
    await manager.start();
    assert.equal(manager.status()["alert-engine"]?.state, "healthy");

    // A pass runs to completion without APNs configured or any device present.
    await worker.runOnce();

    await manager.stop();
    assert.equal(manager.status()["alert-engine"]?.state, "stopped");
  } finally {
    harness.close();
  }
});

test("archive status is reported without a configured Blob account", async () => {
  const harness = createTestHarness({ prefix: "observability-archive" });
  try {
    const summary = await harness.container.repositories.archiveStatus.archiveSummary();
    assert.equal(summary.enabled, false);
    assert.deepEqual(summary.streams, []);
    assert.equal(summary.latestError, null);
  } finally {
    harness.close();
  }
});
