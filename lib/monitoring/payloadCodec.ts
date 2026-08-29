// Compressed JSON storage for the large latest-snapshot rows.
//
// `unifi_latest.payload` is a ~590 KB JSON blob the agent rewrites every ~30
// seconds. At SQLite's 4 KB page size that is a ~147-page overflow chain freed
// and reallocated on every push, and on SMB-backed storage that sustained churn
// corrupted the overflow list. gzip cuts the payload roughly 8x.
//
// Reads stay backward compatible: rows written before compression are plain
// TEXT, so unpackJson sniffs the gzip magic bytes rather than assuming.
import { gunzipSync, gzipSync } from "node:zlib";
import { asText } from "./values.js";

/** JSON to gzipped Buffer, stored as a BLOB (TEXT affinity keeps BLOBs as BLOBs). */
export function packJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

/** Stored value to object. Accepts gzipped BLOBs and legacy plain-text JSON. */
export function unpackJson<T = unknown>(stored: unknown): T | null {
  if (stored === null || stored === undefined) return null;
  try {
    if (Buffer.isBuffer(stored)) {
      const gzipped = stored.length > 1 && stored[0] === 0x1f && stored[1] === 0x8b;
      return JSON.parse((gzipped ? gunzipSync(stored) : stored).toString("utf8")) as T;
    }
    return JSON.parse(asText(stored)) as T;
  } catch {
    return null;
  }
}

/** Best-effort JSON parse used for plain TEXT columns. */
export function safeParse<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : asText(value)) as T;
  } catch {
    return null;
  }
}
