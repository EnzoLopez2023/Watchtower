import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../lib/db/connection.js";
import { ensureWatchtowerSchema } from "../../lib/db/repositories/watchtower/schema.js";
import { SqliteMonitoringArchiveRepository } from "../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import {
  runMonitoringArchiveNow,
  type MonitoringArchiveStorage,
} from "../../lib/monitoring/monitoringArchive.js";

/**
 * `settleHours`, `leaseMs` and `maxDaysPerRun` are parsed from configuration and
 * documented as operator controls. These tests hold them to that: each knob must
 * change behaviour, and omitting it must reproduce the production defaults of a
 * 48-hour settle window, a 30-minute lease and 30 days per pass.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SCRATCH_DIR = join(new URL(".", import.meta.url).pathname, "../../.scratch/wt/tmp");
mkdirSync(SCRATCH_DIR, { recursive: true });
const dbPath = join(SCRATCH_DIR, `archive-config-${Date.now()}.db`);
const db = openDatabase({ path: dbPath, busyTimeoutMs: 5_000 });
ensureWatchtowerSchema(db);

const repo = new SqliteMonitoringArchiveRepository(db, true);

const fakeStorage: MonitoringArchiveStorage = {
  async headBlob() {
    return null;
  },
  async putBytes() {
    return { etag: '"fake"' };
  },
  async hashBlob() {
    return { sha256: "a".repeat(64), bytes: 0, etag: '"fake"' };
  },
};

const FIRST_DAY = Date.UTC(2025, 0, 1);

/** Seeds `days` consecutive complete UTC days of agent log rows. */
function seedDays(days: number): void {
  db.exec("DELETE FROM monitoring_archive_checkpoints; DELETE FROM agent_logs;");
  const insert = db.prepare(
    "INSERT INTO agent_logs (agent, ts, level, message, received_at) VALUES ('unifi', ?, 'info', ?, ?)"
  );
  for (let index = 0; index < days; index += 1) {
    const ts = FIRST_DAY + index * DAY_MS + 1_000;
    insert.run(ts, `day ${index}`, ts);
  }
}

function lease(): { lease_until: number; acquired_at: number } | undefined {
  return db
    .prepare("SELECT lease_until, acquired_at FROM monitoring_archive_run_lock WHERE id = 1")
    .get() as { lease_until: number; acquired_at: number } | undefined;
}

beforeEach(() => {
  db.exec("DELETE FROM monitoring_archive_run_lock;");
});

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
});

