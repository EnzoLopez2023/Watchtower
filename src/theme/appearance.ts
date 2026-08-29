// Appearance settings — one palette per page, and nothing else to reconcile.
//
// Every page resolves through this module, seeded so a fresh install looks like
// the production pages it was lifted from, and every knob — palette, accent,
// font, text colour, veil — is per page.
//
// Why module-level state rather than context: `tokensFor(isDark, palette)` is a
// plain function called from every feature page during render. Threading a hook
// through all of them would be a large, risky refactor for no user-visible
// gain. The provider writes these settings during its own render (not in an
// effect), so anything rendering afterwards reads the current value.

import type { AppView } from '../types/AppView';
import type { HearthTokens, InkMode, Palette, PaletteRamp } from './catalog';
import { accentById, applyCaption, applyInk, compose, rampFor, resolvePalette } from './catalog';
import { resolveFont, type FontPairing } from './fonts';
import { DEFAULT_VEIL, SCRIM_ALPHA, veilGradient, withAlpha } from './contrast';
// Type-only, so this does not create a runtime cycle with tokens.ts.
import type { PaletteName } from './tokens';

/** Everything a single page can pin. Every field is optional — unset means inherit. */
export interface PageAppearance {
  paletteId?: string;
  /** Optional accent override. Unset uses the palette's own accents. */
  accentId?: string;
  fontId?: string;
  inkMode?: InkMode;
  /** Hex, only meaningful when inkMode is 'custom'. */
  inkCustom?: string;
  /** Hex override for caption/muted text, independent of inkMode. */
  captionCustom?: string;
  /** Wallpaper veil opacity, 0.15–0.95. */
  veil?: number;
}

export interface AppearanceSettings {
  version: 2;
  /** Applies to any page without its own entry, over the seeded default. */
  defaults: PageAppearance;
  perView: Partial<Record<AppView, PageAppearance>>;
}

export const VEIL_MIN = 0.15;
export const VEIL_MAX = 0.95;

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  version: 2,
  defaults: {},
  perView: {},
};

const STORAGE_KEY = 'watchtower.appearance.v2';

// ── Seeding ──────────────────────────────────────────────────────────────────
// Which palette each view starts with, carried over from the production pages
// so a fresh install looks exactly like the views it was lifted from.

export const SEED_PALETTE: Record<AppView, PaletteName> = {
  'azure-command-center': 'sky',
  'system-status': 'steel',
  observability: 'signal',
  'power-monitor': 'amber',
  'power-topology': 'amber',
  'unifi-network': 'signal',
  'unifi-topology': 'signal',
  'unifi-config': 'signal',
  synology: 'steel',
  'ip-migration': 'signal',
  protect: 'signal',
  admin: 'steel',
  settings: 'wine',
};

export const DEFAULT_PALETTE_ID = 'wine';

/** The palette a view starts with, before any user preference. */
export const seedPaletteFor = (view: AppView | null): PaletteName =>
  (view && SEED_PALETTE[view]) || 'wine';

/**
 * Legacy palette name → catalog id. Covers the palette names the production
 * pages still pass to `tokensFor`, so a stale id never resolves to the wrong
 * look.
 */
export const PALETTE_ALIAS: Record<string, string> = {
  hearth: 'wine',
  blueprint: 'signal',
  network: 'signal',
  plex: 'amber',
  power: 'amber',
  ink: 'graphite',
  kraft: 'graphite',
};

export const canonicalPaletteId = (id?: string): string | undefined =>
  id ? (PALETTE_ALIAS[id] ?? id) : undefined;

// ── Load / save ──────────────────────────────────────────────────────────────

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normaliseAppearance(JSON.parse(raw));
  } catch {
    /* unparseable or private mode — fall through to defaults */
  }
  return { version: 2, defaults: {}, perView: {} };
}

