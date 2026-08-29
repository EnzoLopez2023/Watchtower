// Colour maths for the theme system: alpha, blending, WCAG contrast, and the
// audit every palette has to pass.
//
// Kept free of palette data so the catalog and the appearance resolver can both
// import it without a cycle.

/** #RGB or #RRGGBB → rgba() with the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Parse #RGB / #RRGGBB into channels. Unparseable input falls back to mid-grey. */
export function rgb(hex: string): { r: number; g: number; b: number } {
  const h = (hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: 128, g: 128, b: 128 };
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Linear blend: `amount` 0 returns `from`, 1 returns `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  const k = Math.max(0, Math.min(1, amount));
  return toHex(
    a.r + (b.r - a.r) * k,
    a.g + (b.g - a.g) * k,
    a.b + (b.b - a.b) * k,
  );
}

// ── WCAG 2.1 relative luminance ──────────────────────────────────────────────
export function luminance(hex: string): number {
  const { r, g, b } = rgb(hex);
  const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrast(fg: string, bg: string): number {
  const [hi = 0, lo = 0] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** True when a colour is closer to white than to black. */
export const isLight = (hex: string): boolean => luminance(hex) > 0.179;

/**
 * Darken or lighten `fg` until it reads at `min` against `bg`, keeping its hue.
 *
 * Semantic colours (status greens, reds, ambers) are deliberately fixed so a
 * warning never stops looking like a warning when the theme changes. But a
 * colour tuned against one palette's paper drifts badly against another's, so
 * this keeps the hue — and therefore the meaning — while moving lightness just
 * far enough to be legible. Returns `fg` unchanged when it already passes.
 */
export function readableOn(fg: string, bg: string, min: number = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;

  const toward = isLight(bg) ? '#000000' : '#FFFFFF';
  let best = fg;
  for (let step = 1; step <= 20; step++) {
    best = mix(fg, toward, step / 20);
    if (contrast(best, bg) >= min) return best;
  }
  return best;
}

// ── Wallpaper maths ──────────────────────────────────────────────────────────
// Text over a page wallpaper sits on two stacked translucent layers: the veil
// (whole page) and, outside a card, the scrim (behind the text block). Both are
// flattened against a mid-tone photograph, which is the worst realistic case
// and the only part of the stack we control.

const MID_PHOTO = '#808080';

/** Flatten a translucent layer over an assumed background. */
export function flatten(hex: string, alpha: number, under: string = MID_PHOTO): string {
  return mix(under, hex, Math.max(0, Math.min(1, alpha)));
}

/** The veil alone — what a bare wallpaper area looks like. */
export const veiledSurface = (bg: string, veil: number): string => flatten(bg, veil);

/** Veil plus scrim — what text placed outside a card actually sits on. */
export const scrimmedSurface = (bg: string, veil: number, scrim: number): string =>
  flatten(bg, scrim, veiledSurface(bg, veil));

/** How much of the wallpaper survives the veil, as a percentage. */
export const wallpaperVisibility = (veil: number): number => Math.round((1 - veil) * 100);

/** The page veil gradient. Bottom is always a touch heavier than the top. */
export const veilGradient = (bg: string, veil: number): string =>
  `linear-gradient(180deg, ${withAlpha(bg, veil)} 0%, ${withAlpha(bg, Math.min(1, veil + 0.16))} 100%)`;

// ── Auditing ─────────────────────────────────────────────────────────────────
/** Opacity of the plate drawn behind text that sits outside a card. */
export const SCRIM_ALPHA = 0.9;

/** The default wallpaper veil, used when nothing overrides it. */
export const DEFAULT_VEIL = 0.42;

export interface ContrastCheck {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
}

/** The token fields the audit reads. Structural so it accepts a ramp or composed tokens. */
export interface AuditableTokens {
  bg: string;
  paper: string;
  ink: string;
  inkSoft: string;
  muted: string;
  rust: string;
}

/**
 * The pairs that actually matter, including text over a scrimmed wallpaper.
 *
 * The rule this design depends on: text never sits on a bare photo. Anything
 * outside a card gets a scrim behind it, so legibility comes from the scrim
 * rather than from cranking the veil up until the photo disappears.
 */
export function auditTokens(t: AuditableTokens, veil: number = DEFAULT_VEIL): ContrastCheck[] {
  const plate = scrimmedSurface(t.bg, veil, SCRIM_ALPHA);
  const checks: Array<[string, string, string, number]> = [
    ['Body text on card', t.ink, t.paper, 7],
    ['Secondary text on card', t.inkSoft, t.paper, 4.5],
    ['Muted text on card', t.muted, t.paper, 4.5],
    ['Body text on page', t.ink, t.bg, 7],
    ['Muted text on page', t.muted, t.bg, 4.5],
    ['Accent on card', t.rust, t.paper, 3],
    ['Accent on page', t.rust, t.bg, 3],
    ['Heading on scrim over wallpaper', t.ink, plate, 4.5],
    ['Caption on scrim over wallpaper', t.muted, plate, 4.5],
  ];
  return checks.map(([label, fg, bg, min]) => {
    const ratio = contrast(fg, bg);
    return { label, fg, bg, ratio, min, pass: ratio >= min };
  });
}

/** Worst-case check for a token set, measured as distance below its own target. */
export function worstCheck(t: AuditableTokens, veil?: number): ContrastCheck {
  return auditTokens(t, veil).reduce((w, c) => (c.ratio / c.min < w.ratio / w.min ? c : w));
}
