import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { IdentityClaims } from "../../lib/db/repositories/identityRepository.js";
import type { AppConfig } from "../config.js";
import { HttpError } from "../http/errors.js";

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedAccessToken extends IdentityClaims {
  readonly scopes: readonly string[];
  readonly appRoles: readonly string[];
  readonly payload: JWTPayload;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedAccessToken>;
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class EntraAccessTokenVerifier implements AccessTokenVerifier {
  private readonly issuer: string;
  private readonly verificationKey: Parameters<typeof jwtVerify>[1];

  public constructor(
    private readonly config: AppConfig["entra"],
    verificationKey?: Parameters<typeof jwtVerify>[1]
  ) {
    this.issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
    this.verificationKey =
      verificationKey ??
      createRemoteJWKSet(
        new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
        { timeoutDuration: 5_000, cooldownDuration: 30_000 }
      );
  }

  public async verify(token: string): Promise<VerifiedAccessToken> {
    if (!this.config.configured) {
      throw new HttpError(503, "auth_unconfigured", "Authentication is not configured");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.verificationKey, {
        issuer: this.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
        clockTolerance: 5
      }));
    } catch {
      throw new HttpError(401, "invalid_access_token", "The access token is invalid");
    }

    const tenantId = stringClaim(payload, "tid")?.toLowerCase();
    const oid = stringClaim(payload, "oid")?.toLowerCase();
    if (tenantId !== this.config.tenantId.toLowerCase() || !oid || !GUID_PATTERN.test(oid)) {
      throw new HttpError(401, "invalid_identity", "The token identity is invalid");
    }

    const scopes = (stringClaim(payload, "scp") ?? "").split(" ").filter(Boolean);
    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is string => typeof role === "string")
      : [];
    return {
      tenantId,
      oid,
      ...(stringClaim(payload, "preferred_username")
        ? { email: stringClaim(payload, "preferred_username") }
        : {}),
      ...(stringClaim(payload, "name") ? { displayName: stringClaim(payload, "name") } : {}),
      scopes,
      appRoles: roles,
      payload
    };
  }
}
