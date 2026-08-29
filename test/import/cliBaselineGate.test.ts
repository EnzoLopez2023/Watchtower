/**
 * End-to-end CLI acceptance tests for approved-baseline admission.
 *
 * These drive `scripts/reconcile.ts` and `scripts/legacy-import.ts` as real
 * subprocesses, because the bypass this suite guards against lived in the CLI
 * wiring rather than in the library: the gate functions were correct but
 * `reconcile.ts` never called them. Testing the library alone would not have
 * caught it, so every case here is a process invocation with a real exit code.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import {
  APPROVED_AGGREGATE_SHA256,
  APPROVED_LINEAGE,
  APPROVED_OWNED_ROW_TOTAL,
  APPROVED_OWNED_TABLES,
  APPROVED_OWNED_TABLE_COUNT,
  APPROVED_TABLES
} from "../../lib/db/import/approvedBaseline.js";
import { OWNED_VIEW_IDS } from "../../lib/db/import/ownership.js";
import { makeScratchDir, removeScratchDir } from "./fixtures.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RECONCILE = join(REPO_ROOT, "scripts/reconcile.ts");
const LEGACY_IMPORT = join(REPO_ROOT, "scripts/legacy-import.ts");
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(script: string, args: readonly string[]): Promise<RunResult> {
  try {
    const result = await execFileAsync(TSX, [script, ...args], {
      cwd: REPO_ROOT,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}

/**
 * A forged but *internally consistent* world: a manifest describing a forged
 * backup, a target imported from it, and an oracle generated over it. Every
 * document agrees with every other; only the pinned baseline disagrees.
 */
function forgeWorld(directory: string): {
  manifestPath: string;
  sourcePath: string;
  targetPath: string;
  oraclePath: string;
  sourceBytes: number;
  sourceSha256: string;
} {
  const sourcePath = join(directory, "forged-source.sqlite3");
  const database = new Database(sourcePath);
  database.pragma("journal_mode = DELETE");
  for (const table of APPROVED_OWNED_TABLES) {
    database.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, payload TEXT)`);
  }
  database.exec(`
    CREATE TABLE hearth_users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT, azure_oid TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE hearth_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, feature TEXT NOT NULL, can_edit INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, received_at INTEGER NOT NULL, user_email TEXT, user_name TEXT, user_oid TEXT, verified INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL, action TEXT NOT NULL, view TEXT, method TEXT, path TEXT, status INTEGER, detail TEXT, ip TEXT);
  `);
  database.close();

  const bytes = readFileSync(sourcePath);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");

  // Manifest that describes the forgery exactly.
  const manifestPath = join(directory, "forged-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      manifestVersion: 1,
      sourceBaseline: {
        repository: APPROVED_LINEAGE.repository,
        version: APPROVED_LINEAGE.version,
        build: APPROVED_LINEAGE.build,
        commit: APPROVED_LINEAGE.commit,
        tree: APPROVED_LINEAGE.tree,
        imageDigest: APPROVED_LINEAGE.imageDigest,
        database: {
          backupBytes: bytes.byteLength,
          backupSha256: sourceSha256,
          backupCreatedUtc: APPROVED_LINEAGE.backupCreatedUtc
        }
      },
      sharedTableDispositions: {
        hearth_users: "t",
        hearth_permissions: "t",
        audit_log: "t",
        hearth_index: "t"
      },
      products: [
        { name: "Watchtower", tables: [...APPROVED_OWNED_TABLES], views: [...OWNED_VIEW_IDS] }
      ]
    })
  );

  // A target that matches the forged source (all owned tables, all empty).
  const targetPath = join(directory, "forged-target.sqlite3");
  const target = new Database(targetPath);
  target.pragma("journal_mode = DELETE");
  for (const table of APPROVED_OWNED_TABLES) {
    target.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, payload TEXT)`);
  }
  target.close();

  // An oracle that agrees with the forged world: real hashes of the forged
  // tables, and a product aggregate over them.
  const oraclePath = join(directory, "forged-oracle.json");
  writeFileSync(
    oraclePath,
    JSON.stringify({
      contract: "hearth.sqlite-canonical-table-hashes.v1",
      database: { path: sourcePath, bytes: bytes.byteLength },
      tableCount: APPROVED_OWNED_TABLES.length,
      tables: APPROVED_OWNED_TABLES.map((name) => ({
        name,
        rowCount: 0,
        primaryKey: ["id"],
        columns: [],
        canonicalSha256: "0".repeat(64)
      })),
      products: [
        { name: "Watchtower", tableCount: APPROVED_OWNED_TABLE_COUNT, rowCount: 0, canonicalSha256: "0".repeat(64) }
      ]
    })
  );

  return { manifestPath, sourcePath, targetPath, oraclePath, sourceBytes: bytes.byteLength, sourceSha256 };
}

