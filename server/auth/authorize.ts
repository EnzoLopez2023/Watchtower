import type { RequestHandler } from "express";
import type {
  AppIdentity,
  AppRole,
  IdentityRepository
} from "../../lib/db/repositories/identityRepository.js";
import { HttpError } from "../http/errors.js";
import type { AccessTokenVerifier } from "./entra.js";

declare global {
  namespace Express {
    interface Locals {
      identity?: AppIdentity;
    }
  }
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "missing_access_token", "A bearer access token is required");
  }
  const token = header.slice(7).trim();
  if (!token) throw new HttpError(401, "missing_access_token", "A bearer access token is required");
  return token;
}

export function authenticate(
  verifier: AccessTokenVerifier,
  identities: IdentityRepository,
  adminOid?: string
): RequestHandler {
  return async (request, response, next) => {
    try {
      const claims = await verifier.verify(bearerToken(request.headers.authorization));
      let identity = await identities.upsertIdentity(claims);
      if (adminOid && claims.oid === adminOid && !identity.roles.includes("admin")) {
        identity = await identities.replaceRoles(
          claims.tenantId,
          claims.oid,
          ["viewer", "operator", "admin"],
          claims
        );
      }
      response.locals.identity = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const ROLE_LEVEL: Readonly<Record<AppRole, number>> = {
  viewer: 1,
  operator: 2,
  admin: 3
};

export function requireRole(required: AppRole): RequestHandler {
  return (_request, response, next) => {
    const identity = response.locals.identity;
    const authorized = identity?.roles.some((role) => ROLE_LEVEL[role] >= ROLE_LEVEL[required]);
    if (!authorized) {
      next(new HttpError(403, "insufficient_role", `The ${required} role is required`));
      return;
    }
    next();
  };
}
