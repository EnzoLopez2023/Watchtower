/**
 * Where `/` lands.
 *
 * Normally System Status. But an imported Hearth permission row can hide that
 * view for an account, and redirecting someone straight into a page they are
 * not allowed to see is a dead landing — so the first view they can actually
 * open wins instead.
 */

import { Navigate } from 'react-router-dom';
import { Box } from '@mui/material';
import { useUserPermissions } from '../context/UserPermissionsContext';
import { EmptyState, LoadingState } from '../components/StateBlocks';
import { pageShellSx } from '../theme/controls';
import { DEFAULT_PATH, NAV_ROUTES, routeForPath } from './navigation';

export default function RootRedirect() {
  const { isAdmin, isHidden, isLoaded } = useUserPermissions();

  // Redirecting before permissions land would race the hidden-view check.
  if (!isLoaded) return <LoadingState label="Opening Watchtower…" />;

  const preferred = routeForPath(DEFAULT_PATH);
  const target =
    preferred && !isHidden(preferred.view)
      ? preferred
      : NAV_ROUTES.find(
          (route) => (!route.adminOnly || isAdmin) && route.view !== 'settings' && !isHidden(route.view),
        );

  if (target) return <Navigate to={target.path} replace />;

  // Everything operational is hidden. Settings is app-local and always
  // reachable, so say so rather than bouncing between blocked routes.
  return (
    <Box sx={pageShellSx()}>
      <EmptyState
        title="No operations views are available to you"
        detail="Every Watchtower view has been hidden for your account. Ask an administrator to restore access."
      />
    </Box>
  );
}
