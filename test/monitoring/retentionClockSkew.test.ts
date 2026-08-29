import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SqliteAgentIngestReceiptRepository } from "../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import {
  SqliteSynologyRepository,
  type IngestSynologyInput
} from "../../lib/db/repositories/watchtower/synologyRepository.js";
import { SqliteNetworkObserverRepository } from "../../lib/db/repositories/watchtower/networkObserverRepository.js";
import { countRows, openTestDatabase, removeDatabase } from "../fixtures/monitoring/harness.js";

/**
 * Retention must prune on the server-authored `received_at`, never on an
 * agent-supplied source clock (`ts` / `metric_time` / `device_ts`). These tests
 * seed rows whose `received_at` and source clock deliberately disagree and prove
 * that:
 *   1. a far-future source clock with an old `received_at` is still pruned, so a
 *      malicious agent cannot pin a row forever with a year-2099 timestamp; and
 *   2. a far-past source clock with a recent `received_at` is retained, so a
 *      zeroed device clock cannot delete fresh evidence early.
 * The source clock column is also asserted to survive the prune untouched.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Server accepted this ingest long ago (older than every retention window). */
const RECEIVED_OLD = Date.UTC(2025, 0, 1);
/** Server accepted this ingest recently (200 days later, inside every window). */
const RECEIVED_RECENT = RECEIVED_OLD + 200 * DAY_MS;
/** Untrusted device clock claiming the far future. */
const SOURCE_FAR_FUTURE = Date.UTC(2099, 0, 1);
/** Bad/zeroed device clock stuck in the far past (still a valid epoch-ms). */
const SOURCE_FAR_PAST = Date.UTC(2001, 0, 1);

function synologyInput(options: {
  readonly nasId: string;
  readonly now: number;
  readonly ts: number;
  readonly prune: boolean;
}): IngestSynologyInput {
  return {
    nasId: options.nasId,
    label: options.nasId,
    host: null,
    payload: Buffer.from("{}"),
    ts: options.ts,
    now: options.now,
    volumes: [{ id: "vol1", total_bytes: 1e12, used_bytes: 5e11 }],
    disks: [{ id: "disk1", temp_c: 35, smart_status: "Normal", health: "Normal", bad_sectors: 0 }],
    shares: [{ name: "homes", used_bytes: 1e9 }],
    backupTasks: [],
    external: [],
    prune: options.prune
  };
}

function observerBody(options: {
  readonly sourceClock: number;
  readonly adminUp: boolean;
}): Record<string, unknown> {
  return {
    ts: options.sourceClock,
    observer_id: "obs-1",
    agent_build: 1,
    probes: [
      {
        kind: "lan",
        id: "gateway",
        label: "Gateway",
        ok: true,
        latency_ms: 1.2,
        ts: options.sourceClock,
        detail: {}
      }
    ],
    isp_metrics: [
      {
        host_id: "host-1",
        site_id: "site-1",
        metric_time: options.sourceClock,
        metric_type: "5m",
        wan: { ispName: "Example ISP", avgLatency: 12 }
      }
    ],
    snmp_devices: [
      {
        id: "switch-1",
        label: "Core Switch",
        host: "10.0.0.1",
        ok: true,
        ts: options.sourceClock,
        system: { uptime_s: 100, cpu_pct: 10, mem_pct: 20, temp_c: 30 },
        interfaces: [
          {
            if_index: 1,
            name: "eth1",
            admin_up: options.adminUp,
            oper_up: true,
            speed_bps: 1_000_000_000,
            in_octets: 0,
            out_octets: 0,
            in_bps: 0,
            out_bps: 0,
            in_errors: 0,
            out_errors: 0,
            in_discards: 0,
            out_discards: 0
          }
        ]
      }
    ],
    diagnostics: {}
  };
}

function readClock(
  database: ReturnType<typeof openTestDatabase>["database"],
  table: string,
  column: string,
  where: string,
  parameter: string | number
): number | undefined {
  const row = database
    .prepare(`SELECT ${column} AS clock FROM ${table} WHERE ${where}`)
    .get(parameter) as { clock: number } | undefined;
  return row?.clock;
}

test("synology sample retention prunes on received_at, keeping the ts clock as evidence", async () => {
  const { database, path } = openTestDatabase("retention-synology");
  const receipts = new SqliteAgentIngestReceiptRepository(database);
  const repository = new SqliteSynologyRepository(database, receipts);
  try {
    // Stale rows: accepted long ago, but the device claims a far-future clock.
    await repository.ingest(
      synologyInput({ nasId: "nas-stale", now: RECEIVED_OLD, ts: SOURCE_FAR_FUTURE, prune: false }),
      null
    );
    // Fresh rows: accepted just now, but the device clock is stuck in the past.
    // This ingest carries the prune pass (cutoff = RECEIVED_RECENT - 180d).
    await repository.ingest(
      synologyInput({ nasId: "nas-fresh", now: RECEIVED_RECENT, ts: SOURCE_FAR_PAST, prune: true }),
      null
    );

    for (const table of [
      "synology_volume_samples",
      "synology_disk_samples",
      "synology_share_samples"
    ]) {
      assert.equal(
        countRows(database, table, "nas_id = ?", "nas-stale"),
        0,
        `${table}: far-future ts with old received_at must be pruned`
      );
      assert.equal(
        countRows(database, table, "nas_id = ?", "nas-fresh"),
        1,
        `${table}: far-past ts with recent received_at must be retained`
      );
      assert.equal(
        readClock(database, table, "ts", "nas_id = ?", "nas-fresh"),
        SOURCE_FAR_PAST,
        `${table}: source ts must survive the prune unchanged as evidence`
      );
      assert.equal(
        readClock(database, table, "received_at", "nas_id = ?", "nas-fresh"),
        RECEIVED_RECENT,
        `${table}: received_at must be the server clock`
      );
    }
  } finally {
    database.close();
    removeDatabase(path);
  }
});

