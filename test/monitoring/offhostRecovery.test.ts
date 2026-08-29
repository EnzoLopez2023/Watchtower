import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../server/config.js";
import {
  pruneLocalBundles,
  runOffhostRecoveryPass,
  type OffhostRecoverySteps
} from "../../server/domain/offhostRecovery.js";
import { createOffhostRecoveryWorker } from "../../server/workers/watchtower/offhostRecoveryWorker.js";
import { WorkerManager, type ManagedWorker } from "../../server/workers/manager.js";

const DEVELOPMENT: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DB_PATH: "./.scratch/wt/tmp/config.db"
};

const ENABLED: NodeJS.ProcessEnv = {
  ...DEVELOPMENT,
  OFFHOST_BACKUP_ENABLED: "true",
  OFFHOST_BACKUP_ACCOUNT: "watchtowerbackups",
  OFFHOST_BACKUP_CONTAINER: "watchtower-backups",
  BACKUP_ROOT: "/home/data/backups/watchtower"
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Configuration ────────────────────────────────────────────────────────────

test("off-host recovery is disabled unless the flag is exactly true", () => {
  assert.equal(loadConfig(DEVELOPMENT).offhostRecovery.enabled, false);
  assert.equal(
    loadConfig({ ...DEVELOPMENT, OFFHOST_BACKUP_ENABLED: "false" }).offhostRecovery.enabled,
    false
  );
  for (const ambiguous of ["1", "yes", "TRUE", "on", "enabled"]) {
    assert.throws(
      () => loadConfig({ ...DEVELOPMENT, OFFHOST_BACKUP_ENABLED: ambiguous }),
      /OFFHOST_BACKUP_ENABLED must be exactly "true" or "false"/,
      `expected ${ambiguous} to be rejected rather than guessed`
    );
  }
  assert.equal(loadConfig(ENABLED).offhostRecovery.enabled, true);
});

test("enabling requires Watchtower-owned account, container and absolute root", () => {
  const withoutAccount = { ...ENABLED };
  delete withoutAccount.OFFHOST_BACKUP_ACCOUNT;
  assert.throws(() => loadConfig(withoutAccount), /OFFHOST_BACKUP_ACCOUNT is required/);

  assert.throws(
    () => loadConfig({ ...ENABLED, OFFHOST_BACKUP_ACCOUNT: "Not A Valid Account" }),
    /account/i
  );
  assert.throws(
    () => loadConfig({ ...ENABLED, OFFHOST_BACKUP_CONTAINER: "Invalid_Container" }),
    /container/i
  );
  assert.throws(
    () => loadConfig({ ...ENABLED, BACKUP_ROOT: "relative/path" }),
    /BACKUP_ROOT must be an absolute, app-owned directory/
  );
});

test("a shared storage credential is rejected, never used as a fallback", () => {
  for (const key of [
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_ACCOUNT_KEY",
    "AZURE_STORAGE_SAS_TOKEN",
    "OFFHOST_BACKUP_ACCOUNT_KEY"
  ]) {
    assert.throws(
      () => loadConfig({ ...ENABLED, [key]: "secret-value" }),
      /prohibited/i,
      `expected ${key} to be refused`
    );
  }
  // Disabled means the scheduler never runs, so the same variable is not a
  // startup failure for an instance that is not backing up.
  assert.equal(
    loadConfig({ ...DEVELOPMENT, AZURE_STORAGE_ACCOUNT_KEY: "secret-value" }).offhostRecovery
      .enabled,
    false
  );
});

test("cadence and retention are bounded", () => {
  const config = loadConfig(ENABLED).offhostRecovery;
  assert.equal(config.intervalHours, 24);
  assert.equal(config.retentionCount, 2);
  assert.equal(config.startDelayMs, 60_000);
  assert.equal(config.retryDelayMs, 60_000);
  assert.equal(config.requestTimeoutMs, 15 * 60_000);
  assert.equal(config.verifyRestore, true);

  assert.throws(() => loadConfig({ ...ENABLED, BACKUP_INTERVAL_HOURS: "0" }), /BACKUP_INTERVAL_HOURS/);
  assert.throws(() => loadConfig({ ...ENABLED, BACKUP_RETENTION_COUNT: "0" }), /BACKUP_RETENTION_COUNT/);
  assert.throws(
    () => loadConfig({ ...ENABLED, OFFHOST_BACKUP_REQUEST_TIMEOUT_MS: "999999999" }),
    /OFFHOST_BACKUP_REQUEST_TIMEOUT_MS/
  );
});

// ── Pass sequencing ──────────────────────────────────────────────────────────

interface StubRecording {
  readonly calls: string[];
  readonly steps: OffhostRecoverySteps;
}

function stubSteps(overrides: Partial<OffhostRecoverySteps> = {}): StubRecording {
  const calls: string[] = [];
  const manifest = {
    contract: "watchtower.sqlite-backup-manifest",
    contractVersion: 1,
    app: "watchtower",
    bundleId: "20260828T140000000Z-0123456789abcdef",
    createdUtc: "2026-08-28T14:00:00.000Z",
    appVersion: null,
    buildId: null,
    sourceCommit: null,
    database: {
      file: "watchtower.sqlite3",
      sourcePath: "/home/data/watchtower.db",
      bytes: 4096,
      sha256: "a".repeat(64),
      identity: { schemaSha256: "b".repeat(64), schemaVersion: 2 },
      tables: [],
      checks: { integrity: "ok", foreignKeys: [] }
    }
  } as unknown as Awaited<ReturnType<OffhostRecoverySteps["createBackup"]>>["manifest"];

  const steps: OffhostRecoverySteps = {
    createBackup: async (options) => {
      calls.push("createBackup");
      return {
        bundleDir: join(options.backupRoot, manifest.bundleId),
        snapshotPath: join(options.backupRoot, manifest.bundleId, "watchtower.sqlite3"),
        manifestPath: join(options.backupRoot, manifest.bundleId, "manifest.json"),
        manifest,
        durationMs: 1
      };
    },
    verifyBackup: async () => {
      calls.push("verifyBackup");
      return { manifest, bytes: 4096, sha256: manifest.database.sha256 } as Awaited<
        ReturnType<OffhostRecoverySteps["verifyBackup"]>
      >;
    },
    uploadBundleWithReadback: async () => {
      calls.push("upload");
      return {
        bundleId: manifest.bundleId,
        snapshot: {
          upload: { url: "https://x", bytes: 4096, sha256: manifest.database.sha256, etag: "e" },
          readback: { url: "https://x", bytes: 4096, sha256: manifest.database.sha256, etag: "e" }
        },
        manifest: {
          upload: { url: "https://y", bytes: 128, sha256: "c".repeat(64), etag: "f" },
          readback: { url: "https://y", bytes: 128, sha256: "c".repeat(64), etag: "f" }
        },
        verified: true
      } as Awaited<ReturnType<OffhostRecoverySteps["uploadBundleWithReadback"]>>;
    },
    restoreBundle: async () => {
      calls.push("restoreBundle");
      return { destination: "/tmp/x", bytes: 4096 } as unknown as Awaited<
        ReturnType<OffhostRecoverySteps["restoreBundle"]>
      >;
    },
    ...overrides
  };
  return { calls, steps };
}

async function withBackupRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "watchtower-offhost-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function passConfig(root: string, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    account: "watchtowerbackups",
    container: "watchtower-backups",
    backupRoot: root,
    intervalHours: 24,
    startDelayMs: 60_000,
    retryDelayMs: 60_000,
    retentionCount: 2,
    requestTimeoutMs: 60_000,
    verifyRestore: true,
    ...overrides
  } as ReturnType<typeof loadConfig>["offhostRecovery"];
}

