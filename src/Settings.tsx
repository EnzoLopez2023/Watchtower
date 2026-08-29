/**
 * Settings — appearance, per page.
 *
 * The controls write through ThemeContext, which persists to localStorage for
 * an instant first paint and mirrors to `/api/settings` under the signed-in
 * identity. A rejected save is shown, never hidden: the shell renders a
 * degraded banner and the page keeps working on the local copy.
 */

import { useMemo, useState } from 'react';
import {
  Box,
  Button,
  MenuItem,
  Select,
  Slider,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import {
  DarkModeOutlined as DarkIcon,
  LightModeOutlined as LightIcon,
  RestartAlt as ResetIcon,
} from '@mui/icons-material';
import PageHero from './components/PageHero';
import SectionLabel from './components/SectionLabel';
import { DegradedBanner } from './components/StateBlocks';
import { useThemeMode } from './context/ThemeContext';
import { useUserPermissions } from './context/UserPermissionsContext';
import { tokensFor } from './theme/tokens';
import { CARD_HOVER_SX, CARD_RADIUS, pageShellSx, toggleGroupSx } from './theme/controls';
import { contrast, withAlpha } from './theme/contrast';
import { FONT_PAIRINGS } from './theme/fonts';
import { ACCENTS, PALETTES, rampFor, swatchesFor } from './theme/catalog';
import type { InkMode } from './theme/catalog';
import {
  VEIL_MAX,
  VEIL_MIN,
  clearAllAppearance,
  clearPageAppearance,
  resolveAppearance,
  setDefaultAppearance,
  setPageAppearance,
} from './theme/appearance';
import { APP_VIEWS, type AppView } from './types/AppView';
import { NAV_ROUTES } from './app/navigation';
import { identityLabel } from './services/identity';

const INK_MODES: { id: InkMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'soft', label: 'Softer' },
  { id: 'strong', label: 'Stronger' },
  { id: 'custom', label: 'Custom' },
];

const VIEW_LABEL: Record<AppView, string> = (() => {
  const out = {} as Record<AppView, string>;
  for (const view of APP_VIEWS) out[view] = view;
  for (const route of NAV_ROUTES) out[route.view] = route.label;
  return out;
})();

