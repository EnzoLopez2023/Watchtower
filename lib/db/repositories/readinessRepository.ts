import type { SqliteDatabase } from "../connection.js";
import { EXPECTED_OWNED_TABLES } from "../import/ownership.js";
import { computeSchemaIdentity } from "../import/schema.js";

export const PRODUCTION_OWNED_SCHEMA_DIGEST =
  "a1dfbe309137dd2e5598e695256fa64a955de6657480340eca4e894b5c9b10f7";

export interface DatabaseReadiness {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly ownedTableCount: number;
  readonly requiredOwnedTableCount: number;
  readonly ownedSchemaDigest: string;
  readonly expectedOwnedSchemaDigest: string | null;
}

export interface ReadinessRepository {
  check(): Promise<DatabaseReadiness>;
}

export class SqliteReadinessRepository implements ReadinessRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly requiredTables: readonly string[] = EXPECTED_OWNED_TABLES,
    private readonly expectedSchemaDigest?: string
  ) {}

  public async check(): Promise<DatabaseReadiness> {
    const schema = this.database
      .prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    const ping = this.database.prepare("SELECT 1 AS ok").get() as { ok: number };
    const journalMode = String(this.database.pragma("journal_mode", { simple: true }));
    const schemaIdentity = computeSchemaIdentity(this.database, this.requiredTables);
    const ownedTableCount = schemaIdentity.tableCount;
    const schemaMatches =
      this.expectedSchemaDigest === undefined ||
      schemaIdentity.digest === this.expectedSchemaDigest;
    return {
      ok:
        ping.ok === 1 &&
        journalMode.toLowerCase() === "delete" &&
        ownedTableCount === this.requiredTables.length &&
        schemaMatches,
      schemaVersion: schema.version,
      journalMode,
      ownedTableCount,
      requiredOwnedTableCount: this.requiredTables.length,
      ownedSchemaDigest: schemaIdentity.digest,
      expectedOwnedSchemaDigest: this.expectedSchemaDigest ?? null
    };
  }
}
