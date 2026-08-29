import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { motion } from 'framer-motion';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { VIEW_WALLPAPER } from '../theme/palettes';
import { withAlpha, SCRIM_ALPHA } from '../theme/contrast';
import { CARD_RADIUS } from '../theme/controls';
import { heroStagger, heroItem } from '../motion/variants';
import { useParallax, useReverseParallax } from '../motion/useParallax';
import Embers from './Embers';

interface PageHeroProps {
  /** Uppercase letter-spaced label above the title (e.g. "HOME MAINTENANCE"). */
  eyebrow: string;
  /** Headline text. The accentPhrase, if present, becomes italic + copper. */
  title: string;
  /** Optional phrase in `title` to italic-color-emphasize (case-sensitive substring). */
  accentPhrase?: string;
  /** Supporting paragraph below the title. */
  subtitle?: ReactNode;
  /** Right-aligned actions slot (buttons, chips, etc). */
  actions?: ReactNode;
  /**
   * Compact mode for dense tool pages (Chat, AI Test, Plex Command Center,
   * Excel Converter). Drops blobs + embers + underline, tightens spacing.
   * Keeps the eyebrow + title + subtitle so every page reads consistently.
   */
  compact?: boolean;
}

/**
 * Marketing-style page header used at the top of every primary Watchtower page.
 *
 * Eyebrow → serif headline (accent phrase in italic copper) →
 * subtitle → actions. Background carries two soft radial blobs + 3
 * slow-drifting embers.
 *
 * Staggers in on mount via heroStagger/heroItem (no-ops under reduced motion).
 */
