import assert from "node:assert/strict";
import test from "node:test";
import { migrateDatabase } from "../../lib/db/migrate.js";
import { SqliteInstanceLeaseRepository } from "../../lib/db/repositories/instanceLeaseRepository.js";
import type { InstanceLeaseRepository } from "../../lib/db/repositories/instanceLeaseRepository.js";
import { InstanceLeaseWorker } from "../../server/workers/instanceLease.js";
import { WorkerManager, type ManagedWorker } from "../../server/workers/manager.js";
import { openTestDatabase, removeDatabase } from "../fixtures/monitoring/harness.js";

function leaseDatabase(prefix: string) {
  const { database, path } = openTestDatabase(prefix);
  migrateDatabase(database);
  return {
    database,
    repository: new SqliteInstanceLeaseRepository(database),
    holders(): number {
      const row = database.prepare("SELECT COUNT(*) AS c FROM runtime_instance_lease").get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    },
    close(): void {
      database.close();
      removeDatabase(path);
    }
  };
}

function recordingWorker(name: string, log: string[]): ManagedWorker {
  return {
    name,
    async start(): Promise<void> {
      log.push(`start:${name}`);
    },
    async stop(): Promise<void> {
      log.push(`stop:${name}`);
    }
  };
}

test("the instance lease starts first and is released last", async () => {
  const context = leaseDatabase("lease-order");
  try {
    const log: string[] = [];
    const lease = new InstanceLeaseWorker(
      {
        acquire: async (...args) => {
          log.push("start:instance-lease");
          return context.repository.acquire(...args);
        },
        renew: (...args) => context.repository.renew(...args),
        release: async (token) => {
          log.push("stop:instance-lease");
          await context.repository.release(token);
        }
      },
      "test-owner",
      () => undefined,
      1_000,
      500
    );
    const manager = new WorkerManager([
      lease,
      recordingWorker("monitoring-archive", log),
      recordingWorker("alert-engine", log)
    ]);

    await manager.start();
    assert.equal(context.holders(), 1, "the authority row is held while running");

    await manager.stop();
    assert.deepEqual(log, [
      "start:instance-lease",
      "start:monitoring-archive",
      "start:alert-engine",
      "stop:alert-engine",
      "stop:monitoring-archive",
      "stop:instance-lease"
    ]);
    assert.equal(context.holders(), 0, "the lease is released only after domain workers stop");
  } finally {
    context.close();
  }
});

test("a second process cannot start while the lease is held", async () => {
  const context = leaseDatabase("lease-contention");
  try {
    const first = new InstanceLeaseWorker(context.repository, "instance-a", () => undefined, 30_000, 10_000);
    const firstManager = new WorkerManager([first]);
    await firstManager.start();

    const second = new InstanceLeaseWorker(context.repository, "instance-b", () => undefined, 30_000, 10_000);
    const secondManager = new WorkerManager([second]);
    await assert.rejects(
      () => secondManager.start(),
      /Worker instance-lease failed to start/,
      "a second instance must fail closed rather than share the database"
    );
    assert.equal(secondManager.status()["instance-lease"]?.state, "degraded");
    assert.equal(context.holders(), 1);

    await firstManager.stop();
    assert.equal(context.holders(), 0);

    // With the lease free, the second instance may now take it.
    const third = new InstanceLeaseWorker(context.repository, "instance-b", () => undefined, 30_000, 10_000);
    const thirdManager = new WorkerManager([third]);
    await thirdManager.start();
    assert.equal(context.holders(), 1);
    await thirdManager.stop();
  } finally {
    context.close();
  }
});

test("a domain worker that fails to start releases the lease", async () => {
  const context = leaseDatabase("lease-unwind");
  try {
    const lease = new InstanceLeaseWorker(context.repository, "instance-a", () => undefined, 30_000, 10_000);
    const failing: ManagedWorker = {
      name: "monitoring-archive",
      async start(): Promise<void> {
        throw new Error("blob account unreachable");
      },
      async stop(): Promise<void> {
        /* never started */
      }
    };
    const manager = new WorkerManager([lease, failing]);
    await assert.rejects(() => manager.start(), /Worker monitoring-archive failed to start/);
    assert.equal(context.holders(), 0, "startup unwinding must not strand the authority row");
  } finally {
    context.close();
  }
});

test("losing the lease raises the shutdown callback exactly once", async () => {
  let renewals = 0;
  const lost: string[] = [];
  const repository: InstanceLeaseRepository = {
    async acquire(): Promise<boolean> {
      return true;
    },
    async renew(): Promise<boolean> {
      renewals += 1;
      return false;
    },
    async release(): Promise<void> {
      lost.push("released");
    }
  };
  const worker = new InstanceLeaseWorker(
    repository,
    "instance-a",
    () => lost.push("lease-lost"),
    200,
    20
  );
  await worker.start(new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.ok(renewals >= 1);
  assert.deepEqual(
    lost.filter((entry) => entry === "lease-lost"),
    ["lease-lost"],
    "a lost lease must escalate once, not on every tick"
  );

  // Stopping after a loss is safe and must not delete another owner's row.
  await worker.stop();
  assert.equal(lost.filter((entry) => entry === "released").length, 0);
});

test("a renewal failure is treated as a loss, not silently retried", async () => {
  const lost: string[] = [];
  const repository: InstanceLeaseRepository = {
    async acquire(): Promise<boolean> {
      return true;
    },
    async renew(): Promise<boolean> {
      throw new Error("database is locked");
    },
    async release(): Promise<void> {
      /* not reached */
    }
  };
  const worker = new InstanceLeaseWorker(repository, "instance-a", () => lost.push("lost"), 200, 20);
  await worker.start(new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await worker.stop();
  assert.deepEqual(lost, ["lost"]);
});