test("maxDaysPerRun caps a pass to the oldest N days", async () => {
  seedDays(6);
  const attempted: number[] = [];
  const result = await runMonitoringArchiveNow(FIRST_DAY + 10 * DAY_MS, {
    repo,
    storage: fakeStorage,
    maxDaysPerRun: 2,
    archiveCandidate: async (_storage, _name, _stream, dayStart) => {
      attempted.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });

  assert.equal(result.eligibleDays, 6, "every settled day is still reported as eligible");
  assert.equal(attempted.length, 2, "only maxDaysPerRun days may be archived in one pass");
  assert.deepEqual(
    attempted,
    [FIRST_DAY, FIRST_DAY + DAY_MS],
    "the cap must take the oldest days first so a backlog drains deterministically"
  );
});

test("an uncapped pass archives every eligible day", async () => {
  seedDays(6);
  const attempted: number[] = [];
  await runMonitoringArchiveNow(FIRST_DAY + 10 * DAY_MS, {
    repo,
    storage: fakeStorage,
    archiveCandidate: async (_storage, _name, _stream, dayStart) => {
      attempted.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });
  assert.equal(attempted.length, 6, "the default cap of 30 must not truncate a 6-day backlog");
});

test("settleHours widens the window that protects recent days", async () => {
  seedDays(4);
  const now = FIRST_DAY + 4 * DAY_MS + 3 * 60 * 60 * 1000;

  const relaxed: number[] = [];
  await runMonitoringArchiveNow(now, {
    repo,
    storage: fakeStorage,
    settleHours: 1,
    archiveCandidate: async (_s, _n, _st, dayStart) => {
      relaxed.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });

  db.exec("DELETE FROM monitoring_archive_checkpoints; DELETE FROM monitoring_archive_run_lock;");

  const strict: number[] = [];
  await runMonitoringArchiveNow(now, {
    repo,
    storage: fakeStorage,
    settleHours: 72,
    archiveCandidate: async (_s, _n, _st, dayStart) => {
      strict.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });

  assert.ok(
    relaxed.length > strict.length,
    `a shorter settle window must expose more days (${relaxed.length} vs ${strict.length})`
  );
  assert.ok(
    Math.max(...relaxed) > Math.max(...strict),
    "the newest eligible day must move with settleHours"
  );
});

test("settleHours defaults to 48 hours when unset", async () => {
  seedDays(4);
  // Two days after the newest sample: with a 48h settle window the newest day is
  // still held back, so only the earlier days may be archived.
  const now = FIRST_DAY + 3 * DAY_MS + 12 * 60 * 60 * 1000;
  const attempted: number[] = [];
  await runMonitoringArchiveNow(now, {
    repo,
    storage: fakeStorage,
    archiveCandidate: async (_s, _n, _st, dayStart) => {
      attempted.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });
  assert.ok(attempted.length > 0, "settled days must still be archived by default");
  assert.ok(
    Math.max(...attempted) <= FIRST_DAY + DAY_MS,
    "the default 48-hour window must hold back the two most recent days"
  );
});

test("settleHours zero archives every fully closed UTC day", async () => {
  seedDays(4);
  const now = FIRST_DAY + 4 * DAY_MS + 3 * 60 * 60 * 1000;
  const attempted: number[] = [];
  await runMonitoringArchiveNow(now, {
    repo,
    storage: fakeStorage,
    settleHours: 0,
    archiveCandidate: async (_storage, _name, _stream, dayStart) => {
      attempted.push(dayStart);
      return { archived: true, rows: 1 };
    },
  });
  assert.equal(
    Math.max(...attempted),
    FIRST_DAY + 3 * DAY_MS,
    "a zero-hour settle window must include yesterday rather than falling back to 48 hours"
  );
});

/**
 * The lease is released when the pass ends, so it has to be observed from inside
 * the run — `archiveCandidate` executes while the lease is still held.
 */
async function leaseWindowDuring(
  options: { leaseMs?: number; maxDaysPerRun?: number; settleHours?: number }
): Promise<number> {
  seedDays(2);
  db.exec("DELETE FROM monitoring_archive_run_lock;");
  let observed: number | null = null;
  await runMonitoringArchiveNow(FIRST_DAY + 10 * DAY_MS, {
    repo,
    storage: fakeStorage,
    ...options,
    archiveCandidate: async () => {
      observed ??= (() => {
        const row = lease();
        return row ? row.lease_until - row.acquired_at : null;
      })();
      return { archived: true, rows: 1 };
    },
  });
  assert.ok(observed != null, "a lease must be held while a day is being archived");
  return observed;
}

test("leaseMs sets the archive lease duration", async () => {
  const window = await leaseWindowDuring({ leaseMs: 5 * 60 * 1000 });
  assert.ok(
    Math.abs(window - 5 * 60 * 1000) < 2_000,
    `expected a 5 minute lease, saw ${window}ms`
  );
});

test("leaseMs defaults to the production 30 minute lease", async () => {
  const window = await leaseWindowDuring({});
  assert.ok(
    Math.abs(window - 30 * 60 * 1000) < 2_000,
    `expected the default 30 minute lease, saw ${window}ms`
  );
});

test("invalid lease, cap, and negative settle values fall back to defaults", async () => {
  const window = await leaseWindowDuring({ leaseMs: 0, maxDaysPerRun: 0, settleHours: -5 });
  assert.ok(
    Math.abs(window - 30 * 60 * 1000) < 2_000,
    "a zero lease must not be honoured — it would make the lease immediately stale"
  );
});
