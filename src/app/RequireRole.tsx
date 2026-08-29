/**
 * Route-level role fence.
 *
 * The admin routes are gated here rather than inside the page, so an
 * unauthorised visitor never renders the page's fetches at all. It fails closed:
 * while roles are still loading, and whenever they failed to load, the page is
 * not shown.
 */

import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { useUserPermissions } from '../context/UserPermissionsContext';
import { hasRole, type AppRole } from '../services/identity';
import { ErrorState, LoadingState } from '../components/StateBlocks';
import { pageShellSx } from '../theme/controls';

export default function RequireRole({
  role,
  children,
}: {
  role: AppRole;
  children: ReactNode;
}) {
  const { roles, isLoaded, error, refreshPermissions } = useUserPermissions();

  if (!isLoaded) return <LoadingState label="Checking your access…" />;

  if (error) {
    return (
      <Box sx={pageShellSx()}>
        <ErrorState
          title="Access could not be verified"
          detail={error}
          onRetry={() => void refreshPermissions()}
        />
      </Box>
    );
  }

  if (!hasRole(roles, role)) {
    return (
      <Box sx={pageShellSx()}>
        <ErrorState
          title="You do not have access to this page"
          detail={`This view requires the ${role} role. Your account currently holds: ${
            roles.length ? roles.join(', ') : 'no roles'
          }.`}
        />
      </Box>
    );
  }

  return <>{children}</>;
}
