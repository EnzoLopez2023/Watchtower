/**
 * App-local identity.
 *
 * Authorization is never derived from an email address or any other Entra
 * claim. The server owns the mapping from a verified token to app-local roles
 * and per-view permissions and returns both from `/api/me`; the client only
 * reads them.
 *
 * The decision *rules* live in `./permissions`, which stays free of the API
 * client so they can be tested directly. They are re-exported here because most
 * callers want the identity and the rules together.
 */

import { apiGet } from './apiClient';
import type { ProductionView } from '../types/AppView';
import type { AppRole, FeaturePermission, FeaturePermissionMap } from './permissions';

export type {
  AppRole,
  FeaturePermission,
  FeaturePermissionMap,
  PermissionSubject,
} from './permissions';
export {
  APP_ROLES,
  isAppRole,
  hasRole,
  roleBlurb,
  roleLabel,
  canEditView,
  canViewView,
  isViewHidden,
  readOnlyReason,
} from './permissions';

export interface AppIdentity {
  readonly tenantId: string;
  readonly oid: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly roles: readonly AppRole[];
  readonly featurePermissions: FeaturePermissionMap;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface MeResponse {
  readonly identity: AppIdentity;
}

/**
 * The signed-in identity with its app-local roles and per-view permissions.
 * Throws ApiError on failure — a failed load is never treated as permission.
 */
export const fetchIdentity = (signal?: AbortSignal): Promise<MeResponse> =>
  apiGet<MeResponse>('/api/me', signal ? { signal } : undefined);

/** The display name to show for an identity, without inventing one. */
export const identityLabel = (identity: Pick<AppIdentity, 'displayName' | 'email' | 'oid'>): string =>
  identity.displayName || identity.email || identity.oid;

/**
 * The imported permission row for a view, or `undefined` when Hearth never
 * stored one.
 *
 * The distinction matters: an absent row means Hearth's default — visible and
 * read-only — whereas a present row with `canEdit: false` is an explicit
 * decision. Neither grants anything; only `canEdit: true` does.
 */
export const permissionFor = (
  identity: Pick<AppIdentity, 'featurePermissions'> | null,
  view: ProductionView,
): FeaturePermission | undefined => identity?.featurePermissions[view];
