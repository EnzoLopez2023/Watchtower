import type { ManagedWorker } from "../manager.js";
import type { AppConfig } from "../../config.js";
import type { MonitoringArchiveRepository } from "../../../lib/db/repositories/watchtower/monitoringArchiveRepository.js";
import { MonitoringArchiveBlobClient } from "../../clients/monitoringArchiveBlob.js";
import {
  runMonitoringArchiveNow,
  runScheduledMonitoringArchivePass,
  type MonitoringArchiveStorage,
} from "../../../lib/monitoring/monitoringArchive.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MonitoringArchiveWorkerOptions {
  readonly config: AppConfig["monitoringArchive"];
  /** Async repository contract; the worker never sees the storage engine. */
  readonly repository: MonitoringArchiveRepository;
}

export function createMonitoringArchiveWorker(
  opts: MonitoringArchiveWorkerOptions
): ManagedWorker {
  const { config, repository } = opts;

  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<unknown> | null = null;
  let activeController: AbortController | null = null;
  let stopped = false;

  let storage: MonitoringArchiveStorage | null = null;
  if (config.enabled && config.account) {
    storage = new MonitoringArchiveBlobClient({
      account: config.account,
      container: config.container,
    });
  }

  const intervalMs = config.intervalHours * 60 * 60 * 1000 || DEFAULT_INTERVAL_MS;

  const run = (): void => {
    if (stopped || activeRun) return;
    const controller = new AbortController();
    activeController = controller;
    activeRun = runScheduledMonitoringArchivePass({
      signal: controller.signal,
      runArchive: ({ signal }) =>
        runMonitoringArchiveNow(Date.now(), {
          repo: repository,
          storage: storage ?? undefined,
          signal,
          settleHours: config.settleHours,
          leaseMs: config.leaseMs,
          maxDaysPerRun: config.maxDaysPerRun,
        }),
      blobClient: storage,
    })
      .catch((error: unknown) =>
        console.error(
          "Monitoring archive run failed:",
          error instanceof Error ? error.message : String(error)
        )
      )
      .finally(() => {
        if (activeController === controller) activeController = null;
        activeRun = null;
      });
  };

  return {
    name: "monitoring-archive",

    async start(signal: AbortSignal): Promise<void> {
      if (!config.enabled || !config.account) {
        console.log("   🗄️  Monitoring archive   — disabled");
        return;
      }
      console.log(`   🗄️  Monitoring archive   — ${config.account}/${config.container}`);

      signal.addEventListener("abort", () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        activeController?.abort();
      }, { once: true });

      const initial = setTimeout(run, 60_000);
      (initial).unref?.();
      timer = setInterval(() => {
        if (!stopped) run();
      }, intervalMs);
      (timer).unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      activeController?.abort();
      if (activeRun) await activeRun;
    },
  };
}
