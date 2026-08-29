/**
 * The four states every data surface in Watchtower has to be able to show.
 *
 * Loading, empty, error and degraded are separate components rather than one
 * component with a `variant` prop because they are genuinely different
 * messages: "wait", "there is nothing", "this failed", "this is partly stale".
 * Collapsing them is how an app ends up rendering an empty list when a request
 * actually failed.
 *
 * None of them ever invent data or imply success.
 */

import type { ReactNode } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import {
  ErrorOutline as ErrorIcon,
  InboxOutlined as EmptyIcon,
  Refresh as RetryIcon,
  WarningAmberOutlined as DegradedIcon,
} from '@mui/icons-material';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { CARD_RADIUS } from '../theme/controls';
import { withAlpha } from '../theme/contrast';

function useTokens() {
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  return { t: tokensFor(isDark, palette), isDark };
}

export interface StateBlockProps {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}

/**
 * Busy state.
 *
 * `role="status"` plus `aria-live="polite"` so a screen reader announces the
 * wait once rather than on every re-render, and the spinner itself is hidden
 * from the accessibility tree because the text already says it.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const { t } = useTokens();
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        py: 6,
        px: 2,
        color: t.muted,
      }}
    >
      <CircularProgress size={20} aria-hidden sx={{ color: t.rust }} />
      <Typography sx={{ fontSize: '0.9rem', color: t.inkSoft }}>{label}</Typography>
    </Box>
  );
}

/** Nothing to show, and that is the correct answer. */
export function EmptyState({ title, detail, action }: StateBlockProps) {
  const { t } = useTokens();
  return (
    <Box
      sx={{
        textAlign: 'center',
        py: 6,
        px: 3,
        borderRadius: CARD_RADIUS,
        border: `1px dashed ${t.line}`,
        bgcolor: withAlpha(t.paper, 0.6),
      }}
    >
      <EmptyIcon aria-hidden sx={{ fontSize: '2rem', color: t.muted, mb: 1 }} />
      <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '1rem' }}>{title}</Typography>
      {detail && (
        <Typography sx={{ color: t.muted, fontSize: '0.875rem', mt: 0.75, mx: 'auto', maxWidth: 460 }}>
          {detail}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  );
}

/**
 * A request failed and there is nothing to show in its place.
 *
 * Announced assertively: unlike a loading message, this one changes what the
 * user can believe about the page.
 */
export function ErrorState({
  title = 'Could not load this data',
  detail,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  detail?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const { t, isDark } = useTokens();
  const tone = isDark ? '#D47A6A' : '#B05945';
  return (
    <Box
      role="alert"
      sx={{
        display: 'flex',
        gap: 1.5,
        alignItems: 'flex-start',
        p: 2.5,
        borderRadius: CARD_RADIUS,
        bgcolor: withAlpha(tone, isDark ? 0.14 : 0.08),
        border: `1px solid ${withAlpha(tone, 0.4)}`,
      }}
    >
      <ErrorIcon aria-hidden sx={{ color: tone, flexShrink: 0, mt: '2px' }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.95rem' }}>{title}</Typography>
        {detail && (
          <Typography sx={{ color: t.inkSoft, fontSize: '0.85rem', mt: 0.5, wordBreak: 'break-word' }}>
            {detail}
          </Typography>
        )}
        {onRetry && (
          <Button
            size="small"
            onClick={onRetry}
            startIcon={<RetryIcon />}
            sx={{ mt: 1.25, color: tone, fontWeight: 700 }}
          >
            {retryLabel}
          </Button>
        )}
      </Box>
    </Box>
  );
}

/**
 * Something is showing, but it is incomplete or stale.
 *
 * The distinction from ErrorState matters operationally: a degraded page still
 * carries usable data, and hiding it behind a full error would cost more than
 * the warning does.
 */
export function DegradedBanner({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const { t, isDark } = useTokens();
  const tone = '#C4A040';
  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        gap: 1.25,
        alignItems: 'center',
        flexWrap: 'wrap',
        px: 2,
        py: 1.25,
        mb: 2,
        borderRadius: CARD_RADIUS,
        bgcolor: withAlpha(tone, isDark ? 0.16 : 0.12),
        border: `1px solid ${withAlpha(tone, 0.45)}`,
      }}
    >
      <DegradedIcon aria-hidden sx={{ color: tone, fontSize: '1.1rem', flexShrink: 0 }} />
      <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.85rem' }}>{title}</Typography>
      {detail && (
        <Typography sx={{ color: t.inkSoft, fontSize: '0.85rem', minWidth: 0 }}>{detail}</Typography>
      )}
      {action && <Box sx={{ ml: 'auto' }}>{action}</Box>}
    </Box>
  );
}
