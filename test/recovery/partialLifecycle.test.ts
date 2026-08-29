/**
 * Finding 10 regressions: `createBackup` must never leave a `<bundleId>.partial`
 * directory behind, whatever fails after the working directory is created; and
 * stale-partial pruning must be narrow enough that it can only ever delete
 * abandoned partials it generated itself.
 */

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_STALE_PARTIAL_MS,
  createBackup,
  pruneStalePartials,
  type BackupFaultHooks
} from "../../lib/recovery/backup.js";
import { RecoveryError } from "../../lib/recovery/errors.js";
import { buildAuthorityFixture, makeScratchDir, removeScratchDir } from "./fixtures.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const directory = makeScratchDir(prefix);
  scratchDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of scratchDirs) removeScratchDir(directory);
});

function partials(backupRoot: string): string[] {
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot).filter((name) => name.endsWith(".partial")).sort();
}

function entries(backupRoot: string): string[] {
  return existsSync(backupRoot) ? readdirSync(backupRoot).sort() : [];
}

const BOOM = "injected fault";

const FAULT_STAGES: (keyof BackupFaultHooks)[] = [
  "afterSnapshotWritten",
  "afterSnapshotOpened",
  "afterJournalAssertion",
  "afterChecks",
  "afterCollection",
  "afterHash",
  "beforeManifestWrite",
  "beforeRename"
];

test("a failure at any post-creation stage removes the partial working directory", async () => {
  for (const stage of FAULT_STAGES) {
    const directory = scratch(`partial-${stage}`);
    const authority = buildAuthorityFixture(directory);
    const backupRoot = join(directory, "backups");

    await assert.rejects(
      createBackup({
        sourcePath: authority.path,
        backupRoot,
        allowInsideGitWorktree: true,
        faults: {
          [stage]: () => {
            throw new Error(BOOM);
          }
        }
      }),
      (error: unknown) => error instanceof Error && error.message === BOOM,
      `${stage}: the original failure must propagate unchanged`
    );

    assert.deepEqual(partials(backupRoot), [], `${stage}: no .partial may survive`);
    assert.deepEqual(entries(backupRoot), [], `${stage}: no bundle may be promoted`);
    assert.ok(existsSync(authority.path), `${stage}: the source is untouched`);
  }
});

