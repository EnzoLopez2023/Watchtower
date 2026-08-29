import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BlobColumnDigest,
  CanonicalDigest,
  canonicalTypeOf,
  describeValue,
  encodeValue,
  hashRow,
  stableJsonDigest,
  stableStringify,
  type SqliteValue
} from "../../lib/db/import/canonical.js";

test("canonicalTypeOf distinguishes every SQLite storage class", () => {
  assert.equal(canonicalTypeOf(null), "null");
  assert.equal(canonicalTypeOf(42n), "integer");
  assert.equal(canonicalTypeOf(42), "real");
  assert.equal(canonicalTypeOf("42"), "text");
  assert.equal(canonicalTypeOf(Buffer.from("42")), "blob");
});

test("integer 1 and real 1.0 hash differently", () => {
  assert.notEqual(hashRow([1n]), hashRow([1]));
});

test("text '1', integer 1 and a blob of '1' all hash differently", () => {
  const digests = new Set([hashRow(["1"]), hashRow([1n]), hashRow([Buffer.from("1")])]);
  assert.equal(digests.size, 3);
});

test("null is distinct from empty text and empty blob", () => {
  const digests = new Set([hashRow([null]), hashRow([""]), hashRow([Buffer.alloc(0)])]);
  assert.equal(digests.size, 3);
});

test("negative zero is distinct from positive zero", () => {
  assert.notEqual(hashRow([-0]), hashRow([0]));
});

test("length framing prevents column-boundary collisions", () => {
  assert.notEqual(hashRow(["ab", "c"]), hashRow(["a", "bc"]));
  assert.notEqual(hashRow([Buffer.from("ab"), Buffer.from("c")]), hashRow([Buffer.from("a"), Buffer.from("bc")]));
});

test("unicode text round-trips through canonical encoding", () => {
  const text = "日本語 ✅ emoji 🎯 \u0000 embedded";
  const encoded = encodeValue(text);
  assert.equal(encoded[0], 0x03);
  assert.equal(encoded.readUInt32BE(1), Buffer.byteLength(text, "utf8"));
  assert.equal(encoded.subarray(5).toString("utf8"), text);
});

test("blob encoding preserves exact bytes including NUL", () => {
  const bytes = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x7f]);
  const encoded = encodeValue(bytes);
  assert.equal(encoded[0], 0x04);
  assert.deepEqual(encoded.subarray(5), bytes);
});

test("large int64 values keep full precision", () => {
  const a = 9_007_199_254_740_993n;
  const b = 9_007_199_254_740_992n;
  assert.notEqual(hashRow([a]), hashRow([b]));
});

test("CanonicalDigest is order sensitive and row-count sealed", () => {
  const rows: SqliteValue[][] = [[1n, "a"], [2n, "b"], [3n, null]];

  const forward = new CanonicalDigest("t");
  for (const row of rows) forward.updateRow(row);

  const reversed = new CanonicalDigest("t");
  for (const row of [...rows].reverse()) reversed.updateRow(row);

  assert.notEqual(forward.digest(), reversed.digest());

  const again = new CanonicalDigest("t");
  for (const row of rows) again.updateRow(row);
  assert.equal(again.rows, 3);
});

test("CanonicalDigest domain separation prevents cross-table collisions", () => {
  const a = new CanonicalDigest("row:alpha");
  const b = new CanonicalDigest("row:beta");
  a.updateRow([1n]);
  b.updateRow([1n]);
  assert.notEqual(a.digest(), b.digest());
});

test("BlobColumnDigest hashes only blob payloads and counts bytes", () => {
  const digest = new BlobColumnDigest("payload");
  digest.update(null);
  digest.update("not a blob");
  digest.update(Buffer.from([1, 2, 3]));
  digest.update(Buffer.alloc(0));
  const result = digest.result();
  assert.equal(result.column, "payload");
  assert.equal(result.blobCount, 2);
  assert.equal(result.blobBytes, 3);

  const other = new BlobColumnDigest("payload");
  other.update(Buffer.from([1, 2, 3]));
  other.update(Buffer.alloc(0));
  assert.equal(other.result().sha256, result.sha256);
});

test("BlobColumnDigest is position sensitive", () => {
  const a = new BlobColumnDigest("p");
  a.update(Buffer.from([1]));
  a.update(Buffer.from([2]));
  const b = new BlobColumnDigest("p");
  b.update(Buffer.from([2]));
  b.update(Buffer.from([1]));
  assert.notEqual(a.result().sha256, b.result().sha256);
});

test("stableStringify sorts keys so digests are order independent", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableJsonDigest({ b: [1, 2], a: null }), stableJsonDigest({ a: null, b: [1, 2] }));
  assert.notEqual(stableJsonDigest({ a: 1 }), stableJsonDigest({ a: "1" }));
});

test("describeValue renders every storage class without leaking full blobs", () => {
  assert.deepEqual(describeValue(null), { type: "null" });
  assert.deepEqual(describeValue(7n), { type: "integer", value: "7" });
  assert.deepEqual(describeValue(1.5), { type: "real", value: "1.5" });

  const text = describeValue("x".repeat(400)) as { type: string; length: number; value: string };
  assert.equal(text.type, "text");
  assert.equal(text.length, 400);
  assert.ok(text.value.length < 400);

  const blob = describeValue(Buffer.from([1, 2, 3])) as { type: string; bytes: number; sha256: string };
  assert.equal(blob.type, "blob");
  assert.equal(blob.bytes, 3);
  assert.match(blob.sha256, /^[0-9a-f]{64}$/);
});
