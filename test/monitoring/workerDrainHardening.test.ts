import assert from "node:assert/strict";
import test from "node:test";
import { createOutagePostmortemWorker } from "../../server/workers/watchtower/outagePostmortemWorker.js";
import { createUnifiLogsBackfillWorker } from "../../server/workers/watchtower/unifiLogsBackfillWorker.js";
import type { OutageRepository } from "../../lib/db/repositories/watchtower/outageRepository.js";
import type { BackfillOptions, BackfillResult } from "../../lib/db/repositories/watchtower/unifiLogsRepository.js";

const outageConfig = { enabled: true } as never;
const repository = {} as OutageRepository;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("stop() awaits an in-flight post-mortem cycle before returning", async () => {
  let finished = false;
  let started = false;
  const worker = createOutagePostmortemWorker({
    config: outageConfig,
    startupDelayMs: 0,
    repository,
    runCycle: async () => {
      started = true;
      await delay(120);
      finished = true;
      return {};
    },
  });

  const controller = new AbortController();
  await worker.start(controller.signal);
  await delay(30);
  assert.equal(started, true, "the cycle should be running before shutdown begins");

  await worker.stop();
  assert.equal(
    finished,
    true,
    "stop() returned while a cycle was still writing — the lease and database would be released underneath it"
  );
});

test("an abort followed by stop() still drains, and stop() is idempotent", async () => {
  let completed = 0;
  const worker = createOutagePostmortemWorker({
    config: outageConfig,
    startupDelayMs: 0,
    repository,
    runCycle: async () => {
      await delay(80);
      completed += 1;
      return {};
    },
  });

  const controller = new AbortController();
  await worker.start(controller.signal);
  await delay(20);

  // The manager aborts its shared signal and then calls stop(); the abort
  // listener must not let the manager's call skip the drain.
  controller.abort();
  await worker.stop();
  assert.equal(completed, 1, "the in-flight cycle must be awaited after abort");

  const before = completed;
  await worker.stop();
  assert.equal(completed, before, "a second stop() must be a no-op, not a re-run");
});

test("no further cycle is scheduled once the worker has stopped", async () => {
  let runs = 0;
  const worker = createOutagePostmortemWorker({
    config: outageConfig,
    startupDelayMs: 0,
    repository,
    runCycle: async () => {
      runs += 1;
      await delay(20);
      return { evidenceBacklog: true };
    },
  });

  const controller = new AbortController();
  await worker.start(controller.signal);
  await delay(40);
  await worker.stop();

  const observed = runs;
  await delay(120);
  assert.equal(runs, observed, "a stopped worker must not reschedule itself");
});

test("a disabled post-mortem worker stops cleanly without running", async () => {
  let runs = 0;
  const worker = createOutagePostmortemWorker({
    config: { enabled: false },
    repository,
    runCycle: async () => {
      runs += 1;
      return {};
    },
  });
  const controller = new AbortController();
  await worker.start(controller.signal);
  await worker.stop();
  assert.equal(runs, 0);
});

// ── UniFi logs backfill worker ───────────────────────────────────────────────

interface FakeBackfillRepo {
  runBackfill(options?: BackfillOptions): Promise<BackfillResult>;
  calls: number;
}

function fakeRepo(passes: number, onCall?: () => void): FakeBackfillRepo {
  let remaining = passes;
  return {
    calls: 0,
    async runBackfill(): Promise<BackfillResult> {
      this.calls += 1;
      onCall?.();
      remaining -= 1;
      return {
        updated: 10,
        invalid: 0,
        timestamps: [],
        batches: 1,
        incomplete: remaining > 0,
      };
    },
  };
}

test("backfill does not run during router or worker construction", async () => {
  const repo = fakeRepo(1);
  createUnifiLogsBackfillWorker({ repository: repo });
  await delay(30);
  assert.equal(repo.calls, 0, "constructing the worker must not touch the database");
});

test("backfill is deferred past startup and then runs to completion", async () => {
  const repo = fakeRepo(3);
  const worker = createUnifiLogsBackfillWorker({
    repository: repo,
    startDelayMs: 20,
    batchPauseMs: 1,
  });

  const controller = new AbortController();
  await worker.start(controller.signal);
  assert.equal(repo.calls, 0, "start() must return before any write happens");
  assert.equal(worker.state().status, "idle");

  await delay(150);
  const state = worker.state();
  assert.equal(state.status, "complete");
  assert.equal(repo.calls, 3, "each incomplete pass should be followed by another");
  assert.equal(state.status === "complete" && state.converted, 30);
});

test("backfill failures are surfaced as state, never swallowed", async () => {
  const worker = createUnifiLogsBackfillWorker({
    repository: {
      async runBackfill(): Promise<BackfillResult> {
        throw new Error("disk is full");
      },
    },
    startDelayMs: 5,
  });

  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args);
  };
  try {
    const controller = new AbortController();
    await worker.start(controller.signal);
    await delay(60);
  } finally {
    console.error = original;
  }

  const state = worker.state();
  assert.equal(state.status, "failed");
  assert.equal(state.status === "failed" && state.error, "disk is full");
  assert.ok(
    errors.some((entry) => entry.join(" ").includes("disk is full")),
    "the failure must also be logged, not silently discarded"
  );
});

test("stopping the backfill worker cancels a pending pass and drains a running one", async () => {
  let inFlight = false;
  let completedWhileStopping = false;
  const worker = createUnifiLogsBackfillWorker({
    repository: {
      async runBackfill(): Promise<BackfillResult> {
        inFlight = true;
        await delay(80);
        inFlight = false;
        completedWhileStopping = true;
        return { updated: 1, invalid: 0, timestamps: [], batches: 1, incomplete: true };
      },
    },
    startDelayMs: 0,
    batchPauseMs: 1,
  });

  const controller = new AbortController();
  await worker.start(controller.signal);
  await delay(25);
  assert.equal(inFlight, true);

  controller.abort();
  await worker.stop();
  assert.equal(inFlight, false, "stop() must not return mid-write");
  assert.equal(completedWhileStopping, true);
  assert.equal(worker.state().status, "cancelled");
});

test("a backfill scheduled but not yet started is cancelled by stop()", async () => {
  const repo = fakeRepo(1);
  const worker = createUnifiLogsBackfillWorker({ repository: repo, startDelayMs: 200 });
  const controller = new AbortController();
  await worker.start(controller.signal);
  await worker.stop();
  await delay(250);
  assert.equal(repo.calls, 0, "the deferred pass must be cancelled, not fired after shutdown");
  assert.equal(worker.state().status, "idle");
});
