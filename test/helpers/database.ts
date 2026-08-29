import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../lib/db/connection.js";
import { migrateDatabase } from "../../lib/db/migrate.js";

export async function withTestDatabase<T>(
  run: (database: SqliteDatabase, directory: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "watchtower-test-"));
  const database = openDatabase({
    path: join(directory, "watchtower.db"),
    busyTimeoutMs: 500
  });
  migrateDatabase(database);
  try {
    return await run(database, directory);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

