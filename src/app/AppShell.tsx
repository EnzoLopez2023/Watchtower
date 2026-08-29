/**
 * The Watchtower shell.
 *
 * A fixed navigation rail at `lg` and above; a compact top bar with a temporary
 * drawer below it. Both are driven by the same NAV_ROUTES table, so a route can
 * never appear in one and not the other.
 *
 * The shell also owns the three pieces of chrome every page depends on: the
 * per-page theme view (so appearance settings resolve), the write fence banner,
 * and the degraded-identity banner.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  DarkModeOutlined as DarkIcon,
  LightModeOutlined as LightIcon,
  Logout as LogoutIcon,
  Menu as MenuIcon,
} from '@mui/icons-material';
import { useMsal } from '@azure/msal-react';
import { useThemeMode } from '../context/ThemeContext';
import { setCurrentView } from '../theme/appearance';
import { OPERATOR_FEATURES, useUserPermissions } from '../context/UserPermissionsContext';
import { tokensFor } from '../theme/tokens';
import {
  CARD_RADIUS,
  PAGE_GUTTER,
  SIDEBAR_RESERVE,
  SIDEBAR_WIDTH,
  cardShadow,
  pageShellSx,
} from '../theme/controls';
import { withAlpha } from '../theme/contrast';
import { DegradedBanner, ErrorState, LoadingState } from '../components/StateBlocks';
import ReadOnlyNotice from '../components/ReadOnlyNotice';
import { identityLabel } from '../services/identity';
import {
  GROUP_LABELS,
  GROUP_ORDER,
  NAV_ROUTES,
  routeForPath,
  routesInGroup,
  type NavRoute,
} from './navigation';

const OPERATOR_SET = new Set(OPERATOR_FEATURES);

function NavList({
  onNavigate,
  currentPath,
}: {
  onNavigate: () => void;
  currentPath: string;
}) {
  const { mode, palette } = useThemeMode();
  const { isAdmin, isHidden } = useUserPermissions();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  // A view hidden by an imported Hearth permission row is removed from the
  // navigation entirely, which is what the monolith's `is_hidden` did.
  const visible = useMemo(
    () => NAV_ROUTES.filter((route) => (!route.adminOnly || isAdmin) && !isHidden(route.view)),
    [isAdmin, isHidden],
  );
  const visibleSet = useMemo(() => new Set(visible.map((r) => r.view)), [visible]);

  return (
    <Box component="nav" aria-label="Watchtower sections" sx={{ display: 'grid', gap: 2 }}>
      {GROUP_ORDER.map((group) => {
        const items = routesInGroup(group).filter((r) => visibleSet.has(r.view));
        if (!items.length) return null;
        return (
          <Box key={group} component="section">
            <Typography
              component="h2"
              sx={{
                fontSize: '0.62rem',
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: t.muted,
                px: 1.25,
                mb: 0.75,
              }}
            >
              {GROUP_LABELS[group]}
            </Typography>
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: 0.25 }}>
              {items.map((route) => (
                <Box component="li" key={route.view}>
                  <NavItem route={route} onNavigate={onNavigate} currentPath={currentPath} />
                </Box>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function NavItem({
  route,
  onNavigate,
  currentPath,
}: {
  route: NavRoute;
  onNavigate: () => void;
  currentPath: string;
}) {
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);
  const Icon = route.icon;
  const active = currentPath === route.path;

  return (
    <Box
      component={NavLink}
      to={route.path}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.25,
        py: 0.85,
        borderRadius: '10px',
        textDecoration: 'none',
        color: active ? t.ink : t.inkSoft,
        fontWeight: active ? 800 : 600,
        fontSize: '0.85rem',
        bgcolor: active ? withAlpha(t.rust, isDark ? 0.22 : 0.16) : 'transparent',
        // A left rule marks the active item without relying on colour alone.
        boxShadow: active ? `inset 3px 0 0 ${t.rust}` : 'none',
        transition: 'background-color 140ms ease, color 140ms ease',
        '&:hover': { bgcolor: withAlpha(t.rust, isDark ? 0.14 : 0.09), color: t.ink },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Icon aria-hidden sx={{ fontSize: '1.05rem', color: active ? t.rust : t.muted, flexShrink: 0 }} />
      <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {route.label}
      </Box>
    </Box>
  );
}

function ModeToggle() {
  const { mode, toggleMode } = useThemeMode();
  const isDark = mode === 'dark';
  return (
    <Tooltip title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
      <IconButton
        size="small"
        onClick={toggleMode}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <LightIcon fontSize="small" /> : <DarkIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
}

function AccountBlock() {
  const { instance } = useMsal();
  const { identity } = useUserPermissions();
  const { mode, palette } = useThemeMode();
  const t = tokensFor(mode === 'dark', palette);

  const signOut = useCallback(() => {
    void instance.logoutRedirect();
  }, [instance]);

  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      {identity && (
        <Box sx={{ minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: '0.8rem',
              fontWeight: 700,
              color: t.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {identityLabel(identity)}
          </Typography>
          <Typography sx={{ fontSize: '0.7rem', color: t.muted }}>
            {identity.roles.length ? identity.roles.join(' · ') : 'No roles assigned'}
          </Typography>
        </Box>
      )}
      <Button
        size="small"
        onClick={signOut}
        startIcon={<LogoutIcon />}
        sx={{ justifyContent: 'flex-start', color: t.muted, fontWeight: 600 }}
      >
        Sign out
      </Button>
    </Box>
  );
}

export default function AppShell() {
  const location = useLocation();
  const { mode, palette, setView, syncError } = useThemeMode();
  const { canEdit, error: identityError, isHidden, isLoaded, readOnlyReason, roles } =
    useUserPermissions();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);
  const wide = useMediaQuery('(min-width:1200px)');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const route = routeForPath(location.pathname);
  const view = route?.view ?? null;

  // Published during render, not in an effect: `tokensFor` is a plain function
  // the pages call while rendering, so the view has to be current *before* the
  // Outlet renders or the first paint of every route uses the previous page's
  // palette. The provider's own state follows via the effect below, which is
  // what rebuilds the MUI theme.
  setCurrentView(view);

  useEffect(() => {
    setView(view);
  }, [setView, view]);

  useEffect(() => {
    document.title = route ? `${route.short} · Watchtower` : 'Watchtower';
  }, [route]);

  // A route change should not leave the drawer covering the page it opened.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const readOnly = view !== null && OPERATOR_SET.has(view) && !canEdit(view);
  // An operator who still cannot edit is being held back by the per-view grant,
  // not by a missing role — a different problem with a different fix.
  const fenceReason = view === null ? 'role' : (readOnlyReason(view) ?? 'role');
  // Enforced here rather than inside each page so a hidden view never mounts,
  // and therefore never fires the requests the server would reject anyway.
  const hiddenHere = view !== null && isHidden(view);

  const railContent = (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        height: '100%',
        minHeight: 0,
        p: 1.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="p"
            sx={{
              fontSize: '0.6rem',
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: t.rust,
              fontWeight: 800,
            }}
          >
            Watchtower
          </Typography>
          <Typography sx={{ fontSize: '0.7rem', color: t.muted }}>Infrastructure operations</Typography>
        </Box>
        <ModeToggle />
      </Box>
      <Divider sx={{ borderColor: t.line }} />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <NavList onNavigate={closeDrawer} currentPath={location.pathname} />
      </Box>
      <Divider sx={{ borderColor: t.line }} />
      <AccountBlock />
    </Box>
  );

  return (
    <Box sx={{ minHeight: '100vh' }}>
      <Box
        component="a"
        href="#watchtower-main"
        sx={{
          position: 'absolute',
          left: -9999,
          top: 0,
          zIndex: 2000,
          p: 1.5,
          bgcolor: t.paper,
          color: t.ink,
          borderRadius: CARD_RADIUS,
          '&:focus': { left: 8, top: 8 },
        }}
      >
        Skip to content
      </Box>

      {wide ? (
        <Box
          component="aside"
          sx={{
            position: 'fixed',
            top: PAGE_GUTTER,
            left: PAGE_GUTTER,
            bottom: PAGE_GUTTER,
            width: SIDEBAR_WIDTH,
            zIndex: 1100,
            bgcolor: t.paper,
            border: `1px solid ${t.line}`,
            borderRadius: '22px',
            boxShadow: cardShadow(isDark),
            overflow: 'hidden',
          }}
        >
          {railContent}
        </Box>
      ) : (
        <>
          <Box
            component="header"
            sx={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 1100,
              height: 54,
              px: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              bgcolor: t.paper,
              borderBottom: `1px solid ${t.line}`,
            }}
          >
            <IconButton
              size="small"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
            >
              <MenuIcon />
            </IconButton>
            <Typography sx={{ fontWeight: 800, fontSize: '0.9rem', color: t.ink, minWidth: 0 }}>
              {route?.label ?? 'Watchtower'}
            </Typography>
            <Box sx={{ ml: 'auto' }}>
              <ModeToggle />
            </Box>
          </Box>
          <Drawer
            open={drawerOpen}
            onClose={closeDrawer}
            slotProps={{ paper: { sx: { width: SIDEBAR_WIDTH + 40, bgcolor: t.paper } } }}
          >
            {railContent}
          </Drawer>
        </>
      )}

      <Box
        sx={{
          pl: { xs: 0, lg: `${SIDEBAR_RESERVE}px` },
          minHeight: '100vh',
        }}
      >
        {identityError && (
          <Box sx={{ px: { xs: 2, lg: 2 }, pt: { xs: '62px', lg: 2 } }}>
            <DegradedBanner
              title="Roles unavailable"
              detail={`${identityError} Every write is blocked until your profile loads.`}
            />
          </Box>
        )}
        {isLoaded && !identityError && roles.length === 0 && (
          <Box sx={{ px: 2, pt: { xs: '62px', lg: 2 } }}>
            <DegradedBanner
              title="No roles assigned"
              detail="Your account is signed in but has no Watchtower role yet. Ask an administrator to grant one."
            />
          </Box>
        )}
        {syncError && (
          <Box sx={{ px: 2, pt: 1 }}>
            <DegradedBanner title="Appearance not synced" detail={syncError} />
          </Box>
        )}
        {readOnly && route && <ReadOnlyNotice label={route.label} reason={fenceReason} />}

        <Box component="main" id="watchtower-main" tabIndex={-1} sx={{ outline: 'none' }}>
          {hiddenHere && route ? (
            <Box sx={pageShellSx()}>
              <ErrorState
                title={`${route.label} is not available to you`}
                detail="An administrator has hidden this view for your account. Ask them to restore it if you need access."
              />
            </Box>
          ) : (
            <Suspense fallback={<LoadingState label="Loading view…" />}>
              <Outlet />
            </Suspense>
          )}
        </Box>
      </Box>
    </Box>
  );
}
