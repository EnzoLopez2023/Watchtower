/**
 * ThemeContext.tsx — the app-local theme provider.
 *
 * Owns the light/dark mode, the open view, and the per-page appearance
 * settings, and turns all three into the MUI theme. The palette itself —
 * surfaces, accents, font and text colour — is resolved in theme/appearance.ts;
 * this file only wires the result into MUI.
 *
 * Appearance is Watchtower's own: it persists to localStorage for an instant
 * first paint, and mirrors to `/api/settings` under the signed-in identity so
 * the choice follows the user between browsers.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { CssBaseline } from '@mui/material';
import { useIsAuthenticated } from '@azure/msal-react';
import type { AppView } from '../types/AppView';
import { tokensFor, type PaletteName } from '../theme/tokens';
import { paletteGradients } from '../theme/palettes';
import { CARD_RADIUS, SHAPE_BORDER_RADIUS, cardShadow, cardShadowHover } from '../theme/controls';
import { IOS_MODE, IOS_SQUIRCLE, iosGlass } from '../theme/ios';
import {
  DEFAULT_APPEARANCE,
  loadAppearance,
  normaliseAppearance,
  resolveAppearance,
  saveAppearance,
  setActiveAppearance,
  setCurrentView,
  type AppearanceSettings,
} from '../theme/appearance';
import { ensureFontLoaded } from '../theme/fonts';
import { withAlpha } from '../theme/contrast';
import { fetchSettings, saveSetting } from '../services/settings';

type Mode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: Mode;
  toggleMode: () => void;
  /** Active app palette seed. A page requests one on mount and restores on unmount. */
  palette: PaletteName;
  setPalette: (p: PaletteName) => void;
  /** The view currently on screen. Drives which page's appearance is resolved. */
  view: AppView | null;
  setView: (v: AppView | null) => void;
  /** Per-page palette, accent, font, text colour and veil. */
  appearance: AppearanceSettings;
  setAppearance: (s: AppearanceSettings) => void;
  resetAppearance: () => void;
  /** Non-null when the server copy of the appearance could not be saved. */
  syncError: string | null;
}

const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'light',
  toggleMode: () => {},
  palette: 'wine',
  setPalette: () => {},
  view: null,
  setView: () => {},
  appearance: DEFAULT_APPEARANCE,
  setAppearance: () => {},
  resetAppearance: () => {},
  syncError: null,
});

export const useThemeMode = () => useContext(ThemeModeContext);

/**
 * Take over the app palette seed for as long as the calling component is
 * mounted, restoring the default on unmount.
 */
export function usePalette(p: PaletteName) {
  const { setPalette } = useThemeMode();
  useEffect(() => {
    setPalette(p);
    return () => setPalette('wine');
  }, [p, setPalette]);
}

// ── Theme factory ────────────────────────────────────────────────────────────

