import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../../http/errors.js";

/** Wraps an async handler so rejections reach the shared error middleware. */
export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => unknown
): RequestHandler {
  return (request, response, next) => {
    void (async () => {
      try {
        await handler(request, response, next);
      } catch (error) {
        next(error);
      }
    })();
  };
}

export function queryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return undefined;
}

export function queryInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = queryString(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function queryBoolean(value: unknown): boolean {
  const raw = queryString(value)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function pathParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function bodyNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Express types `req.body` as `any`. Narrowing it once per handler keeps the
 * unchecked value from spreading through the route, and a non-object body
 * degrades to `{}` so field validation reports the missing field rather than
 * throwing on a property read.
 */
export function readBody(request: Request): Record<string, unknown> {
  return isRecord(request.body) ? request.body : {};
}

let serverErrorLog: (message: string) => void = () => undefined;

/** Installs the structured sink used for the detail behind a 500. */
export function setServerErrorLog(log: (message: string) => void): void {
  serverErrorLog = log;
}

/**
 * Uniform, secret-safe failure response.
 *
 * Internal exception text can carry SQL fragments, file paths and stored column
 * values, so it never reaches the client. The detail is kept server-side where
 * the operator can correlate it with the audit row for the same request.
 */
export function serverError(response: Response, scope: string, error: unknown): void {
  serverErrorLog(
    JSON.stringify({
      event: "watchtower.request_failed",
      scope,
      error: error instanceof Error ? error.message : "unknown"
    })
  );
  if (!response.headersSent) {
    response.status(500).json({ error: "The request failed" });
  }
}
