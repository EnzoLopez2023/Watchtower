import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedWorker } from "../../server/workers/manager.js";
import { WorkerManager } from "../../server/workers/manager.js";

test("workers start in order, share cancellation, and stop in reverse order", async () => {
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const worker = (name: string): ManagedWorker => ({
    name,
    async start(signal) {
      signals.push(signal);
      events.push(`start:${name}`);
    },
    async stop() {
      events.push(`stop:${name}`);
    }
  });
  const manager = new WorkerManager([worker("alerts"), worker("archive"), worker("outages")]);
  await manager.start();
  assert.deepEqual(events, ["start:alerts", "start:archive", "start:outages"]);
  assert.equal(signals.every((signal) => !signal.aborted), true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(manager.status()).map(([name, value]) => [name, value.state])),
    { alerts: "healthy", archive: "healthy", outages: "healthy" }
  );

  await manager.stop();
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.deepEqual(events, [
    "start:alerts",
    "start:archive",
    "start:outages",
    "stop:outages",
    "stop:archive",
    "stop:alerts"
  ]);
});

test("a failed startup rolls back workers that already acquired resources", async () => {
  const events: string[] = [];
  const manager = new WorkerManager([
    {
      name: "instance-lease",
      async start() {
        events.push("lease:acquired");
      },
      async stop() {
        events.push("lease:released");
      }
    },
    {
      name: "alerts",
      async start() {
        throw new Error("startup failed");
      },
      async stop() {
        events.push("alerts:stopped");
      }
    }
  ]);

  await assert.rejects(manager.start(), /alerts failed to start/);
  assert.deepEqual(events, ["lease:acquired", "lease:released"]);
  assert.equal(manager.status()["instance-lease"]?.state, "stopped");
  assert.equal(manager.status().alerts?.state, "degraded");
});
