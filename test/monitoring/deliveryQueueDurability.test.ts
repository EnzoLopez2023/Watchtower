// Regression coverage for two accepted delivery-queue defects:
//   * Defect 5 - flush acknowledged entries by stale array index, so a coalescing
//     enqueue during an in-flight send could delete the unsent replacement.
//   * Defect 6 - enqueue made an entry eligible before its append was durable, and
//     the append did not tolerate short/zero/invalid writes or fsync/close faults.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createDeliveryQueue,
  type QueueFileHandle,
  type QueueFileSystem
} from "../../agents/deliveryQueue.js";
import { DELIVERY_ID_HEADER } from "../../lib/monitoring/agentContract.js";

const SCRATCH_DIR = join(new URL(".", import.meta.url).pathname, "../../.scratch/wt/tmp");
mkdirSync(SCRATCH_DIR, { recursive: true });

let fileCounter = 0;
const created: string[] = [];
const queueFile = (label: string): string => {
  fileCounter += 1;
  const path = join(SCRATCH_DIR, `delivery-${label}-${Date.now()}-${fileCounter}.log`);
  created.push(path);
  return path;
};

after(() => {
  for (const path of created) {
    for (const suffix of ["", ".tmp", ".dead-letter", ".dead-letter.1"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

const FLUSH_BASE = { baseUrl: "https://ingest.example", token: "test-token" };

interface Recorded {
  readonly deliveryId: string;
  readonly body: string;
}

interface FetchController {
  readonly fetch: typeof fetch;
  readonly seen: Recorded[];
  readonly firstStarted: Promise<void>;
  release(): void;
  deliveredIds(): string[];
}

// A fetch double that records every delivery and can hold the first request open
// so a test can mutate the queue while a send is genuinely in flight.
const gatedFetch = ({ gateFirst = false }: { gateFirst?: boolean } = {}): FetchController => {
  const seen: Recorded[] = [];
  let calls = 0;
  let markStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    const deliveryId = new Headers(init?.headers).get(DELIVERY_ID_HEADER) ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ deliveryId, body });
    if (calls === 1 && gateFirst) {
      markStarted();
      await gate;
    }
    return new Response("{}", { status: 200 });
  };

  return {
    fetch: fetchImpl,
    seen,
    firstStarted,
    release: () => {
      openGate();
    },
    deliveredIds: () => seen.map((record) => record.deliveryId)
  };
};

interface FaultBehavior {
  write: (data: Uint8Array, offset: number, length: number) => number;
  sync?: () => void;
  close?: () => void;
}

interface QueueFsProbe {
  readonly fs: QueueFileSystem;
  readonly state: { writeCalls: number; syncCalls: number; closeCalls: number };
  written(): Buffer;
}

// Injects faults only for a single target path; every other path (temp files,
// dead-letter) gets a benign handle so unrelated writes never interfere.
const probeFileSystem = (targetPath: string, behavior: FaultBehavior): QueueFsProbe => {
  const chunks: Uint8Array[] = [];
  const state = { writeCalls: 0, syncCalls: 0, closeCalls: 0 };
  const fs: QueueFileSystem = {
    open(path, _flags): QueueFileHandle {
      if (path !== targetPath) {
        return {
          write: (_data, _offset, length) => length,
          sync: () => undefined,
          close: () => undefined
        };
      }
      return {
        write: (data, offset, length) => {
          state.writeCalls += 1;
          const written = behavior.write(data, offset, length);
          if (Number.isInteger(written) && written > 0) {
            chunks.push(Buffer.from(data.subarray(offset, offset + written)));
          }
          return written;
        },
        sync: () => {
          state.syncCalls += 1;
          behavior.sync?.();
        },
        close: () => {
          state.closeCalls += 1;
          behavior.close?.();
        }
      };
    }
  };
  return {
    fs,
    state,
    written: () => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  };
};

// ---------------------------------------------------------------------------
// Defect 5 - acknowledge by stable id, never by stale array position.
// ---------------------------------------------------------------------------

test("defect5: a coalescing enqueue during an in-flight send retains the replacement", async () => {
  const filePath = queueFile("coalesce-inflight");
  const queue = createDeliveryQueue({ filePath, source: "agent" });

  const controller = gatedFetch({ gateFirst: true });
  const id1 = queue.enqueue({ path: "/snap", body: JSON.stringify({ v: 1 }), coalesceKey: "K" });

  const firstFlush = queue.flush({
    ...FLUSH_BASE,
    fetchImplementation: controller.fetch,
    maxRequests: 1
  });
  await controller.firstStarted; // send(id1) is now blocked mid-flight

  const id2 = queue.enqueue({ path: "/snap", body: JSON.stringify({ v: 2 }), coalesceKey: "K" });
  controller.release();

  const firstResult = await firstFlush;
  assert.deepEqual(firstResult.acceptedIds, [id1], "only the originally-sent entry is acknowledged");
  assert.equal(firstResult.pending, 1, "replacement survives instead of being deleted by stale index");
  assert.deepEqual(controller.deliveredIds(), [id1]);

  const drain = gatedFetch();
  const secondResult = await queue.flush({ ...FLUSH_BASE, fetchImplementation: drain.fetch });
  assert.deepEqual(secondResult.acceptedIds, [id2], "replacement is delivered on the next flush");
  assert.equal(secondResult.pending, 0);
  assert.equal(drain.seen.length, 1, "replacement delivered exactly once, nothing double-sent");
  const delivered = JSON.parse(drain.seen[0]?.body ?? "{}") as { v?: number };
  assert.equal(delivered.v, 2, "the newest coalesced body wins");
});

test("defect5: concurrent enqueues during an in-flight batched event send lose nothing", async () => {
  const filePath = queueFile("batch-concurrent");
  const queue = createDeliveryQueue({ filePath, source: "agent" });
  const batch = { path: "/events", batchKey: "b", batchField: "items" } as const;

  const e1 = queue.enqueue({ ...batch, body: JSON.stringify({ items: [1] }) });
  const e2 = queue.enqueue({ ...batch, body: JSON.stringify({ items: [2] }) });
  const s1 = queue.enqueue({ path: "/snap", body: JSON.stringify({ state: "a" }), coalesceKey: "k" });

  const controller = gatedFetch({ gateFirst: true });
  const flushing = queue.flush({ ...FLUSH_BASE, fetchImplementation: controller.fetch });
  await controller.firstStarted; // snapshot s1 is in flight; events wait behind it

  // Coalesce the in-flight snapshot away and append another event concurrently.
  const s2 = queue.enqueue({ path: "/snap", body: JSON.stringify({ state: "b" }), coalesceKey: "k" });
  const e3 = queue.enqueue({ ...batch, body: JSON.stringify({ items: [3] }) });
  controller.release();

  const result = await flushing;
  assert.equal(result.pending, 0, "the whole queue drained");

  const ids = controller.deliveredIds();
  assert.ok(ids.includes(s1), "the originally-sent snapshot was delivered");
  assert.ok(ids.includes(s2), "the replacement snapshot was retained and delivered, not index-dropped");

  const batchRequest = controller.seen.find((record) => record.deliveryId === e1);
  assert.ok(batchRequest, "the event batch was delivered under the first event id");
  const batchBody = JSON.parse(batchRequest.body) as { items?: number[] };
  assert.deepEqual(batchBody.items, [1, 2, 3], "every batched event survived concurrent enqueue");
  assert.deepEqual(
    [...result.acceptedIds].sort(),
    [s1, s2, e1, e2, e3].sort(),
    "each entry is acknowledged exactly once"
  );
});

test("defect5: stale-index removal would delete a bystander; id removal keeps exact survivors", async () => {
  const filePath = queueFile("bystander");
  const queue = createDeliveryQueue({ filePath, source: "agent" });

  const a = queue.enqueue({ path: "/snap", body: JSON.stringify({ k: "a" }), coalesceKey: "k1" });
  const b = queue.enqueue({ path: "/snap", body: JSON.stringify({ k: "b" }), coalesceKey: "k2" });
  const c = queue.enqueue({ path: "/snap", body: JSON.stringify({ k: "c" }), coalesceKey: "k3" });

  const controller = gatedFetch({ gateFirst: true });
  const firstFlush = queue.flush({
    ...FLUSH_BASE,
    fetchImplementation: controller.fetch,
    maxRequests: 1
  });
  await controller.firstStarted; // send(a) blocked; a sits at index 0

  // Replacing "a" removes it and shifts b, c left - a stale index 0 would hit b.
  const a2 = queue.enqueue({ path: "/snap", body: JSON.stringify({ k: "a2" }), coalesceKey: "k1" });
  controller.release();

  const firstResult = await firstFlush;
  assert.deepEqual(firstResult.acceptedIds, [a]);
  assert.equal(firstResult.pending, 3, "b, c and the replacement all survive the shift");

  const drain = gatedFetch();
  const drainResult = await queue.flush({ ...FLUSH_BASE, fetchImplementation: drain.fetch });
  assert.equal(drainResult.pending, 0);

  const deliveredById = new Map(
    [...controller.seen, ...drain.seen].map(
      (record): [string, { k?: string }] => [record.deliveryId, JSON.parse(record.body) as { k?: string }]
    )
  );
  assert.deepEqual([...deliveredById.keys()].sort(), [a, b, c, a2].sort(), "exact delivered set");
  assert.equal(deliveredById.get(a)?.k, "a");
  assert.equal(deliveredById.get(b)?.k, "b", "innocent bystander b was not dropped");
  assert.equal(deliveredById.get(c)?.k, "c", "innocent bystander c was not dropped");
  assert.equal(deliveredById.get(a2)?.k, "a2", "replacement kept its newest body");
});

// ---------------------------------------------------------------------------
// Defect 6 - durable append gates in-memory eligibility; faults never leak.
// ---------------------------------------------------------------------------

test("defect6: durable append tolerates short writes and makes the entry eligible once", () => {
  const filePath = queueFile("short-writes");
  const probe = probeFileSystem(filePath, {
    write: (_data, _offset, length) => Math.min(length, 7)
  });
  const queue = createDeliveryQueue({ filePath, source: "agent", fileSystem: probe.fs });

  const line = JSON.stringify({ hello: "world", n: 1 });
  const id = queue.enqueue({ path: "/ingest", body: line });

  const writtenText = probe.written().toString("utf8");
  assert.ok(writtenText.endsWith("\n"), "append is newline-terminated");
  const parsed = JSON.parse(writtenText.trimEnd()) as { id: string; body: string; path: string };
  assert.equal(parsed.id, id, "the full record was assembled from the short writes");
  assert.equal(parsed.body, line);
  assert.equal(parsed.path, "/ingest");

  assert.ok(probe.state.writeCalls > 1, "the short-write loop iterated");
  assert.equal(probe.state.syncCalls, 1, "fsync ran once");
  assert.equal(probe.state.closeCalls, 1, "handle closed once");
  assert.equal(queue.status().pending, 1, "entry becomes eligible exactly once");
});

test("defect6: a zero-byte write is rejected without mutating memory or spinning", () => {
  const filePath = queueFile("zero-write");
  const probe = probeFileSystem(filePath, { write: () => 0 });
  const queue = createDeliveryQueue({ filePath, source: "agent", fileSystem: probe.fs });

  assert.throws(
    () => queue.enqueue({ path: "/ingest", body: JSON.stringify({ n: 1 }) }),
    /stalled/,
    "a zero-byte write is a hard failure"
  );
  assert.equal(queue.status().pending, 0, "no eligibility mutation on failure");
  assert.equal(probe.state.writeCalls, 1, "fails fast; does not loop forever");
  assert.equal(probe.state.closeCalls, 1, "handle still closed in finally");
});

test("defect6: a write throw rejects, leaves memory intact, and still closes", () => {
  const filePath = queueFile("write-throw");
  const probe = probeFileSystem(filePath, {
    write: () => {
      throw new Error("disk exploded");
    }
  });
  const queue = createDeliveryQueue({ filePath, source: "agent", fileSystem: probe.fs });

  assert.throws(
    () => queue.enqueue({ path: "/ingest", body: JSON.stringify({ n: 1 }) }),
    /disk exploded/
  );
  assert.equal(queue.status().pending, 0, "no eligibility mutation on failure");
  assert.equal(probe.state.syncCalls, 0, "fsync never ran");
  assert.equal(probe.state.closeCalls, 1, "handle still closed in finally");
});

test("defect6: an fsync throw rejects, leaves memory intact, and still closes", () => {
  const filePath = queueFile("fsync-throw");
  const probe = probeFileSystem(filePath, {
    write: (_data, _offset, length) => length,
    sync: () => {
      throw new Error("fsync failed");
    }
  });
  const queue = createDeliveryQueue({ filePath, source: "agent", fileSystem: probe.fs });

  assert.throws(
    () => queue.enqueue({ path: "/ingest", body: JSON.stringify({ n: 1 }) }),
    /fsync failed/
  );
  assert.equal(queue.status().pending, 0, "durability failure blocks eligibility");
  assert.equal(probe.state.syncCalls, 1, "fsync was attempted");
  assert.equal(probe.state.closeCalls, 1, "handle still closed in finally");
});

test("defect6: a close failure after a successful fsync keeps the durable entry", () => {
  const filePath = queueFile("close-throw");
  const messages: string[] = [];
  const probe = probeFileSystem(filePath, {
    write: (_data, _offset, length) => length,
    close: () => {
      throw new Error("close failed");
    }
  });
  const queue = createDeliveryQueue({
    filePath,
    source: "agent",
    fileSystem: probe.fs,
    onStatus: (message) => messages.push(message)
  });

  const id = queue.enqueue({ path: "/ingest", body: JSON.stringify({ n: 1 }) });
  assert.equal(typeof id, "string", "enqueue succeeds because the bytes are already durable");
  assert.equal(queue.status().pending, 1, "entry stays eligible; close failure does not corrupt state");
  assert.equal(probe.state.syncCalls, 1);
  assert.equal(probe.state.closeCalls, 1, "close was attempted");
  assert.ok(
    messages.some((message) => message.includes("close failed")),
    "the post-fsync close failure is surfaced via onStatus"
  );
});

test("defect6: entries appended durably are recovered by a fresh queue over the same file", async () => {
  const filePath = queueFile("restart-recovery");
  const bodies = [{ n: 1 }, { n: 2 }, { n: 3 }];

  const first = createDeliveryQueue({ filePath, source: "agent" });
  const ids = bodies.map((body) => first.enqueue({ path: "/ingest", body: JSON.stringify(body) }));
  assert.equal(first.status().pending, 3);

  // A brand-new instance over the same on-disk file must recover every entry,
  // proving the durable append format is still readable after a restart.
  const restarted = createDeliveryQueue({ filePath, source: "agent" });
  assert.equal(restarted.status().pending, 3, "all durably-appended entries recovered on restart");

  const controller = gatedFetch();
  const result = await restarted.flush({ ...FLUSH_BASE, fetchImplementation: controller.fetch });
  assert.equal(result.accepted, 3, "recovered entries are deliverable");
  assert.deepEqual([...result.acceptedIds].sort(), [...ids].sort());
  assert.equal(restarted.status().pending, 0);
});
