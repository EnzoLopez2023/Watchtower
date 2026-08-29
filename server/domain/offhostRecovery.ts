import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createBackup,
  isInside,
  pruneStalePartials,
  restoreBundle,
  uploadBundleWithReadback,
  verifyBackup,
  type BackupManifest,
  type OffhostUploadResult,
  type RestoreResult,
  type VerifyBackupResult
} from "../../lib/recovery/index.js";
import type { AppConfig } from "../config.js";

/** `createBackup` names bundles `<yyyymmddThhmmssmmmZ>-<16 hex>`. */
const BUNDLE_ID = /^\d{8}T\d{9}Z-[0-9a-f]{16}$/;

/** Disposable restore target, kept inside the app-owned backup root. */
const VERIFY_DIRECTORY = "restore-verify";

export interface OffhostRecoveryPassResult {
  readonly bundleId: string;
  readonly bundleDir: string;
  readonly manifest: BackupManifest;
  readonly verification: VerifyBackupResult;
  readonly upload: OffhostUploadResult | null;
  readonly restore: RestoreResult | null;
  readonly prunedPartials: readonly string[];
  readonly prunedBundles: readonly string[];
  readonly durationMs: number;
}

/**
 * The four steps, injectable so the schedule and failure handling can be driven
 * without touching a disk or a network.
 */
export interface OffhostRecoverySteps {
  readonly createBackup: typeof createBackup;
  readonly verifyBackup: typeof verifyBackup;
  readonly uploadBundleWithReadback: typeof uploadBundleWithReadback;
  readonly restoreBundle: typeof restoreBundle;
}

const DEFAULT_STEPS: OffhostRecoverySteps = {
  createBackup,
  verifyBackup,
  uploadBundleWithReadback,
  restoreBundle
};

export interface OffhostRecoveryOptions {
  readonly config: AppConfig["offhostRecovery"];
  readonly databasePath: string;
  readonly appVersion?: string | null;
  readonly buildId?: string | null;
  readonly sourceCommit?: string | null;
  readonly steps?: Partial<OffhostRecoverySteps>;
  readonly log?: (message: string) => void;
  /** Permits writing inside a Git worktree; only ever set by tests. */
  readonly allowInsideGitWorktree?: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) {
    throw new Error(`Off-host recovery cancelled before ${stage}`);
  }
}

/**
 * Runs one complete off-host recovery pass:
 *
 *   database-native backup → local verify → managed-identity upload with
 *   mandatory read-back → disposable restore verification → local retention.
 *
 * Nothing here touches the live authority: `createBackup` uses SQLite's online
 * backup API against a read-only handle, and the restore step writes to a
 * throwaway path under the app-owned backup root that is deleted afterwards.
 * The signal is checked between stages, which are the only points at which
 * stopping is safe — abandoning a half-written bundle mid-copy would leave a
 * partial file that later looks like a real backup.
 */
export async function runOffhostRecoveryPass(
  options: OffhostRecoveryOptions,
  signal?: AbortSignal
): Promise<OffhostRecoveryPassResult> {
  const startedAt = Date.now();
  const { config } = options;
  const steps: OffhostRecoverySteps = { ...DEFAULT_STEPS, ...options.steps };
  const backupRoot = resolve(config.backupRoot);
  const log = options.log ?? ((): void => undefined);

  throwIfAborted(signal, "the snapshot");
  await mkdir(backupRoot, { recursive: true, mode: 0o750 });
  const prunedPartials = (
    await pruneStalePartials({ backupRoot })
  ).map((partial) => partial.name);
  if (prunedPartials.length > 0) {
    log(`offhost_recovery pruned ${prunedPartials.length} stale partials`);
  }

  const backup = await steps.createBackup({
    sourcePath: options.databasePath,
    backupRoot,
    appVersion: options.appVersion ?? null,
    buildId: options.buildId ?? null,
    sourceCommit: options.sourceCommit ?? null,
    ...(options.allowInsideGitWorktree === undefined
      ? {}
      : { allowInsideGitWorktree: options.allowInsideGitWorktree })
  });
  log(`offhost_recovery snapshot ${backup.manifest.bundleId}`);

  throwIfAborted(signal, "local verification");
  const verification = await steps.verifyBackup({ bundleDir: backup.bundleDir });

  let upload: OffhostUploadResult | null = null;
  if (config.account) {
    throwIfAborted(signal, "upload");
    upload = await steps.uploadBundleWithReadback({
      account: config.account,
      container: config.container,
      requestTimeoutMs: config.requestTimeoutMs,
      bundleDir: backup.bundleDir,
      ...(config.prefix === undefined ? {} : { prefix: config.prefix })
    });
    log(`offhost_recovery uploaded ${upload.bundleId}`);
  }

  let restore: RestoreResult | null = null;
  if (config.verifyRestore) {
    throwIfAborted(signal, "restore verification");
    const verifyRoot = join(backupRoot, VERIFY_DIRECTORY);
    await mkdir(verifyRoot, { recursive: true, mode: 0o750 });
    const destination = join(verifyRoot, `${backup.manifest.bundleId}.sqlite3`);
    try {
      restore = await steps.restoreBundle({
        bundleDir: backup.bundleDir,
        destination,
        allowedRoot: verifyRoot,
        protectedPaths: [resolve(options.databasePath)],
        ...(options.allowInsideGitWorktree === undefined
          ? {}
          : { allowInsideGitWorktree: options.allowInsideGitWorktree })
      });
      log(`offhost_recovery restore_verified ${backup.manifest.bundleId}`);
    } finally {
      // The verified copy has served its purpose; leaving it behind would grow
      // without bound and could be mistaken for a restorable bundle.
      await rm(destination, { force: true });
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        await rm(`${destination}${suffix}`, { force: true });
      }
    }
  }

  const prunedBundles = await pruneLocalBundles(
    backupRoot,
    config.retentionCount,
    backup.manifest.bundleId
  );
  if (prunedBundles.length > 0) {
    log(`offhost_recovery pruned ${prunedBundles.length}`);
  }

  return {
    bundleId: backup.manifest.bundleId,
    bundleDir: backup.bundleDir,
    manifest: backup.manifest,
    verification,
    upload,
    restore,
    prunedPartials,
    prunedBundles,
    durationMs: Date.now() - startedAt
  };
}

/**
 * Keeps the newest `retentionCount` bundles on local disk.
 *
 * Only directories whose name is a generated bundle id are considered, and the
 * bundle written by this pass is never a candidate, so an unrelated file placed
 * in the backup root cannot be deleted by the scheduler. Bundle ids begin with a
 * UTC timestamp, so a lexicographic sort is a chronological one.
 */
export async function pruneLocalBundles(
  backupRoot: string,
  retentionCount: number,
  keepBundleId?: string
): Promise<string[]> {
  const root = resolve(backupRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const bundles = entries
    .filter((entry) => entry.isDirectory() && BUNDLE_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const bundle of bundles.slice(Math.max(retentionCount, 1))) {
    if (bundle === keepBundleId) continue;
    const target = join(root, bundle);
    if (!isInside(root, target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(bundle);
  }
  return removed;
}
