import { useThemeMode } from '../context/ThemeContext'
import { tokensFor } from '../theme/tokens'
import { withAlpha } from '../theme/contrast'
import { CARD_RADIUS, cardShadow } from '../theme/controls'
import type { AgentName, InsightTone, LogLevel } from './types'

export function useObservabilityTheme() {
  const { mode, palette } = useThemeMode()
  const dark = mode === 'dark'
  const t = tokensFor(dark, palette)
  const accent = dark ? t.rustLight : t.rustDark

  const level: Record<LogLevel, string> = {
    debug: dark ? '#9FB7CA' : '#456578',
    info: dark ? '#75C9A5' : '#267354',
    warn: dark ? '#E7BE64' : '#8A6210',
    error: dark ? '#F08A86' : '#A53D38',
  }
  const source: Record<AgentName, string> = {
    unifi: dark ? '#65C7E6' : '#197899',
    ups: dark ? '#E7BE64' : '#8A6210',
    shutdown: dark ? '#F08A86' : '#A53D38',
    synology: dark ? '#75C9A5' : '#267354',
    sonarr: dark ? '#9FA9F4' : '#5363B8',
  }
  const insight: Record<InsightTone, string> = {
    info: dark ? '#65C7E6' : '#197899',
    warning: level.warn,
    critical: level.error,
    positive: level.info,
  }

  return {
    dark,
    t,
    accent,
    level,
    source,
    insight,
    panel: {
      bgcolor: t.paper,
      border: `1px solid ${t.line}`,
      borderRadius: CARD_RADIUS,
      boxShadow: cardShadow(dark),
    },
    inset: {
      bgcolor: withAlpha(t.bg, dark ? 0.72 : 0.58),
      border: `1px solid ${t.line}`,
      borderRadius: '10px',
    },
    selection: withAlpha(accent, dark ? 0.16 : 0.1),
    hover: withAlpha(accent, dark ? 0.1 : 0.07),
    grid: withAlpha(t.line, dark ? 0.78 : 0.9),
  }
}

export type ObservabilityTheme = ReturnType<typeof useObservabilityTheme>
