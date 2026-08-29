import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_INGEST_CONTRACTS,
  DELIVERY_ID_HEADER,
  DELIVERY_ID_PATTERN,
  contractFor,
  type AgentId
} from "../../lib/monitoring/agentContract.js";
import { withAppServer } from "../helpers/appTestServer.js";
import type { SqliteDatabase } from "../../lib/db/connection.js";
import { countRows, createTestHarness } from "../fixtures/monitoring/harness.js";

const NOW = Date.now();

interface AgentCase {
  readonly id: AgentId;
  readonly token: string;
  /** Table and predicate proving exactly one domain row was written. */
  readonly count: (database: SqliteDatabase) => number;
  body(nonce?: string): Record<string, unknown>;
}

const CASES: readonly AgentCase[] = [
  {
    id: "unifi",
    token: "unifi-secret",
    count: (database) =>
      countRows(database, "unifi_readings"),
    body: () => ({
      ts: NOW,
      wan: { status: "up", latency_ms: 12, _health: { www: { status: "ok" } } },
      devices: [{ mac: "aa:bb:cc:dd:ee:ff", name: "Switch", online: true, rx_bps: 1, tx_bps: 2 }],
      clients: [{ mac: "11:22:33:44:55:66", name: "Laptop", rx_bps: 3, tx_bps: 4 }]
    })
  },
  {
    id: "unifi-logs",
    token: "unifi-secret",
    count: (database) =>
      countRows(database, "unifi_activity_logs"),
    body: (nonce = "1") => ({
      collected_at: NOW,
      activity: [
        {
          id: `activity-${nonce}`,
          timestamp: NOW,
          severity: "info",
          category: "system",
          message: "Controller updated"
        }
      ]
    })
  },
  {
    id: "ups",
    token: "ups-secret",
    count: (database) =>
      countRows(database, "ups_readings"),
    body: () => ({
      ts: NOW,
      ups_id: "tower",
      ups_label: "Tower",
      vars: { "ups.status": "OL", "battery.charge": "100", "battery.runtime": "3600" }
    })
  },
  {
    id: "protect",
    token: "protect-secret",
    count: (database) =>
      countRows(database, "protect_readings"),
    body: () => ({
      ts: NOW,
      nvr: { name: "NVR", storage_used_bytes: 10, storage_total_bytes: 100 },
      cameras: [{ id: "cam-1", name: "Front Door", state: "CONNECTED" }]
    })
  },
  {
    id: "synology",
    token: "synology-secret",
    count: (database) =>
      countRows(database, "synology_latest"),
    body: () => ({
      ts: NOW,
      nas_id: "ds1821",
      label: "DS1821",
      host: "10.0.0.20",
      volumes: [{ name: "volume1", used_pct: 42, total_bytes: 100, used_bytes: 42 }],
      disks: [{ name: "Disk 1", smart_status: "normal", health: "normal" }]
    })
  },
  {
    id: "network-observer",
    token: "observer-secret",
    count: (database) =>
      countRows(database, "network_probe_samples"),
    body: () => ({
      ts: NOW,
      observer_id: "pi-observer",
      probes: [{ kind: "lan", id: "gateway", label: "Gateway", ok: true, latency_ms: 2, ts: NOW }]
    })
  },
  {
    id: "agent-logs",
    token: "unifi-secret",
    count: (database) =>
      countRows(database, "agent_logs"),
    body: () => ({
      agent: "unifi",
      lines: [{ ts: NOW, level: "info", message: "collector started" }]
    })
  }
];