test("a pass runs backup, verify, upload with read-back, then restore verification", async () => {
  await withBackupRoot(async (root) => {
    const { calls, steps } = stubSteps();
    const result = await runOffhostRecoveryPass({
      config: passConfig(root),
      databasePath: join(root, "source.db"),
      steps
    });

    assert.deepEqual(calls, ["createBackup", "verifyBackup", "upload", "restoreBundle"]);
    assert.equal(result.upload?.verified, true);
    assert.ok(result.restore);
  });
});

test("a scheduled pass reaps stale canonical partials before creating its snapshot", async () => {
  await withBackupRoot(async (root) => {
    const stale = "20200101T000000000Z-0000000000000000.partial";
    const unrelated = "operator-notes.partial";
    await mkdir(join(root, stale));
    await mkdir(join(root, unrelated));
    await utimes(join(root, stale), new Date(0), new Date(0));

    const { calls, steps } = stubSteps();
    const result = await runOffhostRecoveryPass({
      config: passConfig(root),
      databasePath: join(root, "source.db"),
      steps
    });

    assert.deepEqual(result.prunedPartials, [stale]);
    assert.deepEqual(calls, ["createBackup", "verifyBackup", "upload", "restoreBundle"]);
    const remaining = await readdir(root);
    assert.ok(!remaining.includes(stale), "the abandoned database-sized partial is removed");
    assert.ok(remaining.includes(unrelated), "non-canonical operator files are untouched");
  });
});

