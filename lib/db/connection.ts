import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DatabaseOptions {
  readonly path: string;
  readonly busyTimeoutMs: number;
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
}

export type SqliteDatabase = Database.Database;

export function openDatabase(options: DatabaseOptions): SqliteDatabase {
  const path = resolve(options.path);
  if (!options.readonly) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  }

  const database = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: options.busyTimeoutMs
  });

  database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  if (!options.readonly) {
    const journalMode = String(database.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
    if (journalMode !== "delete") {
      database.close();
      throw new Error(`SQLite journal mode must be DELETE, received ${journalMode}`);
    }
    database.pragma("synchronous = FULL");
  }

  return database;
}

