// Durable outbound delivery for the on-site agents.
//
// Entries are appended before any network request and removed only after a 2xx
// response or an explicit permanent-rejection dead letter. Tokens are supplied at
// flush time and are never written to disk. Snapshot entries coalesce to the
// newest copy; log entries batch while retaining every line.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { DELIVERY_ID_HEADER } from "../lib/monitoring/agentContract.js";

const CREDENTIAL_HEADER = /(authorization|token|api[-_]?key|cookie)/i;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface QueueEntry {
  readonly id: string;
  readonly source: string;
  readonly queued_at: number;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeout_ms: number;
  readonly kind: "snapshot" | "event";
  readonly coalesce_key: string | null;
  readonly batch_key: string | null;
  readonly batch_field: string | null;
  readonly max_batch_items: number;
  readonly body_encoding: "base64" | "utf8";
  readonly body: string;
}

export interface EnqueueOptions {
  readonly path: string;
  readonly body: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly coalesceKey?: string | null;
  readonly batchKey?: string | null;
  readonly batchField?: string | null;
  readonly maxBatchItems?: number;
}

export interface FlushOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly maxRequests?: number;
  readonly retries?: number;
  readonly fetchImplementation?: typeof fetch;
}

export interface FlushResult {
  readonly accepted: number;
  readonly acceptedIds: readonly string[];
  readonly deadLettered: number;
  readonly deadLetteredIds: readonly string[];
  readonly pending: number;
  readonly oldestQueuedAt: number | null;
  readonly requests: number;
}

export interface QueueStatus {
  readonly pending: number;
  readonly queuedBytes: number;
  readonly oldestQueuedAt: number | null;
}

export interface DeliveryQueue {
  enqueue(options: EnqueueOptions): string;
  flush(options: FlushOptions): Promise<FlushResult>;
  status(): QueueStatus;
}

// A durable file handle scoped to one open/write/fsync/close cycle. Injecting the
// filesystem keeps createDeliveryQueue (and enqueue) synchronous for callers while
// making the append/fsync path fault-testable.
export interface QueueFileHandle {
  write(data: Uint8Array, offset: number, length: number): number;
  sync(): void;
  close(): void;
}

export interface QueueFileSystem {
  open(path: string, flags: string): QueueFileHandle;
}

export interface DeliveryQueueOptions {
  readonly filePath: string;
  readonly source: string;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly deadLetterBytes?: number;
  readonly onStatus?: (message: string) => void;
  readonly fileSystem?: QueueFileSystem;
}

const nodeFileSystem: QueueFileSystem = {
  open(path, flags) {
    const fd = openSync(path, flags);
    return {
      write: (data, offset, length) => writeSync(fd, data, offset, length),
      sync: () => fsyncSync(fd),
      close: () => closeSync(fd)
    };
  }
};

function durableHeaders(headers: unknown): Record<string, string> {
  if (typeof headers !== "object" || headers === null) return {};
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter(([name]) => !CREDENTIAL_HEADER.test(name))
      .map(([name, value]) => [name, String(value)])
  );
}

function readEntries(path: string, onStatus: (message: string) => void): QueueEntry[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return typeof parsed === "object" && parsed !== null
            ? [{ ...(parsed as QueueEntry), headers: durableHeaders((parsed as QueueEntry).headers) }]
            : [];
        } catch (error) {
          onStatus(`ignored malformed queue row: ${error instanceof Error ? error.message : "unknown"}`);
          return [];
        }
      });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      onStatus(`could not read queue: ${error instanceof Error ? error.message : "unknown"}`);
    }
    return [];
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Auth rotation and rollout order are operator-fixable. Retain those payloads
// instead of draining an entire outage backlog to dead letter.
const transientStatus = (status: number): boolean =>
  status === 401 ||
  status === 403 ||
  status === 404 ||
  status === 408 ||
  status === 425 ||
  status === 429 ||
  status >= 500;

const isSnapshot = (entry: QueueEntry): boolean =>
  entry.kind === "snapshot" || Boolean(entry.coalesce_key);

function requestBody(entry: QueueEntry): string | Uint8Array {
  return entry.body_encoding === "base64"
    ? new Uint8Array(Buffer.from(entry.body, "base64"))
    : entry.body;
}

function batchedEntry(entries: readonly QueueEntry[]): QueueEntry {
  const first = entries[0];
  if (!first) throw new Error("cannot batch an empty group");
  if (!first.batch_key || !first.batch_field || entries.length === 1) return first;

  const base = JSON.parse(first.body) as Record<string, unknown>;
  const combined: unknown[] = [];
  for (const entry of entries) {
    const parsed = JSON.parse(entry.body) as Record<string, unknown>;
    const field = parsed[first.batch_field];
    if (Array.isArray(field)) combined.push(...(field as unknown[]));
  }
  base[first.batch_field] = combined;
  base.delivery_id = first.id;
  return { ...first, body: JSON.stringify(base) };
}

