import type { RequestHandler } from "express";
import type { AuditRepository } from "../../lib/db/repositories/auditRepository.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Endpoints that write their own, richer audit row. Only the audit-ingestion
 * endpoint is excluded: recording the act of recording doubles the highest
 * volume category (navigation) without adding evidence.
 */
const SELF_AUDITED = [/^\/api\/audit\/events$/];

export interface AuditTrailOptions {
  readonly audit: AuditRepository;
  /** Structured, secret-safe sink for failures of the audit write itself. */
  readonly log?: (message: string) => void;
}

function requestPath(originalUrl: string): string {
  const queryStart = originalUrl.indexOf("?");
  return queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
}

/**
 * Appends one immutable row per authenticated interactive mutation.
 *
 * Mounted after the Entra gate and before every mutating handler, so it observes
 * the verified identity and the final status — including a 403 from a role guard,
 * which is exactly the attempt worth keeping. It records who (verified tenant and
 * object id), what (method and path, query string stripped) and the outcome, and
 * deliberately never touches request or response bodies, headers, query strings
 * or any shared secret.
 *
 * A request without a verified identity is skipped, so the shared-secret agent
 * and mobile surface — which is mounted ahead of this middleware and carries no
 * user at all — can never be misattributed to a person.
 */
export function auditInteractiveMutations(options: AuditTrailOptions): RequestHandler {
  return (request, response, next) => {
    if (!MUTATING_METHODS.has(request.method)) {
      next();
      return;
    }

    const path = requestPath(request.originalUrl);
    if (SELF_AUDITED.some((pattern) => pattern.test(path))) {
      next();
      return;
    }

    const occurredAt = Date.now();
    response.on("finish", () => {
      const identity = response.locals.identity;
      // No verified identity means this was never a user action.
      if (!identity) return;
      void options.audit
        .append({
          occurredAt,
          tenantId: identity.tenantId,
          userOid: identity.oid,
          verified: true,
          category: path.startsWith("/api/admin/") ? "admin" : "change",
          action: `${request.method} ${path}`,
          method: request.method,
          path,
          status: response.statusCode,
          ...(request.ip ? { ip: request.ip } : {})
        })
        .catch((error: unknown) => {
          // A failed audit write must not alter a response that already shipped;
          // surface it as an operational signal instead.
          options.log?.(
            `audit_append_failed ${request.method} ${path}: ${
              error instanceof Error ? error.name : "unknown"
            }`
          );
        });
    });
    next();
  };
}
