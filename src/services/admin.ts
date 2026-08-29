/** Admin surface: app-local user roles and the audit trail. */

import { apiGet, apiPut } from './apiClient';
import type { ProductionView } from '../types/AppView';
import type { AppIdentity, AppRole, FeaturePermission } from './identity';

export interface AdminUsersResponse {
  readonly users: readonly AppIdentity[];
}

export interface UpdateRolesResponse {
  readonly identity: AppIdentity;
}

export type AuditCategory = 'auth' | 'navigation' | 'change' | 'admin' | 'system';

export interface AuditEvent {
  readonly id: number;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly tenantId?: string;
  readonly userOid?: string;
  readonly emailSnapshot?: string;
  readonly nameSnapshot?: string;
  readonly verified: boolean;
  readonly category: AuditCategory;
  readonly action: string;
  readonly view?: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly ip?: string;
}

export interface AuditResponse {
  readonly events: readonly AuditEvent[];
}

export const listUsers = (signal?: AbortSignal): Promise<AdminUsersResponse> =>
  apiGet<AdminUsersResponse>('/api/admin/users', signal ? { signal } : undefined);

export const updateUserRoles = (
  tenantId: string,
  oid: string,
  roles: readonly AppRole[],
): Promise<UpdateRolesResponse> =>
  apiPut<UpdateRolesResponse>(
    `/api/admin/users/${encodeURIComponent(tenantId)}/${encodeURIComponent(oid)}/roles`,
    { roles },
  );

/**
 * Set one per-view permission row.
 *
 * `feature` is the production view id, which is what the imported Hearth rows
 * are keyed by and what the server validates against its own manifest set.
 */
export const updateUserFeaturePermission = (
  tenantId: string,
  oid: string,
  feature: ProductionView,
  permission: FeaturePermission,
): Promise<UpdateRolesResponse> =>
  apiPut<UpdateRolesResponse>(
    `/api/admin/users/${encodeURIComponent(tenantId)}/${encodeURIComponent(oid)}/features/${encodeURIComponent(feature)}`,
    { canEdit: permission.canEdit, isHidden: permission.isHidden },
  );

export function listAudit(
  options: { limit?: number; beforeId?: number } = {},
  signal?: AbortSignal,
): Promise<AuditResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.beforeId !== undefined) params.set('beforeId', String(options.beforeId));
  return apiGet<AuditResponse>(
    `/api/admin/audit?${params.toString()}`,
    signal ? { signal } : undefined,
  );
}
