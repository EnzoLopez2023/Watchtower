import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { AppConfig } from "../../server/config.js";
import type {
  MonitoringArchiveRepository} from "../db/repositories/watchtower/monitoringArchiveRepository.js";
import {
  ARCHIVE_STREAMS,
  ARCHIVE_DAY_MS,
  dayLabel,
  utcDayStart,
  type ArchiveStreamDefinition,
  type ArchiveStreamName,
  type ArchiveRetention,
  type ArchiveStatusSummary,
} from "../db/repositories/watchtower/monitoringArchiveRepository.js";
import { assertBlobHash } from "../../server/clients/monitoringArchiveBlob.js";
import { asText } from "./values.js";

const gzipAsync = promisify(gzip);

const ARCHIVE_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_SETTLE_HOURS = 48;
const DEFAULT_MAX_DAYS_PER_RUN = 30;

/** Falls back to the default when a caller supplies a non-positive value. */
function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Zero is meaningful for settle hours: archive every fully closed UTC day. */
function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
const ARCHIVE_LEASE_RENEW_MS = 60 * 1000;

export interface PutBytesOptions {
  createOnly?: boolean;
  ifMatch?: string;
  contentType?: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
}

export interface MonitoringArchiveStorage {
  headBlob(name: string, opts?: { allowNotFound?: boolean }): Promise<{ etag: string; bytes: number } | null>;
  putBytes(name: string, body: Buffer, opts?: PutBytesOptions): Promise<{ etag: string | null }>;
  hashBlob(name: string, opts?: { ifMatch?: string }): Promise<{ sha256: string; bytes: number; etag: string | null }>;
}

export interface ArchiveFailure {
  stream?: string;
  day?: string;
  code: string;
  error: string;
}

export interface ArchiveRunResult {
  enabled?: boolean;
  skipped?: boolean;
  reason?: string;
  eligibleDays: number;
  archivedDays: number;
  archivedRows: number;
  failures: ArchiveFailure[];
  cancelled?: boolean;
  latestEligibleDay: string | null;
  latestVerifiedBlob: string | null;
}

interface ArchiveDayResult {
  archived: boolean;
  empty?: boolean;
  current?: boolean;
  rows?: number;
  bytes?: number;
  verifiedBlob?: string;
}

type ArchiveHeartbeat = {
  contract: string;
  app: string;
  status: "idle" | "success" | "failure";
  checkedUtc: string;
  runStartedUtc: string;
  runCompletedUtc: string;
  eligibleDays: number;
  archivedDays: number;
  failures: number;
  latestEligibleDay: string | null;
  latestVerifiedBlob: string | null;
};

function monitoringArchiveBlobName(streamName: string, day: string): string {
  const [year, month] = day.split("-");
  return `v1/${streamName}/${year}/${month}/${day}.jsonl.gz`;
}