async function ingest(
  base: URL,
  contractId: AgentId,
  token: string,
  body: unknown,
  deliveryId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  };
  if (deliveryId) headers[DELIVERY_ID_HEADER] = deliveryId;
  return fetch(new URL(contractFor(contractId).path, base), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

test("agent contracts cover every mounted ingest endpoint", () => {
  assert.equal(AGENT_INGEST_CONTRACTS.length, CASES.length);
  for (const contract of AGENT_INGEST_CONTRACTS) {
    assert.ok(
      CASES.some((candidate) => candidate.id === contract.id),
      `no replay case for ${contract.id}`
    );
    assert.equal(contract.maxBodyBytes, 50 * 1024 * 1024);
    assert.ok(contract.tokenEnv.length > 0);
  }
});

for (const agentCase of CASES) {
  test(`${agentCase.id}: a replayed delivery id is a no-op`, async () => {
    const harness = createTestHarness({ prefix: `replay-${agentCase.id}` });
    try {
      await withAppServer(harness.app, async (base) => {
        const deliveryId = `${agentCase.id}-delivery-1`;
        assert.ok(DELIVERY_ID_PATTERN.test(deliveryId));

        const first = await ingest(base, agentCase.id, agentCase.token, agentCase.body(), deliveryId);
        assert.equal(first.status, 200, `first ingest failed: ${await first.text()}`);
        const afterFirst = agentCase.count(harness.database);
        assert.ok(afterFirst > 0, "first ingest must write a domain row");

        const replay = await ingest(base, agentCase.id, agentCase.token, agentCase.body(), deliveryId);
        assert.equal(replay.status, 200);
        assert.equal(
          agentCase.count(harness.database),
          afterFirst,
          "a replayed delivery id must not write again"
        );

        const receipts = (await harness.container.repositories.receipts.listReceipts()).filter(
          (receipt) => receipt.delivery_id === deliveryId
        );
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0]?.endpoint, contractFor(agentCase.id).path);
      });
    } finally {
      harness.close();
    }
  });

  test(`${agentCase.id}: a fresh delivery id is accepted after a replay`, async () => {
    const harness = createTestHarness({ prefix: `replay-fresh-${agentCase.id}` });
    try {
      await withAppServer(harness.app, async (base) => {
        await ingest(base, agentCase.id, agentCase.token, agentCase.body("a"), "delivery-a");
        const baseline = agentCase.count(harness.database);
        assert.ok(baseline > 0);
        await ingest(base, agentCase.id, agentCase.token, agentCase.body("a"), "delivery-a");
        assert.equal(agentCase.count(harness.database), baseline);
        await ingest(base, agentCase.id, agentCase.token, agentCase.body("b"), "delivery-b");
        assert.ok(
          agentCase.count(harness.database) > baseline || contractFor(agentCase.id).snapshot,
          "a new delivery id must be processed"
        );
      });
    } finally {
      harness.close();
    }
  });

  test(`${agentCase.id}: a malformed delivery id falls back to non-idempotent ingest`, async () => {
    const harness = createTestHarness({ prefix: `replay-bad-${agentCase.id}` });
    try {
      await withAppServer(harness.app, async (base) => {
        const malformed = "!!not-a-valid-id!!";
        assert.equal(DELIVERY_ID_PATTERN.test(malformed), false);
        const response = await ingest(
          base,
          agentCase.id,
          agentCase.token,
          agentCase.body(),
          malformed
        );
        assert.equal(response.status, 200);
        assert.equal(
          (await harness.container.repositories.receipts.listReceipts()).filter(
            (receipt) => receipt.delivery_id === malformed
          ).length,
          0,
          "a malformed id must never be recorded as a receipt"
        );
      });
    } finally {
      harness.close();
    }
  });

  test(`${agentCase.id}: rejects a secret belonging to another collector`, async () => {
    const harness = createTestHarness({ prefix: `replay-auth-${agentCase.id}` });
    try {
      await withAppServer(harness.app, async (base) => {
        const missing = await fetch(new URL(contractFor(agentCase.id).path, base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(agentCase.body())
        });
        assert.equal(missing.status, 401);

        const foreign = await ingest(base, agentCase.id, "totally-wrong-secret", agentCase.body());
        assert.equal(foreign.status, 401);
      });
    } finally {
      harness.close();
    }
  });
}

test("agent-logs: a UPS secret cannot ship UniFi lines", async () => {
  const harness = createTestHarness({ prefix: "replay-agent-log-isolation" });
  try {
    await withAppServer(harness.app, async (base) => {
      const crossed = await ingest(base, "agent-logs", "ups-secret", {
        agent: "unifi",
        lines: [{ ts: NOW, level: "info", message: "should not be accepted" }]
      });
      assert.equal(crossed.status, 401);

      const matched = await ingest(base, "agent-logs", "ups-secret", {
        agent: "ups",
        lines: [{ ts: NOW, level: "info", message: "accepted" }]
      });
      assert.equal(matched.status, 200);
    });
  } finally {
    harness.close();
  }
});

test("agent-logs: the shutdown watchdog shares the UPS secret", async () => {
  const harness = createTestHarness({ prefix: "replay-shutdown" });
  try {
    await withAppServer(harness.app, async (base) => {
      const response = await ingest(base, "agent-logs", "ups-secret", {
        agent: "shutdown",
        lines: [{ ts: NOW, level: "warn", message: "AC lost" }]
      });
      assert.equal(response.status, 200);
    });
    assert.equal(
      countRows(harness.database, "agent_logs", "agent = 'shutdown'"),
      1
    );
  } finally {
    harness.close();
  }
});

test("agent-logs: line count and message length are bounded", async () => {
  const harness = createTestHarness({ prefix: "replay-bounds" });
  try {
    const contract = contractFor("agent-logs");
    await withAppServer(harness.app, async (base) => {
      const lines = Array.from({ length: (contract.maxArrayItems ?? 500) + 25 }, (_, index) => ({
        ts: NOW + index,
        level: "info",
        message: "x".repeat((contract.maxMessageChars ?? 2000) + 100)
      }));
      const response = await ingest(base, "agent-logs", "unifi-secret", { agent: "unifi", lines });
      assert.equal(response.status, 200);
    });
    const stored = harness.database
      .prepare("SELECT message FROM agent_logs")
      .all() as Array<{ message: string }>;
    assert.equal(stored.length, contractFor("agent-logs").maxArrayItems);
    for (const row of stored) {
      assert.equal(row.message.length, contractFor("agent-logs").maxMessageChars);
    }
  } finally {
    harness.close();
  }
});

test("delivery receipts record the endpoint that claimed them", async () => {
  const harness = createTestHarness({ prefix: "replay-receipts" });
  try {
    await withAppServer(harness.app, async (base) => {
      await ingest(base, "ups", "ups-secret", CASES[2]?.body() ?? {}, "shared-id");
      // The same id on a different endpoint is a different delivery only if the
      // receipt table is keyed by id alone — production keys by id, so this is a
      // duplicate and must not write.
      const response = await ingest(
        base,
        "network-observer",
        "observer-secret",
        CASES[5]?.body() ?? {},
        "shared-id"
      );
      assert.equal(response.status, 200);
    });
    const receipts = await harness.container.repositories.receipts.listReceipts();
    assert.equal(receipts.filter((receipt) => receipt.delivery_id === "shared-id").length, 1);
    assert.equal(
      countRows(harness.database, "network_probe_samples"),
      0,
      "a duplicate delivery id must not write on a second endpoint either"
    );
  } finally {
    harness.close();
  }
});