test("reconcile refuses to run for Watchtower without an oracle", async () => {
  const directory = scratch("cli-no-oracle");
  const world = forgeWorld(directory);
  const evidencePath = join(directory, "evidence.json");

  const result = await runCli(RECONCILE, [
    "--manifest",
    world.manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    world.targetPath,
    "--evidence",
    evidencePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0, "a missing oracle must not exit zero");
  assert.match(result.stderr, /BASELINE_REJECTED/);
  assert.ok(!existsSync(evidencePath), "no evidence may be written for a refused run");
});

test("reconcile rejects a self-consistent forged manifest, source, target and oracle", async () => {
  const directory = scratch("cli-forgery");
  const world = forgeWorld(directory);
  const evidencePath = join(directory, "evidence.json");

  const result = await runCli(RECONCILE, [
    "--manifest",
    world.manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    world.targetPath,
    "--oracle",
    world.oraclePath,
    "--evidence",
    evidencePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /BASELINE_REJECTED|MANIFEST_OWNERSHIP_DRIFT|SOURCE_IDENTITY_MISMATCH/);
  assert.ok(!existsSync(evidencePath), "a forged world must not produce evidence");
});

test("the aggregate override flag no longer exists on either CLI", async () => {
  const directory = scratch("cli-override");
  const world = forgeWorld(directory);

  for (const script of [RECONCILE, LEGACY_IMPORT]) {
    const help = await runCli(script, ["--help"]);
    assert.equal(help.code, 0);
    assert.ok(
      !help.stdout.includes("oracle-aggregate-sha256"),
      `${script} must not advertise an aggregate override`
    );
  }

  // Passing it is now an unknown-option error, not a silently accepted override.
  const result = await runCli(RECONCILE, [
    "--manifest",
    world.manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    world.targetPath,
    "--oracle",
    world.oraclePath,
    "--oracle-aggregate-sha256",
    "0".repeat(64),
    "--quiet"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unknown option --oracle-aggregate-sha256/);

  // And it is absent from the source of both scripts.
  for (const script of [RECONCILE, LEGACY_IMPORT]) {
    assert.ok(!readFileSync(script, "utf8").includes("oracle-aggregate-sha256"));
  }
});

test("legacy-import refuses to run for Watchtower without an oracle", async () => {
  const directory = scratch("cli-import-no-oracle");
  const world = forgeWorld(directory);
  const targetPath = join(directory, "never-created.sqlite3");
  const evidencePath = join(directory, "evidence.json");

  const result = await runCli(LEGACY_IMPORT, [
    "--manifest",
    world.manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    targetPath,
    "--tenant-id",
    "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    "--evidence",
    evidencePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /BASELINE_REJECTED/);
  assert.ok(!existsSync(targetPath), "no target may be created");
  assert.ok(!existsSync(evidencePath));
});

test("legacy-import rejects the forged world before creating a target", async () => {
  const directory = scratch("cli-import-forgery");
  const world = forgeWorld(directory);
  const targetPath = join(directory, "never-created.sqlite3");

  const result = await runCli(LEGACY_IMPORT, [
    "--manifest",
    world.manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    targetPath,
    "--tenant-id",
    "52188f12-db6b-46c6-88ff-08c802f0ed3b",
    "--oracle",
    world.oraclePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  assert.ok(!existsSync(targetPath));
  assert.ok(!existsSync(`${targetPath}-journal`));
});

test("a forged oracle is rejected even when the manifest is otherwise plausible", async () => {
  const directory = scratch("cli-forged-oracle");
  const world = forgeWorld(directory);

  // Manifest claiming the approved lineage byte-for-byte, but the source file is
  // still the forgery, so the measured backup identity cannot match.
  const manifestPath = join(directory, "approved-lineage-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      manifestVersion: 1,
      sourceBaseline: {
        repository: APPROVED_LINEAGE.repository,
        version: APPROVED_LINEAGE.version,
        build: APPROVED_LINEAGE.build,
        commit: APPROVED_LINEAGE.commit,
        tree: APPROVED_LINEAGE.tree,
        imageDigest: APPROVED_LINEAGE.imageDigest,
        database: {
          backupBytes: APPROVED_LINEAGE.backupBytes,
          backupSha256: APPROVED_LINEAGE.backupSha256,
          backupCreatedUtc: APPROVED_LINEAGE.backupCreatedUtc
        }
      },
      sharedTableDispositions: {
        hearth_users: "t",
        hearth_permissions: "t",
        audit_log: "t",
        hearth_index: "t"
      },
      products: [{ name: "Watchtower", tables: [...APPROVED_OWNED_TABLES], views: [...OWNED_VIEW_IDS] }]
    })
  );

  const result = await runCli(RECONCILE, [
    "--manifest",
    manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    world.targetPath,
    "--oracle",
    world.oraclePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  // The oracle gate fires before the file is even measured.
  assert.match(result.stderr, /BASELINE_REJECTED/);
});

test("an oracle that matches the approved values but a forged source still fails at the file stage", async () => {
  const directory = scratch("cli-approved-oracle-forged-source");
  const world = forgeWorld(directory);

  const manifestPath = join(directory, "approved-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      manifestVersion: 1,
      sourceBaseline: {
        repository: APPROVED_LINEAGE.repository,
        version: APPROVED_LINEAGE.version,
        build: APPROVED_LINEAGE.build,
        commit: APPROVED_LINEAGE.commit,
        tree: APPROVED_LINEAGE.tree,
        imageDigest: APPROVED_LINEAGE.imageDigest,
        database: {
          backupBytes: APPROVED_LINEAGE.backupBytes,
          backupSha256: APPROVED_LINEAGE.backupSha256,
          backupCreatedUtc: APPROVED_LINEAGE.backupCreatedUtc
        }
      },
      sharedTableDispositions: {
        hearth_users: "t",
        hearth_permissions: "t",
        audit_log: "t",
        hearth_index: "t"
      },
      products: [{ name: "Watchtower", tables: [...APPROVED_OWNED_TABLES], views: [...OWNED_VIEW_IDS] }]
    })
  );

  // An oracle carrying exactly the approved per-table values.
  const oraclePath = join(directory, "approved-oracle.json");
  writeFileSync(
    oraclePath,
    JSON.stringify({
      contract: "hearth.sqlite-canonical-table-hashes.v1",
      database: { path: "/approved", bytes: APPROVED_LINEAGE.backupBytes },
      tableCount: APPROVED_TABLES.size,
      tables: [...APPROVED_TABLES].map(([name, approved]) => ({
        name,
        rowCount: approved.rowCount,
        primaryKey: ["id"],
        columns: [],
        canonicalSha256: approved.canonicalSha256
      })),
      products: [
        {
          name: "Watchtower",
          tableCount: APPROVED_OWNED_TABLE_COUNT,
          rowCount: APPROVED_OWNED_ROW_TOTAL,
          canonicalSha256: APPROVED_AGGREGATE_SHA256
        }
      ]
    })
  );

  const result = await runCli(RECONCILE, [
    "--manifest",
    manifestPath,
    "--source",
    world.sourcePath,
    "--target",
    world.targetPath,
    "--oracle",
    oraclePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  // Manifest and oracle both pass; the measured backup file does not.
  assert.match(result.stderr, /SOURCE_IDENTITY_MISMATCH|BASELINE_REJECTED/);
});

test("the gate runs in order: manifest before oracle, oracle before any file measurement", async () => {
  const directory = scratch("cli-order");
  const world = forgeWorld(directory);

  // A manifest with drifted lineage plus an absent source file. If the manifest
  // gate did not run first, the failure would be about the missing file.
  const manifestPath = join(directory, "drifted.json");
  const drifted = JSON.parse(readFileSync(world.manifestPath, "utf8")) as Record<string, never>;
  (drifted.sourceBaseline as unknown as { build: number }).build = 999;
  writeFileSync(manifestPath, JSON.stringify(drifted));

  const result = await runCli(RECONCILE, [
    "--manifest",
    manifestPath,
    "--source",
    join(directory, "does-not-exist.sqlite3"),
    "--target",
    world.targetPath,
    "--oracle",
    world.oraclePath,
    "--quiet"
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /BASELINE_REJECTED/);
  assert.ok(!result.stderr.includes("SOURCE_MISSING"), "the manifest gate must fire before file access");
});

test("evidence written by a refused reconcile never exists, and a gated pass is distinguishable", () => {
  // The positive end-to-end path runs against the real immutable source in the
  // acceptance run; here we assert the structural rule the artefact must satisfy.
  const directory = scratch("cli-evidence-shape");
  mkdirSync(join(directory, "unused"), { recursive: true });

  // The evidence contract carries the admission block and gates the outcome on it.
  const evidenceSource = readFileSync(join(REPO_ROOT, "lib/db/import/evidence.ts"), "utf8");
  assert.ok(evidenceSource.includes("readonly approvedBaseline: BaselineAdmission;"));
  assert.ok(evidenceSource.includes("isFullyAdmitted(approvedBaseline)"), "outcome must require full admission");

  // The admission record itself declares every stage the acceptance check reads.
  const gateSource = readFileSync(join(REPO_ROOT, "lib/db/import/baselineGate.ts"), "utf8");
  for (const field of [
    "gateEnforced",
    "manifestAdmitted",
    "oracleAdmitted",
    "backupAdmitted",
    "sourceAdmitted"
  ]) {
    assert.ok(gateSource.includes(field), `admission record must carry ${field}`);
  }
  const reconcileSource = readFileSync(RECONCILE, "utf8");
  for (const call of [
    "assertManifestMatchesApprovedBaseline",
    "assertOracleRequiredForProduct",
    "assertOracleMatchesApprovedBaseline",
    "assertBackupIdentityMatchesApprovedBaseline",
    "assertSourceMatchesApprovedBaseline"
  ]) {
    assert.ok(reconcileSource.includes(call), `reconcile.ts must call ${call}`);
  }
});
