import assert from "node:assert/strict";
import test from "node:test";
import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { SqliteAlertStateRepository } from "../../lib/db/repositories/watchtower/alertStateRepository.js";
import { SqliteInfraStatusRepository } from "../../lib/db/repositories/watchtower/infraStatusRepository.js";
import { SqliteMobilePushRepository } from "../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { SqlitePowerTopologyRepository } from "../../lib/db/repositories/watchtower/powerTopologyRepository.js";
import { SqliteUpsRepository } from "../../lib/db/repositories/watchtower/upsRepository.js";
import { openTestDatabase, removeDatabase } from "../fixtures/monitoring/harness.js";

function repositories(prefix: string) {
  const { database, path } = openTestDatabase(prefix);
  const receipts = new SqliteAgentIngestReceiptRepository(database);
  return {
    database,
    receipts,
    ups: new SqliteUpsRepository(database, receipts),
    power: new SqlitePowerTopologyRepository(database),
    alerts: new SqliteAlertStateRepository(database),
    push: new SqliteMobilePushRepository(database),
    infra: new SqliteInfraStatusRepository(database),
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";

// ── The contract itself ──────────────────────────────────────────────────────

test("every public repository method returns a Promise", async () => {
  const context = repositories("async-contract");
  try {
    const probes: Array<[string, unknown]> = [
      ["ups.getLatestPerUps", context.ups.getLatestPerUps()],
      ["ups.getHistory", context.ups.getHistory(Date.now() - 86_400_000, null)],
      ["power.listDiagrams", context.power.listDiagrams()],
      ["alerts.listState", context.alerts.listState()],
      ["alerts.countDevices", context.alerts.countDevices()],
      ["push.listDeviceTokens", context.push.listDeviceTokens()],
      ["infra.agentContact", context.infra.agentContact()],
      ["infra.synologyLatest", context.infra.synologyLatest()]
    ];
    for (const [name, value] of probes) {
      assert.ok(isPromise(value), `${name} must return a Promise`);
    }
    await Promise.all(probes.map(([, value]) => value));
  } finally {
    context.close();
  }
});

/**
 * `protected` is erased at runtime, so this guard has to be a compile-time one:
 * each `@ts-expect-error` fails the build if the member ever becomes public, and
 * an unused `@ts-expect-error` also fails the build if the call starts type-
 * checking for any other reason.
 */
test("transaction control is not reachable from outside an adapter", () => {
  const context = repositories("async-no-transaction");
  try {
    // @ts-expect-error transaction control must stay protected inside the adapter
    assert.equal(typeof context.ups.transaction, "function");
    // @ts-expect-error transaction control must stay protected inside the adapter
    assert.equal(typeof context.power.transaction, "function");
    // @ts-expect-error transaction control must stay protected inside the adapter
    assert.equal(typeof context.alerts.transaction, "function");
    // @ts-expect-error raw statement helpers must stay protected inside the adapter
    assert.equal(typeof context.push.run, "function");
  } finally {
    context.close();
  }
});

// ── Rejection propagation ────────────────────────────────────────────────────

test("a storage failure rejects the promise rather than throwing synchronously", async () => {
  const context = repositories("async-rejects");
  try {
    context.database.exec("DROP TABLE power_diagrams");

    // Synchronous throw would escape here instead of producing a rejection.
    let call: Promise<unknown>;
    assert.doesNotThrow(() => {
      call = context.power.listDiagrams();
    }, "the adapter must not throw before returning its promise");

    await assert.rejects(async () => call, /power_diagrams/);
  } finally {
    context.close();
  }
});

test("a rejection propagates through an awaiting caller", async () => {
  const context = repositories("async-propagate");
  try {
    context.database.exec("DROP TABLE mobile_devices");
    const caller = async (): Promise<number> => {
      const tokens = await context.push.listDeviceTokens();
      return tokens.length;
    };
    await assert.rejects(caller, /mobile_devices/);
  } finally {
    context.close();
  }
});

test("a rejected write leaves no partial state behind", async () => {
  const context = repositories("async-reject-clean");
  try {
    const created = await context.power.createDiagram("Rack");
    const diagramId = Number(created["id"]);
    assert.ok(diagramId > 0);
    context.database.exec("DROP TABLE power_items");
    await assert.rejects(() => context.power.replaceGraph(diagramId, [], [], []), /power_items/);
    const diagrams = await context.power.listDiagrams();
    assert.equal(diagrams.length, 1, "the diagram row itself must survive a failed graph write");
  } finally {
    context.close();
  }
});

// ── Transaction semantics survive the async boundary ─────────────────────────

test("an atomic graph replace commits as a unit", async () => {
  const context = repositories("async-graph-atomic");
  try {
    const diagram = await context.power.createDiagram("Rack");
    const diagramId = Number(diagram["id"]);
    const result = await context.power.replaceGraph(
      diagramId,
      [
        { client_id: "a", name: "UPS", kind: "ups", pos_x: 0, pos_y: 0, plug_count: 4 },
        { client_id: "b", name: "NAS", kind: "device", pos_x: 10, pos_y: 10 }
      ],
      [],
      []
    );
    assert.ok(!("error" in result), "the replace must succeed");
    const graph = await context.power.getDiagramGraph(diagramId);
    assert.equal(graph?.items.length, 2);
  } finally {
    context.close();
  }
});

test("a delivery receipt claimed inside an ingest transaction is not double-counted", async () => {
  const context = repositories("async-receipt-atomic");
  try {
    const row = {
      received_at: Date.now(),
      device_ts: null,
      ups_id: "tower",
      ups_label: "Tower",
      ups_status: "OL",
      battery_charge: 100,
      battery_runtime: 3600,
      battery_voltage: 12.6,
      ups_load: 20,
      input_voltage: 120,
      output_voltage: 120,
      output_power: 60,
      ups_temperature: null,
      raw: "{}",
      agent_diag: null
    };

    assert.equal(await context.ups.ingest(row, "delivery-1"), true);
    assert.equal(await context.ups.ingest(row, "delivery-1"), false, "a replay must be refused");

    const readings = await context.ups.getLatestPerUps();
    assert.equal(readings.length, 1);
    const receipts = await context.receipts.listReceipts();
    assert.equal(receipts.filter((entry) => entry.delivery_id === "delivery-1").length, 1);
  } finally {
    context.close();
  }
});

test("a failed ingest rolls back both the domain row and its receipt", async () => {
  const context = repositories("async-ingest-rollback");
  try {
    // Force the domain insert to fail after the receipt has been claimed.
    context.database.exec("DROP TABLE ups_readings");
    await assert.rejects(
      () =>
        context.ups.ingest(
          {
            received_at: Date.now(),
            device_ts: null,
            ups_id: "tower",
            ups_label: null,
            ups_status: "OL",
            battery_charge: null,
            battery_runtime: null,
            battery_voltage: null,
            ups_load: null,
            input_voltage: null,
            output_voltage: null,
            output_power: null,
            ups_temperature: null,
            raw: "{}",
            agent_diag: null
          },
          "delivery-rollback"
        ),
      /ups_readings/
    );

    const receipts = await context.receipts.listReceipts();
    assert.equal(
      receipts.filter((entry) => entry.delivery_id === "delivery-rollback").length,
      0,
      "the receipt must roll back with the domain write, or the push is lost forever"
    );
  } finally {
    context.close();
  }
});

test("concurrent awaited writes serialize without interleaving", async () => {
  const context = repositories("async-serialize");
  try {
    const diagram = await context.power.createDiagram("Rack");
    const diagramId = Number(diagram["id"]);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        context.power.createItem({
          diagram_id: diagramId,
          name: `Item ${index}`,
          kind: "device",
          pos_x: index,
          pos_y: index
        })
      )
    );
    const graph = await context.power.getDiagramGraph(diagramId);
    assert.equal(graph?.items.length, 12, "every concurrent write must be durable");
  } finally {
    context.close();
  }
});