async function archiveDayImpl(
  repo: MonitoringArchiveRepository,
  storage: MonitoringArchiveStorage,
  streamName: string,
  stream: ArchiveStreamDefinition,
  dayStart: number,
  assertLease: () => Promise<void>
): Promise<ArchiveDayResult> {
  const dayEnd = dayStart + ARCHIVE_DAY_MS;
  const { stats, rows } = await repo.snapshotStream(stream, dayStart, dayEnd);
  if (!stats.row_count) return { archived: false, empty: true };

  const checkpoint = await repo.checkpoint(streamName, dayStart);
  if (
    checkpoint?.archived_at != null &&
    checkpoint.row_count === stats.row_count &&
    checkpoint.source_max_received_at === stats.source_max_received_at
  ) {
    return { archived: false, current: true };
  }

  const attemptedAt = Date.now();
  const name = monitoringArchiveBlobName(streamName, dayLabel(dayStart));
  try {
    if (checkpoint?.pruned_at != null) {
      throw Object.assign(
        new Error(
          "Late rows arrived after this archived day was pruned locally; preserving the complete base blob and retaining the late rows for operator recovery"
        ),
        { code: "ARCHIVE_PRUNED_BASE" }
      );
    }
    if (
      checkpoint?.archived_at != null &&
      stats.row_count <= (checkpoint.row_count ?? 0)
    ) {
      throw Object.assign(
        new Error("Refusing to replace an archived day with a non-additive local snapshot"),
        { code: "ARCHIVE_NON_ADDITIVE" }
      );
    }
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const compressed = await gzipAsync(Buffer.from(body, "utf8"), { level: 6 });
    const sha256 = createHash("sha256").update(compressed).digest("hex");

    const existing = await storage.headBlob(name, { allowNotFound: true });
    const uploaded = await storage.putBytes(name, compressed, {
      createOnly: !existing,
      ifMatch: existing?.etag,
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
      metadata: {
        stream: streamName,
        day: dayLabel(dayStart),
        row_count: asText(rows.length),
        sha256,
      },
    });
    if (!uploaded.etag) {
      throw Object.assign(new Error("Azure Blob upload did not return an ETag"), {
        code: "ARCHIVE_UPLOAD_NO_ETAG",
      });
    }
    const readback = await storage.hashBlob(name, { ifMatch: uploaded.etag });
    assertBlobHash(readback, sha256, compressed.length, "Monitoring archive Blob");
    if (readback.etag !== uploaded.etag) {
      throw Object.assign(new Error("Monitoring archive Blob ETag changed during readback"), {
        code: "ARCHIVE_READBACK_ETAG_CHANGED",
      });
    }

    await assertLease();
    const finalized = await repo.finalizeSuccess({
      streamName,
      stream,
      dayStart,
      dayEnd,
      expected: stats,
      blobName: name,
      rowCount: rows.length,
      sha256,
      blobEtag: uploaded.etag,
      attemptedAt,
    });
    if (!finalized) {
      throw Object.assign(
        new Error("Source rows changed during archive upload; retrying with the next run"),
        { code: "ARCHIVE_SOURCE_CHANGED" }
      );
    }
    return { archived: true, rows: rows.length, bytes: compressed.length, verifiedBlob: name };
  } catch (error) {
    await repo.saveFailure({
      streamName,
      dayStart,
      dayEnd,
      rowCount: stats.row_count ?? 0,
      sourceMaxReceivedAt: stats.source_max_received_at,
      attemptedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface RunMonitoringArchiveOptions {
  signal?: AbortSignal | null;
  repo?: MonitoringArchiveRepository;
  storage?: MonitoringArchiveStorage;
  /** Hours a UTC day must be closed before it is eligible. Default 48. */
  settleHours?: number;
  /** Cross-process lease duration in milliseconds. Default 30 minutes. */
  leaseMs?: number;
  /** Upper bound on days archived per pass, oldest first. Default 30. */
  maxDaysPerRun?: number;
  archiveCandidate?: (
    storage: MonitoringArchiveStorage,
    streamName: string,
    stream: ArchiveStreamDefinition,
    dayStart: number,
    assertLease: () => Promise<void>
  ) => Promise<ArchiveDayResult>;
}

export async function runMonitoringArchiveNow(
  now: number,
  options: RunMonitoringArchiveOptions = {}
): Promise<ArchiveRunResult> {
  const { signal = null, repo, storage, archiveCandidate } = options;

  if (!repo) {
    return {
      enabled: false,
      skipped: true,
      reason: "not-configured",
      eligibleDays: 0,
      archivedDays: 0,
      archivedRows: 0,
      failures: [],
      latestEligibleDay: null,
      latestVerifiedBlob: null,
    };
  }

  if (!storage) {
    return {
      enabled: false,
      skipped: true,
      reason: "not-configured",
      eligibleDays: 0,
      archivedDays: 0,
      archivedRows: 0,
      failures: [],
      latestEligibleDay: null,
      latestVerifiedBlob: null,
    };
  }

  const leaseMs = positiveNumber(options.leaseMs, ARCHIVE_LEASE_MS);
  const settleMs =
    nonNegativeNumber(options.settleHours, DEFAULT_SETTLE_HOURS) * 60 * 60 * 1000;
  const maxDaysPerRun = positiveNumber(options.maxDaysPerRun, DEFAULT_MAX_DAYS_PER_RUN);

  const leaseToken = randomUUID();
  if (!await repo.acquireLease(leaseToken, Date.now(), leaseMs)) {
    return {
      enabled: true,
      skipped: true,
      reason: "lease-held",
      eligibleDays: 0,
      archivedDays: 0,
      archivedRows: 0,
      failures: [],
      latestEligibleDay: null,
      latestVerifiedBlob: null,
    };
  }

  let leaseLost = false;
  const assertLease = async (): Promise<void> => {
    if (leaseLost) {
      throw Object.assign(new Error("Monitoring archive cross-process lease was lost"), {
        code: "ARCHIVE_LEASE_LOST",
      });
    }
    const renewed = await repo.renewLease(leaseToken, Date.now() + leaseMs);
    if (!renewed) {
      leaseLost = true;
      throw Object.assign(new Error("Monitoring archive cross-process lease was lost"), {
        code: "ARCHIVE_LEASE_LOST",
      });
    }
  };

  const renewal = setInterval(() => {
    void assertLease().catch(() => { leaseLost = true; });
  }, ARCHIVE_LEASE_RENEW_MS);
  (renewal).unref?.();

  const result: ArchiveRunResult = {
    enabled: true,
    eligibleDays: 0,
    archivedDays: 0,
    archivedRows: 0,
    failures: [],
    cancelled: false,
    latestEligibleDay: null,
    latestVerifiedBlob: null,
  };

  try {
    if (signal?.aborted) {
      result.cancelled = true;
      return result;
    }

    const eligibleEnd = utcDayStart(now - settleMs);

    const candidates: Array<{ streamName: ArchiveStreamName; stream: ArchiveStreamDefinition; dayStart: number }> = [];

    for (const [streamName, stream] of Object.entries(ARCHIVE_STREAMS) as Array<[ArchiveStreamName, ArchiveStreamDefinition]>) {
      const bounds = await repo.dayBounds(stream, eligibleEnd);
      if (bounds.oldest == null || bounds.newest == null) continue;
      const newestDay = Math.min(utcDayStart(bounds.newest), eligibleEnd - ARCHIVE_DAY_MS);
      for (let dayStart = utcDayStart(bounds.oldest); dayStart <= newestDay; dayStart += ARCHIVE_DAY_MS) {
        const stats = await repo.streamStats(stream, dayStart, dayStart + ARCHIVE_DAY_MS);
        if (!stats.row_count) continue;
        const checkpoint = await repo.checkpoint(streamName, dayStart);
        if (checkpoint?.pruned_at != null && checkpoint.archived_at != null) continue;
        if (
          checkpoint?.archived_at != null &&
          checkpoint.row_count === stats.row_count &&
          checkpoint.source_max_received_at === stats.source_max_received_at
        ) continue;
        candidates.push({ streamName, stream, dayStart });
      }
    }

    // Deterministic order — oldest day first, then stream name — so a capped run
    // always makes forward progress from the oldest backlog instead of
    // re-attempting an arbitrary subset.
    candidates.sort((a, b) => a.dayStart - b.dayStart || a.streamName.localeCompare(b.streamName));
    result.eligibleDays = candidates.length;
    result.latestEligibleDay =
      candidates.length > 0
        ? dayLabel(candidates[candidates.length - 1]!.dayStart)
        : null;

    const scheduled = candidates.slice(0, maxDaysPerRun);

    const doArchive =
      archiveCandidate ??
      ((storage: MonitoringArchiveStorage, sn: string, stream: ArchiveStreamDefinition, dayStart: number, al: () => Promise<void>) =>
        archiveDayImpl(repo, storage, sn, stream, dayStart, al));

    for (const candidate of scheduled) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }
      try {
        const archived = await doArchive(
          storage,
          candidate.streamName,
          candidate.stream,
          candidate.dayStart,
          assertLease
        );
        if (archived.archived) {
          result.archivedDays += 1;
          result.archivedRows += archived.rows ?? 0;
          if (archived.verifiedBlob) result.latestVerifiedBlob = archived.verifiedBlob;
        }
        if (signal?.aborted) result.cancelled = true;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        result.failures.push({
          stream: candidate.streamName,
          day: dayLabel(candidate.dayStart),
          code: (err as NodeJS.ErrnoException).code ?? "ARCHIVE_DAY_FAILED",
          error: err.message,
        });
      }
    }

    return result;
  } finally {
    clearInterval(renewal);
    await repo.releaseLease(leaseToken);
  }
}

function buildHeartbeat(
  run: ArchiveRunResult,
  runStartedUtc: string,
  runCompletedUtc: string
): ArchiveHeartbeat {
  const failureCodes = run.failures.map((f) => f.code ?? "ARCHIVE_DAY_FAILED");
  if (run.skipped) failureCodes.push("ARCHIVE_RUN_SKIPPED");
  if (run.cancelled) failureCodes.push("ARCHIVE_RUN_CANCELLED");
  const failures = failureCodes.length;
  const eligibleDays = run.eligibleDays ?? 0;
  const archivedDays = run.archivedDays ?? 0;
  let status: ArchiveHeartbeat["status"];
  if (failures > 0) {
    status = "failure";
  } else if (eligibleDays === 0 && archivedDays === 0) {
    status = "idle";
  } else if (archivedDays > 0) {
    status = "success";
  } else {
    status = "failure";
  }
  return {
    contract: "hearth.monitoring-archive-health.v1",
    app: "hearth",
    status,
    checkedUtc: runCompletedUtc,
    runStartedUtc,
    runCompletedUtc,
    eligibleDays,
    archivedDays,
    failures,
    latestEligibleDay: run.latestEligibleDay ?? null,
    latestVerifiedBlob: run.latestVerifiedBlob ?? null,
  };
}

async function defaultPublishHeartbeat({
  blobClient,
  heartbeat,
}: {
  blobClient: MonitoringArchiveStorage;
  heartbeat: ArchiveHeartbeat;
}): Promise<string> {
  if (heartbeat.status === "failure") {
    throw new Error("Failed archive runs must not publish a healthy marker");
  }
  const date = new Date(heartbeat.checkedUtc);
  const nonce = randomUUID().replace(/-/g, "");
  const markerName = [
    "v1/monitoring",
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
    nonce,
    "_HEALTH.json",
  ].join("/");
  await blobClient.putBytes(
    markerName,
    Buffer.from(JSON.stringify(heartbeat, null, 2) + "\n", "utf8"),
    { createOnly: true, contentType: "application/json" }
  );
  return markerName;
}

export interface ScheduledPassOptions {
  config?: AppConfig["monitoringArchive"] | Record<never, never>;
  signal?: AbortSignal | null;
  runArchive?: (opts: { signal?: AbortSignal | null }) => Promise<ArchiveRunResult>;
  blobClient?: MonitoringArchiveStorage | null;
  publishHeartbeat?: (opts: { blobClient: MonitoringArchiveStorage; heartbeat: ArchiveHeartbeat }) => Promise<string>;
  now?: () => Date;
  writeLine?: (line: string) => void;
}

export interface ScheduledPassResult {
  run: ArchiveRunResult;
  heartbeat: ArchiveHeartbeat | null;
  event: Record<string, unknown>;
  published: boolean;
}

export async function runScheduledMonitoringArchivePass({
  signal = null,
  runArchive,
  blobClient = null,
  publishHeartbeat = defaultPublishHeartbeat,
  now = () => new Date(),
  writeLine = (line) => console.log(line),
}: ScheduledPassOptions = {}): Promise<ScheduledPassResult> {
  const runStartedUtc = now().toISOString();
  let run: ArchiveRunResult = { archivedDays: 0, archivedRows: 0, failures: [], eligibleDays: 0, latestEligibleDay: null, latestVerifiedBlob: null };
  let checkedUtc = runStartedUtc;

  const emit = (status: string, failureCount: number): Record<string, unknown> => {
    const event: Record<string, unknown> = {
      event: "monitoring_archive_run",
      checkedUtc,
      status,
      archivedDays: Number(run.archivedDays ?? 0),
      archivedRows: Number(run.archivedRows ?? 0),
      failureCount,
    };
    writeLine(JSON.stringify(event));
    return event;
  };

  const defaultRunArchive = async ({ signal: runSignal }: { signal?: AbortSignal | null } = {}) =>
    runMonitoringArchiveNow(Date.now(), { signal: runSignal });

  try {
    run = await (runArchive ?? defaultRunArchive)({ signal });
    const runCompletedUtc = now().toISOString();
    checkedUtc = runCompletedUtc;
    const heartbeat = buildHeartbeat(run, runStartedUtc, runCompletedUtc);
    if (heartbeat.status === "failure") {
      return {
        run,
        heartbeat,
        event: emit("failed", heartbeat.failures),
        published: false,
      };
    }
    const client = blobClient;
    if (client) {
      await publishHeartbeat({ blobClient: client, heartbeat });
    }
    return {
      run,
      heartbeat,
      event: emit("healthy", 0),
      published: true,
    };
  } catch {
    checkedUtc = now().toISOString();
    const failureCount = Math.max(1, Number(run.failures?.length ?? 0));
    return {
      run,
      heartbeat: null,
      event: emit("failed", failureCount),
      published: false,
    };
  }
}

export async function monitoringArchiveStatus(repo: MonitoringArchiveRepository): Promise<ArchiveStatusSummary> {
  return repo.archiveSummary();
}

export function invalidateMonitoringArchiveDays(
  repo: ArchiveRetention,
  streamName: ArchiveStreamName,
  timestamps: readonly number[],
  now?: number
): void {
  repo.invalidateDays(streamName, timestamps, now);
}

export function archiveAwareDeleteBefore(
  repo: ArchiveRetention,
  streamName: ArchiveStreamName,
  table: string,
  timestampColumn: string,
  cutoff: number
): { changes: number } {
  return repo.deleteBefore(streamName, table, timestampColumn, cutoff);
}

export function archiveAwareDeleteThroughId(
  repo: ArchiveRetention,
  streamName: ArchiveStreamName,
  table: string,
  timestampColumn: string,
  idThreshold: number | null,
  scopeSql?: string,
  scopeParams?: readonly (string | number | null)[]
): { changes: number } {
  return repo.deleteThroughId(streamName, table, timestampColumn, idThreshold, scopeSql, scopeParams);
}
