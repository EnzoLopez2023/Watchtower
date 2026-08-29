import type { SqliteDatabase } from "../../connection.js";

/**
 * Base class for the SQLite-backed monitoring adapters.
 *
 * Raw better-sqlite3 lives only in this directory, and so does transaction
 * control. `transaction` is deliberately `protected`: better-sqlite3 requires a
 * synchronous callback, so a transaction can only ever be composed from the
 * private synchronous helpers of one adapter. Exposing it would let a route or a
 * domain module drive BEGIN/COMMIT across an arbitrary set of calls, which is
 * how a half-written ingest ends up committed.
 *
 * Public methods on an adapter return Promises, so route, domain and worker code
 * awaits an async contract and never depends on the storage engine happening to
 * be synchronous today.
 */
export abstract class SqliteRepository {
  protected constructor(protected readonly database: SqliteDatabase) {}

  /**
   * Runs `work` inside a single SQLite transaction (BEGIN/COMMIT or ROLLBACK).
   *
   * `work` must be synchronous: better-sqlite3 throws if it returns a promise.
   * Compose transactions from private sync helpers only.
   */
  protected transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  /** Immediate-mode transaction; takes the write reservation up front. */
  protected immediateTransaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }

  protected all<T>(sql: string, ...parameters: readonly SqlValue[]): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }

  protected get<T>(sql: string, ...parameters: readonly SqlValue[]): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }

  protected run(sql: string, ...parameters: readonly SqlValue[]): RunOutcome {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  protected runNamed(sql: string, parameters: Readonly<Record<string, SqlValue>>): RunOutcome {
    const result = this.database.prepare(sql).run(parameters);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }
}

/**
 * Marker for a repository contract consumed outside this directory: every method
 * returns a Promise. Adapters satisfy it by declaring their public methods
 * `async`; the synchronous statement and transaction work stays private.
 */
export type AsyncRepository<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export type SqlValue = string | number | bigint | Buffer | null;

export interface RunOutcome {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

/** SQLite stores booleans as 0/1; normalize both directions at the adapter edge. */
export const toSqliteBoolean = (value: unknown): 0 | 1 => (value ? 1 : 0);
export const fromSqliteBoolean = (value: unknown): boolean => value === 1 || value === true;

export function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nullableInteger(value: unknown): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

export function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
