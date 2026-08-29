import type { ManagedWorker } from "../manager.js";

export type OffhostRunOutcome =
  | { readonly status: "success"; readonly at: number; readonly durationMs: number }
  | { readonly status: "failed"; readonly at: number; readonly error: string; readonly retry: boolean }
  | { readonly status: "skipped"; readonly at: number; readonly reason: string };

export interface OffhostRecoveryWorkerOptions {
  readonly enabled: boolean;
  /** One complete recovery pass. Injected so tests never touch disk or network. */
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  readonly intervalMs: number;
  /** Delay before the first pass, keeping backups off the startup path. */
  readonly startDelayMs: number;
  /** Delay before re-attempting a pass that failed for a transient reason. */
  readonly retryDelayMs: number;
  readonly name?: string;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

/** Failures worth retrying sooner than the next scheduled pass. */
const RETRYABLE = /already running|cancelled|lock|timed? ?out|ETIMEDOUT|ECONNRESET|EBUSY|throttl/i;

export interface OffhostRecoveryWorker extends ManagedWorker {
  /** Runs one pass immediately, bypassing the schedule. Used by tests. */
  runNow(): Promise<OffhostRunOutcome>;
  lastOutcome(): OffhostRunOutcome | null;
  /** Resolves once any in-flight pass has settled. */
  drain(): Promise<void>;
}

/**
 * Schedules off-host recovery on a bounded cadence.
 *
 * The first pass is deferred by `startDelayMs` so a restart never competes with
 * request warm-up, and each pass re-arms the next one rather than running on a
 * fixed interval, so a long backup can never overlap its own successor.
 *
 * `stop()` aborts the active pass and then *awaits* it. That ordering matters:
 * this worker holds a read handle on the live authority, and the instance lease
 * is released — and the database closed — only after every worker has stopped.
 * Returning before the pass settled would close the database underneath an
 * in-flight snapshot.
 */
export function createOffhostRecoveryWorker(
  options: OffhostRecoveryWorkerOptions
): OffhostRecoveryWorker {
  const name = options.name ?? "offhost-recovery";
  const now = options.now ?? Date.now;
  const log = options.log ?? ((): void => undefined);

  let timer: NodeJS.Timeout | undefined;
  let activeRun: Promise<OffhostRunOutcome> | undefined;
  let activeController: AbortController | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let outcome: OffhostRunOutcome | null = null;

  const record = (next: OffhostRunOutcome): OffhostRunOutcome => {
    outcome = next;
    log(JSON.stringify({ event: "offhost_recovery_run", ...next }));
    return next;
  };

  const execute = async (): Promise<OffhostRunOutcome> => {
    if (stopped) return record({ status: "skipped", at: now(), reason: "stopped" });
    if (activeRun) return record({ status: "skipped", at: now(), reason: "busy" });

    const controller = new AbortController();
    activeController = controller;
    const startedAt = now();
    const pass = (async (): Promise<OffhostRunOutcome> => {
      try {
        await options.run(controller.signal);
        return record({ status: "success", at: now(), durationMs: now() - startedAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        return record({
          status: "failed",
          at: now(),
          error: message,
          retry: RETRYABLE.test(message)
        });
      }
    })();
    activeRun = pass;
    try {
      return await pass;
    } finally {
      if (activeRun === pass) {
        activeRun = undefined;
        activeController = undefined;
      }
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void execute().then((result) => {
        if (stopped) return;
        schedule(
          result.status === "failed" && result.retry ? options.retryDelayMs : options.intervalMs
        );
      });
    }, delayMs);
    timer.unref();
  };

  return {
    name,

    async start(signal: AbortSignal): Promise<void> {
      if (!options.enabled) {
        log(JSON.stringify({ event: "offhost_recovery_disabled" }));
        return;
      }
      if (signal.aborted) return;
      signal.addEventListener("abort", () => void this.stop(), { once: true });
      schedule(options.startDelayMs);
    },

    async stop(): Promise<void> {
      // The manager aborts its shared signal and then calls stop(), so this runs
      // twice. Memoizing the shutdown — rather than returning early on a
      // `stopped` flag — means the second caller awaits the same drain instead
      // of racing past a pass that is still holding the database open.
      stopPromise ??= (async () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        activeController?.abort();
        while (activeRun) {
          await activeRun.catch(() => undefined);
        }
      })();
      await stopPromise;
    },

    async runNow(): Promise<OffhostRunOutcome> {
      return execute();
    },

    lastOutcome(): OffhostRunOutcome | null {
      return outcome;
    },

    async drain(): Promise<void> {
      // A pass that is settling may still be observed as active for a tick, so
      // wait until nothing is in flight rather than awaiting a single handle.
      while (activeRun) {
        await activeRun.catch(() => undefined);
      }
    }
  };
}