export default function PageHero({
  eyebrow,
  title,
  accentPhrase,
  subtitle,
  actions,
  compact = false,
}: PageHeroProps) {
  const { mode, palette, view } = useThemeMode();
  const isDark = mode === 'dark';
  // Subtle parallax: hero drifts up + fades a touch as the page scrolls.
  // Embers drift in the opposite direction so they appear suspended.
  const heroParallax = useParallax(40);
  const emberDrift = useReverseParallax(28);

  // Colours come from the active tokens, so the hero follows whatever theme is
  // in force — app-wide or pinned to this page. These were hardcoded Wine
  // Cellar hex, which is why a themed page kept a plum headline and a subtitle
  // that measured 2.5-3.6:1 against the wallpaper.
  const t = tokensFor(isDark, palette);

  // The hero sits outside any card, directly on the wallpaper. Measured over a
  // veiled photo the accent's mid tone lands as low as 1.6:1, so the headline
  // phrase uses the mode-appropriate end of the accent triad (brighter on dark,
  // deeper on light) and the whole block gets a scrim. Every palette in the
  // catalog is audited against that scrim before it ships.
  const ACCENT   = isDark ? t.rustLight : t.rustDark;
  const TEXT_PRI = t.ink;
  const TEXT_SEC = t.inkSoft;

  // Only plate the hero when there is actually a photo behind it; on flat
  // backgrounds the page already provides the contrast.
  const hasWallpaper = !!(view && VIEW_WALLPAPER[view]);
  const scrim = withAlpha(t.bg, SCRIM_ALPHA);

  const titleSegments = (() => {
    if (!accentPhrase || !title.includes(accentPhrase)) return [{ text: title, accent: false }];
    const idx = title.indexOf(accentPhrase);
    const out: { text: string; accent: boolean }[] = [];
    if (idx > 0) out.push({ text: title.slice(0, idx), accent: false });
    out.push({ text: accentPhrase, accent: true });
    const tail = title.slice(idx + accentPhrase.length);
    if (tail) out.push({ text: tail, accent: false });
    return out;
  })();

  return (
    <motion.div
      style={{
        position: 'relative',
        marginBottom: compact ? 24 : 32,
        ...heroParallax,
      }}
    >
      {/* Soft gradient blobs + drifting embers — full hero only */}
      {!compact && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: '-24px -24px -16px -24px',
            pointerEvents: 'none',
            zIndex: 0,
            overflow: 'hidden',
          }}
        >
          <Box sx={{
            position: 'absolute', top: -100, left: '10%',
            width: 360, height: 360, borderRadius: '50%',
            // Light: warm champagne wash. Dark: plum bloom.
            background: isDark
              ? 'radial-gradient(circle, rgba(199,122,160,0.18) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(200,165,105,0.16) 0%, transparent 70%)',
            filter: 'blur(50px)',
          }} />
          <Box sx={{
            position: 'absolute', top: -60, right: '6%',
            width: 300, height: 300, borderRadius: '50%',
            background: isDark
              ? 'radial-gradient(circle, rgba(220,184,122,0.12) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(92,42,74,0.10) 0%, transparent 70%)',
            filter: 'blur(50px)',
          }} />
          <Embers yOffset={emberDrift} />
        </Box>
      )}

      <Box
        component={motion.div}
        variants={heroStagger}
        initial="initial"
        animate="animate"
        sx={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          // Stack on phones so the headline + subtitle get the full width
          // instead of being squeezed into a narrow column by the actions.
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'flex-start' },
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{
          minWidth: 0,
          flex: 1,
          // Frosted plate so the headline and subtitle stay legible over a
          // photo without having to crank the veil up and hide the photo.
          // Carries the shared card radius and shadow so the banner reads as
          // floating over the wallpaper, matching every other surface and
          // lining up with the sidebar beside it.
          ...(hasWallpaper && {
            bgcolor: scrim,
            backdropFilter: 'blur(6px)',
            borderRadius: CARD_RADIUS,
            boxShadow: 'var(--card-shadow)',
            px: { xs: 1.75, md: 2.25 },
            py: { xs: 1.5, md: 1.75 },
            border: `1px solid ${withAlpha(t.line, 0.6)}`,
          }),
        }}>
          {/* Eyebrow with leading ember dot */}
          <motion.div variants={heroItem}>
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.875, mb: 1 }}>
              <Box
                aria-hidden
                sx={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  backgroundColor: ACCENT,
                  boxShadow: `0 0 6px ${withAlpha(ACCENT, 0.6)}`,
                }}
              />
              <Typography sx={{
                fontSize: { xs: '0.62rem', md: '0.66rem' },
                fontWeight: 700,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: ACCENT,
              }}>
                {eyebrow}
              </Typography>
            </Box>
          </motion.div>

          {/* Headline — accent phrase becomes italic copper */}
          <motion.div variants={heroItem}>
            <Typography
              component="h1"
              sx={{
                fontFamily: 'var(--hearth-heading)',
                fontSize: compact
                  ? { xs: '1.5rem', md: '1.8rem' }
                  : 'clamp(1.85rem, 1.4rem + 1.8vw, 2.5rem)',
                fontWeight: 700,
                color: TEXT_PRI,
                letterSpacing: '-0.02em',
                lineHeight: 1.12,
                margin: 0,
              }}
            >
              {titleSegments.map((seg, i) =>
                seg.accent ? (
                  <Box key={i} component="em" sx={{
                    fontStyle: 'italic',
                    color: ACCENT,
                    // Subtle text-shadow makes the italic phrase feel like it's softly glowing.
                    textShadow: `0 0 18px ${withAlpha(ACCENT, isDark ? 0.25 : 0.18)}`,
                  }}>
                    {seg.text}
                  </Box>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </Typography>
          </motion.div>

          {/* Hairline copper underline — full hero only */}
          {!compact && (
            <motion.div variants={heroItem}>
              <Box sx={{
                mt: 1.25,
                width: 64,
                height: 1.5,
                borderRadius: 1,
                background: `linear-gradient(90deg, ${ACCENT} 0%, transparent 100%)`,
                opacity: 0.7,
              }} />
            </motion.div>
          )}

          {subtitle && (
            <motion.div variants={heroItem}>
              <Typography sx={{
                color: TEXT_SEC,
                mt: 1.5,
                mb: 0,
                fontSize: { xs: '0.9rem', md: '0.98rem' },
                lineHeight: 1.6,
                maxWidth: 580,
                // Halo only helps on a flat background; over the scrim it just
                // muddies the edges, and the plate already carries the contrast.
                textShadow: hasWallpaper
                  ? 'none'
                  : `0 1px 3px ${withAlpha(t.bg, isDark ? 0.55 : 0.9)}`,
              }}>
                {subtitle}
              </Typography>
            </motion.div>
          )}
        </Box>

        {actions && (
          <Box
            component={motion.div}
            variants={heroItem}
            sx={{
              display: 'flex',
              // On phones the actions drop below the headline and each button
              // goes full-width so nothing overlaps the title.
              flexDirection: { xs: 'column', sm: 'row' },
              gap: 1,
              alignItems: { xs: 'stretch', sm: 'center' },
              flexShrink: 0,
              width: { xs: '100%', sm: 'auto' },
              '& > *': { width: { xs: '100%', sm: 'auto' } },
            }}
          >
            {actions}
          </Box>
        )}
      </Box>
    </motion.div>
  );
}
