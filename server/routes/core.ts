import { Router } from "express";
import { BUILD_IDENTITY } from "../../lib/buildIdentity.js";
import type { AuditRepository } from "../../lib/db/repositories/auditRepository.js";
import type {
  AppRole,
  IdentityRepository
} from "../../lib/db/repositories/identityRepository.js";
import type { ReadinessRepository } from "../../lib/db/repositories/readinessRepository.js";
import type { SettingsRepository } from "../../lib/db/repositories/settingsRepository.js";
import { requireRole } from "../auth/authorize.js";
import { HttpError } from "../http/errors.js";

/**
 * Runtime deployment identity, distinct from the baked-in BUILD_IDENTITY.
 *
 * The deploy workflow (.github/workflows/deploy.yml) writes BUILD_SHA and
 * BUILD_ID as App Service settings for the exact image it just pushed, and
 * WEBSITE_INSTANCE_ID is supplied by the platform. `/api/version` echoes them so
 * the workflow can confirm the running container is the one it deployed. All
 * three are null in local/dev and CI, where the check does not run.
 */
const DEPLOY_IDENTITY = Object.freeze({
  commit: process.env.BUILD_SHA?.trim() || null,
  buildId: process.env.BUILD_ID?.trim() || null,
  instanceId: process.env.WEBSITE_INSTANCE_ID?.trim() || null
});

export interface LifecycleState {
  readonly state: "starting" | "ready" | "draining" | "stopped";
}

export interface WorkerReadiness {
  status(): Readonly<Record<string, { readonly state: string; readonly updatedAt: number }>>;
}

export interface RecoveryDiagnosticStatus {
  readonly enabled: boolean;
  readonly uploadConfigured: boolean;
  readonly restoreVerificationEnabled: boolean;
  readonly lastOutcome: {
    readonly status: "success" | "failed" | "skipped";
    readonly at: number;
    readonly durationMs: number | null;
  } | null;
}

export interface RecoveryDiagnostics {
  status(): RecoveryDiagnosticStatus;
}

export interface CoreRouteDependencies {
  readonly startedAt: number;
  readonly databasePath: string;
  readonly lifecycle: () => LifecycleState;
  readonly readiness: ReadinessRepository;
  readonly workers: WorkerReadiness;
  readonly recovery?: RecoveryDiagnostics;
  readonly identities: IdentityRepository;
  readonly audit: AuditRepository;
  readonly settings: SettingsRepository;
}

const WATCHTOWER_FEATURES = new Set([
  "azure-command-center",
  "system-status",
  "observability",
  "power-monitor",
  "power-topology",
  "unifi-network",
  "unifi-topology",
  "unifi-config",
  "synology",
  "ip-migration",
  "protect"
]);

function currentIdentity(identity: Express.Locals["identity"]) {
  if (!identity) throw new HttpError(401, "missing_identity", "Identity is required");
  return identity;
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function rolesFromBody(body: unknown): readonly AppRole[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("roles" in body) ||
    !Array.isArray(body.roles) ||
    body.roles.length === 0 ||
    !body.roles.every((role) => ["viewer", "operator", "admin"].includes(String(role)))
  ) {
    throw new HttpError(400, "invalid_roles", "roles must contain app-local role names");
  }
  return body.roles as AppRole[];
}

export function createPublicCoreRouter(dependencies: CoreRouteDependencies): Router {
  const router = Router();

  router.get("/api/live", (_request, response) => {
    response.json({
      ok: true,
      app: BUILD_IDENTITY.app,
      uptimeSeconds: Math.floor((Date.now() - dependencies.startedAt) / 1000)
    });
  });

  router.get("/api/version", (_request, response) =>
    response.json({ ...BUILD_IDENTITY, deploy: DEPLOY_IDENTITY })
  );
  router.get("/version.json", (_request, response) => response.json(BUILD_IDENTITY));

  router.get("/api/ready", async (_request, response) => {
    try {
      const database = await dependencies.readiness.check();
      const lifecycle = dependencies.lifecycle();
      const workers = dependencies.workers.status();
      const workersReady = Object.values(workers).every(({ state }) =>
        ["healthy", "degraded", "stopped"].includes(state)
      );
      const ok = database.ok && lifecycle.state === "ready" && workersReady;
      response.status(ok ? 200 : 503).json({
        ok,
        build: BUILD_IDENTITY,
        authority: {
          engine: "sqlite",
          path: dependencies.databasePath,
          journalMode: database.journalMode,
          schemaVersion: database.schemaVersion,
          migrationCount: database.migrationCount,
          migrationIdentityDigest: database.migrationIdentityDigest,
          ownedTableCount: database.ownedTableCount,
          requiredOwnedTableCount: database.requiredOwnedTableCount,
          ownedSchemaDigest: database.ownedSchemaDigest,
          expectedOwnedSchemaDigest: database.expectedOwnedSchemaDigest
        },
        lifecycle: lifecycle.state,
        workers,
        ...(dependencies.recovery ? { recovery: dependencies.recovery.status() } : {})
      });
    } catch {
      response.status(503).json({
        ok: false,
        build: BUILD_IDENTITY,
        lifecycle: dependencies.lifecycle().state,
        error: { code: "readiness_failed", message: "Readiness checks failed" }
      });
    }
  });

  return router;
}

