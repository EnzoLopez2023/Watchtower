import type { WorkerReadiness } from "../routes/core.js";

export interface ManagedWorker {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

interface WorkerStatus {
  state: "starting" | "healthy" | "degraded" | "stopping" | "stopped";
  updatedAt: number;
}

export class WorkerManager implements WorkerReadiness {
  private readonly controller = new AbortController();
  private readonly statuses = new Map<string, WorkerStatus>();
  private readonly started: ManagedWorker[] = [];

  public constructor(private readonly workers: readonly ManagedWorker[]) {
    for (const worker of workers) {
      this.statuses.set(worker.name, { state: "stopped", updatedAt: Date.now() });
    }
  }

  public async start(): Promise<void> {
    for (const worker of this.workers) {
      this.setStatus(worker.name, "starting");
      try {
        await worker.start(this.controller.signal);
        this.started.push(worker);
        this.setStatus(worker.name, "healthy");
      } catch (error) {
        this.setStatus(worker.name, "degraded");
        await this.stopStarted();
        throw new Error(`Worker ${worker.name} failed to start`, { cause: error });
      }
    }
  }

  public async stop(): Promise<void> {
    this.controller.abort();
    await this.stopStarted();
  }

  public status(): Readonly<Record<string, WorkerStatus>> {
    return Object.fromEntries(this.statuses);
  }

  private async stopStarted(): Promise<void> {
    for (const worker of this.started.splice(0).reverse()) {
      this.setStatus(worker.name, "stopping");
      await worker.stop();
      this.setStatus(worker.name, "stopped");
    }
  }

  private setStatus(name: string, state: WorkerStatus["state"]): void {
    this.statuses.set(name, { state, updatedAt: Date.now() });
  }
}
