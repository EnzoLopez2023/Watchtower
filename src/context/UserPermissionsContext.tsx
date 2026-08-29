/**
 * App-local permissions, bound to the signed-in identity.
 *
 * This module is only the React binding: it loads `/api/me`, holds the result,
 * and exposes the decision functions from `services/permissions` curried with
 * it. Every rule — admin bypass, hidden denies, the operator ceiling, and the
 * requirement that an edit be granted explicitly — lives there, so the fence
 * the UI applies is the same code the contract tests execute.
 *
 * A failed load is not treated as permission. It is surfaced through `error` so
 * the shell can show a degraded banner, and every fence stays closed.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useIsAuthenticated } from '@azure/msal-react';
import type { AppView } from '../types/AppView';
import { errorMessage } from '../services/apiClient';
import { fetchIdentity, type AppIdentity } from '../services/identity';
import {
  NO_ACCESS,
  canEditView,
  canViewView,
  hasRole,
  isViewHidden,
  readOnlyReason,
  storedPermission,
  type AppRole,
  type FeaturePermission,
  type PermissionSubject,
} from '../services/permissions';

export {
  ADMIN_FEATURES,
  OPERATOR_FEATURES,
  isManagedFeature,
  requiredRoleFor,
} from '../services/permissions';

export interface UserPermissionsContextValue {
  identity: AppIdentity | null;
  roles: readonly AppRole[];
  isAdmin: boolean;
  isOperator: boolean;
  /** True once the identity request has settled, successfully or not. */
  isLoaded: boolean;
  /** Non-null when `/api/me` failed. The app runs degraded, never elevated. */
  error: string | null;
  /**
   * Requires an explicit `canEdit: true` row *and* the operator ceiling. The
   * operator role on its own never grants a write.
   */
  canEdit: (feature: AppView) => boolean;
  /** Hidden by an imported Hearth permission row. Administrators see everything. */
  isHidden: (feature: AppView) => boolean;
  /** Not hidden, and permitted by role. */
  canView: (feature: AppView) => boolean;
  /** Why a writable view is read-only, or `null` when it is not. */
  readOnlyReason: (feature: AppView) => 'role' | 'feature-rule' | null;
  /** The stored row for a production view, when the import materialised one. */
  featurePermission: (feature: AppView) => FeaturePermission | undefined;
  refreshPermissions: () => Promise<void>;
}

const UserPermissionsContext = createContext<UserPermissionsContextValue>({
  identity: null,
  roles: [],
  isAdmin: false,
  isOperator: false,
  isLoaded: false,
  error: null,
  canEdit: () => false,
  isHidden: () => false,
  canView: () => false,
  readOnlyReason: () => 'role',
  featurePermission: () => undefined,
  refreshPermissions: async () => {},
});

export const useUserPermissions = () => useContext(UserPermissionsContext);

export function UserPermissionsProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const [identity, setIdentity] = useState<AppIdentity | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated) {
      setIdentity(null);
      setError(null);
      setIsLoaded(false);
      return;
    }
    try {
      const { identity: next } = await fetchIdentity();
      setIdentity(next);
      setError(null);
    } catch (caught) {
      setIdentity(null);
      setError(errorMessage(caught, 'Could not load your Watchtower profile.'));
    } finally {
      setIsLoaded(true);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo((): UserPermissionsContextValue => {
    // Before the profile arrives, and after it fails, the subject is empty —
    // which every rule below reads as "no access".
    const subject: PermissionSubject = identity
      ? { roles: identity.roles, featurePermissions: identity.featurePermissions }
      : NO_ACCESS;

    return {
      identity,
      roles: subject.roles,
      isAdmin: hasRole(subject.roles, 'admin'),
      isOperator: hasRole(subject.roles, 'operator'),
      isLoaded,
      error,
      canEdit: (feature: AppView) => canEditView(subject, feature),
      isHidden: (feature: AppView) => isViewHidden(subject, feature),
      canView: (feature: AppView) => canViewView(subject, feature),
      readOnlyReason: (feature: AppView) => readOnlyReason(subject, feature),
      featurePermission: (feature: AppView) => storedPermission(subject, feature),
      refreshPermissions: load,
    };
  }, [identity, isLoaded, error, load]);

  return (
    <UserPermissionsContext.Provider value={value}>{children}</UserPermissionsContext.Provider>
  );
}

/**
 * Whether the signed-in user may only look at a feature.
 *
 * The one call every page with edit affordances makes. Kept here rather than
 * open-coded as `!canEdit(x)` so that "still loading" is answered the same way
 * everywhere: a page is read-only until roles and per-view permissions have
 * actually arrived, so the fence fails closed rather than briefly offering
 * controls the server will reject.
 */
export function useReadOnly(feature: AppView): boolean {
  const { canEdit } = useUserPermissions();
  return !canEdit(feature);
}
