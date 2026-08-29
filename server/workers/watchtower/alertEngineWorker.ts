import type { AlertEngine } from "../../../lib/monitoring/alertEngine.js";
import type { ManagedWorker } from "../manager.js";

export interface AlertEngineWorkerOptions {
  readonly engine: AlertEngine;
  readonly pollSeconds: number;
  readonly log?: (message: string) => void;
}

/**
 * Polls on a fixed cadence (60s by default). The pass is cheap and no-ops until
 * APNs and a registered device exist, which keeps the baseline state fresh so the
 * first real alert fires on a true transition rather than on a cold start.
 */
export class AlertEngineWorker implements ManagedWorker {
  public readonly name = "alert-engine";
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;

  public constructor(private readonly options: AlertEngineWorkerOptions) {}

  public async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    signal.addEventListener(
      "abort",
      () => {
        if (this.timer) clearInterval(this.timer);
        this.controller?.abort();
      },
      { once: true }
    );
    this.timer = setInterval(() => this.tick(signal), this.options.pollSeconds * 1000);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.drain();
  }

  public async drain(): Promise<void> {
    if (this.activeRun) await this.activeRun;
  }

  /** Runs one pass immediately; used by tests and by an operator-triggered check. */
  public async runOnce(signal?: AbortSignal): Promise<void> {
    await this.options.engine.run(signal);
  }

  private tick(parentSignal: AbortSignal): void {
    if (this.stopped || this.activeRun || parentSignal.aborted) return;
    const controller = new AbortController();
    this.controller = controller;
    this.activeRun = this.options.engine
      .run(controller.signal)
      .catch((error: unknown) => {
        this.options.log?.(
          `Alert engine pass failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      })
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
        this.activeRun = undefined;
      });
  }
}
