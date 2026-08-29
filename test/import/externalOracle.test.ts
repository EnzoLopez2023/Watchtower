/**
 * Tests for executing an external canonical-hash generator as the source-side
 * oracle.
 *
 * These use a synthetic generator script written to the scratch directory rather
 * than the coordinator's real one, so the suite is self-contained and never
 * depends on production paths. The synthetic generator is a faithful copy of the
 * coordinator's contract (it emits `hearth.sqlite-canonical-table-hashes.v1`
 * over the fixture) plus deliberately broken variants.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExternalSourceOracle } from "../../lib/db/import/externalOracle.js";
import { ORACLE_CONTRACT } from "../../lib/db/import/oracle.js";
import { reconcile } from "../../lib/db/import/reconcile.js";
import { runImport } from "../../lib/db/import/importer.js";
import { openSourceReadonly } from "../../lib/db/import/sourceIdentity.js";
import { openTargetReadonly } from "../../lib/db/import/target.js";
import { buildEvidenceManifest } from "../../lib/db/import/evidence.js";
import { ImportError } from "../../lib/db/import/errors.js";
import {
  buildSourceFixture,
  fixtureOwnership,
  FIXTURE_OWNED_TABLES,
  FIXTURE_TENANT_ID,
  makeScratchDir,
  referenceProductHash,
  referenceTableHash,
  removeScratchDir,
  openOracleReader,
  type FixtureSource
} from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

/**
 * Writes a standalone generator that mirrors the coordinator's contract.
 * `variant` selects deliberate misbehaviour for negative cases.
 */
