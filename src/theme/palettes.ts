// Gradients derived from a page's resolved tokens, plus the map of which
// wallpaper each view wears.
//
// Watchtower ships no photographic wallpapers, so VIEW_WALLPAPER is empty and
// every page draws on the palette's own flat canvas. The map is kept because
// PageHero, SectionLabel and Scrim all branch on it — a standalone deployment
// that drops an image into `public/` and adds an entry here gets the plated
// treatment back with no component changes.

import type { AppView } from '../types/AppView';
import { tokensFor, type PaletteName, type HearthTokens } from './tokens';
import { resolveVeilGradient } from './appearance';
import { withAlpha } from './contrast';

type Mode = 'light' | 'dark';

export interface PaletteGradients {
  body: string;
  blobTR: string;
  blobBL: string;
  card: string;
  veil: string;
}

/**
 * Every gradient the theme needs, derived from the tokens in force.
 *
 * `view` is optional: pass it where the gradient belongs to a specific page, so
 * the veil picks up that page's slider rather than the one for whatever view is
 * currently open.
 */
export function paletteGradients(
  palette: PaletteName,
  isDark: boolean,
  view?: AppView,
): PaletteGradients {
  const t: HearthTokens = tokensFor(isDark, palette);
  return {
    body: isDark
      ? `radial-gradient(ellipse 1000px 700px at 50% -8%, ${t.surface} 0%, ${t.bg} 55%, ${t.bg} 100%)`
      : `radial-gradient(ellipse 1100px 700px at 78% -10%, ${t.paper} 0%, ${t.bg} 45%, ${t.surface} 100%)`,
    blobTR: `radial-gradient(circle, ${withAlpha(t.rust, isDark ? 0.18 : 0.15)} 0%, transparent 70%)`,
    blobBL: `radial-gradient(circle, ${withAlpha(t.champagne, isDark ? 0.12 : 0.1)} 0%, transparent 70%)`,
    card: `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`,
    veil: resolveVeilGradient(isDark, view ?? null),
  };
}

export const bodyGradient = (p: PaletteName, m: Mode) => paletteGradients(p, m === 'dark').body;
export const blobTR = (p: PaletteName, m: Mode) => paletteGradients(p, m === 'dark').blobTR;
export const blobBL = (p: PaletteName, m: Mode) => paletteGradients(p, m === 'dark').blobBL;
export const cardGradient = (p: PaletteName, m: Mode) => paletteGradients(p, m === 'dark').card;

/** Wallpaper image (in public/) per view. Empty in the standalone build. */
export const VIEW_WALLPAPER: Partial<Record<AppView, string>> = {};

export const wallpaperForView = (view: AppView): string | undefined => VIEW_WALLPAPER[view];
