import type { ManagedWorker } from "../manager.js";
import type { AppConfig } from "../../config.js";
import type { OutageRepository } from "../../../lib/db/repositories/watchtower/outageRepository.js";
import { runOutagePostmortemCycle } from "../../../lib/monitoring/outagePostmortems.js";

const ENGINE_INTERVAL_MS = 30 * 1000;
const BACKFILL_INTERVAL_MS = 1_000;
const DEFAULT_STARTUP_DELAY_MS = 60 * 1000;

export interface OutagePostmortemWorkerOptions {
  readonly config: AppConfig["outagePostmortems"];
  /** Async repository contract; the worker never sees the storage engine. */
  readonly repository: OutageRepository;
  /** Test seam for driving a cycle; production uses the real engine. */
  readonly runCycle?: (repository: OutageRepository) => Promise<{ evidenceBacklog?: boolean }>;
  /** Overrides the startup delay so lifecycle tests need not wait. */
  readonly startupDelayMs?: number;
}

export interface OutagePostmortemWorker extends ManagedWorker {
  /** Resolves once any in-flight cycle has settled. */
  drain(): Promise<void>;
}

export function createOutagePostmortemWorker(
  opts: OutagePostmortemWorkerOptions
): OutagePostmortemWorker {
  const { config, repository } = opts;
  const runCycle = opts.runCycle ?? ((repo: OutageRepository) => runOutagePostmortemCycle(repo));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let activeRun: Promise<unknown> | null = null;
  let stopPromise: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    // A settling cycle can still be observed as active for a tick, so wait until
    // nothing is in flight rather than awaiting a single handle.
    while (activeRun) {
      // Settlement only: the run records and logs its own failure, so nothing is
      // lost here — rethrowing would abort shutdown midway.
      await activeRun.catch(() => undefined);
    }
  };

  return {
    name: "outage-postmortems",

    async start(signal: AbortSignal): Promise<void> {
      if (!config.enabled) {
        console.log("   🩺  Outage post-mortems — disabled");
        return;
      }

      signal.addEventListener("abort", () => void this.stop(), { once: true });

      const run = (): void => {
        if (stopped) return;
        const cycle = runCycle(repository)
          .then((result) => {
            const delay = result.evidenceBacklog ? BACKFILL_INTERVAL_MS : ENGINE_INTERVAL_MS;
            if (!stopped) {
              timer = setTimeout(run, delay);
              (timer).unref?.();
            }
          })
          .catch((error: unknown) => {
            console.error(
              "Outage post-mortem cycle failed:",
              error instanceof Error ? error.message : String(error)
            );
            if (!stopped) {
              timer = setTimeout(run, ENGINE_INTERVAL_MS);
              (timer).unref?.();
            }
          })
          .finally(() => {
            if (activeRun === cycle) activeRun = null;
          });
        activeRun = cycle;
      };

      const startupDelay = (() => {
        const value = Number(process.env["OUTAGE_POSTMORTEM_STARTUP_DELAY_SECONDS"]);
        if (opts.startupDelayMs != null) return opts.startupDelayMs;
        if (Number.isSafeInteger(value) && value >= 0 && value <= 10 * 60) return value * 1000;
        return DEFAULT_STARTUP_DELAY_MS;
      })();

      timer = setTimeout(run, startupDelay);
      (timer).unref?.();
      console.log("   🩺  Outage post-mortems — enabled");
    },

    /**
     * The manager aborts its shared signal and then calls stop(), so this runs
     * twice. Memoizing the shutdown means the second caller awaits the same
     * drain instead of racing past a cycle that is still writing — the instance
     * lease is released and the database closed immediately after every worker
     * has stopped.
     */
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

    async drain(): Promise<void> {
      await drain();
    },
  };
}
