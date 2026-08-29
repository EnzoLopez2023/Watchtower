// The palette registry. Everything that picks, previews or resolves a palette
// goes through here.

import type { Palette, PaletteGroup } from './types';
import { WATCHTOWER_PALETTES } from './palettes';

export * from './types';
export { ACCENTS, accentById } from './accents';

export const PALETTES: Palette[] = [...WATCHTOWER_PALETTES];

const BY_ID = new Map(PALETTES.map((p) => [p.id, p]));

/** The palette every unknown id falls back to — the app's own brand look. */
export const FALLBACK_PALETTE: Palette = BY_ID.get('wine') ?? (PALETTES[0] as Palette);

export function paletteById(id?: string): Palette | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Never returns undefined — use where a palette is required to render. */
export function resolvePalette(id?: string): Palette {
  return paletteById(id) ?? FALLBACK_PALETTE;
}

export const GROUP_LABELS: Record<PaletteGroup, string> = {
  hearth: 'Watchtower themes',
  community: 'More palettes',
};

export const palettesByGroup = (group: PaletteGroup): Palette[] =>
  PALETTES.filter((p) => p.group === group);

export const GROUP_ORDER: PaletteGroup[] = ['hearth', 'community'];

/** Every non-empty group with its label and members, in picker order. */
export const groupedPalettes = (): { group: PaletteGroup; label: string; palettes: Palette[] }[] =>
  GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    palettes: palettesByGroup(group),
  })).filter((g) => g.palettes.length > 0);