function writeGenerator(
  directory: string,
  variant: "good" | "exit-nonzero" | "no-output" | "wrong-contract" | "writes-source" = "good"
): string {
  const path = join(directory, `generator-${variant}.mjs`);
  const body = `
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [databaseArg, ownershipArg, outputArg] = process.argv.slice(2)
const require = createRequire(resolve(process.cwd(), 'package.json'))
const Database = require('better-sqlite3')

const variant = ${JSON.stringify(variant)}
if (variant === 'exit-nonzero') {
  process.stderr.write('synthetic generator failure\\n')
  process.exit(3)
}
if (variant === 'writes-source') {
  appendFileSync(resolve(databaseArg), Buffer.from([0x00]))
}

const databasePath = resolve(databaseArg)
const ownership = JSON.parse(readFileSync(resolve(ownershipArg), 'utf8'))
const database = new Database(databasePath, { readonly: true, fileMustExist: true })
database.defaultSafeIntegers(true)
database.pragma('query_only = ON')

const quoteIdentifier = (value) => '"' + String(value).replaceAll('"', '""') + '"'

function writeLength(hash, length) {
  const encoded = Buffer.alloc(8)
  encoded.writeBigUInt64BE(BigInt(length))
  hash.update(encoded)
}

function writeValue(hash, value) {
  if (value === null) { hash.update('N'); writeLength(hash, 0); return }
  if (Buffer.isBuffer(value)) { hash.update('B'); writeLength(hash, value.length); hash.update(value); return }
  if (typeof value === 'bigint') {
    const encoded = Buffer.from(value.toString(10), 'utf8')
    hash.update('I'); writeLength(hash, encoded.length); hash.update(encoded); return
  }
  if (typeof value === 'number') {
    const encoded = Buffer.from(
      Number.isNaN(value) ? 'NaN'
        : Object.is(value, -0) ? '-0'
        : value === Infinity ? 'Infinity'
        : value === -Infinity ? '-Infinity'
        : value.toString(), 'utf8')
    hash.update('F'); writeLength(hash, encoded.length); hash.update(encoded); return
  }
  if (typeof value === 'string') {
    const encoded = Buffer.from(value, 'utf8')
    hash.update('T'); writeLength(hash, encoded.length); hash.update(encoded); return
  }
  throw new TypeError('Unsupported SQLite value type: ' + typeof value)
}

function hashTable(table) {
  const columns = database.prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')').all()
    .sort((left, right) => Number(left.cid) - Number(right.cid))
  const primaryKey = columns.filter((c) => Number(c.pk) > 0)
    .sort((l, r) => Number(l.pk) - Number(r.pk)).map((c) => String(c.name))
  const orderBy = primaryKey.length > 0 ? primaryKey.map(quoteIdentifier).join(', ') : 'rowid'

  const hash = createHash('sha256')
  hash.update('hearth.sqlite-table-canonical.v1\\0')
  writeValue(hash, table)
  writeValue(hash, columns.length)
  for (const column of columns) {
    writeValue(hash, String(column.name))
    writeValue(hash, String(column.type ?? ''))
  }

  let rowCount = 0
  const statement = database.prepare(
    'SELECT ' + columns.map((c) => quoteIdentifier(c.name)).join(', ') +
    ' FROM ' + quoteIdentifier(table) + ' ORDER BY ' + orderBy)
  for (const row of statement.iterate()) {
    hash.update('R')
    for (const column of columns) writeValue(hash, row[column.name])
    rowCount += 1
  }
  return {
    name: table,
    rowCount,
    primaryKey,
    columns: columns.map((c) => ({
      name: String(c.name), type: String(c.type ?? ''),
      notNull: Number(c.notnull) === 1, primaryKeyOrder: Number(c.pk),
    })),
    canonicalSha256: hash.digest('hex'),
  }
}

const tables = database.prepare(
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map((row) => String(row.name))
const tableResults = tables.map((table) => {
  const result = hashTable(table)
  console.error(result.name + ': ' + result.rowCount)
  return result
})
database.close()

const byName = new Map(tableResults.map((t) => [t.name, t]))
const products = ownership.products.map((product) => {
  const productHash = createHash('sha256')
  productHash.update('hearth.sqlite-product-canonical.v1\\0')
  writeValue(productHash, product.name)
  let rowCount = 0
  for (const tableName of [...product.tables].sort()) {
    const table = byName.get(tableName)
    if (!table) throw new Error('Ownership manifest references missing table ' + tableName)
    writeValue(productHash, tableName)
    writeValue(productHash, table.canonicalSha256)
    writeValue(productHash, table.rowCount)
    rowCount += table.rowCount
  }
  return { name: product.name, tableCount: product.tables.length, rowCount, canonicalSha256: productHash.digest('hex') }
})

if (variant === 'no-output') process.exit(0)

const output = {
  contract: variant === 'wrong-contract' ? 'some.other.contract.v1' : 'hearth.sqlite-canonical-table-hashes.v1',
  database: { path: databasePath, bytes: statSync(databasePath).size },
  tableCount: tableResults.length,
  tables: tableResults,
  products,
}
writeFileSync(resolve(outputArg), JSON.stringify(output, null, 2) + '\\n')
`;
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A manifest in the shape the generator expects (`products[].tables`). */
function writeOwnershipManifest(directory: string): string {
  const path = join(directory, "ownership.json");
  writeFileSync(
    path,
    JSON.stringify({ products: [{ name: "Watchtower", tables: [...FIXTURE_OWNED_TABLES] }] }, null, 2)
  );
  return path;
}

async function importFixture(directory: string, source: FixtureSource): Promise<string> {
  const result = await runImport({
    ownership: fixtureOwnership(source),
    sourcePath: source.path,
    targetPath: join(directory, "target.sqlite3"),
    tenantId: FIXTURE_TENANT_ID,
    allowInsideGitWorktree: true,
    importedAtMs: 1_790_000_500_000,
    allowDispositions: ["identity_missing_oid"],
    __unsafeSkipApprovedBaselineGateForTests: true
  });
  return result.targetPath;
}

test("executing the generator produces a loadable document and full provenance", async () => {
  const directory = scratch("external-oracle-run");
  const source = buildSourceFixture(directory);
  const generatorPath = writeGenerator(directory);
  const manifestPath = writeOwnershipManifest(directory);
  const outputPath = join(directory, "source-oracle.json");

  const messages: string[] = [];
  const run = await runExternalSourceOracle({
    generatorPath,
    sourcePath: source.path,
    ownershipManifestPath: manifestPath,
    outputPath,
    onProgress: (message) => messages.push(message)
  });

  const provenance = run.provenance;
  assert.equal(provenance.generatorPath, generatorPath);
  assert.equal(
    provenance.generatorSha256,
    createHash("sha256").update(readFileSync(generatorPath)).digest("hex")
  );
  assert.ok(provenance.generatorBytes > 0);
  assert.equal(provenance.nodeExecutable, process.execPath);
  assert.equal(provenance.nodeVersion, process.version);
  assert.equal(provenance.exitCode, 0);
  assert.deepEqual([...provenance.arguments], [generatorPath, source.path, manifestPath, outputPath]);
  assert.ok(provenance.durationMs > 0);
  assert.ok(provenance.stderrTail.length > 0, "the generator's per-table log is retained");

  assert.equal(provenance.outputPath, outputPath);
  assert.equal(
    provenance.outputSha256,
    createHash("sha256").update(readFileSync(outputPath)).digest("hex")
  );
  assert.equal(provenance.outputBytes, readFileSync(outputPath).byteLength);

  assert.equal(provenance.sourceBytesBefore, source.bytes);
  assert.equal(provenance.sourceBytesAfter, source.bytes);
  assert.equal(provenance.sourceSha256Before, source.sha256);
  assert.equal(provenance.sourceSha256After, source.sha256);
  assert.ok(provenance.sourceUnmutated);

  assert.equal(run.document.contract, ORACLE_CONTRACT);
  // The generator hashes the whole file, not just the owned subset — which is
  // exactly why the target side needs our mapping-aware reconciliation instead.
  assert.ok(run.document.tables.size > FIXTURE_OWNED_TABLES.length);
  for (const table of FIXTURE_OWNED_TABLES) {
    assert.ok(run.document.tables.has(table), `${table} missing from the generator output`);
  }
  for (const shared of ["hearth_users", "hearth_permissions", "audit_log", "other_product_table"]) {
    assert.ok(run.document.tables.has(shared), "the generator covers non-owned tables too");
  }
  assert.equal(run.document.products.get("Watchtower")?.tableCount, FIXTURE_OWNED_TABLES.length);
  assert.ok(messages.some((message) => message.includes("executing source oracle")));
});

test("the generator's own output file is preserved verbatim, not rewritten", async () => {
  const directory = scratch("external-oracle-preserve");
  const source = buildSourceFixture(directory);
  const outputPath = join(directory, "source-oracle.json");

  const run = await runExternalSourceOracle({
    generatorPath: writeGenerator(directory),
    sourcePath: source.path,
    ownershipManifestPath: writeOwnershipManifest(directory),
    outputPath
  });

  const bytesAfterLoad = readFileSync(outputPath);
  assert.equal(
    createHash("sha256").update(bytesAfterLoad).digest("hex"),
    run.provenance.outputSha256,
    "loading the document must not modify the generator's artefact"
  );

  // The retained artefact is the generator's own JSON, in its own shape.
  const parsed = JSON.parse(bytesAfterLoad.toString("utf8")) as Record<string, unknown>;
  assert.equal(parsed.contract, ORACLE_CONTRACT);
  assert.ok(Array.isArray(parsed.tables));
  assert.ok(Array.isArray(parsed.products));
});

test("the executed generator's digests match an in-repo reference computation", async () => {
  const directory = scratch("external-oracle-agreement");
  const source = buildSourceFixture(directory);
  const outputPath = join(directory, "source-oracle.json");

  const run = await runExternalSourceOracle({
    generatorPath: writeGenerator(directory),
    sourcePath: source.path,
    ownershipManifestPath: writeOwnershipManifest(directory),
    outputPath
  });

  const database = openOracleReader(source.path);
  const forAggregate: { name: string; rowCount: number; canonicalSha256: string }[] = [];
  try {
    for (const table of [...FIXTURE_OWNED_TABLES].sort()) {
      const reference = referenceTableHash(database, table);
      const published = run.document.tables.get(table);
      assert.ok(published, `${table} missing from the generator output`);
      assert.equal(published.canonicalSha256, reference.canonicalSha256, `hash differs for ${table}`);
      assert.equal(published.rowCount, reference.rowCount);
      forAggregate.push({
        name: table,
        rowCount: reference.rowCount,
        canonicalSha256: reference.canonicalSha256
      });
    }
  } finally {
    database.close();
  }

  assert.equal(
    run.document.products.get("Watchtower")?.canonicalSha256,
    referenceProductHash("Watchtower", forAggregate)
  );
});

test("an imported target is verified against the executed source oracle", async () => {
  const directory = scratch("external-oracle-reconcile");
  const source = buildSourceFixture(directory);
  const outputPath = join(directory, "source-oracle.json");

  const run = await runExternalSourceOracle({
    generatorPath: writeGenerator(directory),
    sourcePath: source.path,
    ownershipManifestPath: writeOwnershipManifest(directory),
    outputPath
  });
  const published = run.document.products.get("Watchtower");
  assert.ok(published);

  const targetPath = await importFixture(directory, source);
  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const result = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal,
      oracle: run.document,
      expectedOracleAggregateSha256: published.canonicalSha256
    });

    assert.ok(result.ok);
    assert.ok(result.oracle);
    assert.ok(result.oracle.matched);
    assert.ok(result.oracle.publishedMatchesExpected);
    assert.ok(result.oracle.targetMatchesPublished);
    assert.equal(result.oracle.target.aggregateSha256, published.canonicalSha256);
    assert.equal(result.oracle.oraclePath, outputPath);

    const manifest = buildEvidenceManifest({
      ownership: fixtureOwnership(source),
      sourceIdentity: {
        path: source.path,
        realPath: source.path,
        bytes: source.bytes,
        sha256: source.sha256,
        mtimeMs: 0,
        inode: 0,
        device: 0
      },
      sourceVerifiedAfterRun: null,
      sqliteVersion: "test",
      target: null,
      importSummary: null,
      dispositions: [],
      reconciliation: result,
      oracle: run.document,
      oracleExecution: run.provenance,
      approvedBaseline: {
        gateEnforced: true,
        manifestAdmitted: true,
        oracleAdmitted: true,
        backupAdmitted: true,
        sourceAdmitted: true,
        source: {
          schema: { tables: 101, explicitIndexes: 137, triggers: 8, views: 0 },
          ownedSchemaDigest: "a".repeat(64),
          ownedRowTotal: source.ownedRowTotal
        }
      },
      failures: [],
      generatedUtc: "2026-08-28T00:00:00.000Z"
    });

    assert.ok(manifest.sourceOracle);
    assert.equal(manifest.sourceOracle.mode, "executed");
    assert.equal(manifest.sourceOracle.matched, true);
    assert.equal(manifest.sourceOracle.execution?.generatorSha256, run.provenance.generatorSha256);
    assert.equal(manifest.sourceOracle.execution?.outputPath, outputPath);
    assert.equal(manifest.sourceOracle.execution?.sourceUnmutated, true);
    assert.equal(manifest.outcome, "pass");
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("cross-checking the source can be disabled without weakening the target check", async () => {
  const directory = scratch("external-oracle-crosscheck");
  const source = buildSourceFixture(directory);
  const run = await runExternalSourceOracle({
    generatorPath: writeGenerator(directory),
    sourcePath: source.path,
    ownershipManifestPath: writeOwnershipManifest(directory),
    outputPath: join(directory, "source-oracle.json")
  });
  const expected = run.document.products.get("Watchtower")?.canonicalSha256;
  assert.ok(expected);

  const targetPath = await importFixture(directory, source);
  const sourceDb = openSourceReadonly(source.path, 5000);
  const targetDb = openTargetReadonly(targetPath, 5000);
  try {
    targetDb.pragma("foreign_keys = ON");
    const result = reconcile({
      source: sourceDb,
      target: targetDb,
      tables: FIXTURE_OWNED_TABLES,
      expectedRowTotal: source.ownedRowTotal,
      oracle: run.document,
      expectedOracleAggregateSha256: expected,
      crossCheckSource: false
    });
    assert.ok(result.ok);
    assert.equal(result.oracle?.sourceCrossCheck, null);
    assert.equal(result.oracle?.sourceCrossCheckAgrees, null);
    assert.ok(result.oracle?.targetMatchesPublished);
    assert.ok(result.oracle?.matched);
  } finally {
    targetDb.close();
    sourceDb.close();
  }
});

test("a generator that exits non-zero fails closed with its stderr", async () => {
  const directory = scratch("external-oracle-exit");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    runExternalSourceOracle({
      generatorPath: writeGenerator(directory, "exit-nonzero"),
      sourcePath: source.path,
      ownershipManifestPath: writeOwnershipManifest(directory),
      outputPath: join(directory, "never.json")
    }),
    (error: unknown) =>
      error instanceof ImportError &&
      error.code === "ORACLE_GENERATOR_FAILED" &&
      error.details.exitCode === 3 &&
      Array.isArray(error.details.stderrTail) &&
      (error.details.stderrTail as string[]).some((line) => line.includes("synthetic generator failure"))
  );
});

