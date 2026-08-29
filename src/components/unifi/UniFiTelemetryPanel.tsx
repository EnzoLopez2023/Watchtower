import { apiFetch } from '../../services/apiClient';
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Skeleton,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from '@mui/material'
import {
  CheckCircle as HealthyIcon,
  CloudQueue as IspIcon,
  Dns as ProbeIcon,
  Memory as DeviceIcon,
  Router as WanIcon,
  Timeline as TimelineIcon,
  Warning as WarningIcon,
} from '@mui/icons-material'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { HearthTokens } from '../../theme/tokens'
import { CARD_HOVER_SX, CARD_RADIUS, toggleGroupSx } from '../../theme/controls'
import OutagePostmortemsPanel from './OutagePostmortemsPanel'

type RangeKey = '24h' | '7d' | '30d'
type TimelineKind = 'wan' | 'probe' | 'activity' | 'port' | 'snmp'
type TimelineFilter = 'all' | TimelineKind

interface TelemetryDevice {
  id: string | null
  name: string | null
  model: string | null
  online: boolean
  uptime: number | null
  cpu?: number | null
  mem?: number | null
  temperature?: number | null
  poe_power?: number | null
  poe_active_ports: number
}

interface WanPoint {
  received_at: number
  wan_key: string
  name: string | null
  active: number
  internet_reachable: number | null
  latency_ms: number | null
  availability: number | null
  uptime_seconds: number | null
  downtime_seconds: number | null
}

interface IspPoint {
  metric_time: number
  isp_name: string | null
  isp_asn: string | null
  latency_ms: number | null
  max_latency_ms: number | null
  packet_loss_pct: number | null
  download_kbps: number | null
  upload_kbps: number | null
  uptime_pct: number | null
  downtime: number | null
}

interface ProbePoint {
  received_at: number
  kind: string
  target_id: string
  target_label: string | null
  ok: number
  latency_ms: number | null
  status_code: number | null
  error: string | null
}

interface ActivityEvent {
  id: number
  event_ts: number
  key: string | null
  subsystem: string | null
  message: string | null
  title: string | null
  severity: string | null
}

interface PortPoint {
  received_at: number
  device_id: string
  device_name: string | null
  port_idx: number
  port_name: string | null
  connected: string | null
  up: number | null
  speed: number | null
  full_duplex: number | null
  poe_active: number | null
  poe_power: number | null
  rx_errors: number | null
  tx_errors: number | null
  rx_dropped: number | null
  tx_dropped: number | null
  stp_state: string | null
}

interface SnmpInterfaceEvent {
  received_at: number
  device_id: string
  device_label: string | null
  if_index: number
  name: string | null
  previous_admin_up: number | null
  admin_up: number | null
  previous_oper_up: number | null
  oper_up: number | null
  previous_speed_bps: number | null
  speed_bps: number | null
  in_bps: number | null
  out_bps: number | null
  in_errors_delta: number
  out_errors_delta: number
  in_discards_delta: number
  out_discards_delta: number
}

interface LatestSnmpDevice {
  id: string
  label: string | null
  host: string | null
  ok: boolean
  error: string | null
  system?: { uptime_s?: number | null }
  interfaces: Array<{
    if_index: number
    name: string | null
    admin_up: boolean
    oper_up: boolean
    speed_bps: number | null
    in_bps: number | null
    out_bps: number | null
    in_errors: number | null
    out_errors: number | null
    in_discards: number | null
    out_discards: number | null
  }>
}

interface ObserverResponse {
  present: boolean
  observers: Array<{
    age_seconds: number
    stale: boolean
    payload: {
      probes: Array<{ kind: string; id: string; label: string; ok: boolean; latency_ms: number | null }>
      snmp_devices: LatestSnmpDevice[]
    }
  }>
}

interface TelemetryData {
  wan: WanPoint[]
  isp: IspPoint[]
  probes: ProbePoint[]
  activity: ActivityEvent[]
  ports: PortPoint[]
  snmpEvents: SnmpInterfaceEvent[]
  observer: ObserverResponse | null
}

interface TimelineEntry {
  id: string
  ts: number
  kind: TimelineKind
  title: string
  detail: string
  tone: 'ok' | 'info' | 'warn' | 'critical'
}

const EMPTY: TelemetryData = {
  wan: [],
  isp: [],
  probes: [],
  activity: [],
  ports: [],
  snmpEvents: [],
  observer: null,
}

const rangeMs: Record<RangeKey, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const fmtNumber = (value: number | null | undefined, digits = 0) => (
  value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits })
)

const fmtBps = (value: number | null | undefined) => {
  if (value == null) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} Gbps`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} Mbps`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)} Kbps`
  return `${Math.round(value)} bps`
}

const fmtUptime = (seconds: number | null | undefined) => {
  if (seconds == null) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`
}