function buildTheme(mode: Mode, palette: PaletteName, view: AppView | null) {
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);
  // The whole app is pinned to the iOS visual mode. This is the MUI equivalent
  // of `setupIonicReact({ mode: 'ios' })`: `IOS_MODE` is the single switch, and
  // it drives the squircle corner scale here plus the frosted-glass surfaces in
  // the shell (src/theme/ios.ts, src/app/AppShell.tsx).
  void IOS_MODE;
  const g = paletteGradients(palette, isDark, view ?? undefined);
  const { font } = resolveAppearance(isDark, view, palette);
  ensureFontLoaded(font.id);

  const accentWash = withAlpha(t.rust, isDark ? 0.1 : 0.06);
  const accentRing = withAlpha(t.rust, isDark ? 0.18 : 0.12);

  return createTheme({
    palette: {
      mode,
      primary: {
        main: t.rust,
        light: t.rustLight,
        dark: t.rustDark,
        contrastText: isDark ? t.bg : '#FFFFFF',
      },
      secondary: {
        main: t.champagne,
        light: t.rustLight,
        dark: t.rustDark,
        contrastText: isDark ? t.bg : '#FFFFFF',
      },
      success: { main: isDark ? '#7CAE6A' : '#4F7A3E' },
      error: { main: isDark ? '#D47A6A' : '#B05945' },
      warning: { main: '#C4A040' },
      info: { main: isDark ? '#7AA8C4' : '#4A7A9B' },
      background: { default: t.bg, paper: t.paper },
      text: {
        primary: t.ink,
        secondary: t.muted,
        disabled: withAlpha(t.muted, 0.55),
      },
      divider: t.line,
    },
    typography: {
      fontFamily: font.body,
      h1: { fontFamily: font.heading, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.08 },
      h2: { fontFamily: font.heading, fontWeight: 700, letterSpacing: '-0.01em' },
      h3: { fontFamily: font.heading, fontWeight: 700 },
      h4: { fontFamily: font.heading, fontWeight: 700 },
      h5: { fontFamily: font.heading, fontWeight: 700 },
      h6: { fontWeight: 600 },
      body1: { fontSize: '0.95rem', lineHeight: 1.6 },
      body2: { fontSize: '0.875rem', lineHeight: 1.55 },
      caption: { fontSize: '0.8rem' },
    },
    // MUI multiplies a NUMERIC sx borderRadius by this value, so it sets the
    // corner scale for the whole app. Derived from CARD_RADIUS so the numeric
    // and string forms cannot drift apart.
    shape: { borderRadius: SHAPE_BORDER_RADIUS },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            color: t.ink,
            background: g.body,
            backgroundAttachment: 'fixed',
            minHeight: '100vh',
            // Card shadows live here as variables so CARD_HOVER_SX can be a
            // plain constant, applied by components that never receive isDark.
            '--card-shadow': cardShadow(isDark),
            '--card-shadow-hover': cardShadowHover(isDark),
            '--hearth-heading': font.heading,
            '--hearth-body': font.body,
            transition: 'background 0.5s ease',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          },
          '#root': { position: 'relative', minHeight: '100vh' },
          '#root::before, #root::after': {
            content: '""',
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: -1,
            borderRadius: '50%',
            filter: 'blur(64px)',
          },
          '#root::before': { top: -180, right: -120, width: 540, height: 540, background: g.blobTR },
          '#root::after': { bottom: -200, left: -160, width: 600, height: 600, background: g.blobBL },
          // Anything focused by keyboard gets a visible ring in the page accent.
          ':focus-visible': { outline: `2px solid ${t.rust}`, outlineOffset: 2 },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none' as const,
            borderRadius: '999px',
            fontWeight: 600,
            boxShadow: 'none',
            fontSize: '0.875rem',
            '&:hover': { boxShadow: 'none' },
          },
          containedPrimary: {
            backgroundColor: t.rust,
            color: isDark ? t.bg : '#FFFFFF',
            '&:hover': { backgroundColor: t.rustDark, filter: 'brightness(1.05)' },
          },
          outlinedPrimary: {
            borderColor: t.line,
            color: t.muted,
            '&:hover': { borderColor: t.rust, color: t.rust, backgroundColor: accentWash },
          },
        },
        defaultProps: { disableElevation: true },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: '10px',
              fontSize: '0.95rem',
              backgroundColor: t.paper,
              '& fieldset': { borderColor: t.line },
              '&:hover fieldset': { borderColor: t.rust },
              '&.Mui-focused fieldset': {
                borderColor: t.rust,
                boxShadow: `0 0 0 3px ${accentRing}`,
              },
            },
          },
        },
      },
      MuiSelect: { styleOverrides: { outlined: { borderRadius: '10px' } } },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: '999px',
            fontWeight: 500,
            fontSize: '0.8rem',
            backgroundColor: t.surface,
            color: t.ink,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: CARD_RADIUS,
            backgroundImage: 'none',
            backgroundColor: t.paper,
            boxShadow: cardShadow(isDark),
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: CARD_RADIUS,
            background: g.card,
            border: `1px solid ${t.line}`,
            boxShadow: isDark
              ? `inset 0 1px 0 ${withAlpha(t.champagne, 0.1)}, ${cardShadow(true)}`
              : `inset 0 1px 0 rgba(255,255,255,0.85), ${cardShadow(false)}`,
            transition: 'transform 0.18s, box-shadow 0.22s, border-color 0.18s',
            '&:hover': {
              boxShadow: isDark
                ? `inset 0 1px 0 ${withAlpha(t.champagne, 0.14)}, 0 20px 40px -16px ${withAlpha(t.rust, 0.45)}, 0 6px 14px -6px rgba(0,0,0,0.45)`
                : `inset 0 1px 0 rgba(255,255,255,0.95), 0 18px 36px -16px ${withAlpha(t.rust, 0.3)}, 0 6px 14px -6px ${withAlpha(t.ink, 0.12)}`,
            },
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: CARD_RADIUS,
            boxShadow: isDark
              ? '0 24px 64px rgba(0,0,0,0.6)'
              : `0 24px 64px ${withAlpha(t.ink, 0.2)}`,
            backgroundColor: t.paper,
          },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: t.line } } },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: isDark ? t.surface : t.bg,
            color: t.ink,
            boxShadow: 'none',
            borderBottom: `1px solid ${t.line}`,
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: '8px',
            fontSize: '0.78rem',
            backgroundColor: isDark ? t.paper : t.inkSoft,
            color: isDark ? t.ink : t.paper,
          },
        },
      },
      // iOS-style context menus: squircle corners over frosted glass.
      MuiMenu: {
        styleOverrides: {
          paper: {
            ...iosGlass(t, isDark),
            borderRadius: IOS_SQUIRCLE,
            backgroundImage: 'none',
          },
        },
      },
    },
  });
}

