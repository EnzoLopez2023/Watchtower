import type { SqliteDatabase } from "../../connection.js";
import { asText } from "../../../monitoring/values.js";
import { SqliteRepository } from "./base.js";

const RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface AgentDeliveryClaim {
  /**
   * Claims `deliveryId` for `endpoint`. Returns false when the same delivery was
   * already recorded, which makes the caller's ingest a no-op replay.
   *
   * Must be invoked inside the same transaction as the domain writes so a rolled
   * back ingest also releases the receipt.
   */
  claim(deliveryId: string | null, endpoint: string, now: number): boolean;
}

export interface AgentIngestReceiptRow {
  readonly delivery_id: string;
  readonly endpoint: string;
  readonly received_at: number;
}

export class SqliteAgentIngestReceiptRepository
  extends SqliteRepository
  implements AgentDeliveryClaim
{
  private lastPruneAt = 0;

  public constructor(database: SqliteDatabase) {
    super(database);
  }

  public claim(deliveryId: string | null, endpoint: string, now: number): boolean {
    // Backward compatibility with deployed agents that predate delivery ids.
    if (!deliveryId) return true;
    const claimed =
      this.run(
        `INSERT OR IGNORE INTO agent_ingest_receipts (delivery_id, endpoint, received_at)
         VALUES (?, ?, ?)`,
        deliveryId,
        endpoint,
        now
      ).changes > 0;
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.run("DELETE FROM agent_ingest_receipts WHERE received_at < ?", now - RECEIPT_RETENTION_MS);
      this.lastPruneAt = now;
    }
    return claimed;
  }

  public async listReceipts(limit = 100): Promise<AgentIngestReceiptRow[]> {
    return this.all<AgentIngestReceiptRow>(
      "SELECT delivery_id, endpoint, received_at FROM agent_ingest_receipts ORDER BY received_at DESC LIMIT ?",
      limit
    );
  }
}

/** Extracts a delivery id from the header or body, rejecting malformed values. */
export function deliveryIdFrom(
  header: string | undefined,
  body: unknown
): string | null {
  const fromBody =
    typeof body === "object" && body !== null && "delivery_id" in body
      ? (body as { delivery_id?: unknown }).delivery_id
      : undefined;
  const value = asText(header ?? fromBody).trim();
  return DELIVERY_ID_PATTERN.test(value) ? value : null;
}