const eventTone = (severity: string | null): TimelineEntry['tone'] => {
  const value = String(severity ?? '').toUpperCase()
  if (value === 'VERY_HIGH' || value === 'CRITICAL') return 'critical'
  if (value === 'HIGH' || value === 'MEDIUM') return 'warn'
  return 'info'
}

function probeTransitions(points: ProbePoint[]): TimelineEntry[] {
  const byTarget = new Map<string, ProbePoint[]>()
  for (const point of points) {
    const key = `${point.kind}:${point.target_id}`
    byTarget.set(key, [...(byTarget.get(key) ?? []), point])
  }
  const entries: TimelineEntry[] = []
  for (const [key, rows] of byTarget) {
    rows.sort((a, b) => a.received_at - b.received_at)
    const incidents: Array<{
      start: number
      end: number | null
      failures: number
      label: string
      kind: string
      error: string | null
    }> = []
    let current: typeof incidents[number] | null = null
    for (const row of rows) {
      if (!row.ok) {
        if (!current) {
          current = {
            start: row.received_at,
            end: null,
            failures: 0,
            label: row.target_label ?? row.target_id,
            kind: row.kind,
            error: row.error ?? (row.status_code ? `HTTP ${row.status_code}` : null),
          }
        }
        current.failures += 1
      } else if (current) {
        current.end = row.received_at
        incidents.push(current)
        current = null
      }
    }
    if (current) incidents.push(current)
    const merged: typeof incidents = []
    for (const incident of incidents) {
      const prior = merged.at(-1)
      if (prior?.end != null && incident.start - prior.end <= 5 * 60 * 1000) {
        prior.end = incident.end
        prior.failures += incident.failures
        prior.error = incident.error ?? prior.error
      } else {
        merged.push({ ...incident })
      }
    }
    for (const incident of merged) {
      const end = incident.end ?? Date.now()
      const durationMs = Math.max(0, end - incident.start)
      if (incident.failures === 1 && durationMs < 2 * 60 * 1000) continue
      const minutes = Math.max(1, Math.round(durationMs / 60000))
      entries.push({
        id: `probe:${key}:${incident.start}`,
        ts: incident.start,
        kind: 'probe',
        title: `${incident.label} ${incident.end ? 'instability' : 'unavailable'}`,
        detail: `${incident.failures} failed ${incident.kind.toUpperCase()} samples over ${minutes} min${incident.end ? ' · recovered' : ''}${incident.error ? ` · ${incident.error}` : ''}`,
        tone: incident.end ? 'warn' : 'critical',
      })
    }
  }
  return entries
}

function wanTransitions(points: WanPoint[]): TimelineEntry[] {
  const byTime = new Map<number, WanPoint[]>()
  for (const point of points) byTime.set(point.received_at, [...(byTime.get(point.received_at) ?? []), point])
  let prior: string | null = null
  const entries: TimelineEntry[] = []
  for (const [ts, rows] of [...byTime].sort(([a], [b]) => a - b)) {
    const active = rows.find((point) => point.active === 1)
    const key = active?.wan_key ?? null
    if (prior == null) { prior = key; continue }
    if (key === prior) continue
    entries.push({
      id: `wan:${ts}`,
      ts,
      kind: 'wan',
      title: key ? `Traffic moved to ${active?.name ?? key}` : 'No routed WAN',
      detail: active?.latency_ms != null
        ? `${Math.round(active.latency_ms)} ms · ${fmtNumber(active.availability, 1)}% availability`
        : key ? 'Uplink route changed' : 'Every uplink was unavailable',
      tone: key === 'WAN' ? 'ok' : key ? 'warn' : 'critical',
    })
    prior = key
  }
  return entries
}