export function createAuthenticatedCoreRouter(dependencies: CoreRouteDependencies): Router {
  const router = Router();

  router.get("/api/me", (_request, response) => {
    response.json({ identity: currentIdentity(response.locals.identity) });
  });

  router.get("/api/settings", requireRole("viewer"), async (_request, response, next) => {
    try {
      const identity = currentIdentity(response.locals.identity);
      response.json({ settings: await dependencies.settings.getAll(identity.tenantId, identity.oid) });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/settings/:key", requireRole("viewer"), async (request, response, next) => {
    try {
      const identity = currentIdentity(response.locals.identity);
      await dependencies.settings.set(
        identity.tenantId,
        identity.oid,
        routeParam(request.params.key),
        request.body
      );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/audit/events", requireRole("viewer"), async (request, response, next) => {
    try {
      const identity = currentIdentity(response.locals.identity);
      const body = request.body as Record<string, unknown>;
      if (typeof body.action !== "string" || typeof body.category !== "string") {
        throw new HttpError(400, "invalid_audit_event", "category and action are required");
      }
      const allowedCategories = new Set(["auth", "navigation", "change", "admin", "system"]);
      if (!allowedCategories.has(body.category)) {
        throw new HttpError(400, "invalid_audit_event", "Unsupported audit category");
      }
      const id = await dependencies.audit.append({
        occurredAt: typeof body.occurredAt === "number" ? body.occurredAt : Date.now(),
        tenantId: identity.tenantId,
        userOid: identity.oid,
        emailSnapshot: identity.email,
        nameSnapshot: identity.displayName,
        verified: true,
        category: body.category as "auth" | "navigation" | "change" | "admin" | "system",
        action: body.action,
        ...(typeof body.view === "string" ? { view: body.view } : {}),
        ip: request.ip
      });
      response.status(201).json({ id });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/admin/users", requireRole("admin"), async (_request, response, next) => {
    try {
      response.json({ users: await dependencies.identities.listIdentities() });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/api/admin/users/:tenantId/:oid/roles",
    requireRole("admin"),
    async (request, response, next) => {
      try {
        const actor = currentIdentity(response.locals.identity);
        const roles = rolesFromBody(request.body);
        const identity = await dependencies.identities.replaceRoles(
          routeParam(request.params.tenantId),
          routeParam(request.params.oid),
          roles,
          actor
        );
        await dependencies.audit.append({
          occurredAt: Date.now(),
          tenantId: actor.tenantId,
          userOid: actor.oid,
          verified: true,
          category: "admin",
          action: "Updated app-local roles",
          method: request.method,
          path: request.path,
          status: 200,
          detail: `${identity.tenantId}/${identity.oid}: ${roles.join(",")}`,
          ip: request.ip
        });
        response.json({ identity });
      } catch (error) {
        next(error);
      }
    }
  );

  router.put(
    "/api/admin/users/:tenantId/:oid/features/:feature",
    requireRole("admin"),
    async (request, response, next) => {
      try {
        const actor = currentIdentity(response.locals.identity);
        const feature = routeParam(request.params.feature);
        const body = request.body as Record<string, unknown>;
        if (
          !WATCHTOWER_FEATURES.has(feature) ||
          typeof body.canEdit !== "boolean" ||
          typeof body.isHidden !== "boolean"
        ) {
          throw new HttpError(
            400,
            "invalid_feature_permission",
            "A Watchtower feature, canEdit, and isHidden are required"
          );
        }
        const identity = await dependencies.identities.setFeaturePermission(
          routeParam(request.params.tenantId),
          routeParam(request.params.oid),
          feature,
          { canEdit: body.canEdit, isHidden: body.isHidden }
        );
        await dependencies.audit.append({
          occurredAt: Date.now(),
          tenantId: actor.tenantId,
          userOid: actor.oid,
          verified: true,
          category: "admin",
          action: "Updated app-local feature permission",
          method: request.method,
          path: request.path,
          status: 200,
          detail: `${identity.tenantId}/${identity.oid}: ${feature}`,
          ip: request.ip
        });
        response.json({ identity });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/api/admin/audit", requireRole("admin"), async (request, response, next) => {
    try {
      const limit = Number(request.query.limit ?? 100);
      const beforeId = request.query.beforeId ? Number(request.query.beforeId) : undefined;
      response.json({
        events: await dependencies.audit.list(
          Number.isFinite(limit) ? limit : 100,
          Number.isFinite(beforeId) ? beforeId : undefined
        )
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