// ── Provider ─────────────────────────────────────────────────────────────────

const MODE_KEY = 'watchtower.theme-mode';

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* private mode */
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [palette, setPaletteState] = useState<PaletteName>('wine');
  const [view, setViewState] = useState<AppView | null>(null);
  const [appearance, setAppearanceState] = useState<AppearanceSettings>(loadAppearance);
  const [syncError, setSyncError] = useState<string | null>(null);
  const hydrated = useRef(false);

  // Publish during render, before any child reads tokensFor. Doing this in an
  // effect would leave the first paint on stale tokens.
  setActiveAppearance(appearance);
  setCurrentView(view);

  // Server copy wins on first load: the local one only exists so the first
  // paint is not unstyled.
  useEffect(() => {
    if (!isAuthenticated || hydrated.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await fetchSettings();
        if (cancelled) return;
        if (settings.appearance) {
          const next = normaliseAppearance(settings.appearance);
          setActiveAppearance(next);
          saveAppearance(next);
          setAppearanceState(next);
        }
        setSyncError(null);
      } catch {
        // A settings failure must not blank the app: the local copy stands and
        // the shell shows the degraded state.
        if (!cancelled) setSyncError('Saved appearance could not be loaded from the server.');
      } finally {
        hydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const persist = useCallback((next: AppearanceSettings) => {
    setActiveAppearance(next);
    saveAppearance(next);
    setAppearanceState(next);
    void saveSetting('appearance', next)
      .then(() => setSyncError(null))
      .catch(() => setSyncError('Appearance saved on this device only — the server rejected it.'));
  }, []);

  const resetAppearance = useCallback(() => {
    persist({ version: 2, defaults: {}, perView: {} });
  }, [persist]);

  const toggleMode = useCallback(() => {
    setMode((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  const setPalette = useCallback((p: PaletteName) => setPaletteState(p), []);
  const setView = useCallback((v: AppView | null) => setViewState(v), []);

  const theme = useMemo(
    () => {
      void appearance;
      return buildTheme(mode, palette, view);
    },
    // `appearance` is read through tokensFor rather than directly, so it has to
    // be named here or the theme keeps the previous page's tokens.
    [mode, palette, view, appearance],
  );

  const ctxValue = useMemo(
    () => ({
      mode,
      toggleMode,
      palette,
      setPalette,
      view,
      setView,
      appearance,
      setAppearance: persist,
      resetAppearance,
      syncError,
    }),
    [mode, toggleMode, palette, setPalette, view, setView, appearance, persist, resetAppearance, syncError],
  );

  return (
    <ThemeModeContext.Provider value={ctxValue}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}
