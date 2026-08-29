import { randomUUID } from "node:crypto";
import type { InstanceLeaseRepository } from "../../lib/db/repositories/instanceLeaseRepository.js";
import type { ManagedWorker } from "./manager.js";

export class InstanceLeaseWorker implements ManagedWorker {
  public readonly name = "instance-lease";
  private readonly token = randomUUID();
  private timer?: NodeJS.Timeout;
  private stopped = true;

  public constructor(
    private readonly repository: InstanceLeaseRepository,
    private readonly owner: string,
    private readonly onLeaseLost: () => void,
    private readonly leaseMs = 30_000,
    private readonly renewEveryMs = 10_000
  ) {
    if (renewEveryMs >= leaseMs) {
      throw new Error("Instance lease renewal interval must be shorter than its duration");
    }
  }

  public async start(_signal: AbortSignal): Promise<void> {
    if (!(await this.repository.acquire(this.token, this.owner, Date.now(), this.leaseMs))) {
      throw new Error("Another Watchtower process holds the SQLite authority lease");
    }
    this.stopped = false;
    this.timer = setInterval(() => void this.renew(), this.renewEveryMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.repository.release(this.token);
  }

  private async renew(): Promise<void> {
    if (this.stopped) return;
    try {
      const renewed = await this.repository.renew(this.token, Date.now(), this.leaseMs);
      if (!renewed) this.loseLease();
    } catch {
      this.loseLease();
    }
  }

  private loseLease(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.onLeaseLost();
  }
}