test("a snapshot that cannot be opened still cleans up", async () => {
  const directory = scratch("partial-open");
  const authority = buildAuthorityFixture(directory);
  const backupRoot = join(directory, "backups");

  await assert.rejects(
    createBackup({
      sourcePath: authority.path,
      backupRoot,
      allowInsideGitWorktree: true,
      faults: {
        afterSnapshotWritten: () => {
          throw new RecoveryError("BACKUP_FAILED", "snapshot unusable");
        }
      }
    }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_FAILED"
  );
  assert.deepEqual(entries(backupRoot), []);
});

test("a foreign key violation in the snapshot cleans up the partial", async () => {
  const directory = scratch("partial-fk");
  const authority = buildAuthorityFixture(directory);
  const backupRoot = join(directory, "backups");

  const database = new Database(authority.path);
  database.pragma("foreign_keys = OFF");
  database
    .prepare("INSERT INTO outage_incident_evidence (incident_id, received_at) VALUES (?, ?)")
    .run("nope", 1);
  database.close();

  await assert.rejects(
    createBackup({ sourcePath: authority.path, backupRoot, allowInsideGitWorktree: true }),
    (error: unknown) => error instanceof RecoveryError && error.code === "BACKUP_FOREIGN_KEY_CHECK_FAILED"
  );
  assert.deepEqual(entries(backupRoot), [], "a failed integrity check must not leave a partial");
});

test("a successful backup leaves no partial behind", async () => {
  const directory = scratch("partial-success");
  const authority = buildAuthorityFixture(directory);
  const backupRoot = join(directory, "backups");

  const result = await createBackup({
    sourcePath: authority.path,
    backupRoot,
    allowInsideGitWorktree: true
  });

  assert.deepEqual(partials(backupRoot), []);
  assert.deepEqual(entries(backupRoot), [result.manifest.bundleId]);
});

test("a stale partial is pruned only past the configured age", async () => {
  const directory = scratch("prune-age");
  const backupRoot = join(directory, "backups");
  mkdirSync(backupRoot, { recursive: true });

  const fresh = join(backupRoot, "20260828T120000000Z-aaaaaaaaaaaaaaaa.partial");
  const stale = join(backupRoot, "20260827T120000000Z-bbbbbbbbbbbbbbbb.partial");
  for (const path of [fresh, stale]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "watchtower.sqlite3"), "partial bytes");
  }
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(stale, old, old);

  const pruned = await pruneStalePartials({ backupRoot, olderThanMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(
    pruned.map((entry) => entry.name),
    ["20260827T120000000Z-bbbbbbbbbbbbbbbb.partial"]
  );
  assert.ok(existsSync(fresh), "a fresh partial must survive");
  assert.ok(!existsSync(stale));
  assert.ok(pruned[0]!.ageMs >= 24 * 60 * 60 * 1000);
});

test("pruning ignores anything that is not a canonical generated partial", async () => {
  const directory = scratch("prune-shape");
  const backupRoot = join(directory, "backups");
  mkdirSync(backupRoot, { recursive: true });

  const survivors = [
    "20260828T120000000Z-aaaaaaaaaaaaaaaa", // a real promoted bundle
    "not-a-bundle.partial",
    "20260828T120000000Z-SHORT.partial",
    "20260828T120000000Z-aaaaaaaaaaaaaaaaa.partial", // 17 hex chars
    "20260828T120000000Z-AAAAAAAAAAAAAAAA.partial", // uppercase
    "important-data",
    ".partial"
  ];
  for (const name of survivors) {
    const path = join(backupRoot, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "keep.txt"), "keep");
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(path, old, old);
  }
  // A plain file shaped like a partial must also be ignored.
  const filePartial = join(backupRoot, "20260826T120000000Z-cccccccccccccccc.partial");
  writeFileSync(filePartial, "not a directory");

  const pruned = await pruneStalePartials({ backupRoot, olderThanMs: 0 });
  assert.deepEqual(pruned, []);
  for (const name of survivors) assert.ok(existsSync(join(backupRoot, name)), `${name} must survive`);
  assert.ok(existsSync(filePartial));
});

test("pruning never follows a symlink or escapes the backup root", async () => {
  const directory = scratch("prune-symlink");
  const backupRoot = join(directory, "backups");
  const outside = join(directory, "outside");
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "precious.txt"), "must survive");

  // A symlink named exactly like a stale partial, pointing outside the root.
  const link = join(backupRoot, "20260820T120000000Z-dddddddddddddddd.partial");
  symlinkSync(outside, link);
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  try {
    utimesSync(link, old, old);
  } catch {
    // Some platforms refuse to set times on a symlink; the shape check still applies.
  }

  const pruned = await pruneStalePartials({ backupRoot, olderThanMs: 0 });
  assert.deepEqual(pruned, [], "a symlink must never be treated as a prunable partial");
  assert.ok(existsSync(join(outside, "precious.txt")), "the link target must be untouched");
  assert.ok(existsSync(link));
});

test("pruning tolerates a missing root and validates the age argument", async () => {
  const directory = scratch("prune-args");
  assert.deepEqual(await pruneStalePartials({ backupRoot: join(directory, "absent") }), []);
  await assert.rejects(
    pruneStalePartials({ backupRoot: directory, olderThanMs: -1 }),
    (error: unknown) => error instanceof RecoveryError && error.code === "ARGUMENT_INVALID"
  );
  assert.equal(DEFAULT_STALE_PARTIAL_MS, 6 * 60 * 60 * 1000);
});

test("pruning only touches direct children of the resolved root", async () => {
  const directory = scratch("prune-nested");
  const backupRoot = join(directory, "backups");
  const nested = join(backupRoot, "sub", "20260820T120000000Z-eeeeeeeeeeeeeeee.partial");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "keep.txt"), "keep");
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  utimesSync(nested, old, old);

  const pruned = await pruneStalePartials({ backupRoot: resolve(backupRoot), olderThanMs: 0 });
  assert.deepEqual(pruned, []);
  assert.ok(existsSync(nested), "a nested partial is not a direct child and must survive");
});
