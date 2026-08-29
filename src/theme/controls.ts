// Shared styling for interactive controls that need to stay legible over the
// app's page canvas.
//
// The toggle "tab" pattern was the problem case: an unselected label drawn in
// `muted` lands around 2.5:1 contrast, which is unreadable. Two fixes, applied
// together:
//
//   1. The group gets its own opaque surface rather than letting the page show
//      through behind small text.
//   2. Unselected labels use `inkSoft` instead of `muted`, and selection is
//      carried by background + weight rather than by colour alone.

import type { tokensFor } from './tokens';
import { isLight, mix } from './contrast';

type Tk = ReturnType<typeof tokensFor>;

/** Styling for a ToggleButtonGroup used as a row of page tabs / filters. */
export const toggleGroupSx = (t: Tk) => ({
  bgcolor: t.paper,
  borderRadius: 2,
  border: `1px solid ${t.line}`,
  overflow: 'hidden',
  '& .MuiToggleButton-root': {
    color: t.inkSoft,
    border: 'none',
    borderRight: `1px solid ${t.line}`,
    borderRadius: 0,
    textTransform: 'none',
    fontWeight: 600,
    fontSize: '0.8rem',
    px: 1.75,
    py: 0.6,
    '&:last-of-type': { borderRight: 'none' },
    '&:hover': { bgcolor: `${t.rust}14` },
  },
  '& .MuiToggleButton-root.Mui-selected': {
    color: `${t.ink} !important`,
    bgcolor: `${t.rust}2E !important`,
    fontWeight: 800,
    // A left rule marks the active tab without relying on colour alone.
    boxShadow: `inset 3px 0 0 ${t.rust}`,
    '&:hover': { bgcolor: `${t.rust}3D !important` },
  },
  '& .MuiToggleButton-root.Mui-disabled': { color: t.muted, opacity: 0.5 },
});

// ── Card surface ─────────────────────────────────────────────────────────────
// One radius and one shadow for every card in the app.
//
// MUI multiplies a numeric `borderRadius` by theme.shape.borderRadius, so
// shape.borderRadius is CARD_RADIUS / 2 and the common numeric
// `borderRadius: 2` resolves to exactly CARD_RADIUS. Keep those two in step:
// changing the radius here without changing SHAPE_BORDER_RADIUS silently splits
// the app into two radii.

/** The single card radius, shared by every surface. */
export const CARD_RADIUS = '14px';

/** Numeric sx `borderRadius: 2` must land on CARD_RADIUS — see ThemeContext. */
export const SHAPE_BORDER_RADIUS = 7;

// ── Page geometry ────────────────────────────────────────────────────────────
// Shared by the page shell and the navigation rail so a page banner's top edge
// lines up with the top of the rail.

/** Inset around the page column. Equals the navigation rail's own fixed inset. */
export const PAGE_GUTTER = 16;

/** Width of the floating navigation rail. */
export const SIDEBAR_WIDTH = 212;

/**
 * Horizontal space the rail occupies: its inset plus its width. Content offsets
 * by exactly this, and the page shell's own `px` then supplies the gap between
 * the rail's right edge and the first card.
 */
export const SIDEBAR_RESERVE = PAGE_GUTTER + SIDEBAR_WIDTH;

/** Standard reading column. */
export const PAGE_MAX_WIDTH = 1280;

/** Wider column for diagram/topology pages that need the canvas. */
export const PAGE_MAX_WIDTH_WIDE = 1600;

/**
 * The one page container. Spread into a page's root `sx`.
 *
 * `pt` is PAGE_GUTTER precisely because the rail is fixed at that same inset —
 * that is what puts the two top edges on one line.
 *
 * Below `lg` the rail collapses to a fixed top bar with nothing in flow behind
 * it, so the column starts lower to clear it. The `lg` breakpoint is 1200px,
 * which is exactly where the rail returns.
 */
export const pageShellSx = (wide = false) => ({
  pt: { xs: '62px', lg: `${PAGE_GUTTER}px` },
  px: `${PAGE_GUTTER}px`,
  // Room to scroll past the last card rather than ending flush against it.
  pb: 6,
  maxWidth: wide ? PAGE_MAX_WIDTH_WIDE : PAGE_MAX_WIDTH,
  mx: 'auto',
  width: '100%',
});

/**
 * Resting shadow — present at all times, not only on hover. Strong enough to be
 * visible on its own.
 */
export const cardShadow = (isDark: boolean) =>
  isDark
    ? '0 1px 3px rgba(0,0,0,0.50), 0 6px 18px -6px rgba(0,0,0,0.60)'
    : '0 1px 3px rgba(0,0,0,0.10), 0 6px 16px -6px rgba(0,0,0,0.22)';

/** Hover shadow — a clear step above the resting one, so the lift reads. */
export const cardShadowHover = (isDark: boolean) =>
  isDark
    ? '0 4px 12px rgba(0,0,0,0.55), 0 16px 36px -10px rgba(0,0,0,0.75)'
    : '0 4px 10px rgba(0,0,0,0.14), 0 16px 32px -10px rgba(0,0,0,0.30)';

/**
 * Shadow + hover lift for a card. Spread into an existing sx block; it
 * deliberately sets no background, border or padding so a card keeps its own.
 *
 * Driven by CSS variables (set on the body in ThemeContext) rather than an
 * isDark argument, because most card components receive `t` but not `isDark`.
 *
 * The lift is suppressed under prefers-reduced-motion: a page where every card
 * shifts as the pointer crosses it is exactly what that setting is for.
 */
export const CARD_HOVER_SX = {
  boxShadow: 'var(--card-shadow, 0 1px 3px rgba(0,0,0,0.10), 0 6px 16px -6px rgba(0,0,0,0.22))',
  transition: 'box-shadow 180ms ease, transform 180ms ease',
  '&:hover': {
    boxShadow:
      'var(--card-shadow-hover, 0 4px 10px rgba(0,0,0,0.14), 0 16px 32px -10px rgba(0,0,0,0.30))',
    transform: 'translateY(-2px)',
  },
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'box-shadow 180ms ease',
    '&:hover': { transform: 'none' },
  },
} as const;

/** A complete card surface: radius, background, border, shadow and hover. */
export const cardSx = (t: Tk) => ({
  borderRadius: CARD_RADIUS,
  background: t.paper,
  border: `1px solid ${t.line}`,
  ...CARD_HOVER_SX,
});

/**
 * Text/icon colour for content sitting on a filled accent button. Chosen from
 * the accent's own luminance, so a pale accent never gets white text on it.
 */
export const onAccent = (accent: string): string => (isLight(accent) ? '#1A1410' : '#FFFFFF');

/** Hover fill for a filled accent button: the accent pushed further from the page. */
export const accentHover = (accent: string, isDark: boolean): string =>
  mix(accent, isDark ? '#FFFFFF' : '#000000', 0.18);
