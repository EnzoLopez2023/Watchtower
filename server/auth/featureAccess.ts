import type { RequestHandler } from "express";
import type { AppIdentity, AppRole } from "../../lib/db/repositories/identityRepository.js";
import { OWNED_VIEW_IDS } from "../../lib/db/import/ownership.js";
import { HttpError } from "../http/errors.js";

/**
 * Route-level enforcement of the imported Hearth per-view permissions.
 *
 * A global `operator` role is a **ceiling, not a grant**. Hearth stored a
 * per-view `canEdit` / `isHidden` row for every identity, and those rows came
 * across in the import; honouring the role alone would silently promote every
 * operator to "may edit everything", which is exactly what the acceptance
 * review rejected. So each interactive route declares the manifest view ids its
 * data belongs to, and the guard resolves the decision against the identity's
 * `featurePermissions`.
 *
 * The rules, highest precedence first — deliberately identical to the client
 * rules in `src/services/permissions.ts` so the UI never offers an affordance
 * the server will refuse:
 *
 *   1. `admin` bypasses everything.
 *   2. A read needs `viewer` **and at least one** of the route's views visible.
 *      Shared data legitimately serves several views (UPS readings feed both
 *      Power Monitor and Power Topology), so hiding one of them must not blank
 *      out the other — hence any-of.
 *   3. A write needs `operator` **and** an explicit `canEdit: true` row on
 *      **every** view the route writes. A missing row is Hearth's default,
 *      which is read-only; an absent rule therefore never authorises a write.
 *   4. A hidden view denies both reads and writes, so a direct URL or a raw
 *      API call against a hidden feature is 403 rather than a data leak.
 */

export type ViewId = (typeof OWNED_VIEW_IDS)[number];

const VIEW_SET = new Set<string>(OWNED_VIEW_IDS);

export function isViewId(value: string): value is ViewId {
  return VIEW_SET.has(value);
}

const ROLE_LEVEL: Readonly<Record<AppRole, number>> = { viewer: 1, operator: 2, admin: 3 };

function hasRole(identity: AppIdentity | undefined, required: AppRole): boolean {
  return identity?.roles.some((role) => ROLE_LEVEL[role] >= ROLE_LEVEL[required]) === true;
}

function isAdmin(identity: AppIdentity | undefined): boolean {
  return identity?.roles.includes("admin") === true;
}

/**
 * The stored row, or undefined when the import never materialised one.
 *
 * The map itself is treated as optional: an identity assembled without one is
 * read as "no rows", which resolves to Hearth's defaults rather than throwing
 * and turning an authorization decision into a 500.
 */
function storedPermission(
  identity: AppIdentity,
  view: ViewId
): { readonly canEdit: boolean; readonly isHidden: boolean } | undefined {
  return identity.featurePermissions?.[view];
}

/** An absent row keeps Hearth's default, which is visible. */
export function isViewVisible(identity: AppIdentity, view: ViewId): boolean {
  if (isAdmin(identity)) return true;
  return storedPermission(identity, view)?.isHidden !== true;
}

/** An absent row keeps Hearth's default, which is read-only. */
export function canEditView(identity: AppIdentity, view: ViewId): boolean {
  if (isAdmin(identity)) return true;
  if (!isViewVisible(identity, view)) return false;
  if (!hasRole(identity, "operator")) return false;
  return storedPermission(identity, view)?.canEdit === true;
}

/**
 * Authentication runs ahead of this guard, so a request without an identity has
 * already been refused with 401. Reaching here without one means the identity
 * carries nothing to authorize, which `requireRole` has always reported as 403 —
 * matched here so the two guards cannot disagree about the same request.
 */
function identityOf(locals: { identity?: AppIdentity }): AppIdentity | undefined {
  return locals.identity;
}

export interface FeatureReadOptions {
  /** Any-of: the caller needs at least one of these views visible. */
  readonly views: readonly ViewId[];
  /** Minimum role, defaulting to viewer. */
  readonly role?: AppRole;
}

/**
 * Read guard: the role floor plus at least one visible view.
 *
 * `role` exists for observability/admin surfaces, which need `admin` *and*
 * still respect visibility where a manifest view backs them.
 */
export function requireFeatureRead(options: FeatureReadOptions): RequestHandler {
  const { views, role = "viewer" } = options;
  return (_request, response, next) => {
    try {
      const identity = identityOf(response.locals);
      if (!identity || !hasRole(identity, role)) {
        next(new HttpError(403, "insufficient_role", `The ${role} role is required`));
        return;
      }
      if (isAdmin(identity)) {
        next();
        return;
      }
      const visible = views.some((view) => isViewVisible(identity, view));
      if (!visible) {
        next(
          new HttpError(403, "feature_hidden", "This feature is not visible to your account")
        );
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export interface FeatureWriteOptions {
  /**
   * All-of: a write touches this data, so every view that owns it must grant
   * the edit. Writes are single-view in practice; the array keeps shared
   * surfaces honest rather than letting one lenient row unlock another view.
   */
  readonly views: readonly ViewId[];
  readonly role?: AppRole;
}

/** Write guard: operator floor plus an explicit `canEdit: true` on every view. */
export function requireFeatureWrite(options: FeatureWriteOptions): RequestHandler {
  const { views, role = "operator" } = options;
  return (_request, response, next) => {
    try {
      const identity = identityOf(response.locals);
      if (!identity || !hasRole(identity, role)) {
        next(new HttpError(403, "insufficient_role", `The ${role} role is required`));
        return;
      }
      if (isAdmin(identity)) {
        next();
        return;
      }
      const denied = views.filter((view) => !canEditView(identity, view));
      if (denied.length > 0) {
        next(
          new HttpError(
            403,
            "feature_read_only",
            "This feature is read-only for your account"
          )
        );
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
