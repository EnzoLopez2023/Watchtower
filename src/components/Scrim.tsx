// Plate for text that sits outside a card, over the wallpaper.
//
// Watchtower pages render over a full-bleed photograph. Text inside a card is fine
// because the card supplies its own surface; text placed directly on the page
// is not — measured against a mid-tone wallpaper sample, muted text there is
// 1.6–2.25:1, which no theme choice can rescue. The same text on this plate
// measures 5.36–7.96:1 across every palette in the catalog.
//
// The colour comes from the palette pinned to the current page, so the per-page
// theme button controls it rather than it being pinned to a hardcoded value.
import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import { useThemeMode } from '../context/ThemeContext';
import { resolveScrim } from '../theme/appearance';

export default function Scrim({
  children,
  sx,
  block = false,
}: {
  children: ReactNode;
  sx?: SxProps<Theme>;
  /** Full-width instead of hugging the text (headings with a trailing rule). */
  block?: boolean;
}) {
  const { mode, view } = useThemeMode();
  const scrim = resolveScrim(mode === 'dark', view);

  return (
    <Box
      sx={{
        bgcolor: scrim,
        borderRadius: 2,
        px: 1.25,
        py: 0.75,
        display: block ? 'block' : 'inline-block',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}
