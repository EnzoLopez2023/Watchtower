import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteMonitoringArchiveRepository } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import {
  runMonitoringArchiveNow,
  runScheduledMonitoringArchivePass,
  archiveAwareDeleteBefore,
  archiveAwareDeleteThroughId,
  invalidateMonitoringArchiveDays,
  type MonitoringArchiveStorage,
  type ArchiveRunResult,
} from "../../lib/monitoring/monitoringArchive.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const SCRATCH_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../../.scratch/wt/tmp"
);
mkdirSync(SCRATCH_DIR, { recursive: true });
const dbPath = join(SCRATCH_DIR, `archive-test-${Date.now()}.db`);
const db = openDatabase({ path: dbPath, busyTimeoutMs: 5_000 });
ensureWatchtowerSchema(db);

const repo = new SqliteMonitoringArchiveRepository(db, true);

const fakeStorage: MonitoringArchiveStorage = {
  async headBlob() {
    return null;
  },
  async putBytes(_name, _body) {
    return { etag: '"fake-etag"' };
  },
  async hashBlob(_name, _opts) {
    return { sha256: "a".repeat(64), bytes: 0, etag: '"fake-etag"' };
  },
};

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

test("prunes complete archive days and refuses to replace a pruned base blob with late rows", async () => {
  const dayStart = Date.UTC(2025, 0, 1);
  const firstTs = dayStart + 60 * 60 * 1000;
  const secondTs = dayStart + 18 * 60 * 60 * 1000;
  const insertLog = db.prepare(
    "INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES ('unifi', ?, 'info', ?, ?)"
  );
  insertLog.run(firstTs, "first", firstTs);
  insertLog.run(secondTs, "second", secondTs);
  db.prepare(
    `INSERT INTO monitoring_archive_checkpoints (
      stream, day_start, day_end, blob_name, row_count,
      source_max_received_at, sha256, archived_at, last_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "agent-logs",
    dayStart,
    dayStart + DAY_MS,
    "v1/agent-logs/2025/01/2025-01-01.jsonl.gz",
    2,
    secondTs,
    "complete-day-checksum",
    secondTs + 1,
    secondTs + 1
  );

  const middayCutoff = dayStart + 13 * 60 * 60 * 1000;
  assert.equal(
    archiveAwareDeleteBefore(repo, "agent-logs", "agent_logs", "ts", middayCutoff).changes,
    0
  );
  assert.equal(
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM agent_logs").get()?.count,
    2
  );

  const nextDayMidday = dayStart + DAY_MS + 13 * 60 * 60 * 1000;
  assert.equal(
    archiveAwareDeleteBefore(repo, "agent-logs", "agent_logs", "ts", nextDayMidday).changes,
    2
  );
  type CP = { row_count: number; archived_at: number | null; pruned_at: number | null; last_error: string | null };
  let checkpoint = db
    .prepare<[number], CP>(
      "SELECT row_count, archived_at, pruned_at, last_error FROM monitoring_archive_checkpoints WHERE stream = 'agent-logs' AND day_start = ?"
    )
    .get(dayStart);
  assert.ok(checkpoint?.pruned_at);
  assert.ok(checkpoint?.archived_at);

  const lateTs = dayStart + 20 * 60 * 60 * 1000;
  insertLog.run(lateTs, "late", Date.UTC(2025, 0, 10));
  invalidateMonitoringArchiveDays(repo, "agent-logs", [lateTs], Date.UTC(2025, 0, 10));
  checkpoint = db
    .prepare<[number], CP>(
      "SELECT row_count, archived_at, pruned_at, last_error FROM monitoring_archive_checkpoints WHERE stream = 'agent-logs' AND day_start = ?"
    )
    .get(dayStart);
  assert.equal(checkpoint?.archived_at, null);
  assert.match(checkpoint?.last_error ?? "", /New source rows/);

  const result = await runMonitoringArchiveNow(Date.UTC(2025, 0, 10), {
    repo,
    storage: fakeStorage,
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!.error, /preserving the complete base blob/);
  checkpoint = db
    .prepare<[number], CP>(
      "SELECT row_count, archived_at, pruned_at, last_error FROM monitoring_archive_checkpoints WHERE stream = 'agent-logs' AND day_start = ?"
    )
    .get(dayStart);
  assert.equal(checkpoint?.row_count, 2);
  assert.equal(checkpoint?.archived_at, null);
  assert.ok(checkpoint?.pruned_at);
  assert.match(checkpoint?.last_error ?? "", /preserving the complete base blob/);
  assert.equal(
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM agent_logs").get()?.count,
    1
  );

  const olderDay = dayStart + DAY_MS;
  const boundaryDay = olderDay + DAY_MS;
  const olderId = insertLog.run(olderDay + 1000, "older", olderDay + 1000).lastInsertRowid;
  insertLog.run(olderDay + 2000, "older-2", olderDay + 2000);
  const boundaryId = insertLog.run(boundaryDay + 1000, "boundary", boundaryDay + 1000).lastInsertRowid;
  insertLog.run(boundaryDay + 2000, "boundary-2", boundaryDay + 2000);
  const insertCheckpoint = db.prepare(
    `INSERT INTO monitoring_archive_checkpoints (
      stream, day_start, day_end, blob_name, row_count,
      source_max_received_at, sha256, archived_at, last_attempt_at
    ) VALUES ('agent-logs', ?, ?, ?, 2, ?, 'checksum', ?, ?)`
  );
  insertCheckpoint.run(
    olderDay,
    olderDay + DAY_MS,
    "older.jsonl.gz",
    olderDay + 2000,
    olderDay + 3000,
    olderDay + 3000
  );
  insertCheckpoint.run(
    boundaryDay,
    boundaryDay + DAY_MS,
    "boundary.jsonl.gz",
    boundaryDay + 2000,
    boundaryDay + 3000,
    boundaryDay + 3000
  );

  const capped = archiveAwareDeleteThroughId(
    repo,
    "agent-logs",
    "agent_logs",
    "ts",
    Number(boundaryId),
    "AND agent = ?",
    ["unifi"]
  );
  assert.equal(capped.changes, 2);
  assert.equal(
    db
      .prepare<[number], { count: number }>("SELECT COUNT(*) AS count FROM agent_logs WHERE id >= ?")
      .get(Number(boundaryId))?.count,
    2
  );
  assert.equal(
    db
      .prepare<[number], { count: number }>("SELECT COUNT(*) AS count FROM agent_logs WHERE id = ?")
      .get(Number(olderId))?.count,
    0
  );
  assert.ok(
    db
      .prepare<[number], { pruned_at: number | null }>(
        "SELECT pruned_at FROM monitoring_archive_checkpoints WHERE stream = 'agent-logs' AND day_start = ?"
      )
      .get(olderDay)?.pruned_at
  );
});

test("shutdown cancellation drains the current archive day without starting another", async () => {
  db.exec(`
    DELETE FROM monitoring_archive_checkpoints;
    DELETE FROM agent_logs;
  `);
  const firstDay = Date.UTC(2025, 0, 1);
  const secondDay = firstDay + DAY_MS;
  const insert = db.prepare(
    "INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES ('unifi', ?, 'info', ?, ?)"
  );
  insert.run(firstDay + 1_000, "first day", firstDay + 1_000);
  insert.run(secondDay + 1_000, "second day", secondDay + 1_000);

  const controller = new AbortController();
  const attemptedDays: Array<{ streamName: string; dayStart: number }> = [];
  const result = await runMonitoringArchiveNow(Date.UTC(2025, 0, 10), {
    repo,
    storage: fakeStorage,
    signal: controller.signal,
    archiveCandidate: async (_storage, streamName, _stream, dayStart) => {
      attemptedDays.push({ streamName, dayStart });
      controller.abort();
      return { archived: true, rows: 1 };
    },
  });

  assert.deepEqual(attemptedDays, [{ streamName: "agent-logs", dayStart: firstDay }]);
  assert.equal(result.archivedDays, 1);
  assert.equal(result.archivedRows, 1);
  assert.equal(result.cancelled, true);
});

test("cross-process archive lease prevents a concurrent writer", async () => {
  db.prepare(
    `INSERT OR REPLACE INTO monitoring_archive_run_lock (
      id, lease_token, lease_until, acquired_at
    ) VALUES (1, 'other-process', ?, ?)`
  ).run(Date.now() + 60_000, Date.now());
  try {
    const result = await runMonitoringArchiveNow(Date.now(), { repo, storage: fakeStorage });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "lease-held");
  } finally {
    db.prepare("DELETE FROM monitoring_archive_run_lock WHERE lease_token = 'other-process'").run();
  }
});

function scheduledPassOptions(
  run: Partial<ArchiveRunResult>,
  lines: string[],
  published: unknown[]
) {
  return {
    config: {} as never,
    runArchive: async () => run as ArchiveRunResult,
    blobClient: {} as never,
    publishHeartbeat: async ({ heartbeat }: { heartbeat: unknown }) => {
      published.push(heartbeat);
      return "v1/monitoring/test/_HEALTH.json";
    },
    now: () => new Date("2026-08-25T23:00:00.000Z"),
    writeLine: (line: string) => lines.push(line),
  };
}

test("scheduled archive success publishes health and emits one healthy JSON event", async () => {
  const lines: string[] = [];
  const published: unknown[] = [];
  const result = await runScheduledMonitoringArchivePass(
    scheduledPassOptions(
      {
        eligibleDays: 1,
        archivedDays: 1,
        archivedRows: 42,
        failures: [],
        latestEligibleDay: "2026-08-24",
        latestVerifiedBlob: "v1/agent-logs/2026/08/2026-08-24.jsonl.gz",
      },
      lines,
      published
    )
  );
  assert.equal(result.published, true);
  assert.equal((published[0] as { status: string }).status, "success");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: "monitoring_archive_run",
    checkedUtc: "2026-08-25T23:00:00.000Z",
    status: "healthy",
    archivedDays: 1,
    archivedRows: 42,
    failureCount: 0,
  });
});

test("scheduled archive idle publishes health and emits one healthy JSON event", async () => {
  const lines: string[] = [];
  const published: unknown[] = [];
  const result = await runScheduledMonitoringArchivePass(
    scheduledPassOptions(
      {
        eligibleDays: 0,
        archivedDays: 0,
        archivedRows: 0,
        failures: [],
        latestEligibleDay: null,
        latestVerifiedBlob: null,
      },
      lines,
      published
    )
  );
  assert.equal(result.published, true);
  assert.equal((published[0] as { status: string }).status, "idle");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).status, "healthy");
  assert.equal(JSON.parse(lines[0]!).failureCount, 0);
});

test("scheduled archive failure emits one failed JSON event and no health marker", async () => {
  const lines: string[] = [];
  const published: unknown[] = [];
  const result = await runScheduledMonitoringArchivePass(
    scheduledPassOptions(
      {
        eligibleDays: 1,
        archivedDays: 0,
        archivedRows: 0,
        failures: [{ code: "ARCHIVE_READBACK_FAILED", error: "must not be logged" }],
        latestEligibleDay: "2026-08-24",
        latestVerifiedBlob: null,
      },
      lines,
      published
    )
  );
  assert.equal(result.published, false);
  assert.equal(published.length, 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: "monitoring_archive_run",
    checkedUtc: "2026-08-25T23:00:00.000Z",
    status: "failed",
    archivedDays: 0,
    archivedRows: 0,
    failureCount: 1,
  });
  assert.doesNotMatch(lines[0]!, /must not be logged/);
});

test("scheduled archive cancellation emits one failed event and no health marker", async () => {
  const lines: string[] = [];
  const published: unknown[] = [];
  const result = await runScheduledMonitoringArchivePass(
    scheduledPassOptions(
      {
        cancelled: true,
        eligibleDays: 2,
        archivedDays: 1,
        archivedRows: 42,
        failures: [],
        latestEligibleDay: "2026-08-24",
        latestVerifiedBlob: "v1/agent-logs/2026/08/2026-08-23.jsonl.gz",
      },
      lines,
      published
    )
  );
  assert.equal(result.published, false);
  assert.equal(published.length, 0);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).status, "failed");
  assert.equal(JSON.parse(lines[0]!).failureCount, 1);
});
