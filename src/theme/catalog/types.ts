// The palette catalog's shape.
//
// A PALETTE is one complete look: neutral surfaces AND its own accent ramp, in
// both a light and a dark variant. An accent override still exists for anyone
// who wants one palette's accent on another's paper, but it is opt-in and off
// by default.

import { mix, isLight } from '../contrast';

export type Mode = 'light' | 'dark';

/**
 * The runtime token shape every page reads through `tokensFor()`.
 *
 * The `rust*` field names are historical — they carry each palette's primary
 * accent, not a rust colour. They are kept because every page reads them.
 */
export interface HearthTokens {
  /** Page background */
  bg: string;
  /** Section/surface fill (slightly different from bg) */
  surface: string;
  /** Card / paper surface */
  paper: string;
  /** Primary text */
  ink: string;
  /** Secondary text */
  inkSoft: string;
  /** Tertiary / muted text */
  muted: string;
  /** Default border */
  line: string;
  /** Primary accent */
  rust: string;
  /** Deeper accent for hover/active */
  rustDark: string;
  /** Lighter accent for highlights */
  rustLight: string;
  /** Secondary accent */
  champagne: string;
  /** Alias of the primary accent, kept for existing callers */
  wine: string;
}

/** One mode of a palette: the seven neutrals plus the four accent slots. */
export interface PaletteRamp {
  bg: string;
  surface: string;
  paper: string;
  ink: string;
  inkSoft: string;
  muted: string;
  line: string;
  rust: string;
  rustDark: string;
  rustLight: string;
  champagne: string;
  /**
   * The colour strip drawn along the bottom edge of a preview card. Optional:
   * palettes whose identity is a single accent family fall back to a strip
   * derived from their own accents.
   */
  swatches?: string[];
}

export type PaletteGroup = 'hearth' | 'community';

export interface Palette {
  id: string;
  name: string;
  group: PaletteGroup;
  blurb: string;
  light: PaletteRamp;
  dark: PaletteRamp;
}

/** An optional accent override, applied on top of any palette's neutrals. */
export interface AccentTriad {
  rust: string;
  rustDark: string;
  rustLight: string;
  champagne: string;
}

export interface AccentDef {
  id: string;
  name: string;
  dark: AccentTriad;
  light: AccentTriad;
}

// ── Composition ──────────────────────────────────────────────────────────────

/** Merge a palette ramp — optionally with an accent override — into app tokens. */
export function compose(ramp: PaletteRamp, accent?: AccentTriad): HearthTokens {
  const a = accent ?? ramp;
  return {
    bg: ramp.bg,
    surface: ramp.surface,
    paper: ramp.paper,
    ink: ramp.ink,
    inkSoft: ramp.inkSoft,
    muted: ramp.muted,
    line: ramp.line,
    rust: a.rust,
    rustDark: a.rustDark,
    rustLight: a.rustLight,
    champagne: a.champagne,
    wine: a.rust,
  };
}

/**
 * The preview strip for a ramp. Authored swatches win; otherwise the palette's
 * own accent family is spread into a six-stop ramp.
 */
export function swatchesFor(ramp: PaletteRamp): string[] {
  if (ramp.swatches?.length) return ramp.swatches;
  return [ramp.rustDark, ramp.rust, ramp.rustLight, ramp.champagne, ramp.line, ramp.muted];
}

/** Pick the ramp for a mode. */
export const rampFor = (p: Palette, isDark: boolean): PaletteRamp => (isDark ? p.dark : p.light);

// ── Ink adjustment ───────────────────────────────────────────────────────────

export type InkMode = 'auto' | 'soft' | 'strong' | 'custom';

/**
 * Re-derive the ink ladder for a ramp.
 *
 * `soft` pulls every text tone toward the paper, `strong` pushes the primary
 * tone to the extreme and tightens the ladder behind it, `custom` rebuilds the
 * whole ladder from one hex so secondary and muted text stay proportional
 * instead of a custom colour leaving them stranded on the old palette.
 */
export function applyInk(
  ramp: PaletteRamp,
  inkMode: InkMode = 'auto',
  custom?: string,
): PaletteRamp {
  if (inkMode === 'auto') return ramp;

  if (inkMode === 'soft') {
    return {
      ...ramp,
      ink: mix(ramp.ink, ramp.paper, 0.18),
      inkSoft: mix(ramp.inkSoft, ramp.paper, 0.14),
      muted: mix(ramp.muted, ramp.paper, 0.1),
    };
  }

  if (inkMode === 'strong') {
    const extreme = isLight(ramp.paper) ? '#000000' : '#FFFFFF';
    return {
      ...ramp,
      ink: mix(ramp.ink, extreme, 0.55),
      inkSoft: mix(ramp.inkSoft, extreme, 0.4),
      muted: mix(ramp.muted, extreme, 0.3),
    };
  }

  // custom — the ladder is rebuilt by stepping the chosen colour toward the
  // paper, so the three tiers keep their relative separation on any palette.
  const base = custom || ramp.ink;
  return {
    ...ramp,
    ink: base,
    inkSoft: mix(base, ramp.paper, 0.22),
    muted: mix(base, ramp.paper, 0.42),
  };
}

/**
 * Override the caption tone on its own.
 *
 * `muted` is the bottom rung of the ink ladder, and every mode above derives it
 * by stepping toward the paper — which is what makes captions the first tone to
 * fail a contrast target, with no way to lift them without dragging body text
 * along. Applied after applyInk so it wins, and it is the only tone it touches.
 */
export function applyCaption(ramp: PaletteRamp, custom?: string): PaletteRamp {
  if (!custom) return ramp;
  return { ...ramp, muted: custom };
}