test("the upload step is skipped when no account is configured", async () => {
  await withBackupRoot(async (root) => {
    const { calls, steps } = stubSteps();
    const config = passConfig(root);
    const withoutAccount = { ...config, account: undefined };
    const result = await runOffhostRecoveryPass({
      config: withoutAccount,
      databasePath: join(root, "source.db"),
      steps
    });
    assert.deepEqual(calls, ["createBackup", "verifyBackup", "restoreBundle"]);
    assert.equal(result.upload, null);
  });
});

test("an aborted signal stops the pass between stages", async () => {
  await withBackupRoot(async (root) => {
    const controller = new AbortController();
    const { calls, steps } = stubSteps({
      verifyBackup: async () => {
        controller.abort();
        calls.push("verifyBackup");
        return {} as Awaited<ReturnType<OffhostRecoverySteps["verifyBackup"]>>;
      }
    });
    await assert.rejects(
      () =>
        runOffhostRecoveryPass(
          { config: passConfig(root), databasePath: join(root, "source.db"), steps },
          controller.signal
        ),
      /cancelled before upload/
    );
    assert.deepEqual(calls, ["createBackup", "verifyBackup"]);
  });
});

test("the disposable restore target is removed even when verification fails", async () => {
  await withBackupRoot(async (root) => {
    const { steps } = stubSteps({
      restoreBundle: async () => {
        throw new Error("restore verification failed");
      }
    });
    await assert.rejects(
      () =>
        runOffhostRecoveryPass({
          config: passConfig(root),
          databasePath: join(root, "source.db"),
          steps
        }),
      /restore verification failed/
    );
    const verifyRoot = join(root, "restore-verify");
    assert.deepEqual(await readdir(verifyRoot), [], "no restored copy may be left behind");
  });
});

// ── Local retention ──────────────────────────────────────────────────────────

test("retention keeps the newest bundles and ignores unrelated entries", async () => {
  await withBackupRoot(async (root) => {
    const bundles = [
      "20260825T140000000Z-0000000000000001",
      "20260826T140000000Z-0000000000000002",
      "20260827T140000000Z-0000000000000003",
      "20260828T140000000Z-0000000000000004"
    ];
    for (const bundle of bundles) await mkdir(join(root, bundle), { recursive: true });
    await mkdir(join(root, "restore-verify"), { recursive: true });
    await mkdir(join(root, "operator-copy"), { recursive: true });
    await writeFile(join(root, "notes.txt"), "keep me", "utf8");

    const removed = await pruneLocalBundles(root, 2);
    assert.deepEqual(removed.sort(), [bundles[0], bundles[1]].sort());

    const remaining = (await readdir(root)).sort();
    assert.deepEqual(remaining, [
      "20260827T140000000Z-0000000000000003",
      "20260828T140000000Z-0000000000000004",
      "notes.txt",
      "operator-copy",
      "restore-verify"
    ]);
  });
});

test("the bundle written by the current pass is never pruned", async () => {
  await withBackupRoot(async (root) => {
    const older = "20260820T140000000Z-000000000000000a";
    const newest = "20260828T140000000Z-000000000000000b";
    for (const bundle of [older, newest]) await mkdir(join(root, bundle), { recursive: true });
    const removed = await pruneLocalBundles(root, 1, newest);
    assert.deepEqual(removed, [older]);
    assert.ok((await readdir(root)).includes(newest));
  });
});

// ── Worker lifecycle ─────────────────────────────────────────────────────────

