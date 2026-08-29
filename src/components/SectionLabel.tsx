// Small uppercase caption that introduces a group of cards ("SAMPLE ITEMS",
// "RECENT ACTIVITY", …).
//
// These sit between cards, directly on the page wallpaper, which is exactly the
// case Scrim exists for: a muted caption measured against a mid-tone photo lands
// around 1.6-2.25:1, and no palette choice can rescue it. Pages were also
// hard-coding their own hex for the colour, so the per-page text-colour control
// in the theme flyout had nothing to act on.
//
// Rendering them through here fixes both at once — the colour comes from the
// resolved tokens for the current page, and the plate is drawn only when there
// is actually a photo behind the page.

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { VIEW_WALLPAPER } from '../theme/palettes';
import { withAlpha, SCRIM_ALPHA } from '../theme/contrast';

export interface SectionLabelProps {
  children: ReactNode;
  /**
   * Which token carries the text.
   *
   * `muted` is the default and matches how these labels have always read.
   * `soft` and `ink` step up for labels that need to hold their own next to a
   * heading; `accent` is for the handful that are colour-coded on purpose.
   */
  tone?: 'muted' | 'soft' | 'ink' | 'accent';
  /** Trailing slot (a count, a link, an action) laid out on the same line. */
  action?: ReactNode;
  /**
   * Force the scrim plate on or off. Unset draws it whenever the page has a
   * wallpaper, which is the right call for a label sitting on the page itself —
   * pass `false` for one used inside a card, which supplies its own surface.
   */
  plate?: boolean;
  /** Escape hatch for spacing. Colour and type scale come from the component. */
  sx?: SxProps<Theme>;
}

export default function SectionLabel({
  children,
  tone = 'muted',
  action,
  plate,
  sx,
}: SectionLabelProps) {
  const { mode, palette, view } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  // The accent's mid tone is tuned for card surfaces; over a scrimmed wallpaper
  // it needs the mode-appropriate end of the triad, same as PageHero's eyebrow.
  const color =
    tone === 'accent' ? (isDark ? t.rustLight : t.rustDark)
    : tone === 'ink'  ? t.ink
    : tone === 'soft' ? t.inkSoft
    : t.muted;

  // Only plate the label when there is a photo behind the page; on flat
  // backgrounds the page already supplies the contrast and a plate would just
  // read as a stray grey bar.
  const showPlate = plate ?? !!(view && VIEW_WALLPAPER[view]);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: action ? 'space-between' : 'flex-start',
        gap: 1.5,
        mb: 2,
        ...(showPlate && {
          alignSelf: 'flex-start',
          width: action ? '100%' : 'fit-content',
          bgcolor: withAlpha(t.bg, SCRIM_ALPHA),
          backdropFilter: 'blur(6px)',
          borderRadius: 2,
          px: 1.25,
          py: 0.75,
        }),
        ...sx,
      }}
    >
      <Typography
        component="h2"
        sx={{
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          lineHeight: 1.4,
          margin: 0,
          color,
        }}
      >
        {children}
      </Typography>
      {action}
    </Box>
  );
}
