import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { HttpError } from "../../http/errors.js";

/**
 * Constant-time shared-secret authentication for the headless service surface.
 *
 * These endpoints are mounted *before* the interactive Entra gate: the on-site
 * collectors and the iOS app hold their own bearer secrets and never present a
 * user identity. Each ingest family keeps its own distinct token exactly as it
 * did in production, so revoking one collector cannot silently authorize
 * another. Authorization is never derived from an email address or a header
 * that the caller controls.
 */
export function tokenMatches(provided: string | null | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const actual = Buffer.from(String(provided));
  const target = Buffer.from(String(expected));
  if (actual.length !== target.length) return false;
  try {
    return timingSafeEqual(actual, target);
  } catch {
    return false;
  }
}

/** `Authorization: ******` only. */
export function bearerToken(request: Request): string {
  const authorization = request.get("authorization") ?? "";
  return /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, "").trim() : "";
}

/** Bearer token, falling back to the collector-specific header aliases. */
export function bearerOrHeaderToken(request: Request, ...headers: readonly string[]): string | null {
  const bearer = bearerToken(request);
  if (bearer) return bearer;
  for (const header of headers) {
    const value = request.get(header);
    if (value) return value;
  }
  return null;
}

export interface ServiceTokenOptions {
  /** Resolves the expected secret at request time so rotation needs no restart. */
  readonly expected: () => string | undefined;
  /** Message returned with 503 when the secret is absent. */
  readonly unconfiguredMessage: string;
  /** Additional headers accepted besides `Authorization: Bearer`. */
  readonly headers?: readonly string[];
  readonly unconfiguredCode?: string;
  readonly invalidCode?: string;
  readonly invalidMessage?: string;
}

export function requireServiceToken(options: ServiceTokenOptions): RequestHandler {
  return (request, _response, next) => {
    const expected = options.expected();
    if (!expected) {
      next(
        new HttpError(
          503,
          options.unconfiguredCode ?? "ingest_not_configured",
          options.unconfiguredMessage
        )
      );
      return;
    }
    const supplied = options.headers?.length
      ? bearerOrHeaderToken(request, ...options.headers)
      : bearerToken(request);
    if (!tokenMatches(supplied, expected)) {
      next(
        new HttpError(
          401,
          options.invalidCode ?? "invalid_ingest_token",
          options.invalidMessage ?? "Invalid or missing ingest token"
        )
      );
      return;
    }
    next();
  };
}