function portTransitions(points: PortPoint[]): TimelineEntry[] {
  const byPort = new Map<string, PortPoint[]>()
  for (const point of points) {
    const key = `${point.device_id}:${point.port_idx}`
    byPort.set(key, [...(byPort.get(key) ?? []), point])
  }
  const entries: TimelineEntry[] = []
  for (const [key, rows] of byPort) {
    rows.sort((a, b) => a.received_at - b.received_at)
    let prior: PortPoint | null = null
    for (const row of rows) {
      if (!prior) { prior = row; continue }
      const stateChanged = row.up !== prior.up
        || row.speed !== prior.speed
        || row.poe_active !== prior.poe_active
        || row.stp_state !== prior.stp_state
        || row.connected !== prior.connected
      const errorDelta = Math.max(0, (row.rx_errors ?? 0) - (prior.rx_errors ?? 0))
        + Math.max(0, (row.tx_errors ?? 0) - (prior.tx_errors ?? 0))
      const dropDelta = Math.max(0, (row.rx_dropped ?? 0) - (prior.rx_dropped ?? 0))
        + Math.max(0, (row.tx_dropped ?? 0) - (prior.tx_dropped ?? 0))
      const countersIncreased = errorDelta > 0 || dropDelta > 0
      if (!stateChanged && !countersIncreased) { prior = row; continue }
      const counterDetail = countersIncreased
        ? `+${fmtNumber(errorDelta)} errors, +${fmtNumber(dropDelta)} drops`
        : null
      entries.push({
        id: `port:${key}:${row.received_at}`,
        ts: row.received_at,
        kind: 'port',
        title: `${row.device_name ?? row.device_id} · port ${row.port_idx} ${row.up ? 'changed' : 'down'}`,
        detail: [
          row.port_name,
          row.speed ? `${row.speed} Mbps` : null,
          row.poe_active ? `PoE ${fmtNumber(row.poe_power, 1)} W` : null,
          row.stp_state,
          row.connected,
          counterDetail,
        ].filter(Boolean).join(' · ') || 'Port state changed',
        tone: row.up === 0 ? 'critical' : countersIncreased ? 'warn' : 'info',
      })
      prior = row
    }
  }
  const byTimestamp = new Map<number, TimelineEntry[]>()
  for (const entry of entries) byTimestamp.set(entry.ts, [...(byTimestamp.get(entry.ts) ?? []), entry])
  return [...byTimestamp].flatMap(([ts, sameTime]) => {
    if (sameTime.length < 10) return sameTime
    const devices = new Set(sameTime.map((entry) => entry.title.split(' · port ')[0]))
    return [{
      id: `port-baseline:${ts}`,
      ts,
      kind: 'port' as const,
      title: 'Port telemetry baseline refreshed',
      detail: `${sameTime.length} ports across ${devices.size} devices were captured together; treated as inventory, not a simultaneous outage`,
      tone: 'info' as const,
    }]
  })
}

const physicalInterface = (name: string | null) => {
  const value = String(name ?? '')
  if (/wifi|wlan|radio|ath|ap\d/i.test(value)) return false
  return /^(eth|en|bond|br|lan|wan|port|\d+\/\d+)/i.test(value)
}

function snmpTransitions(events: SnmpInterfaceEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const strongestByInterface = new Map<string, {
      row: SnmpInterfaceEvent
      errors: number
      discards: number
      score: number
  }>()
  for (const row of events) {
    if (!physicalInterface(row.name)) continue
    const key = `${row.device_id}:${row.if_index}`
    const label = `${row.device_label ?? row.device_id} · ${row.name ?? `Interface ${row.if_index}`}`
    const linkChanged = row.previous_oper_up != null
      && row.oper_up != null
      && row.previous_oper_up !== row.oper_up
    const adminChanged = row.previous_admin_up != null
      && row.admin_up != null
      && row.previous_admin_up !== row.admin_up
    const speedChanged = row.previous_speed_bps != null
      && row.speed_bps != null
      && row.previous_speed_bps !== row.speed_bps
    if (linkChanged && row.admin_up === 1) {
      entries.push({
        id: `snmp-link:${key}:${row.received_at}`,
        ts: row.received_at,
        kind: 'snmp',
        title: `${label} ${row.oper_up ? 'up' : 'down'}`,
        detail: row.speed_bps ? fmtBps(row.speed_bps) : 'Physical link state changed',
        tone: row.oper_up ? 'ok' : 'critical',
      })
    } else if (adminChanged) {
      entries.push({
        id: `snmp-admin:${key}:${row.received_at}`,
        ts: row.received_at,
        kind: 'snmp',
        title: `${label} administratively ${row.admin_up ? 'enabled' : 'disabled'}`,
        detail: 'Interface configuration changed',
        tone: 'info',
      })
    } else if (speedChanged && row.oper_up === 1) {
      entries.push({
        id: `snmp-speed:${key}:${row.received_at}`,
        ts: row.received_at,
        kind: 'snmp',
        title: `${label} negotiated ${fmtBps(row.speed_bps)}`,
        detail: `Previously ${fmtBps(row.previous_speed_bps)}`,
        tone: 'warn',
      })
    }
    const errors = row.in_errors_delta + row.out_errors_delta
    const discards = row.in_discards_delta + row.out_discards_delta
    if (errors >= 10 || discards >= 100) {
      const score = errors * 100 + discards
      const strongest = strongestByInterface.get(key)
      if (!strongest || score > strongest.score) {
        strongestByInterface.set(key, { row, errors, discards, score })
      }
    }
  }
  for (const [key, { row, errors, discards }] of strongestByInterface) {
    const label = `${row.device_label ?? row.device_id} · ${row.name ?? `Interface ${row.if_index}`}`
    entries.push({
      id: `snmp-counter:${key}:${row.received_at}`,
      ts: row.received_at,
      kind: 'snmp',
      title: `${label} counter growth`,
      detail: [
        row.speed_bps ? fmtBps(row.speed_bps) : null,
        errors > 0 ? `+${errors} errors` : null,
        discards > 0 ? `+${discards} discards` : null,
        'largest observed interval',
      ].filter(Boolean).join(' · '),
      tone: 'warn',
    })
  }
  return entries
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function Panel({ t, title, subtitle, icon, children }: {
  t: HearthTokens
  title: string
  subtitle?: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Box sx={{
      p: { xs: 1.5, md: 2 },
      minWidth: 0,
      maxWidth: '100%',
      overflow: 'hidden',
      borderRadius: CARD_RADIUS,
      background: t.paper,
      border: `1px solid ${t.line}`,
      ...CARD_HOVER_SX,
    }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 1.5 }}>
        <Box sx={{ color: t.rust, display: 'grid', placeItems: 'center', mt: 0.1 }}>{icon}</Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ color: t.ink, fontSize: '0.94rem', fontWeight: 800 }}>{title}</Typography>
          {subtitle && <Typography sx={{ color: t.muted, fontSize: '0.72rem', mt: 0.2 }}>{subtitle}</Typography>}
        </Box>
      </Box>
      {children}
    </Box>
  )
}

