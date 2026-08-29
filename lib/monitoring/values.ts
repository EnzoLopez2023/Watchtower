/**
 * Narrowing helpers for the loosely-typed agent payloads.
 *
 * The collectors post JSON that is validated at the edge rather than by a schema
 * compiler, so every read of an unknown field goes through one of these instead
 * of `String(value)` — which would silently stringify an object as
 * `[object Object]` and let a malformed payload look like real data.
 */
export function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  return fallback;
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