test("a generator that writes no output fails closed", async () => {
  const directory = scratch("external-oracle-nooutput");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    runExternalSourceOracle({
      generatorPath: writeGenerator(directory, "no-output"),
      sourcePath: source.path,
      ownershipManifestPath: writeOwnershipManifest(directory),
      outputPath: join(directory, "missing.json")
    }),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_GENERATOR_FAILED"
  );
});

test("a generator emitting a different contract is rejected", async () => {
  const directory = scratch("external-oracle-contract");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    runExternalSourceOracle({
      generatorPath: writeGenerator(directory, "wrong-contract"),
      sourcePath: source.path,
      ownershipManifestPath: writeOwnershipManifest(directory),
      outputPath: join(directory, "wrong.json")
    }),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_INVALID"
  );
});

test("a generator that mutates the source is detected and fails the run", async () => {
  const directory = scratch("external-oracle-mutation");
  const source = buildSourceFixture(directory);
  await assert.rejects(
    runExternalSourceOracle({
      generatorPath: writeGenerator(directory, "writes-source"),
      sourcePath: source.path,
      ownershipManifestPath: writeOwnershipManifest(directory),
      outputPath: join(directory, "mutated.json")
    }),
    (error: unknown) => error instanceof ImportError && error.code === "SOURCE_MUTATED"
  );
});

test("a missing generator and unsafe output paths are refused", async () => {
  const directory = scratch("external-oracle-paths");
  const source = buildSourceFixture(directory);
  const generatorPath = writeGenerator(directory);
  const manifestPath = writeOwnershipManifest(directory);

  await assert.rejects(
    runExternalSourceOracle({
      generatorPath: join(directory, "absent.mjs"),
      sourcePath: source.path,
      ownershipManifestPath: manifestPath,
      outputPath: join(directory, "out.json")
    }),
    (error: unknown) => error instanceof ImportError && error.code === "ORACLE_GENERATOR_MISSING"
  );

  await assert.rejects(
    runExternalSourceOracle({
      generatorPath,
      sourcePath: source.path,
      ownershipManifestPath: manifestPath,
      outputPath: source.path
    }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );

  await assert.rejects(
    runExternalSourceOracle({
      generatorPath,
      sourcePath: source.path,
      ownershipManifestPath: manifestPath,
      outputPath: generatorPath
    }),
    (error: unknown) => error instanceof ImportError && error.code === "ARGUMENT_INVALID"
  );
});
