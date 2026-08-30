// iOS-mode design primitives.
//
// Watchtower is a React 19 + MUI app, not an Ionic app, so there is no
// `setupIonicReact({ mode: 'ios' })` call to make. This module is the
// equivalent: one switch (`IOS_MODE`) plus the geometry, easing and
// glassmorphism helpers that give the shell the native iOS look —
// squircle corners, Apple-timed transitions and hardware-accelerated
// frosted glass. The shell and the theme factory read from here, so the
// iOS treatment is defined once and applied everywhere.

import type { tokensFor } from './tokens';
import { withAlpha } from './contrast';

type Tk = ReturnType<typeof tokensFor>;

/**
 * Force the whole app into the iOS visual mode. The one flag every other
 * primitive in this file is gated behind — flip it off and the shell falls
 * back to the plain MUI surfaces.
 */
export const IOS_MODE = true as const;

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * iOS "squircle" corner radius. Matches CARD_RADIUS so a glass panel lines up
 * with every card beside it; kept as its own constant so nav items, menu
 * sheets and control blocks can opt in without importing the card module.
 */
export const IOS_SQUIRCLE = '14px';

/** Tighter squircle for small interactive blocks (nav rows, chips, toggles). */
export const IOS_SQUIRCLE_SM = '12px';

/** Radius for a full-height side sheet / navigation rail. */
export const IOS_SHEET_RADIUS = '22px';

// ── Motion ──────────────────────────────────────────────────────────────────

/** Apple's standard ease — used for sheet slides and press feedback. */
export const IOS_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * The hover transition for sidebar rows. Deliberately the plain, natural
 * `ease-in-out` at 200ms that the iPad sidebar uses — no spring, no overshoot.
 */
export const IOS_HOVER_TRANSITION = 'background 0.2s ease-in-out';

// ── Glassmorphism ───────────────────────────────────────────────────────────

/** Blur radius for every frosted surface. Hardware-accelerated on WebKit. */
export const IOS_BLUR = 'blur(20px)';

/**
 * A high-fidelity frosted-glass surface: a semi-transparent tint over a
 * 20px hardware-accelerated blur, a matching hairline border and a faint
 * inner top highlight so the panel edge catches the light like real glass.
 *
 * The reference iOS value is `rgba(255, 255, 255, 0.4)`; here the tint is
 * derived from the active palette's paper token so the glass carries the
 * theme's warmth instead of going flat grey, and the dark variant drops to
 * a low-alpha dark tint for the same effect on the pewter canvas.
 */
export function iosGlass(t: Tk, isDark: boolean) {
  const tint = withAlpha(t.paper, isDark ? 0.55 : 0.62);
  const hairline = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.6)';
  return {
    backgroundColor: tint,
    backdropFilter: `${IOS_BLUR} saturate(180%)`,
    WebkitBackdropFilter: `${IOS_BLUR} saturate(180%)`,
    border: `1px solid ${hairline}`,
    boxShadow: isDark
      ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 40px -12px rgba(0,0,0,0.65)`
      : `inset 0 1px 0 rgba(255,255,255,0.7), 0 8px 40px -12px rgba(0,0,0,0.22)`,
    // A no-backdrop-filter browser (or one with it disabled) still gets a
    // readable opaque-ish surface rather than see-through text.
    '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))': {
      backgroundColor: withAlpha(t.paper, isDark ? 0.92 : 0.96),
    },
  } as const;
}

/**
 * The elevated translucent layer a sidebar row lifts to on hover — a thin
 * white wash that reads as glass-on-glass. The reference value is
 * `rgba(255, 255, 255, 0.15)`; the light variant uses a stronger white so the
 * lift stays visible against the brighter frosted tint.
 */
export const iosHoverLayer = (isDark: boolean): string =>
  isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.55)';
