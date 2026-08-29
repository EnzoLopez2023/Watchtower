/**
 * Canonical, type-aware encoding and hashing of SQLite values.
 *
 * Encoding rules (deliberately unambiguous so two databases can only produce the
 * same digest when they hold the same storage classes and the same bytes):
 *
 *   null     -> 0x00
 *   integer  -> 0x01 | uint32be(len) | ASCII base-10 int64 text
 *   real     -> 0x02 | uint32be(8)   | IEEE-754 float64 big-endian
 *   text     -> 0x03 | uint32be(len) | UTF-8 bytes
 *   blob     -> 0x04 | uint32be(len) | raw bytes
 *
 * INTEGER and REAL never collide because the storage class tag differs, so
 * `1` and `1.0` hash differently. `-0.0` and `0.0` differ because the raw
 * float64 bytes differ. Every payload is length-prefixed, so no concatenation
 * of adjacent columns can be confused with a different column split.
 *
 * Reads must use `Database#defaultSafeIntegers(true)` so SQLite INTEGER values
 * arrive as `bigint` and REAL values arrive as `number`. Without that, the two
 * storage classes are indistinguishable in JavaScript.
 */

import { createHash, type Hash } from "node:crypto";

export type SqliteValue = null | bigint | number | string | Uint8Array;
export type CanonicalType = "null" | "integer" | "real" | "text" | "blob";

const TAG_NULL = 0x00;
const TAG_INTEGER = 0x01;
const TAG_REAL = 0x02;
const TAG_TEXT = 0x03;
const TAG_BLOB = 0x04;

const NULL_FRAME = Buffer.from([TAG_NULL]);
const ROW_SEPARATOR = Buffer.from([0x1e]);

export function canonicalTypeOf(value: SqliteValue): CanonicalType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return "integer";
  if (typeof value === "number") return "real";
  if (typeof value === "string") return "text";
  if (value instanceof Uint8Array) return "blob";
  throw new TypeError(`Unsupported SQLite value type: ${typeof value}`);
}

function frame(tag: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt8(tag, 0);
  out.writeUInt32BE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

/** Canonical byte encoding of a single SQLite value. */
export function encodeValue(value: SqliteValue): Buffer {
  const type = canonicalTypeOf(value);
  switch (type) {
    case "null":
      return NULL_FRAME;
    case "integer":
      return frame(TAG_INTEGER, Buffer.from((value as bigint).toString(10), "ascii"));
    case "real": {
      const payload = Buffer.allocUnsafe(8);
      payload.writeDoubleBE(value as number, 0);
      return frame(TAG_REAL, payload);
    }
    case "text":
      return frame(TAG_TEXT, Buffer.from(value as string, "utf8"));
    case "blob": {
      const bytes = value as Uint8Array;
      return frame(TAG_BLOB, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
  }
}

/** SHA-256 of one canonically encoded row, lowercase hex. */
export function hashRow(values: readonly SqliteValue[]): string {
  const hash = createHash("sha256");
  updateHashWithRow(hash, values);
  return hash.digest("hex");
}

function updateHashWithRow(hash: Hash, values: readonly SqliteValue[]): void {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(values.length, 0);
  hash.update(ROW_SEPARATOR);
  hash.update(header);
  for (const value of values) {
    hash.update(encodeValue(value));
  }
}

/**
 * Order-preserving streaming digest over a sequence of rows.
 *
 * Rows must be fed in a deterministic order (see `orderingKey` in `schema.ts`),
 * so the digest verifies both content and row ordering with O(1) memory.
 */
export class CanonicalDigest {
  #hash: Hash;
  #rows = 0;

  constructor(domainSeparator: string) {
    this.#hash = createHash("sha256");
    this.#hash.update(Buffer.from(`watchtower.canonical.v1:${domainSeparator}\n`, "utf8"));
  }

  updateRow(values: readonly SqliteValue[]): void {
    updateHashWithRow(this.#hash, values);
    this.#rows += 1;
  }

  get rows(): number {
    return this.#rows;
  }

  digest(): string {
    const trailer = Buffer.allocUnsafe(8);
    trailer.writeBigUInt64BE(BigInt(this.#rows), 0);
    this.#hash.update(trailer);
    return this.#hash.digest("hex");
  }
}

/** Streaming SHA-256 restricted to BLOB payload bytes of a single column. */
export class BlobColumnDigest {
  readonly column: string;
  #hash: Hash;
  #blobCount = 0;
  #blobBytes = 0;

  constructor(column: string) {
    this.column = column;
    this.#hash = createHash("sha256");
    this.#hash.update(Buffer.from(`watchtower.blob.v1:${column}\n`, "utf8"));
  }

  update(value: SqliteValue): void {
    if (!(value instanceof Uint8Array)) return;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(this.#blobCount, 0);
    header.writeUInt32BE(value.byteLength, 4);
    this.#hash.update(header);
    this.#hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    this.#blobCount += 1;
    this.#blobBytes += value.byteLength;
  }

  result(): { column: string; blobCount: number; blobBytes: number; sha256: string } {
    return {
      column: this.column,
      blobCount: this.#blobCount,
      blobBytes: this.#blobBytes,
      sha256: this.#hash.digest("hex")
    };
  }
}

/** Stable SHA-256 over an arbitrary JSON-serialisable value with sorted keys. */
export function stableJsonDigest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** JSON-safe rendering of a SQLite value for bounded difference reporting. */
export function describeValue(value: SqliteValue, maxLength = 120): unknown {
  const type = canonicalTypeOf(value);
  switch (type) {
    case "null":
      return { type };
    case "integer":
      return { type, value: (value as bigint).toString(10) };
    case "real":
      return { type, value: String(value) };
    case "text": {
      const text = value as string;
      return {
        type,
        length: text.length,
        value: text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
      };
    }
    case "blob": {
      const bytes = value as Uint8Array;
      return {
        type,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      };
    }
  }
}