function worker(
  run: (signal: AbortSignal) => Promise<unknown>,
  overrides: Partial<Parameters<typeof createOffhostRecoveryWorker>[0]> = {}
) {
  return createOffhostRecoveryWorker({
    enabled: true,
    run,
    intervalMs: 50,
    startDelayMs: 10,
    retryDelayMs: 15,
    ...overrides
  });
}

test("a disabled worker never runs and still starts and stops cleanly", async () => {
  let runs = 0;
  const subject = worker(
    async () => {
      runs += 1;
    },
    { enabled: false }
  );
  const manager = new WorkerManager([subject]);
  await manager.start();
  await sleep(60);
  await manager.stop();
  assert.equal(runs, 0);
  assert.equal(subject.lastOutcome(), null);
});

test("the first pass is deferred off the startup path, then repeats", async () => {
  const startedAt = Date.now();
  let firstAt = 0;
  let runs = 0;
  const subject = worker(async () => {
    runs += 1;
    if (firstAt === 0) firstAt = Date.now();
  });
  const manager = new WorkerManager([subject]);
  await manager.start();
  assert.equal(runs, 0, "no pass may run during start()");
  await sleep(140);
  await manager.stop();
  assert.ok(firstAt - startedAt >= 10, "the first pass waits for the start delay");
  assert.ok(runs >= 2, `expected repeats, saw ${runs}`);
});

test("stop aborts the active pass and awaits it before returning", async () => {
  let observedAbort = false;
  let settled = false;
  const subject = worker(async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          setTimeout(() => {
            settled = true;
            resolve();
          }, 30);
        },
        { once: true }
      );
    });
  });
  const manager = new WorkerManager([subject]);
  await manager.start();
  await sleep(30);
  await manager.stop();
  assert.equal(observedAbort, true, "the pass must be told to stop");
  assert.equal(settled, true, "stop must not return while a pass is still running");
});

test("a transient failure retries sooner than the next scheduled pass", async () => {
  let runs = 0;
  const subject = worker(async () => {
    runs += 1;
    throw new Error("BACKUP_ALREADY_RUNNING: lock held");
  });
  const manager = new WorkerManager([subject]);
  await manager.start();
  await sleep(60);
  await manager.stop();
  const outcome = subject.lastOutcome();
  assert.equal(outcome?.status, "failed");
  assert.equal(outcome?.status === "failed" ? outcome.retry : null, true);
  assert.ok(runs >= 2, `expected a retry, saw ${runs} runs`);
});

test("a permanent failure waits for the next scheduled pass", async () => {
  const subject = worker(async () => {
    throw new Error("manifest digest mismatch");
  });
  await subject.start(new AbortController().signal);
  await sleep(30);
  const outcome = subject.lastOutcome();
  await subject.stop();
  assert.equal(outcome?.status, "failed");
  assert.equal(outcome?.status === "failed" ? outcome.retry : null, false);
});

test("overlapping passes are skipped rather than run concurrently", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const subject = worker(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(40);
    concurrent -= 1;
  });
  await subject.start(new AbortController().signal);
  const [, second] = await Promise.all([subject.runNow(), subject.runNow()]);
  await subject.stop();
  assert.equal(maxConcurrent, 1, "a pass must never overlap its predecessor");
  assert.equal(second.status, "skipped");
  assert.equal(second.status === "skipped" ? second.reason : null, "busy");
});

test("the worker stops after the writers and before the lease is released", async () => {
  const order: string[] = [];
  const record = (name: string): ManagedWorker => ({
    name,
    async start(): Promise<void> {
      order.push(`start:${name}`);
    },
    async stop(): Promise<void> {
      order.push(`stop:${name}`);
    }
  });
  const offhost = worker(async () => undefined, { enabled: false });
  const manager = new WorkerManager([
    record("instance-lease"),
    offhost,
    record("monitoring-archive"),
    record("alert-engine")
  ]);
  await manager.start();
  await manager.stop();

  const stops = order.filter((entry) => entry.startsWith("stop:"));
  assert.deepEqual(stops, ["stop:alert-engine", "stop:monitoring-archive", "stop:instance-lease"]);
  assert.ok(
    order.indexOf("start:instance-lease") < order.indexOf("start:monitoring-archive"),
    "the lease must be acquired before the writers start"
  );
});
