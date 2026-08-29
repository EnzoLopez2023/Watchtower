import type { AgentName, LogLevel, TimePreset, TimeRange } from './types'

export const AGENTS: { id: AgentName; label: string; short: string }[] = [
  { id: 'unifi', label: 'UniFi', short: 'UniFi' },
  { id: 'ups', label: 'UPS', short: 'UPS' },
  { id: 'shutdown', label: 'Shutdown watchdog', short: 'Shutdown' },
  { id: 'synology', label: 'Synology', short: 'Synology' },
  { id: 'sonarr', label: 'Sonarr', short: 'Sonarr' },
]

export const LEVELS: { id: LogLevel; label: string }[] = [
  { id: 'debug', label: 'Debug' },
  { id: 'info', label: 'Info' },
  { id: 'warn', label: 'Warning' },
  { id: 'error', label: 'Error' },
]

export const PRESET_MS: Record<Exclude<TimePreset, 'custom'>, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export function presetRange(preset: Exclude<TimePreset, 'custom'>, now = Date.now()): TimeRange {
  return { from: now - PRESET_MS[preset], to: now, preset }
}

export function formatTimestamp(timestamp: number, includeDate = true) {
  return new Intl.DateTimeFormat(undefined, {
    ...(includeDate ? { month: 'short', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

export function formatFullTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(timestamp)
}

export function formatDelay(milliseconds: number | null | undefined) {
  if (milliseconds == null) return '—'
  if (milliseconds < 0) return 'Clock ahead'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
  }
  if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1)} min`
  return `${(milliseconds / 3_600_000).toFixed(1)} hr`
}

export function formatCount(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value)
}

export function formatPercent(value: number, digits = 1) {
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatDelta(value: number | null, unit: 'percent' | 'points' = 'percent') {
  if (value == null) return 'No prior baseline'
  const amount = Math.abs(value * 100).toFixed(1)
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'unchanged'
  if (direction === 'unchanged') return 'Unchanged from prior window'
  return `${direction} ${amount}${unit === 'points' ? ' points' : '%'}`
}

export function agentLabel(agent: AgentName) {
  return AGENTS.find((entry) => entry.id === agent)?.label ?? agent
}

export function levelLabel(level: LogLevel) {
  return LEVELS.find((entry) => entry.id === level)?.label ?? level
}

export function toLocalInput(timestamp: number) {
  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(timestamp - offset).toISOString().slice(0, 16)
}

export function fromLocalInput(value: string, through = false) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return null
  return through ? timestamp + 60_000 - 1 : timestamp
}

export function rangeLabel(range: TimeRange) {
  if (range.preset !== 'custom') return `Last ${range.preset}`
  const format = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${format.format(range.from)} – ${format.format(range.to)}`
}
