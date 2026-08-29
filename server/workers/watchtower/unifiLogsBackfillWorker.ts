import type { ManagedWorker } from "../manager.js";
import type { BackfillResult, UnifiLogsRepository } from "../../../lib/db/repositories/watchtower/unifiLogsRepository.js";

/** Wait before the first pass so the lease and listener settle first. */
const DEFAULT_START_DELAY_MS = 5_000;
/** Pause between bounded batches so backfill never monopolises the writer. */
const DEFAULT_BATCH_PAUSE_MS = 250;
const DEFAULT_BATCH_SIZE = 500;
/** Hard bound on batches per process so a corrupt row cannot spin forever. */
const DEFAULT_MAX_BATCHES = 200;
/** Batches per repository call, so the worker regains control to pause/abort. */
const BATCHES_PER_PASS = 4;

export interface UnifiLogsBackfillWorkerOptions {
  readonly repository: Pick<UnifiLogsRepository, "runBackfill">;
  readonly startDelayMs?: number;
  readonly batchPauseMs?: number;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export type BackfillState =
  | { status: "idle" }
  | { status: "running"; batches: number; converted: number }
  | { status: "complete"; batches: number; converted: number }
  | { status: "cancelled"; batches: number; converted: number }
  | { status: "failed"; batches: number; converted: number; error: string };

export interface UnifiLogsBackfillWorker extends ManagedWorker {
  /** Structured outcome — failures are observable, never swallowed. */
  state(): BackfillState;
  /** Resolves once any in-flight pass has settled. */
  drain(): Promise<void>;
}

/**
 * Historically this ran inline in the router factory: it blocked startup, wrote
 * before the instance lease was held, and discarded every error. As a managed
 * worker it starts after the lease, works in bounded batches, reports failure,
 * and drains before the lease is released.
 */
export function createUnifiLogsBackfillWorker(
  opts: UnifiLogsBackfillWorkerOptions
): UnifiLogsBackfillWorker {
  const {
    repository,
    startDelayMs = DEFAULT_START_DELAY_MS,
    batchPauseMs = DEFAULT_BATCH_PAUSE_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxBatches = DEFAULT_MAX_BATCHES,
  } = opts;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let activeRun: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let state: BackfillState = { status: "idle" };

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (ms <= 0 || signal.aborted) {
        resolve();
        return;
      }
      const handle = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      handle.unref?.();
      function onAbort(): void {
        clearTimeout(handle);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const runBackfill = async (signal: AbortSignal): Promise<void> => {
    let batches = 0;
    let converted = 0;
    state = { status: "running", batches, converted };
    try {
      for (;;) {
        if (signal.aborted || stopped) {
          state = { status: "cancelled", batches, converted };
          return;
        }
        const result: BackfillResult = await repository.runBackfill({
          batchSize,
          maxBatches: BATCHES_PER_PASS,
          shouldStop: () => signal.aborted || stopped,
        });
        batches += result.batches;
        converted += result.updated;
        state = { status: "running", batches, converted };
        if (!result.incomplete) {
          state = { status: "complete", batches, converted };
          return;
        }
        if (batches >= maxBatches) {
          state = { status: "complete", batches, converted };
          return;
        }
        // Yield the writer between passes so ingest is never starved.
        await sleep(batchPauseMs, signal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = { status: "failed", batches, converted, error: message };
      console.error("UniFi logs backfill failed:", message);
    }
  };

  const drain = async (): Promise<void> => {
    while (activeRun) {
      // Settlement only: the run records and logs its own failure, so nothing is
      // lost here — rethrowing would abort shutdown midway.
      await activeRun.catch(() => undefined);
    }
  };

  return {
    name: "unifi-logs-backfill",

    async start(signal: AbortSignal): Promise<void> {
      // Deferred: startup must not block on historical conversion, and nothing
      // may be written until the instance lease has been acquired.
      timer = setTimeout(() => {
        timer = null;
        if (stopped || signal.aborted) return;
        const run = runBackfill(signal).finally(() => {
          activeRun = null;
        });
        activeRun = run;
      }, startDelayMs);
      timer.unref?.();
      signal.addEventListener("abort", () => void this.stop(), { once: true });
      console.log("   🧾 UniFi log backfill    — scheduled");
    },

    async stop(): Promise<void> {
      stopPromise ??= (async () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await drain();
      })();
      await stopPromise;
    },

    state(): BackfillState {
      return state;
    },

    async drain(): Promise<void> {
      await drain();
    },
  };
}
