/**
 * The app-local authorization decision, as pure functions.
 *
 * Kept free of React, MSAL and the API client on purpose: this is the rule set
 * the whole UI fences on, so it has to be directly executable by a test rather
 * than only reachable through a provider and a network round trip.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * Two independent inputs, both owned by the server and delivered by `/api/me`
 * (and, for the admin screen, by `/api/admin/users`) — never an email address,
 * a tenant claim or a hard-coded list:
 *
 *   * **Roles** — `viewer` / `operator` / `admin`.
 *   * **`featurePermissions`** — the Hearth per-view `canEdit` / `isHidden`
 *     rows carried across by the import, keyed by production view id.
 *
 * Resolution, highest precedence first:
 *
 *   1. `admin` bypasses everything: edits every view, sees every view.
 *   2. A hidden view denies edits regardless of any other flag.
 *   3. `operator` is a **ceiling, never a grant**. Below it nothing writes.
 *   4. An edit needs an explicit `canEdit: true` row. An **absent row keeps
 *      Hearth's default, which is read-only** — a global operator role alone
 *      never opens Power Topology, IP Migration or Synology.
 */

// The explicit `.js` extension is deliberate and load-bearing. This module is
// the one piece of the client that the server-side test project loads directly,
// to prove the two rule sets agree; that project resolves with node16, which
// rejects an extensionless relative import. Vite and the app tsconfig both map
// `.js` back to this `.ts` source, so it costs nothing here. Do not "tidy" it
// to match the extensionless style of the rest of `src`.
import { isProductionView, type AppView, type ProductionView } from '../types/AppView.js';

export type AppRole = 'viewer' | 'operator' | 'admin';

export const APP_ROLES: readonly AppRole[] = ['viewer', 'operator', 'admin'] as const;

export const isAppRole = (value: string): value is AppRole =>
  (APP_ROLES as readonly string[]).includes(value);

const RANK: Record<AppRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** True when the roles satisfy `required` at or above its level. */
export function hasRole(roles: readonly AppRole[] | undefined, required: AppRole): boolean {
  if (!roles?.length) return false;
  const need = RANK[required];
  return roles.some((role) => RANK[role] >= need);
}

/**
 * One imported Hearth per-view permission row.
 *
 * `canEdit` is the view's read-only switch and `isHidden` removes it from the
 * app entirely — both exactly as the monolith's admin panel set them.
 */
export interface FeaturePermission {
  readonly canEdit: boolean;
  readonly isHidden: boolean;
}

/**
 * Keyed by production view id. Sparse on purpose: the import materialises only
 * the rows Hearth actually stored, and a missing key means "Hearth's default"
 * — visible, and read-only.
 */
export type FeaturePermissionMap = Readonly<Partial<Record<ProductionView, FeaturePermission>>>;

/** Just enough of an identity to decide anything. */
export interface PermissionSubject {
  readonly roles: readonly AppRole[];
  readonly featurePermissions: FeaturePermissionMap;
}

/** The subject used before `/api/me` has answered, and after it has failed. */
export const NO_ACCESS: PermissionSubject = { roles: [], featurePermissions: {} };

/**
 * Views that have write endpoints at all.
 *
 * Used for presentation — which pages are worth explaining a read-only state on
 * — not for the decision. `canEditView` requires an explicit grant regardless,
 * so adding a view here can never hand out an edit.
 */
export const OPERATOR_FEATURES: readonly AppView[] = [
  'power-topology',
  'ip-migration',
  'synology',
] as const;

/** Views only an administrator may open at all. */
export const ADMIN_FEATURES: readonly AppView[] = ['admin'] as const;

const WRITABLE = new Set<AppView>(OPERATOR_FEATURES);
const ADMIN_ONLY = new Set<AppView>(ADMIN_FEATURES);

/** True for features that expose edit affordances worth fencing. */
export const isManagedFeature = (feature: AppView): boolean => WRITABLE.has(feature);

/** The minimum role a feature's writes require. Not sufficient on its own. */
export const requiredRoleFor = (feature: AppView): AppRole =>
  ADMIN_ONLY.has(feature) ? 'admin' : 'operator';

/**
 * The stored row for a view, or `undefined` when the import never materialised
 * one. Only the eleven production views can carry a row — the app-local screens
 * never existed in the monolith.
 */
export function storedPermission(
  subject: PermissionSubject,
  view: AppView,
): FeaturePermission | undefined {
  return isProductionView(view) ? subject.featurePermissions[view] : undefined;
}

/** Hidden by an imported Hearth row. Administrators see everything. */
export function isViewHidden(subject: PermissionSubject, view: AppView): boolean {
  // An administrator is never hidden from anything — that is what keeps a
  // mistakenly hidden view recoverable.
  if (hasRole(subject.roles, 'admin')) return false;
  // An absent row means Hearth's default, which is visible.
  return storedPermission(subject, view)?.isHidden ?? false;
}

/**
 * Whether the subject may change records in a view.
 *
 * Fails closed at every step. Note the last line: the grant must be explicit,
 * so an operator with no row for Power Topology is read-only there.
 */
export function canEditView(subject: PermissionSubject, view: AppView): boolean {
  if (hasRole(subject.roles, 'admin')) return true;
  if (ADMIN_ONLY.has(view)) return false;
  if (isViewHidden(subject, view)) return false;
  // The ceiling: a `canEdit: true` row can never promote a viewer into a writer.
  if (!hasRole(subject.roles, 'operator')) return false;
  // The grant: an absent row keeps Hearth's read-only default. The operator
  // role by itself is not, and must never become, a licence to write.
  return storedPermission(subject, view)?.canEdit === true;
}

/** Whether the subject may open a view at all. */
export function canViewView(subject: PermissionSubject, view: AppView): boolean {
  if (hasRole(subject.roles, 'admin')) return true;
  if (ADMIN_ONLY.has(view)) return false;
  if (isViewHidden(subject, view)) return false;
  return subject.roles.length > 0;
}

/**
 * Why a writable view is read-only for this subject.
 *
 * `role` and `feature-rule` need different messages: one is fixed by granting a
 * role, the other by granting the view. `null` means the subject can write.
 */
export function readOnlyReason(
  subject: PermissionSubject,
  view: AppView,
): 'role' | 'feature-rule' | null {
  if (canEditView(subject, view)) return null;
  return hasRole(subject.roles, 'operator') ? 'feature-rule' : 'role';
}

export const roleLabel: Record<AppRole, string> = {
  viewer: 'Viewer',
  operator: 'Operator',
  admin: 'Administrator',
};

export const roleBlurb: Record<AppRole, string> = {
  viewer: 'Read-only access to every operations view.',
  operator: 'May change a view only where that view has been granted explicitly.',
  admin: 'Everything, plus user roles, per-view access and the audit trail.',
};
