import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import {
  defaultPersistentStorageProbe,
  parseMountInfoPoints
} from "../../lib/deployment/index.js";

const SCRATCH = resolve("./.scratch/wt/tmp");
const createdDirs: string[] = [];

after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(name: string): string {
  const dir = join(SCRATCH, `probe-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  return dir;
}

// A realistic synthetic mount table with an octal-escaped space in a path.
const SYNTHETIC_MOUNTINFO = [
  "21 24 0:20 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw",
  "36 35 98:0 / / rw,relatime shared:1 - ext4 /dev/root rw",
  "112 35 0:57 / /home rw,relatime shared:60 - cifs //share/home rw",
  "113 35 0:58 / /mnt/with\\040space rw,relatime shared:61 - ext4 /dev/sdb rw"
].join("\n");

test("parseMountInfoPoints reads the mount-point column and unescapes it", () => {
  const points = parseMountInfoPoints(SYNTHETIC_MOUNTINFO);
  assert.deepEqual(points, ["/proc", "/", "/home", "/mnt/with space"]);
});

test("parseMountInfoPoints tolerates blank lines and trailing newlines", () => {
  assert.deepEqual(parseMountInfoPoints("\n\n"), []);
  assert.deepEqual(parseMountInfoPoints(`${SYNTHETIC_MOUNTINFO}\n`).length, 4);
});

test("the real probe returns an array of mount points without throwing", () => {
  // On macOS /proc/self/mountinfo is absent, so this is []; on Linux it is the
  // real table. Either way it must be an array and must not throw.
  assert.ok(Array.isArray(defaultPersistentStorageProbe.mountPoints()));
});

test("the real probe reports the device id of an existing path", () => {
  const dir = scratchDir("dev");
  assert.equal(defaultPersistentStorageProbe.deviceId(dir), statSync(dir).dev);
});

test("the real probe returns undefined for a path that does not exist", () => {
  assert.equal(defaultPersistentStorageProbe.deviceId(join(SCRATCH, "does-not-exist-xyz")), undefined);
});

test("the real write probe succeeds on a writable dir and leaves nothing behind", () => {
  const dir = scratchDir("write-ok");
  const result = defaultPersistentStorageProbe.writeProbe(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(readdirSync(dir), [], "the probe file must be cleaned up");
});

test("the real write probe reports failure for a non-existent directory", () => {
  const missing = join(SCRATCH, `probe-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
  assert.equal(existsSync(missing), false);
  const result = defaultPersistentStorageProbe.writeProbe(missing);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ENOENT");
});
