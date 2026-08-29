// Font pairings.
//
// A heading face and a body face, chosen together. Only the default pair is in
// index.html; the rest are fetched the first time something asks for them.

export interface FontPairing {
  id: string;
  name: string;
  /** CSS font-family stack for headings. */
  heading: string;
  /** CSS font-family stack for body copy. */
  body: string;
  /** Google Fonts query fragment, or undefined when nothing needs fetching. */
  google?: string;
  blurb: string;
}

const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const SERIF_FALLBACK = 'Georgia, "Times New Roman", serif';
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const FONT_PAIRINGS: FontPairing[] = [
  {
    id: 'system',
    name: 'System',
    heading: SANS_FALLBACK,
    body: SANS_FALLBACK,
    blurb: "Whatever your OS ships. Nothing to download, so it's the fastest.",
  },
  {
    id: 'technical',
    name: 'Technical',
    heading: `"Space Grotesk", ${SANS_FALLBACK}`,
    body: `"IBM Plex Sans", ${SANS_FALLBACK}`,
    google: 'family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700',
    blurb: 'Geometric headings, engineered body text. Suits the dashboards.',
  },
  {
    id: 'compact',
    name: 'Compact',
    heading: `"Archivo", ${SANS_FALLBACK}`,
    body: `"Archivo", ${SANS_FALLBACK}`,
    google: 'family=Archivo:wght@400;500;600;700',
    blurb: 'Narrow and dense. Fits more into a table row.',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    heading: `"Fraunces", ${SERIF_FALLBACK}`,
    body: `"Source Sans 3", ${SANS_FALLBACK}`,
    google:
      'family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Source+Sans+3:wght@300;400;500;600;700',
    blurb: 'Warm optical serif with a workhorse sans underneath.',
  },
  {
    id: 'mono',
    name: 'Mono',
    heading: `"JetBrains Mono", ${MONO_FALLBACK}`,
    body: `"JetBrains Mono", ${MONO_FALLBACK}`,
    google: 'family=JetBrains+Mono:wght@400;500;700',
    blurb: 'Everything monospaced. Terminal energy, and numbers line up.',
  },
];

export const DEFAULT_FONT_ID = 'system';

const BY_ID = new Map(FONT_PAIRINGS.map((f) => [f.id, f]));

export const FALLBACK_FONT: FontPairing =
  BY_ID.get(DEFAULT_FONT_ID) ?? (FONT_PAIRINGS[0] as FontPairing);

export const fontById = (id?: string): FontPairing | undefined => (id ? BY_ID.get(id) : undefined);

/** Never undefined — use where a font is required to render. */
export const resolveFont = (id?: string): FontPairing => fontById(id) ?? FALLBACK_FONT;

// ── Loading ──────────────────────────────────────────────────────────────────

const LINK_PREFIX = 'watchtower-font-';

/**
 * Add the stylesheet for a pairing, once. Safe to call on every render: the
 * element id doubles as the guard, so repeat calls are a map lookup.
 */
export function ensureFontLoaded(id: string): void {
  if (typeof document === 'undefined') return;
  const pairing = fontById(id);
  if (!pairing?.google) return;

  const elementId = LINK_PREFIX + pairing.id;
  if (document.getElementById(elementId)) return;

  const link = document.createElement('link');
  link.id = elementId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${pairing.google}&display=swap`;
  document.head.appendChild(link);
}

/** Warm every pairing so the picker can render each option in its own face. */
export function preloadAllFonts(): void {
  for (const f of FONT_PAIRINGS) ensureFontLoaded(f.id);
}