interface SendResult {
  readonly accepted: boolean;
  readonly duplicate?: boolean;
  readonly permanent?: boolean;
  readonly status?: number;
  readonly detail?: string;
}

export function createDeliveryQueue(options: DeliveryQueueOptions): DeliveryQueue {
  const {
    filePath,
    source,
    maxBytes = 128 * 1024 * 1024,
    maxEntries = 50_000,
    deadLetterBytes = 10 * 1024 * 1024,
    onStatus = () => undefined,
    fileSystem = nodeFileSystem
  } = options;
  const tempPath = `${filePath}.tmp`;
  const deadPath = `${filePath}.dead-letter`;
  let entries = readEntries(filePath, onStatus);
  let flushChain: Promise<unknown> = Promise.resolve();
  let entryBytes = new Map<QueueEntry, number>();
  let queuedBytes = 0;
  let enqueuesSincePersist = 0;

  const serializedBytes = (entry: QueueEntry): number =>
    Buffer.byteLength(JSON.stringify(entry)) + 1;

  const rebuildByteCount = (): void => {
    entryBytes = new Map();
    queuedBytes = 0;
    for (const entry of entries) {
      const bytes = serializedBytes(entry);
      entryBytes.set(entry, bytes);
      queuedBytes += bytes;
    }
  };

  const removeEntries = (index: number, count: number): QueueEntry[] => {
    const removed = entries.splice(index, count);
    for (const entry of removed) {
      queuedBytes -= entryBytes.get(entry) ?? serializedBytes(entry);
      entryBytes.delete(entry);
    }
    return removed;
  };

  // Acknowledge deliveries by stable entry id, never by array position: enqueue
  // coalescing can splice the queue during an awaited send, so an index captured
  // before the await may point at a different, unsent entry once it resolves.
  const removeEntriesById = (ids: readonly string[]): QueueEntry[] => {
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    const removed: QueueEntry[] = [];
    const retained: QueueEntry[] = [];
    for (const entry of entries) {
      if (targets.has(entry.id)) {
        removed.push(entry);
        queuedBytes -= entryBytes.get(entry) ?? serializedBytes(entry);
        entryBytes.delete(entry);
      } else {
        retained.push(entry);
      }
    }
    entries = retained;
    return removed;
  };
  rebuildByteCount();

  const writeAll = (handle: QueueFileHandle, line: string): void => {
    const payload = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      const written = handle.write(payload, offset, payload.length - offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error(
          `delivery queue write stalled at ${offset}/${payload.length} bytes (handle reported ${String(written)})`
        );
      }
      offset += written;
    }
  };

  // Append one line durably: write every byte (tolerating short writes), fsync,
  // then close in a finally. Callers mutate in-memory state only after this
  // returns, so a throw or partial write never leaves a visible-but-unwritten row.
  const appendDurable = (path: string, line: string): void => {
    const handle = fileSystem.open(path, "a");
    let synced = false;
    try {
      writeAll(handle, line);
      handle.sync();
      synced = true;
    } finally {
      try {
        handle.close();
      } catch (error) {
        // After a successful fsync the bytes are durable, so a close failure must
        // not fail the append or desync memory from disk. Before fsync, the write
        // or sync error from the try block propagates and close stays best-effort.
        if (synced) {
          onStatus(
            `queue append close failed after fsync: ${error instanceof Error ? error.message : "unknown"}`
          );
        }
      }
    }
  };

  /**
   * Never concatenate the whole outage queue into one string: base64 gzip bodies
   * are already large and the temporary copies fast-fail Node on Windows before
   * the agent can drain. Serialize one bounded entry at a time.
   */
  const persist = (): void => {
    const handle = fileSystem.open(tempPath, "w");
    try {
      for (const entry of entries) writeAll(handle, `${JSON.stringify(entry)}\n`);
      handle.sync();
    } finally {
      handle.close();
    }
    renameSync(tempPath, filePath);
    enqueuesSincePersist = 0;
  };

  const deadLetter = (entry: QueueEntry, reason: string): void => {
    try {
      try {
        if (statSync(deadPath).size >= deadLetterBytes) {
          rmSync(`${deadPath}.1`, { force: true });
          renameSync(deadPath, `${deadPath}.1`);
        }
      } catch {
        // No dead-letter file yet.
      }
      appendDurable(deadPath, `${JSON.stringify({ failed_at: Date.now(), reason, entry })}\n`);
    } catch (error) {
      onStatus(`could not write dead letter: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };

  const enforceBounds = ({ compactSnapshots = false } = {}): {
    dropped: number;
    compacted: number;
  } => {
    let compactedCount = 0;
    if (compactSnapshots) {
      const before = entries.length;
      const latestByKey = new Set<string>();
      const compacted: QueueEntry[] = [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry) continue;
        if (entry.coalesce_key) {
          if (latestByKey.has(entry.coalesce_key)) continue;
          latestByKey.add(entry.coalesce_key);
        }
        compacted.push(entry);
      }
      entries = compacted.reverse();
      compactedCount = before - entries.length;
      rebuildByteCount();
    }

    const removed = new Set<QueueEntry>();
    let retainedCount = entries.length;
    let retainedBytes = queuedBytes;
    const overCapacity = (): boolean => retainedCount > maxEntries || retainedBytes > maxBytes;
    // Coalesced snapshots are the newest known state for each subsystem. Preserve
    // them and shed oldest historical events first in one linear pass.
    for (const snapshotPass of [false, true]) {
      for (const entry of entries) {
        if (!overCapacity()) break;
        if (isSnapshot(entry) !== snapshotPass) continue;
        removed.add(entry);
        retainedCount -= 1;
        retainedBytes -= entryBytes.get(entry) ?? serializedBytes(entry);
      }
      if (!overCapacity()) break;
    }
    const dropped = removed.size;
    if (dropped) {
      entries = entries.filter((entry) => !removed.has(entry));
      rebuildByteCount();
      for (const entry of removed) deadLetter(entry, "queue capacity exceeded");
      onStatus(
        `queue capacity exceeded; moved ${dropped} oldest entr${dropped === 1 ? "y" : "ies"} to dead letter`
      );
    }
    return { dropped, compacted: compactedCount };
  };

  const enqueue = (input: EnqueueOptions): string => {
    const buffer = Buffer.isBuffer(input.body) ? input.body : null;
    const entry: QueueEntry = {
      id: `${source}-${Date.now()}-${randomUUID()}`,
      source,
      queued_at: Date.now(),
      path: input.path,
      headers: durableHeaders(input.headers),
      timeout_ms: input.timeoutMs ?? 30_000,
      kind: input.coalesceKey ? "snapshot" : "event",
      coalesce_key: input.coalesceKey ?? null,
      batch_key: input.batchKey ?? null,
      batch_field: input.batchField ?? null,
      max_batch_items: input.maxBatchItems ?? 500,
      body_encoding: buffer ? "base64" : "utf8",
      body: buffer ? buffer.toString("base64") : String(input.body)
    };
    appendDurable(filePath, `${JSON.stringify(entry)}\n`);
    entries.push(entry);
    entryBytes.set(entry, serializedBytes(entry));
    queuedBytes += serializedBytes(entry);
    if (entry.coalesce_key) {
      for (let index = entries.length - 2; index >= 0; index -= 1) {
        if (entries[index]?.coalesce_key === entry.coalesce_key) removeEntries(index, 1);
      }
    }
    const { dropped } = enforceBounds();
    enqueuesSincePersist += 1;
    // Appends are already durable; compact stale snapshots periodically rather
    // than rewriting a potentially large outage queue on every log line.
    if (dropped || enqueuesSincePersist >= 100) persist();
    if (!entryBytes.has(entry)) {
      throw new Error("delivery queue capacity rejected the new entry");
    }
    return entry.id;
  };

  const send = async (
    entry: QueueEntry,
    context: { baseUrl: string; token: string; retries: number; fetchImplementation: typeof fetch }
  ): Promise<SendResult> => {
    let lastFailure: string | null = null;
    for (let attempt = 0; attempt <= context.retries; attempt += 1) {
      try {
        const response = await context.fetchImplementation(`${context.baseUrl}${entry.path}`, {
          method: "POST",
          headers: {
            ...entry.headers,
            authorization: `Bearer ${context.token}`,
            [DELIVERY_ID_HEADER]: entry.id
          },
          body: requestBody(entry),
          signal: AbortSignal.timeout(entry.timeout_ms)
        });
        const detail = await response.text().catch(() => "");
        if (response.ok) {
          let duplicate = false;
          try {
            duplicate = (JSON.parse(detail) as { duplicate?: boolean }).duplicate === true;
          } catch {
            // Body is optional.
          }
          return { accepted: true, duplicate, status: response.status };
        }
        if (!transientStatus(response.status)) {
          return {
            accepted: false,
            permanent: true,
            status: response.status,
            detail: detail.slice(0, 300)
          };
        }
        lastFailure = `HTTP ${response.status}: ${detail.slice(0, 200)}`;
        if (attempt < context.retries) {
          await sleep(Math.min(retryAfterMs(response) ?? 1000 * 2 ** attempt, 30_000));
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : "unknown";
        if (attempt < context.retries) await sleep(Math.min(1000 * 2 ** attempt, 30_000));
      }
    }
    return { accepted: false, permanent: false, detail: lastFailure ?? "delivery failed" };
  };

  const flushOnce = async (input: FlushOptions): Promise<FlushResult> => {
    if (!input.baseUrl || !input.token) {
      throw new Error("baseUrl and token are required to flush the delivery queue");
    }
    const context = {
      baseUrl: input.baseUrl,
      token: input.token,
      retries: input.retries ?? 1,
      fetchImplementation: input.fetchImplementation ?? fetch
    };
    const maxRequests = input.maxRequests ?? 50;
    const bounded = enforceBounds();
    let changed = bounded.dropped > 0;

    let accepted = 0;
    const acceptedIds: string[] = [];
    let deadLettered = 0;
    const deadLetteredIds: string[] = [];
    let requests = 0;

    while (entries.length && requests < maxRequests) {
      // Deliver the newest subsystem snapshots before historical events so a
      // recovery is reflected immediately, without reordering the event backlog.
      const snapshotIndex = entries.findIndex(isSnapshot);
      const startIndex = snapshotIndex >= 0 ? snapshotIndex : 0;
      const first = entries[startIndex];
      if (!first) break;
      const group: QueueEntry[] = [first];
      if (first.batch_key && first.batch_field) {
        for (
          let index = startIndex + 1;
          index < entries.length && group.length < first.max_batch_items;
          index += 1
        ) {
          const candidate = entries[index];
          if (
            !candidate ||
            candidate.batch_key !== first.batch_key ||
            candidate.batch_field !== first.batch_field ||
            candidate.path !== first.path
          ) {
            break;
          }
          group.push(candidate);
        }
      }

      let outgoing: QueueEntry;
      try {
        outgoing = batchedEntry(group);
      } catch (error) {
        for (const entry of group) {
          deadLetter(entry, `could not build batch: ${error instanceof Error ? error.message : "unknown"}`);
        }
        removeEntriesById(group.map((entry) => entry.id));
        changed = true;
        deadLettered += group.length;
        deadLetteredIds.push(...group.map((entry) => entry.id));
        continue;
      }

      requests += 1;
      const result = await send(outgoing, context);
      if (result.accepted) {
        // A prior attempt may have reached the server even though its response
        // was lost. If that first delivery id is retried with newer entries
        // batched behind it, the server correctly reports a duplicate but has not
        // seen the newer rows. Drop only the known duplicate.
        const consumed = result.duplicate && group.length > 1 ? group.slice(0, 1) : group;
        removeEntriesById(consumed.map((entry) => entry.id));
        changed = true;
        accepted += consumed.length;
        acceptedIds.push(...consumed.map((entry) => entry.id));
        continue;
      }
      if (result.permanent) {
        for (const entry of group) {
          deadLetter(entry, `permanent HTTP ${result.status ?? 0}: ${result.detail ?? ""}`);
        }
        removeEntriesById(group.map((entry) => entry.id));
        changed = true;
        deadLettered += group.length;
        deadLetteredIds.push(...group.map((entry) => entry.id));
        onStatus(
          `delivery rejected permanently with HTTP ${result.status ?? 0}; moved ${group.length} entr${
            group.length === 1 ? "y" : "ies"
          } to dead letter`
        );
        continue;
      }

      onStatus(`delivery deferred after retries: ${result.detail ?? "unknown"}`);
      break;
    }

    // Idempotency receipts make it safe to checkpoint once after the drain: a
    // replayed accepted entry is acknowledged as a duplicate, not written twice.
    if (changed) persist();
    return {
      accepted,
      acceptedIds,
      deadLettered,
      deadLetteredIds,
      pending: entries.length,
      oldestQueuedAt: entries[0]?.queued_at ?? null,
      requests
    };
  };

  const flush = (input: FlushOptions): Promise<FlushResult> => {
    const run = flushChain.then(
      () => flushOnce(input),
      () => flushOnce(input)
    );
    flushChain = run.catch(() => undefined);
    return run;
  };

  const status = (): QueueStatus => ({
    pending: entries.length,
    queuedBytes,
    oldestQueuedAt: entries[0]?.queued_at ?? null
  });

  const startupBounds = enforceBounds({ compactSnapshots: true });
  if (startupBounds.dropped || startupBounds.compacted) persist();
  return { enqueue, flush, status };
}