function Signal({ t, label, value, detail, tone = 'info' }: {
  t: HearthTokens
  label: string
  value: string
  detail?: string
  tone?: TimelineEntry['tone']
}) {
  const colors = {
    ok: '#2E9E5B',
    info: t.rust,
    warn: '#C4841A',
    critical: '#C4443A',
  }
  return (
    <Box sx={{ minWidth: 0, py: 0.25 }}>
      <Typography sx={{ color: t.muted, fontSize: '0.66rem', fontWeight: 700 }}>{label}</Typography>
      <Typography sx={{ color: colors[tone], fontSize: '1rem', fontWeight: 850, lineHeight: 1.3 }}>{value}</Typography>
      {detail && <Typography sx={{ color: t.inkSoft, fontSize: '0.7rem', overflowWrap: 'anywhere' }}>{detail}</Typography>}
    </Box>
  )
}

function ProbeLanes({ t, points, range }: { t: HearthTokens; points: ProbePoint[]; range: RangeKey }) {
  const compact = useMediaQuery('(max-width:600px)')
  const lanes = useMemo(() => {
    const to = Date.now()
    const from = to - rangeMs[range]
    const bins = compact ? 24 : 64
    const byTarget = new Map<string, ProbePoint[]>()
    for (const point of points) {
      const key = `${point.kind}:${point.target_id}`
      byTarget.set(key, [...(byTarget.get(key) ?? []), point])
    }
    return [...byTarget].map(([key, rows]) => {
      const segments = Array.from({ length: bins }, () => ({ seen: false, failed: false }))
      rows.forEach((row) => {
        const index = Math.min(bins - 1, Math.max(0, Math.floor((row.received_at - from) / (to - from) * bins)))
        const segment = segments[index]
        if (!segment) return
        segment.seen = true
        if (!row.ok) segment.failed = true
      })
      const latest = rows.at(-1)
      return {
        key,
        label: latest?.target_label ?? latest?.target_id ?? key,
        kind: latest?.kind ?? key.split(':')[0] ?? key,
        latest,
        segments,
      }
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
  }, [compact, points, range])

  if (!lanes.length) return <Typography sx={{ color: t.muted, fontSize: '0.76rem' }}>No probe history in this range.</Typography>
  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      {lanes.map((lane) => (
        <Box key={lane.key} sx={{ display: 'grid', gridTemplateColumns: { xs: '110px minmax(0,1fr)', sm: '170px minmax(0,1fr) 72px' }, gap: 1, alignItems: 'center' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ color: t.inkSoft, fontSize: '0.72rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lane.label}</Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.6rem', textTransform: 'uppercase' }}>{lane.kind}</Typography>
          </Box>
          <Box aria-label={`${lane.label} probe timeline`} sx={{ display: 'grid', gridTemplateColumns: `repeat(${lane.segments.length}, minmax(1px, 1fr))`, gap: '1px', height: 14 }}>
            {lane.segments.map((segment, index) => (
              <Box key={index} sx={{
                bgcolor: !segment.seen ? `${t.line}80` : segment.failed ? '#C4443A' : '#2E9E5B',
                borderRadius: '2px',
              }} />
            ))}
          </Box>
          <Typography sx={{ display: { xs: 'none', sm: 'block' }, color: lane.latest?.ok ? '#2E9E5B' : '#C4443A', fontSize: '0.68rem', fontWeight: 750, textAlign: 'right' }}>
            {lane.latest?.latency_ms != null ? `${Math.round(lane.latest.latency_ms)} ms` : lane.latest?.ok ? 'healthy' : 'failed'}
          </Typography>
        </Box>
      ))}
    </Box>
  )
}

export default function UniFiTelemetryPanel({ t, isDark, range, devices, onOpenDevice }: {
  t: HearthTokens
  isDark: boolean
  range: RangeKey
  devices: TelemetryDevice[]
  onOpenDevice: (deviceId: string) => void
}) {
  const [data, setData] = useState<TelemetryData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('all')

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true)
    try {
      const [
        wan,
        isp,
        probes,
        activity,
        ports,
        snmpEvents,
        observer,
      ] = await Promise.all([
        apiFetch(`/api/unifi/wan-history?range=${range}`, { signal }).then((response) => responseJson<{ points: WanPoint[] }>(response)),
        apiFetch(`/api/network-observer/isp?range=${range}`, { signal }).then((response) => responseJson<{ points: IspPoint[] }>(response)),
        apiFetch(`/api/network-observer/history?range=${range}`, { signal }).then((response) => responseJson<{ points: ProbePoint[] }>(response)),
        apiFetch(`/api/unifi/events?range=${range}&limit=1000`, { signal }).then((response) => responseJson<{ events: ActivityEvent[] }>(response)),
        apiFetch(`/api/unifi/ports/history?range=${range}`, { signal }).then((response) => responseJson<{ points: PortPoint[] }>(response)),
        apiFetch(`/api/network-observer/snmp-events?range=${range}`, { signal }).then((response) => responseJson<{ events: SnmpInterfaceEvent[] }>(response)),
        apiFetch('/api/network-observer', { signal }).then((response) => responseJson<ObserverResponse>(response)),
      ])
      setData({
        wan: wan.points,
        isp: isp.points,
        probes: probes.points,
        activity: activity.events,
        ports: ports.points,
        snmpEvents: snmpEvents.events,
        observer,
      })
      setError(null)
    } catch (loadError) {
      if (signal.aborted) return
      setError(loadError instanceof Error ? loadError.message : 'Could not load network telemetry.')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [range])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, retry])

  const observer = data.observer?.observers[0] ?? null
  const latestWan = useMemo(() => {
    const latestTs = Math.max(...data.wan.map((point) => point.received_at), -Infinity)
    return data.wan.find((point) => point.received_at === latestTs && point.active === 1) ?? null
  }, [data.wan])
  const latestIsp = data.isp.at(-1) ?? null
  const liveProbes = observer?.payload.probes ?? []
  const probeFailures = liveProbes.filter((probe) => !probe.ok)
  const snmpDevices = observer?.payload.snmp_devices ?? []
  const snmpFailures = snmpDevices.filter((device) => !device.ok)
  const chart = useMemo(() => {
    const points = [
      ...data.wan.filter((point) => point.active === 1).map((point) => ({
        ts: point.received_at,
        wanLatency: point.latency_ms,
        activeWan: point.name ?? point.wan_key,
      })),
      ...data.isp.map((point) => ({
        ts: point.metric_time,
        ispLatency: point.latency_ms,
        maxLatency: point.max_latency_ms,
        packetLoss: point.packet_loss_pct,
      })),
    ]
    return points.sort((a, b) => a.ts - b.ts)
  }, [data.isp, data.wan])
  const chartTicks = useMemo(() => {
    const head = chart[0]
    if (chart.length < 2 || !head) return []
    const from = head.ts
    const to = chart.at(-1)?.ts ?? from
    const count = 7
    return Array.from({ length: count }, (_, index) => from + ((to - from) * index) / (count - 1))
  }, [chart])

  const snmpEvidence = useMemo(() => snmpTransitions(data.snmpEvents), [data.snmpEvents])
  const recentInterfaceIssues = useMemo(() => snmpEvidence.filter((entry) => (
    entry.tone === 'critical' && Date.now() - entry.ts <= 60 * 60 * 1000
  )), [snmpEvidence])
  const timeline = useMemo(() => {
    const activity: TimelineEntry[] = data.activity.map((event) => ({
      id: `activity:${event.id}`,
      ts: event.event_ts,
      kind: 'activity',
      title: event.title ?? event.key ?? 'UniFi activity',
      detail: event.message ?? event.subsystem ?? 'Controller activity',
      tone: eventTone(event.severity),
    }))
    return [
      ...wanTransitions(data.wan),
      ...probeTransitions(data.probes),
      ...activity,
      ...portTransitions(data.ports),
      ...snmpEvidence,
    ].sort((a, b) => b.ts - a.ts)
  }, [data.activity, data.ports, data.probes, data.wan, snmpEvidence])
  const filteredTimeline = timelineFilter === 'all'
    ? timeline
    : timeline.filter((entry) => entry.kind === timelineFilter)

  const fleet = useMemo(() => [...devices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return Math.max(b.cpu ?? 0, b.mem ?? 0) - Math.max(a.cpu ?? 0, a.mem ?? 0)
  }), [devices])

  if (loading && !data.wan.length) {
    return <Box sx={{ display: 'grid', gap: 1.5 }}>{[1, 2, 3].map((item) => <Skeleton key={item} variant="rounded" height={item === 2 ? 300 : 110} sx={{ borderRadius: CARD_RADIUS }} />)}</Box>
  }
  if (error && !data.wan.length) {
    return (
      <Box sx={{ p: 3, borderRadius: CARD_RADIUS, background: t.paper, border: `1px solid ${t.line}`, textAlign: 'center' }}>
        <WarningIcon sx={{ color: '#C4443A', mb: 1 }} />
        <Typography sx={{ color: t.ink, fontWeight: 800 }}>Telemetry could not load</Typography>
        <Typography sx={{ color: t.muted, fontSize: '0.78rem', mt: 0.5 }}>{error}</Typography>
        <Button onClick={() => setRetry((value) => value + 1)} sx={{ mt: 1.5, color: t.rust, textTransform: 'none' }}>Try again</Button>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5, minWidth: 0, width: '100%', maxWidth: '100%' }}>
      {error && (
        <Box sx={{ px: 1.5, py: 1, borderRadius: CARD_RADIUS, bgcolor: '#C4443A18', border: '1px solid #C4443A55' }}>
          <Typography sx={{ color: '#C4443A', fontSize: '0.76rem', fontWeight: 700 }}>Refresh failed; showing the last successful telemetry.</Typography>
        </Box>
      )}

      <Box sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'repeat(2, minmax(0,1fr))', lg: 'repeat(5, minmax(0,1fr))' },
        gap: 1,
        minWidth: 0,
        width: '100%',
        p: 1.5,
        borderRadius: CARD_RADIUS,
        background: t.paper,
        border: `1px solid ${t.line}`,
        ...CARD_HOVER_SX,
      }}>
        <Signal t={t} label="Routed WAN" value={latestWan?.name ?? latestWan?.wan_key ?? 'Unknown'} detail={latestWan?.latency_ms != null ? `${Math.round(latestWan.latency_ms)} ms` : undefined} tone={latestWan?.wan_key === 'WAN' ? 'ok' : 'warn'} />
        <Signal t={t} label="ISP quality" value={latestIsp ? `${fmtNumber(latestIsp.packet_loss_pct, 2)}% loss` : 'No sample'} detail={latestIsp ? `${fmtNumber(latestIsp.latency_ms)} / ${fmtNumber(latestIsp.max_latency_ms)} ms avg/max` : undefined} tone={(latestIsp?.packet_loss_pct ?? 0) > 0 ? 'warn' : 'ok'} />
        <Signal t={t} label="Independent probes" value={probeFailures.length ? `${probeFailures.length} failing` : `${liveProbes.length} healthy`} detail={observer?.stale ? 'Observer is stale' : undefined} tone={observer?.stale ? 'warn' : probeFailures.length ? 'critical' : 'ok'} />
        <Signal t={t} label="SNMP devices" value={snmpFailures.length ? `${snmpFailures.length} failing` : `${snmpDevices.length} healthy`} detail={`${snmpDevices.reduce((sum, device) => sum + (device.interfaces?.length ?? 0), 0)} interfaces`} tone={snmpFailures.length ? 'warn' : 'ok'} />
        <Signal t={t} label="Interface evidence" value={recentInterfaceIssues.length ? `${recentInterfaceIssues.length} recent link events` : snmpEvidence.length ? `${snmpEvidence.length} historical signals` : 'No current faults'} detail={recentInterfaceIssues[0]?.title ?? 'Physical links only; radio counters excluded'} tone={recentInterfaceIssues.length ? 'warn' : snmpEvidence.length ? 'info' : 'ok'} />
      </Box>

      <OutagePostmortemsPanel t={t} />

      <Panel t={t} icon={<WanIcon />} title="WAN and ISP quality" subtitle={`Routed-path latency and cloud-side packet loss over ${range}`}>
        {chart.length < 2 ? (
          <Typography sx={{ color: t.muted, fontSize: '0.76rem' }}>Not enough WAN and ISP history yet.</Typography>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" ticks={chartTicks} interval={0} tick={{ fill: t.muted, fontSize: 10 }} tickFormatter={(value) => new Date(value).toLocaleString([], range === '24h' ? { hour: 'numeric', minute: '2-digit' } : { month: 'numeric', day: 'numeric' })} />
              <YAxis yAxisId="latency" tick={{ fill: t.muted, fontSize: 10 }} width={46} unit=" ms" />
              <YAxis yAxisId="loss" orientation="right" tick={{ fill: t.muted, fontSize: 10 }} width={42} unit="%" />
              <ChartTooltip
                contentStyle={{ background: t.paper, border: `1px solid ${t.line}`, borderRadius: 10, color: t.ink, fontSize: 11 }}
                labelFormatter={(value) => new Date(value as number).toLocaleString()}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: t.muted }} />
              <Area yAxisId="loss" type="stepAfter" dataKey="packetLoss" name="Packet loss" stroke="#C4841A" fill="#C4841A22" connectNulls />
              <Line yAxisId="latency" type="monotone" dataKey="wanLatency" name="UniFi path" stroke={t.rust} strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="latency" type="monotone" dataKey="ispLatency" name="Site Manager avg" stroke={isDark ? '#65C7E6' : '#197899'} strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="latency" type="monotone" dataKey="maxLatency" name="Site Manager max" stroke={isDark ? '#F08A86' : '#A53D38'} strokeDasharray="4 3" dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel t={t} icon={<ProbeIcon />} title="Independent probe lanes" subtitle="Green means observed healthy; red means at least one failed sample in that interval">
        <ProbeLanes t={t} points={data.probes} range={range} />
      </Panel>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'minmax(0,1.1fr) minmax(380px,0.9fr)' }, gap: 1.5, alignItems: 'start' }}>
        <Panel t={t} icon={<TimelineIcon />} title="Correlated incident timeline" subtitle={`${filteredTimeline.length.toLocaleString()} material changes across the selected window`}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={timelineFilter}
            onChange={(_, value) => value && setTimelineFilter(value)}
            sx={{
              mb: 1.25,
              width: { xs: '100%', sm: 'auto' },
              maxWidth: '100%',
              flexWrap: { xs: 'wrap', sm: 'nowrap' },
              ...toggleGroupSx(t),
              '& .MuiToggleButton-root': {
                flex: { xs: '1 1 33.333%', sm: '0 0 auto' },
              },
            }}
          >
            {(['all', 'wan', 'probe', 'activity', 'port', 'snmp'] as TimelineFilter[]).map((value) => (
              <ToggleButton key={value} value={value}>{value === 'all' ? 'All' : value.toUpperCase()}</ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Box sx={{ maxHeight: 560, overflowY: 'auto', pr: 0.5 }}>
            {filteredTimeline.length ? filteredTimeline.slice(0, 200).map((entry, index) => {
              const color = entry.tone === 'critical' ? '#C4443A' : entry.tone === 'warn' ? '#C4841A' : entry.tone === 'ok' ? '#2E9E5B' : t.rust
              return (
                <Box key={entry.id} sx={{ display: 'grid', gridTemplateColumns: '9px minmax(0,1fr)', gap: 1, py: 0.85, borderBottom: index < Math.min(filteredTimeline.length, 200) - 1 ? `1px solid ${t.line}` : 'none' }}>
                  <Box sx={{ width: 8, height: 8, mt: 0.55, borderRadius: '50%', bgcolor: color }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', gap: { xs: 0.15, sm: 1 }, alignItems: { xs: 'flex-start', sm: 'baseline' } }}>
                      <Typography sx={{ color: t.ink, fontSize: '0.78rem', fontWeight: 750, overflowWrap: 'anywhere' }}>{entry.title}</Typography>
                      <Typography sx={{ color: t.muted, fontSize: '0.64rem', flexShrink: 0 }}>{new Date(entry.ts).toLocaleString()}</Typography>
                    </Box>
                    <Typography sx={{ color: t.inkSoft, fontSize: '0.7rem', mt: 0.15, overflowWrap: 'anywhere' }}>{entry.detail}</Typography>
                    <Chip label={entry.kind} size="small" sx={{ mt: 0.5, height: 18, fontSize: '0.58rem', bgcolor: `${color}18`, color, border: `1px solid ${color}44` }} />
                  </Box>
                </Box>
              )
            }) : (
              <Typography sx={{ color: t.muted, fontSize: '0.76rem', py: 3, textAlign: 'center' }}>No material state changes in this range.</Typography>
            )}
          </Box>
        </Panel>

        <Box sx={{ display: 'grid', gap: 1.5 }}>
          <Panel t={t} icon={<DeviceIcon />} title="UniFi device health" subtitle="Live Integration API resource signals; open a device for history">
            <Box sx={{ overflowX: 'auto' }}>
              <Box sx={{ minWidth: 520, display: 'grid' }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1.5fr) repeat(5,minmax(62px,.6fr))', gap: 0.75, pb: 0.6, borderBottom: `1px solid ${t.line}` }}>
                  {['Device', 'CPU', 'Memory', 'Temp', 'Uptime', 'PoE'].map((label) => <Typography key={label} sx={{ color: t.muted, fontSize: '0.62rem', fontWeight: 800 }}>{label}</Typography>)}
                </Box>
                {fleet.map((device) => (
                  <Box
                    key={device.id ?? device.name}
                    role={device.id ? 'button' : undefined}
                    tabIndex={device.id ? 0 : undefined}
                    onClick={() => device.id && onOpenDevice(device.id)}
                    onKeyDown={(event) => {
                      if (device.id && (event.key === 'Enter' || event.key === ' ')) onOpenDevice(device.id)
                    }}
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(150px,1.5fr) repeat(5,minmax(62px,.6fr))',
                      gap: 0.75,
                      py: 0.65,
                      px: 0.5,
                      mx: -0.5,
                      borderRadius: '6px',
                      borderBottom: `1px solid ${t.line}`,
                      cursor: device.id ? 'pointer' : 'default',
                      '&:hover': device.id ? { bgcolor: `${t.rust}10` } : undefined,
                      '&:focus-visible': device.id ? { outline: `2px solid ${t.rust}`, outlineOffset: 1 } : undefined,
                    }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ color: device.online ? t.ink : '#C4443A', fontSize: '0.72rem', fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{device.name ?? device.model ?? 'Device'}</Typography>
                      <Typography sx={{ color: t.muted, fontSize: '0.6rem' }}>{device.model}</Typography>
                    </Box>
                    <Typography sx={{ color: (device.cpu ?? 0) >= 85 ? '#C4443A' : t.inkSoft, fontSize: '0.7rem' }}>{device.cpu == null ? '—' : `${fmtNumber(device.cpu, 1)}%`}</Typography>
                    <Typography sx={{ color: (device.mem ?? 0) >= 90 ? '#C4443A' : t.inkSoft, fontSize: '0.7rem' }}>{device.mem == null ? '—' : `${fmtNumber(device.mem, 1)}%`}</Typography>
                    <Typography sx={{ color: (device.temperature ?? 0) >= 75 ? '#C4443A' : t.inkSoft, fontSize: '0.7rem' }}>{device.temperature == null ? '—' : `${fmtNumber(device.temperature, 1)}°`}</Typography>
                    <Typography sx={{ color: t.inkSoft, fontSize: '0.7rem' }}>{fmtUptime(device.uptime)}</Typography>
                    <Typography sx={{ color: t.inkSoft, fontSize: '0.7rem' }}>{device.poe_power != null ? `${fmtNumber(device.poe_power, 1)} W` : device.poe_active_ports ? `${device.poe_active_ports} ports` : '—'}</Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          </Panel>

          <Panel t={t} icon={recentInterfaceIssues.length ? <WarningIcon /> : <HealthyIcon />} title="SNMP interface evidence" subtitle={`${snmpDevices.length} devices · ${snmpDevices.reduce((sum, device) => sum + (device.interfaces?.length ?? 0), 0)} interfaces`}>
            {recentInterfaceIssues.length ? (
              <Box sx={{ display: 'grid', gap: 0.75 }}>
                {recentInterfaceIssues.slice(0, 12).map((issue) => (
                  <Box key={issue.id} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, pb: 0.6, borderBottom: `1px solid ${t.line}` }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ color: '#C4443A', fontSize: '0.72rem', fontWeight: 750 }}>{issue.title}</Typography>
                      <Typography sx={{ color: t.muted, fontSize: '0.64rem' }}>{issue.detail}</Typography>
                    </Box>
                    <Typography sx={{ color: t.muted, fontSize: '0.62rem', flexShrink: 0 }}>{new Date(issue.ts).toLocaleTimeString()}</Typography>
                  </Box>
                ))}
              </Box>
            ) : (
              <Typography sx={{ color: '#2E9E5B', fontSize: '0.76rem', fontWeight: 750 }}>No physical link-down transition was observed in the last hour. Significant counter growth remains in the timeline.</Typography>
            )}
          </Panel>

          <Panel t={t} icon={<IspIcon />} title="ISP evidence" subtitle="Cloud-side Site Manager measurements survive local collector outages">
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 1 }}>
              <Signal t={t} label="ISP" value={latestIsp?.isp_name ?? 'Unknown'} detail={latestIsp?.isp_asn ?? undefined} />
              <Signal t={t} label="Uptime" value={latestIsp ? `${fmtNumber(latestIsp.uptime_pct, 2)}%` : '—'} detail={latestIsp?.downtime ? `${fmtNumber(latestIsp.downtime)} downtime` : 'No reported downtime'} tone={(latestIsp?.downtime ?? 0) > 0 ? 'warn' : 'ok'} />
              <Signal t={t} label="Download" value={latestIsp?.download_kbps == null ? '—' : fmtBps(latestIsp.download_kbps * 1000)} />
              <Signal t={t} label="Upload" value={latestIsp?.upload_kbps == null ? '—' : fmtBps(latestIsp.upload_kbps * 1000)} />
            </Box>
          </Panel>
        </Box>
      </Box>
    </Box>
  )
}
