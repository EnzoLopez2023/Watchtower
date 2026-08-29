// The single seam between the pages and the theme system.
//
// `tokensFor(isDark, palette)` is called from every feature page. It asks the
// appearance resolver, which folds together the palette pinned to the current
// page, any accent override, and the text-colour setting.
//
// The signature is deliberately unchanged from the source application, so the
// scoped production views render identically. `palette` is the *seed* — the
// look a page asks for when the user has expressed no preference.

import { resolveTokens } from './appearance';
import type { HearthTokens } from './catalog/types';

export type { HearthTokens } from './catalog/types';

/**
 * The palette names the pages themselves use.
 *
 * Kept as a closed union because the seed map keys off it and the compiler
 * catching a typo there is worth more than the flexibility. Catalog ids are
 * plain strings — nothing type-references a palette the user picked, only ones
 * the code ships with.
 *
 * The legacy names (`hearth`, `blueprint`, `network`, `plex`, `power`, `ink`)
 * stay in the union and are redirected by PALETTE_ALIAS, so any value carried
 * over from a production call site still resolves.
 */
export type PaletteName =
  | 'wine' | 'hearth' | 'sky' | 'signal' | 'blueprint' | 'network'
  | 'amber' | 'plex' | 'power' | 'steel' | 'scholar'
  | 'midnight' | 'graphite' | 'contrast' | 'ink' | 'kraft';

/**
 * Tokens for the current mode.
 *
 * Resolution order, highest first: the palette pinned to the current page, the
 * page's seed palette, the app default, then the `palette` argument.
 *
 * The returned object is cached per resolved theme, so repeated calls with the
 * same inputs hand back the *same* frozen object. That makes `t` safe to put in
 * a `useMemo`/`useEffect` dependency array — which several pages do, and which
 * would otherwise be an infinite render loop.
 */
export const tokensFor = (isDark: boolean, palette: PaletteName = 'wine'): HearthTokens =>
  resolveTokens(isDark, palette);

/** Tokens for the app's own identity, ignoring whatever page is open. */
export const tokens = (isDark: boolean): HearthTokens => resolveTokens(isDark, 'wine', null);
