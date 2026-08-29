/**
 * Administration — app-local user roles and the audit trail.
 *
 * Both halves are strictly server-driven: the user list, the role write and the
 * audit page all come from `/api/admin/*`, and every failure is rendered rather
 * than swallowed. Nothing here decides access from an email address; the server
 * enforces the admin role and this page only shows what it returns.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  MenuItem,
  Select,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import {
  ExpandLess as CollapseIcon,
  ExpandMore as ExpandIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import PageHero from './components/PageHero';
import SectionLabel from './components/SectionLabel';
import { DegradedBanner, EmptyState, ErrorState, LoadingState } from './components/StateBlocks';
import { useThemeMode } from './context/ThemeContext';
import { useUserPermissions } from './context/UserPermissionsContext';
import { tokensFor } from './theme/tokens';
import { CARD_HOVER_SX, CARD_RADIUS, pageShellSx, toggleGroupSx } from './theme/controls';
import { withAlpha } from './theme/contrast';
import { errorMessage } from './services/apiClient';
import {
  listAudit,
  listUsers,
  updateUserFeaturePermission,
  updateUserRoles,
  type AuditEvent,
} from './services/admin';
import {
  APP_ROLES,
  identityLabel,
  roleBlurb,
  roleLabel,
  type AppIdentity,
  type AppRole,
  type FeaturePermission,
} from './services/identity';
import { PRODUCTION_VIEWS, type ProductionView } from './types/AppView';
import { routeForView } from './app/navigation';

type AdminTab = 'users' | 'audit';

const AUDIT_PAGE = 100;

/** The single role a row is edited as. Roles are cumulative, so the highest wins. */
function primaryRole(roles: readonly AppRole[]): AppRole | '' {
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('operator')) return 'operator';
  if (roles.includes('viewer')) return 'viewer';
  return '';
}

/**
 * Hearth's default for a view with no stored row: visible and read-only.
 *
 * The editor shows that default rather than inventing a row, so "never
 * configured" stays distinguishable from "explicitly denied" — the two look the
 * same to the fence, but only one of them is a decision someone made.
 */
const HEARTH_DEFAULT: FeaturePermission = { canEdit: false, isHidden: false };

const viewLabel = (view: ProductionView): string => routeForView(view)?.label ?? view;

const timestamp = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const CATEGORY_TONE: Record<AuditEvent['category'], string> = {
  auth: '#4A7A9B',
  navigation: '#7A8A9B',
  change: '#C4A040',
  admin: '#B05945',
  system: '#4F7A3E',
};