export function saveAppearance(s: AppearanceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/** Coerce anything (a stored blob, an `/api/settings` value) into valid settings. */
export function normaliseAppearance(parsed: unknown): AppearanceSettings {
  const p = (parsed ?? {}) as Partial<AppearanceSettings>;
  const perViewEntries = Object.entries(p.perView ?? {}).filter(([view]) =>
    Object.hasOwn(SEED_PALETTE, view),
  );
  return {
    version: 2,
    defaults: cleanPage(p.defaults),
    perView: Object.fromEntries(
      perViewEntries.map(([view, value]) => [view, cleanPage(value)]),
    ),
  };
}

function cleanPage(value: unknown): PageAppearance {
  const v = (value ?? {}) as PageAppearance;
  const out: PageAppearance = {};
  const paletteId = canonicalPaletteId(v.paletteId);
  if (paletteId) out.paletteId = paletteId;
  if (v.accentId) out.accentId = v.accentId;
  if (v.fontId) out.fontId = v.fontId;
  if (v.inkMode) out.inkMode = v.inkMode;
  if (v.inkCustom) out.inkCustom = v.inkCustom;
  if (v.captionCustom) out.captionCustom = v.captionCustom;
  if (typeof v.veil === 'number' && Number.isFinite(v.veil)) {
    out.veil = Math.min(VEIL_MAX, Math.max(VEIL_MIN, v.veil));
  }
  return out;
}

// ── Active settings, readable by the plain token functions ───────────────────

let active: AppearanceSettings = { version: 2, defaults: {}, perView: {} };
export const getAppearance = (): AppearanceSettings => active;
export const setActiveAppearance = (s: AppearanceSettings): void => {
  active = s;
};

let currentView: AppView | null = null;
export const setCurrentView = (v: AppView | null): void => {
  currentView = v;
};
export const getCurrentView = (): AppView | null => currentView;

// ── Resolution ───────────────────────────────────────────────────────────────

/** Everything a page ends up with, after seeds and defaults are folded in. */
export interface ResolvedAppearance {
  palette: Palette;
  /** The ramp for the current mode, with any accent override and ink change applied. */
  ramp: PaletteRamp;
  tokens: HearthTokens;
  font: FontPairing;
  veil: number;
  inkMode: InkMode;
  inkCustom?: string;
  captionCustom?: string;
  accentId?: string;
  /** True when this page has pinned anything of its own. */
  pinned: boolean;
}

/** The stored entry for a view, if it has any effect at all. */
export function pageSettings(view: AppView | null, s = active): PageAppearance | null {
  if (!view) return null;
  const o = s.perView[view];
  if (!o) return null;
  return Object.keys(o).length ? o : null;
}

export const isPinned = (view: AppView | null, s = active): boolean =>
  pageSettings(view, s) !== null;

/** Fold the layers for one field: the page's own pin, then the global default. */
function pick<K extends keyof PageAppearance>(
  key: K,
  view: AppView | null,
  s: AppearanceSettings,
): PageAppearance[K] {
  const page = view ? s.perView[view] : undefined;
  return page?.[key] ?? s.defaults[key];
}

/**
 * The palette id in force for a view.
 *
 * `requested` is the palette name the calling page passed to `tokensFor`. It is
 * the lowest-priority input — a seed for anything that renders before the view
 * is known — because the user's choice wins over the code's.
 */
export function resolvePaletteId(
  view: AppView | null = currentView,
  requested?: string,
  s = active,
): string {
  return (
    pick('paletteId', view, s) ??
    (view ? SEED_PALETTE[view] : undefined) ??
    canonicalPaletteId(requested) ??
    DEFAULT_PALETTE_ID
  );
}

/**
 * Token identity cache.
 *
 * `compose()` builds a fresh object on every call, so two renders of the same
 * page with the same theme would hand back two different references. Pages put
 * `t` in `useMemo`/`useEffect` dependency arrays; an effect that both depends on
 * `t` and calls setState then re-fires on every render, and React eventually
 * throws "Maximum update depth exceeded".
 *
 * The key is every *resolved* input `compose()` reads, so an entry can never go
 * stale: changing the settings changes the key rather than invalidating a cache.
 */
const tokenCache = new Map<string, HearthTokens>();

function composeCached(
  isDark: boolean,
  paletteId: string,
  accentId: string | undefined,
  inkMode: InkMode,
  inkCustom: string | undefined,
  captionCustom: string | undefined,
): HearthTokens {
  const key = `${isDark ? 'd' : 'l'}|${paletteId}|${accentId ?? ''}|${inkMode}|${inkCustom ?? ''}|${captionCustom ?? ''}`;
  const hit = tokenCache.get(key);
  if (hit) return hit;

  const palette = resolvePalette(paletteId);
  const base = applyCaption(applyInk(rampFor(palette, isDark), inkMode, inkCustom), captionCustom);
  const accent = accentById(accentId);
  // Frozen so a caller cannot mutate the shared instance out from under every
  // other page reading the same theme.
  const composed = Object.freeze(
    compose(base, accent ? (isDark ? accent.dark : accent.light) : undefined),
  );
  tokenCache.set(key, composed);
  return composed;
}

/** Everything resolved for one view in one mode. */
export function resolveAppearance(
  isDark: boolean,
  view: AppView | null = currentView,
  requested?: string,
  s = active,
): ResolvedAppearance {
  const paletteId = resolvePaletteId(view, requested, s);
  const palette = resolvePalette(paletteId);
  const accentId = pick('accentId', view, s);
  const inkMode = pick('inkMode', view, s) ?? 'auto';
  const inkCustom = pick('inkCustom', view, s);
  const captionCustom = pick('captionCustom', view, s);

  const base = applyCaption(applyInk(rampFor(palette, isDark), inkMode, inkCustom), captionCustom);
  const accent = accentById(accentId);
  const triad = accent ? (isDark ? accent.dark : accent.light) : undefined;

  return {
    palette,
    ramp: triad ? { ...base, ...triad } : base,
    tokens: composeCached(isDark, paletteId, accentId, inkMode, inkCustom, captionCustom),
    font: resolveFont(pick('fontId', view, s)),
    veil: pick('veil', view, s) ?? DEFAULT_VEIL,
    inkMode,
    ...(inkCustom ? { inkCustom } : {}),
    ...(captionCustom ? { captionCustom } : {}),
    ...(accentId ? { accentId } : {}),
    pinned: isPinned(view, s),
  };
}

/**
 * Composed tokens for a view. The single seam `tokensFor` calls through.
 *
 * Returns the same object for the same theme, so `t` is safe to place in a
 * dependency array.
 */
export function resolveTokens(
  isDark: boolean,
  requested?: string,
  view: AppView | null = currentView,
): HearthTokens {
  const s = active;
  return composeCached(
    isDark,
    resolvePaletteId(view, requested, s),
    pick('accentId', view, s),
    pick('inkMode', view, s) ?? 'auto',
    pick('inkCustom', view, s),
    pick('captionCustom', view, s),
  );
}

/** Wallpaper veil gradient for a view. */
export function resolveVeilGradient(isDark: boolean, view: AppView | null = currentView): string {
  const { ramp, veil } = resolveAppearance(isDark, view);
  return veilGradient(ramp.bg, veil);
}

/** Plate colour for text placed outside a card. */
export function resolveScrim(isDark: boolean, view: AppView | null = currentView): string {
  const { ramp } = resolveAppearance(isDark, view);
  return withAlpha(ramp.bg, SCRIM_ALPHA);
}

// ── Mutation helpers ─────────────────────────────────────────────────────────
// Pure: each returns a new settings object for the caller to persist.

export function setPageAppearance(
  s: AppearanceSettings,
  view: AppView,
  patch: PageAppearance,
): AppearanceSettings {
  const next = cleanPage({ ...s.perView[view], ...patch });
  return { ...s, perView: { ...s.perView, [view]: next } };
}

export function setDefaultAppearance(
  s: AppearanceSettings,
  patch: PageAppearance,
): AppearanceSettings {
  return { ...s, defaults: cleanPage({ ...s.defaults, ...patch }) };
}

export function clearPageAppearance(s: AppearanceSettings, view: AppView): AppearanceSettings {
  const perView = { ...s.perView };
  delete perView[view];
  return { ...s, perView };
}

export function clearAllAppearance(s: AppearanceSettings): AppearanceSettings {
  return { ...s, defaults: {}, perView: {} };
}
