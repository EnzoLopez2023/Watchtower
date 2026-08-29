// "View only" bar for a page the signed-in user may read but not change.
//
// Rendered once by the shell above the page content rather than by each page,
// for the same reason the admin fence lives in the router: a rule every page has
// to remember is a rule most pages forget. Pages still hide their own edit
// affordances; this explains why they are missing.

import { Box, Typography } from '@mui/material';
import { LockOutlined as LockIcon } from '@mui/icons-material';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { withAlpha } from '../theme/contrast';

export default function ReadOnlyNotice({
  label,
  reason,
}: {
  label: string;
  /**
   * Why the fence is closed. A per-view rule and a missing role are different
   * problems with different fixes, so they must not share one message.
   */
  reason: 'role' | 'feature-rule';
}) {
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
        px: { xs: 2, md: 4 },
        py: 1,
        // Full-bleed across the content column rather than inset like a card:
        // page paddings vary, so anything inset would sit crooked on half the
        // app. A strip pinned to the edges reads as app chrome, which it is.
        bgcolor: withAlpha(t.rust, isDark ? 0.16 : 0.1),
        borderBottom: `1px solid ${withAlpha(t.rust, 0.35)}`,
      }}
    >
      <LockIcon sx={{ fontSize: '1rem', color: t.rust, flexShrink: 0 }} />
      <Typography sx={{ fontSize: '0.82rem', color: t.ink, fontWeight: 600 }}>View only</Typography>
      <Typography sx={{ fontSize: '0.82rem', color: t.muted, minWidth: 0 }}>
        {reason === 'feature-rule'
          ? `You can read ${label} but not change it. Your role allows edits, but this view has not been granted to your account.`
          : `You can read ${label} but not change it. Ask an administrator for operator access.`}
      </Typography>
    </Box>
  );
}