/** A labelled block of controls. Keeps the page one column on every width. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const { mode, palette } = useThemeMode();
  const t = tokensFor(mode === 'dark', palette);
  return (
    <Box component="section" sx={{ mb: 3 }}>
      <SectionLabel tone="soft">{title}</SectionLabel>
      {description && (
        <Typography sx={{ color: t.muted, fontSize: '0.85rem', mt: -1, mb: 1.5, maxWidth: 640 }}>
          {description}
        </Typography>
      )}
      <Box
        sx={{
          p: 2.25,
          borderRadius: CARD_RADIUS,
          bgcolor: t.paper,
          border: `1px solid ${t.line}`,
          ...CARD_HOVER_SX,
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export default function Settings() {
  const { mode, toggleMode, palette, appearance, setAppearance, syncError } = useThemeMode();
  const { identity, isAdmin, isHidden } = useUserPermissions();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);

  // "Which page am I editing" — `null` means the app-wide default, which is
  // what a page without its own pin inherits.
  const [selectedTarget, setSelectedTarget] = useState<AppView | 'default'>('default');

  // A page the user cannot open is not worth offering a theme for.
  const visibleRoutes = NAV_ROUTES.filter(
    (route) => (!route.adminOnly || isAdmin) && !isHidden(route.view),
  );

  // If the selected page is hidden while this screen is open, fall back to the
  // app-wide default rather than leaving the picker on a value it no longer offers.
  const target =
    selectedTarget === 'default' || visibleRoutes.some((route) => route.view === selectedTarget)
      ? selectedTarget
      : 'default';
  const view = target === 'default' ? null : target;

  // `appearance` is not read directly — resolveAppearance reads the module-level
  // copy the provider publishes — but it must stay in the deps or editing a
  // setting would leave this page showing the previous resolution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => resolveAppearance(isDark, view), [isDark, view, appearance]);
  const page = view ? (appearance.perView[view] ?? {}) : appearance.defaults;

  const patch = (next: Parameters<typeof setPageAppearance>[2]) => {
    setAppearance(
      view ? setPageAppearance(appearance, view, next) : setDefaultAppearance(appearance, next),
    );
  };

  const clearTarget = () => {
    setAppearance(view ? clearPageAppearance(appearance, view) : clearAllAppearance(appearance));
  };

  const ramp = rampFor(resolved.palette, isDark);
  const bodyRatio = contrast(resolved.tokens.ink, resolved.tokens.paper);
  const captionRatio = contrast(resolved.tokens.muted, resolved.tokens.paper);

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        compact
        eyebrow="Watchtower"
        title="Settings"
        accentPhrase="Settings"
        subtitle={
          identity
            ? `Appearance for ${identityLabel(identity)}. Saved to your Watchtower profile, so it follows you between browsers.`
            : 'Appearance for this account, saved to your Watchtower profile.'
        }
        actions={
          <Button
            size="small"
            variant="outlined"
            startIcon={isDark ? <LightIcon /> : <DarkIcon />}
            onClick={toggleMode}
          >
            {isDark ? 'Light mode' : 'Dark mode'}
          </Button>
        }
      />

      {syncError && <DegradedBanner title="Not synced to the server" detail={syncError} />}

      <Section
        title="What you are changing"
        description="Every knob below applies to one page, or to the app-wide default that any unpinned page inherits."
      >
        <Select
          size="small"
          fullWidth
          value={target}
          aria-label="Page to configure"
          onChange={(event: SelectChangeEvent<string>) =>
            setSelectedTarget(event.target.value as AppView | 'default')
          }
          sx={{ maxWidth: 420, bgcolor: t.surface }}
        >
          <MenuItem value="default">App-wide default</MenuItem>
          {visibleRoutes.map((route) => (
            <MenuItem key={route.view} value={route.view}>
              {route.label}
            </MenuItem>
          ))}
        </Select>
        <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.8rem', color: t.muted }}>
            {view
              ? resolved.pinned
                ? `${VIEW_LABEL[view]} has its own settings.`
                : `${VIEW_LABEL[view]} is inheriting the default.`
              : 'Editing the app-wide default.'}
          </Typography>
          <Button size="small" startIcon={<ResetIcon />} onClick={clearTarget} sx={{ color: t.muted }}>
            {view ? 'Clear this page' : 'Clear all pages'}
          </Button>
        </Box>
      </Section>

      <Section title="Palette" description="Surfaces and accent, in both light and dark.">
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
            gap: 1.25,
          }}
        >
          {PALETTES.map((option) => {
            const optionRamp = rampFor(option, isDark);
            const selected = resolved.palette.id === option.id;
            return (
              <Box
                key={option.id}
                component="button"
                type="button"
                aria-pressed={selected}
                onClick={() => patch({ paletteId: option.id })}
                sx={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  p: 1.5,
                  borderRadius: CARD_RADIUS,
                  bgcolor: optionRamp.paper,
                  color: optionRamp.ink,
                  border: `2px solid ${selected ? optionRamp.rust : withAlpha(optionRamp.line, 0.9)}`,
                  font: 'inherit',
                  display: 'grid',
                  gap: 0.75,
                }}
              >
                <Typography sx={{ fontWeight: 800, fontSize: '0.85rem', color: optionRamp.ink }}>
                  {option.name}
                </Typography>
                <Typography sx={{ fontSize: '0.72rem', color: optionRamp.muted, lineHeight: 1.45 }}>
                  {option.blurb}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25 }} aria-hidden>
                  {swatchesFor(optionRamp).map((swatch, index) => (
                    <Box
                      key={`${option.id}-${index}`}
                      sx={{ width: 18, height: 8, borderRadius: 1, bgcolor: swatch }}
                    />
                  ))}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Section>

      <Section
        title="Accent"
        description="Optional. Leave on the palette default unless you want one palette's accent on another's surfaces."
      >
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant={page.accentId ? 'outlined' : 'contained'}
            onClick={() => patch({ accentId: '' })}
          >
            Palette default
          </Button>
          {ACCENTS.map((accent) => {
            const triad = isDark ? accent.dark : accent.light;
            const selected = page.accentId === accent.id;
            return (
              <Button
                key={accent.id}
                size="small"
                variant={selected ? 'contained' : 'outlined'}
                onClick={() => patch({ accentId: accent.id })}
                sx={{
                  borderColor: triad.rust,
                  ...(selected ? { bgcolor: triad.rust } : { color: triad.rust }),
                }}
              >
                {accent.name}
              </Button>
            );
          })}
        </Box>
      </Section>

      <Section title="Typography" description="A heading face and a body face, chosen together.">
        <Box sx={{ display: 'grid', gap: 0.75 }}>
          {FONT_PAIRINGS.map((font) => {
            const selected = resolved.font.id === font.id;
            return (
              <Box
                key={font.id}
                component="button"
                type="button"
                aria-pressed={selected}
                onClick={() => patch({ fontId: font.id })}
                sx={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  px: 1.5,
                  py: 1.15,
                  borderRadius: '10px',
                  bgcolor: selected ? withAlpha(t.rust, isDark ? 0.2 : 0.12) : t.surface,
                  border: `1px solid ${selected ? t.rust : t.line}`,
                  font: 'inherit',
                }}
              >
                <Typography sx={{ fontFamily: font.heading, fontWeight: 700, color: t.ink }}>
                  {font.name}
                </Typography>
                <Typography sx={{ fontFamily: font.body, fontSize: '0.8rem', color: t.muted }}>
                  {font.blurb}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Section>

      <Section
        title="Text colour"
        description="Adjusts the whole ink ladder, so secondary and caption text stay proportional."
      >
        <ToggleButtonGroup
          exclusive
          value={resolved.inkMode}
          onChange={(_event, next: InkMode | null) => next && patch({ inkMode: next })}
          aria-label="Text colour"
          sx={toggleGroupSx(t)}
        >
          {INK_MODES.map((option) => (
            <ToggleButton key={option.id} value={option.id}>
              {option.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        {resolved.inkMode === 'custom' && (
          <TextField
            size="small"
            label="Body text colour"
            value={page.inkCustom ?? ramp.ink}
            onChange={(event) => patch({ inkCustom: event.target.value })}
            sx={{ mt: 1.5, maxWidth: 220, display: 'block' }}
          />
        )}

        <TextField
          size="small"
          label="Caption colour (optional)"
          value={page.captionCustom ?? ''}
          placeholder={ramp.muted}
          onChange={(event) => patch({ captionCustom: event.target.value })}
          sx={{ mt: 1.5, maxWidth: 220, display: 'block' }}
        />

        <Box sx={{ mt: 2, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: '0.78rem', color: bodyRatio >= 7 ? t.inkSoft : '#C4A040' }}>
            Body on card: {bodyRatio.toFixed(2)}:1 {bodyRatio >= 7 ? '(AAA)' : '(below 7:1)'}
          </Typography>
          <Typography sx={{ fontSize: '0.78rem', color: captionRatio >= 4.5 ? t.inkSoft : '#C4A040' }}>
            Caption on card: {captionRatio.toFixed(2)}:1 {captionRatio >= 4.5 ? '(AA)' : '(below 4.5:1)'}
          </Typography>
        </Box>
      </Section>

      <Section
        title="Backdrop"
        description="How heavily the page canvas is veiled. Only visible on a deployment that ships wallpapers."
      >
        <Slider
          value={resolved.veil}
          min={VEIL_MIN}
          max={VEIL_MAX}
          step={0.01}
          onChange={(_event, value: number | number[]) =>
            patch({ veil: Array.isArray(value) ? value[0] : value })
          }
          valueLabelDisplay="auto"
          valueLabelFormat={(value: number) => `${Math.round(value * 100)}%`}
          aria-label="Backdrop veil"
          sx={{ maxWidth: 420, color: t.rust }}
        />
      </Section>
    </Box>
  );
}