function UsersPanel() {
  const { mode, palette } = useThemeMode();
  const { identity: me, refreshPermissions } = useUserPermissions();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  const [users, setUsers] = useState<readonly AppIdentity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { users: next } = await listUsers();
      setUsers(next);
      setError(null);
    } catch (caught) {
      setUsers(null);
      setError(errorMessage(caught, 'Could not load Watchtower users.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changeRole = useCallback(
    async (user: AppIdentity, role: AppRole) => {
      const key = `${user.tenantId}/${user.oid}`;
      setSavingKey(key);
      setSaveError(null);
      try {
        // Roles are cumulative on the server, so the selection is expanded into
        // the full ladder rather than sent as a single name.
        const roles: AppRole[] =
          role === 'admin'
            ? ['viewer', 'operator', 'admin']
            : role === 'operator'
              ? ['viewer', 'operator']
              : ['viewer'];
        const { identity } = await updateUserRoles(user.tenantId, user.oid, roles);
        setUsers((current) =>
          (current ?? []).map((u) =>
            u.tenantId === identity.tenantId && u.oid === identity.oid ? identity : u,
          ),
        );
        // Changing your own roles changes what the shell may show you.
        if (me && me.tenantId === identity.tenantId && me.oid === identity.oid) {
          await refreshPermissions();
        }
      } catch (caught) {
        setSaveError(errorMessage(caught, 'Role update was rejected.'));
      } finally {
        setSavingKey(null);
      }
    },
    [me, refreshPermissions],
  );

  const changeFeature = useCallback(
    async (user: AppIdentity, feature: ProductionView, next: FeaturePermission) => {
      const key = `${user.tenantId}/${user.oid}/${feature}`;
      setSavingKey(key);
      setSaveError(null);
      try {
        const { identity } = await updateUserFeaturePermission(
          user.tenantId,
          user.oid,
          feature,
          next,
        );
        setUsers((current) =>
          (current ?? []).map((u) =>
            u.tenantId === identity.tenantId && u.oid === identity.oid ? identity : u,
          ),
        );
        if (me && me.tenantId === identity.tenantId && me.oid === identity.oid) {
          await refreshPermissions();
        }
      } catch (caught) {
        setSaveError(errorMessage(caught, 'Per-view permission was rejected.'));
      } finally {
        setSavingKey(null);
      }
    },
    [me, refreshPermissions],
  );

  if (loading && !users) return <LoadingState label="Loading users…" />;
  if (error) return <ErrorState title="Users unavailable" detail={error} onRetry={() => void load()} />;
  if (!users?.length) {
    return (
      <EmptyState
        title="No identities recorded yet"
        detail="A user appears here the first time they sign in to Watchtower."
      />
    );
  }

  return (
    <Box>
      {saveError && <DegradedBanner title="Change not saved" detail={saveError} />}
      <SectionLabel
        tone="soft"
        action={
          <Typography sx={{ fontSize: '0.75rem', color: t.muted }}>
            {users.length} {users.length === 1 ? 'identity' : 'identities'}
          </Typography>
        }
      >
        App-local roles
      </SectionLabel>

      <Box sx={{ display: 'grid', gap: 1.25 }}>
        {users.map((user) => {
          const key = `${user.tenantId}/${user.oid}`;
          const current = primaryRole(user.roles);
          const saving = savingKey === key;
          const isSelf = me?.tenantId === user.tenantId && me?.oid === user.oid;
          const overrides = PRODUCTION_VIEWS.filter((view) => user.featurePermissions[view]);
          const hiddenCount = overrides.filter(
            (view) => user.featurePermissions[view]?.isHidden,
          ).length;
          const open = expanded === key;
          const isAdministrator = user.roles.includes('admin');
          return (
            <Box
              key={key}
              sx={{
                p: 2,
                borderRadius: CARD_RADIUS,
                bgcolor: t.paper,
                border: `1px solid ${t.line}`,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 1.5,
                ...CARD_HOVER_SX,
              }}
            >
              <Box sx={{ minWidth: 200, flex: 1 }}>
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.92rem' }}>
                  {identityLabel(user)}
                  {isSelf && (
                    <Chip
                      label="You"
                      size="small"
                      sx={{ ml: 1, height: 18, fontSize: '0.65rem', bgcolor: withAlpha(t.rust, 0.18) }}
                    />
                  )}
                </Typography>
                <Typography sx={{ fontSize: '0.75rem', color: t.muted, wordBreak: 'break-all' }}>
                  {user.email ?? user.oid}
                </Typography>
                <Typography sx={{ fontSize: '0.7rem', color: t.muted, mt: 0.25 }}>
                  Last seen {timestamp(user.lastSeenAt)}
                </Typography>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {saving && <CircularProgress size={16} sx={{ color: t.rust }} />}
                <Select
                  size="small"
                  value={current}
                  disabled={saving}
                  displayEmpty
                  aria-label={`Role for ${identityLabel(user)}`}
                  onChange={(event: SelectChangeEvent<string>) =>
                    void changeRole(user, event.target.value as AppRole)
                  }
                  sx={{ minWidth: 168, bgcolor: t.surface }}
                >
                  <MenuItem value="" disabled>
                    No role
                  </MenuItem>
                  {APP_ROLES.map((role) => (
                    <MenuItem key={role} value={role}>
                      {roleLabel[role]}
                    </MenuItem>
                  ))}
                </Select>
                <Button
                  size="small"
                  onClick={() => setExpanded(open ? null : key)}
                  endIcon={open ? <CollapseIcon /> : <ExpandIcon />}
                  aria-expanded={open}
                  sx={{ color: t.muted, fontWeight: 600, whiteSpace: 'nowrap' }}
                >
                  {overrides.length
                    ? `${overrides.length} view ${overrides.length === 1 ? 'rule' : 'rules'}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}`
                    : 'Per-view access'}
                </Button>
              </Box>

              <Collapse in={open} sx={{ width: '100%' }} unmountOnExit>
                <Box sx={{ pt: 1.5, mt: 1.5, borderTop: `1px solid ${t.line}` }}>
                  <Typography sx={{ fontSize: '0.78rem', color: t.muted, mb: 1.5, maxWidth: 640 }}>
                    {isAdministrator
                      ? 'Administrators bypass every per-view rule, so these switches have no effect until the role is lowered.'
                      : 'Carried over from the imported Hearth permissions. An edit needs both the operator role and Can edit switched on here — a view left unset stays read-only.'}
                  </Typography>
                  <Box sx={{ display: 'grid', gap: 0.25 }}>
                    {PRODUCTION_VIEWS.map((view) => {
                      const row = user.featurePermissions[view];
                      const effective = row ?? HEARTH_DEFAULT;
                      const busy = savingKey === `${key}/${view}`;
                      return (
                        <Box
                          key={view}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            flexWrap: 'wrap',
                            px: 1,
                            py: 0.5,
                            borderRadius: '8px',
                            bgcolor: row ? withAlpha(t.rust, isDark ? 0.1 : 0.06) : 'transparent',
                          }}
                        >
                          <Typography
                            sx={{ fontSize: '0.82rem', color: t.ink, flex: 1, minWidth: 160 }}
                          >
                            {viewLabel(view)}
                            {!row && (
                              <Box
                                component="span"
                                sx={{ color: t.muted, fontSize: '0.72rem', ml: 0.75 }}
                              >
                                no rule · read-only
                              </Box>
                            )}
                          </Typography>
                          {busy && <CircularProgress size={14} sx={{ color: t.rust }} />}
                          <Tooltip title="Allow this user to change records in this view">
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>
                                Can edit
                              </Typography>
                              <Switch
                                size="small"
                                checked={effective.canEdit}
                                disabled={busy}
                                inputProps={{
                                  'aria-label': `Allow ${identityLabel(user)} to edit ${viewLabel(view)}`,
                                }}
                                onChange={(event) =>
                                  void changeFeature(user, view, {
                                    canEdit: event.target.checked,
                                    isHidden: effective.isHidden,
                                  })
                                }
                              />
                            </Box>
                          </Tooltip>
                          <Tooltip title="Remove this view from the user's navigation entirely">
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>
                                Hidden
                              </Typography>
                              <Switch
                                size="small"
                                checked={effective.isHidden}
                                disabled={busy}
                                inputProps={{
                                  'aria-label': `Hide ${viewLabel(view)} from ${identityLabel(user)}`,
                                }}
                                onChange={(event) =>
                                  void changeFeature(user, view, {
                                    canEdit: effective.canEdit,
                                    isHidden: event.target.checked,
                                  })
                                }
                              />
                            </Box>
                          </Tooltip>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              </Collapse>
            </Box>
          );
        })}
      </Box>

      <Box sx={{ mt: 3 }}>
        <SectionLabel tone="soft">What each role allows</SectionLabel>
        <Box sx={{ display: 'grid', gap: 0.75 }}>
          {APP_ROLES.map((role) => (
            <Box key={role} sx={{ display: 'flex', gap: 1.25, alignItems: 'baseline' }}>
              <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.82rem', minWidth: 108 }}>
                {roleLabel[role]}
              </Typography>
              <Typography sx={{ color: t.muted, fontSize: '0.82rem' }}>{roleBlurb[role]}</Typography>
            </Box>
          ))}
        </Box>
        <Typography sx={{ color: t.muted, fontSize: '0.82rem', mt: 1.25, maxWidth: 640 }}>
          The operator role is a ceiling, not a grant: below it nothing can be changed, and above it
          each view still has to be granted individually. A view with no rule stays read-only.
          Administrators bypass all of it.
        </Typography>
      </Box>
    </Box>
  );
}

function AuditPanel() {
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { events: next } = await listAudit({ limit: AUDIT_PAGE });
      setEvents([...next]);
      setExhausted(next.length < AUDIT_PAGE);
      setError(null);
    } catch (caught) {
      setEvents([]);
      setError(errorMessage(caught, 'Could not load the audit trail.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    const oldest = events.at(-1);
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const { events: next } = await listAudit({ limit: AUDIT_PAGE, beforeId: oldest.id });
      setEvents((current) => [...current, ...next]);
      setExhausted(next.length < AUDIT_PAGE);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not load more audit entries.'));
    } finally {
      setLoadingMore(false);
    }
  }, [events]);

  if (loading && !events.length && !error) return <LoadingState label="Loading audit trail…" />;
  if (error && !events.length) {
    return <ErrorState title="Audit trail unavailable" detail={error} onRetry={() => void load()} />;
  }
  if (!events.length) {
    return (
      <EmptyState
        title="No audit entries yet"
        detail="Sign-ins, role changes and infrastructure edits are recorded here as they happen."
      />
    );
  }

  return (
    <Box>
      {error && <DegradedBanner title="Showing entries already loaded" detail={error} />}
      <SectionLabel
        tone="soft"
        action={
          <Typography sx={{ fontSize: '0.75rem', color: t.muted }}>{events.length} entries</Typography>
        }
      >
        Audit trail
      </SectionLabel>

      <Box sx={{ display: 'grid', gap: 0.5 }}>
        {events.map((event) => {
          const tone = CATEGORY_TONE[event.category];
          return (
            <Box
              key={event.id}
              sx={{
                p: 1.5,
                borderRadius: CARD_RADIUS,
                bgcolor: t.paper,
                border: `1px solid ${t.line}`,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1,
                alignItems: 'baseline',
              }}
            >
              <Typography
                sx={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.72rem',
                  color: t.muted,
                  minWidth: 168,
                }}
              >
                {timestamp(event.occurredAt)}
              </Typography>
              <Chip
                label={event.category}
                size="small"
                sx={{
                  height: 20,
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  bgcolor: withAlpha(tone, isDark ? 0.24 : 0.16),
                  color: t.ink,
                }}
              />
              <Typography sx={{ fontWeight: 600, color: t.ink, fontSize: '0.85rem', minWidth: 0 }}>
                {event.action}
              </Typography>
              <Typography sx={{ fontSize: '0.78rem', color: t.muted, minWidth: 0 }}>
                {event.nameSnapshot ?? event.emailSnapshot ?? event.userOid ?? 'system'}
              </Typography>
              {event.detail && (
                <Typography
                  sx={{ fontSize: '0.75rem', color: t.muted, width: '100%', wordBreak: 'break-word' }}
                >
                  {event.detail}
                </Typography>
              )}
              {!event.verified && (
                <Chip
                  label="unverified"
                  size="small"
                  sx={{ height: 20, fontSize: '0.65rem', bgcolor: withAlpha('#C4A040', 0.24) }}
                />
              )}
            </Box>
          );
        })}
      </Box>

      {!exhausted && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={loadingMore} variant="outlined">
            {loadingMore ? 'Loading…' : 'Load older entries'}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default function Admin() {
  const { mode, palette } = useThemeMode();
  const t = tokensFor(mode === 'dark', palette);
  const [tab, setTab] = useState<AdminTab>('users');
  const [reloadNonce, setReloadNonce] = useState(0);

  const panel = useMemo(
    () => (tab === 'users' ? <UsersPanel key={`users-${reloadNonce}`} /> : <AuditPanel key={`audit-${reloadNonce}`} />),
    [tab, reloadNonce],
  );

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        compact
        eyebrow="Watchtower"
        title="Administration"
        accentPhrase="Administration"
        subtitle="App-local roles and the record of everything that changed. Authorization is decided here, never by an email address."
        actions={
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            Refresh
          </Button>
        }
      />

      <ToggleButtonGroup
        exclusive
        value={tab}
        onChange={(_event, next: AdminTab | null) => next && setTab(next)}
        aria-label="Administration section"
        sx={{ ...toggleGroupSx(t), mb: 2 }}
      >
        <ToggleButton value="users">Users &amp; roles</ToggleButton>
        <ToggleButton value="audit">Audit trail</ToggleButton>
      </ToggleButtonGroup>

      <Divider sx={{ borderColor: t.line, mb: 2 }} />
      {panel}
    </Box>
  );
}