test("network observer sample retention prunes on received_at across probe, isp, and snmp tables", async () => {
  const { database, path } = openTestDatabase("retention-observer");
  const receipts = new SqliteAgentIngestReceiptRepository(database);
  const repository = new SqliteNetworkObserverRepository(database, receipts);
  try {
    // Stale rows: old received_at, far-future source clocks everywhere.
    await repository.ingest(observerBody({ sourceClock: SOURCE_FAR_FUTURE, adminUp: true }), RECEIVED_OLD, null);
    // Fresh rows: recent received_at, far-past source clocks. This ingest runs
    // maintenance (it is > 1h since the previous one), so it prunes.
    await repository.ingest(observerBody({ sourceClock: SOURCE_FAR_PAST, adminUp: true }), RECEIVED_RECENT, null);

    const tables: ReadonlyArray<{ table: string; clock: string }> = [
      { table: "network_probe_samples", clock: "device_ts" },
      { table: "network_isp_samples", clock: "metric_time" },
      { table: "network_snmp_device_samples", clock: "device_ts" },
      { table: "network_snmp_interface_samples", clock: "device_ts" }
    ];
    for (const { table, clock } of tables) {
      assert.equal(
        countRows(database, table, "received_at = ?", RECEIVED_OLD),
        0,
        `${table}: far-future ${clock} with old received_at must be pruned`
      );
      assert.equal(
        countRows(database, table, "received_at = ?", RECEIVED_RECENT),
        1,
        `${table}: far-past ${clock} with recent received_at must be retained`
      );
      assert.equal(
        readClock(database, table, clock, "received_at = ?", RECEIVED_RECENT),
        SOURCE_FAR_PAST,
        `${table}: source clock ${clock} must survive the prune unchanged as evidence`
      );
    }
  } finally {
    database.close();
    removeDatabase(path);
  }
});

test("network observer interface events prune on received_at, not the device_ts clock", async () => {
  const { database, path } = openTestDatabase("retention-observer-events");
  const receipts = new SqliteAgentIngestReceiptRepository(database);
  const repository = new SqliteNetworkObserverRepository(database, receipts);
  try {
    // Baseline sample so the next interface change produces an event.
    await repository.ingest(
      observerBody({ sourceClock: SOURCE_FAR_FUTURE, adminUp: true }),
      RECEIVED_OLD - HOUR_MS,
      null
    );
    // Stale event: old received_at, far-future device_ts (admin state flips).
    await repository.ingest(observerBody({ sourceClock: SOURCE_FAR_FUTURE, adminUp: false }), RECEIVED_OLD, null);
    assert.equal(
      countRows(database, "network_snmp_interface_events"),
      1,
      "an interface admin-state change must record exactly one event"
    );

    // Fresh event: recent received_at, far-past device_ts. This ingest prunes.
    await repository.ingest(observerBody({ sourceClock: SOURCE_FAR_PAST, adminUp: true }), RECEIVED_RECENT, null);

    assert.equal(
      countRows(database, "network_snmp_interface_events", "received_at = ?", RECEIVED_OLD),
      0,
      "far-future device_ts with old received_at must be pruned"
    );
    assert.equal(
      countRows(database, "network_snmp_interface_events", "received_at = ?", RECEIVED_RECENT),
      1,
      "far-past device_ts with recent received_at must be retained"
    );
    assert.equal(
      readClock(database, "network_snmp_interface_events", "device_ts", "received_at = ?", RECEIVED_RECENT),
      SOURCE_FAR_PAST,
      "event device_ts must survive the prune unchanged as evidence"
    );
  } finally {
    database.close();
    removeDatabase(path);
  }
});

test("every retention DELETE in both repositories cuts on received_at and covers the known tables", () => {
  const expected: ReadonlyArray<{ file: string; tables: ReadonlySet<string> }> = [
    {
      file: "synologyRepository.ts",
      tables: new Set([
        "synology_volume_samples",
        "synology_disk_samples",
        "synology_share_samples"
      ])
    },
    {
      file: "networkObserverRepository.ts",
      tables: new Set([
        "network_probe_samples",
        "network_isp_samples",
        "network_snmp_device_samples",
        "network_snmp_interface_samples",
        "network_snmp_interface_events"
      ])
    }
  ];

  for (const { file, tables } of expected) {
    const source = readFileSync(
      fileURLToPath(new URL(`../../lib/db/repositories/watchtower/${file}`, import.meta.url)),
      "utf8"
    );
    const deletes = [...source.matchAll(/DELETE FROM (\w+) WHERE (\w+) < \?/g)].map((match) => ({
      table: match[1] as string,
      column: match[2] as string
    }));

    assert.ok(deletes.length > 0, `${file}: expected at least one retention DELETE`);
    for (const { table, column } of deletes) {
      assert.equal(
        column,
        "received_at",
        `${file}: DELETE FROM ${table} must cut on received_at, found ${column}`
      );
    }
    assert.deepEqual(
      new Set(deletes.map((entry) => entry.table)),
      tables,
      `${file}: retention table inventory drifted — add any new table to the clock-skew tests`
    );
  }
});
