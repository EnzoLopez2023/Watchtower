// UniFi Network — read-only network dashboard.
//
// Renders the latest snapshot pushed by the local UniFi agent
// (scripts/unifi-agent): WAN health, device fleet (with PoE/ports), connected
// clients, throughput history, and the alerts/events feed. Data is polled from
// Watchtower's own API (/api/unifi, /api/unifi/history, /api/unifi/events) — it never
// touches the UDM directly, so this works from anywhere Watchtower is reachable.
// Auto-refreshes every 30s.
//
// THESIS: Health and investigation share one network workspace, without mixing
// collector diagnostics into the traffic record.
// OWN-WORLD: Watchtower's restrained network palette, paper panels, dense tables,
// and familiar filters; semantic color is reserved for live state and policy.
// STORY: Check health, enter Logs, narrow a time window, and trace an event or
// flow back to its actor, endpoint, and matched policy.
// FIRST VIEWPORT: Existing hero, one persistent section switcher, then either
// the health dashboard or a retention-and-drift summary above searchable logs.
// FORM: An extension of the incumbent operator dashboard; no new visual system.

import { apiFetch } from './services/apiClient';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Chip, CircularProgress, Skeleton, useMediaQuery, Drawer, IconButton, Menu, MenuItem, TextField, Button, Checkbox, ListItemText, Dialog, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { motion } from 'framer-motion';
import {
  Router as RouterIcon,
  Lan as LanIcon,
  Devices as DevicesIcon,
  People as ClientsIcon,
  Bolt as PoeIcon,
  NotificationsActive as AlertIcon,
  Warning as WarningIcon,
  SwapVert as ThroughputIcon,
  Timer as UptimeIcon,
  NetworkPing as LatencyIcon,
  Close as CloseIcon,
  ViewColumn as ColumnsIcon,
  Download as ExportIcon,
  ChevronRight as ChevronRightIcon,
  ContentCopy as CopyIcon,
  Check as CheckIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as ChartTooltip, Legend,
} from 'recharts';
import PageHero from './components/PageHero';
import { NAV_TELEMETRY_DEEP_LINK } from './app/navigation';
import UniFiLogsPanel from './components/unifi/UniFiLogsPanel';
import { useThemeMode } from './context/ThemeContext';
import { tokensFor } from './theme/tokens';
import { toggleGroupSx, CARD_RADIUS, CARD_HOVER_SX, pageShellSx } from './theme/controls';

const UniFiTelemetryPanel = lazy(() => import('./components/unifi/UniFiTelemetryPanel'));

// ── Types (match routes/unifi.js normalized payload) ─────────────────────────
export interface Port {
  idx: number | null;
  up: boolean;
  speed: number | null;
  max_speed: number | null;
  connector: string | null;
  poe_enabled: boolean;
  poe_active: boolean;
  poe_power: number | null;
  name: string | null;
  connected: string | null;
  full_duplex?: boolean | null;
  rx_errors?: number | null;
  tx_errors?: number | null;
  rx_dropped?: number | null;
  tx_dropped?: number | null;
  stp_state?: string | null;
}
export interface UniFiDevice {
  id: string | null;
  name: string | null;
  model: string | null;
  type: string | null;
  online: boolean;
  version: string | null;
  ip: string | null;
  mac: string | null;
  rx_bps: number | null;
  tx_bps: number | null;
  uptime: number | null;
  cpu?: number | null;
  mem?: number | null;
  temperature?: number | null;
  poe_power?: number | null;
  poe_active_ports: number;
  uplink_id: string | null;
  ports: Port[];
  raw?: unknown;
}
export interface UniFiClient {
  id: string | null;
  name: string | null;
  ip: string | null;
  mac: string | null;
  wired: boolean;
  uplink: string | null;
  uplink_id: string | null;
  sw_port: number | null;
  signal: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  // How the client got its address. 'likely' = in-pool but unconfirmed, which is
  // every wired client: UniFi only reports a lease (dhcpend_time) for wireless.
  ip_source?: 'reserved' | 'static' | 'dhcp' | 'likely' | 'unknown';
  fixed_ip?: string | null;
  raw?: unknown;
}
interface Wan {
  status: string | null;
  latency_ms: number | null;
  uptime: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
}
interface Reading {
  received_at: number;
  wan_status: string | null;
  wan_latency_ms: number | null;
  wan_uptime: number | null;
  wan_rx_bps: number | null;
  wan_tx_bps: number | null;
  num_clients: number | null;
  num_devices: number | null;
  devices_online: number | null;
  internet_reachable?: number | null;
  active_wan?: string | null;
  active_wan_name?: string | null;
  raw: { wan: Wan; devices: UniFiDevice[]; clients: UniFiClient[] } | null;
}
interface SnapshotResponse {
  ok: boolean;
  present: boolean;
  age_seconds?: number;
  stale?: boolean;
  reading?: Reading;
}
interface HistoryPoint {
  received_at: number;
  wan_rx_bps: number | null;
  wan_tx_bps: number | null;
  wan_latency_ms: number | null;
  num_clients: number | null;
  devices_online: number | null;
}
interface UniFiEvent {
  id: number;
  upstream_id: string | null;
  event_ts: number;
  is_alarm: number;
  key: string | null;
  subsystem: string | null;
  message: string | null;
  title: string | null;
  severity: string | null;
  source: 'activity' | 'legacy';
}
interface EventCollection {
  status: string;
  evidence: string | null;
  held: number;
  updated_at: number | null;
}
type RangeKey = '24h' | '7d' | '30d';
const RANGES: RangeKey[] = ['24h', '7d', '30d'];
export type DetailTarget =
  | { kind: 'device'; data: UniFiDevice }
  | { kind: 'client'; data: UniFiClient }
  | null;

// Device kind classification + colors, shared by the cards and topology sort.
type DeviceKind = 'gateway' | 'switch' | 'ap' | 'other';
function deviceKind(d: { model: string | null; name: string | null; type: string | null }): DeviceKind {
  const m = `${d.model ?? ''} ${d.name ?? ''}`;
  if (/udm|dream machine|uxg|ucg|ugw|usg|gateway/i.test(m)) return 'gateway';
  if (d.type === 'accessPoint' || /\bap\b|u6|u7|\bac (pro|lite|mesh|lr|hd)|nanohd|beacon|in.?wall/i.test(m)) return 'ap';
  if (d.type === 'switching' || /switch|usw|\bus[- ]/i.test(m)) return 'switch';
  return 'other';
}
function kindColor(kind: DeviceKind, isDark: boolean): string {
  switch (kind) {
    case 'gateway': return isDark ? '#B79CF0' : '#7C5CD6';
    case 'switch':  return isDark ? '#5AA9E6' : '#2E6FB0';
    case 'ap':      return isDark ? '#43C97D' : '#2E9E5B';
    default:        return isDark ? '#B9A98F' : '#8A7B60';
  }
}
const KIND_LABEL: Record<DeviceKind, string> = { gateway: 'Gateway', switch: 'Switch', ap: 'Access Point', other: 'Device' };
const KIND_ORDER: Record<DeviceKind, number> = { gateway: 0, switch: 1, ap: 2, other: 3 };

// Switch-port color by link speed (PoE is shown separately as a bolt overlay).
function portColor(p: { up: boolean; speed: number | null; connector: string | null }, isDark: boolean): { c: string; label: string } {
  if (!p.up) return { c: isDark ? '#6E6E78' : '#9A9A9A', label: 'Down' };
  if ((p.connector ?? '').toUpperCase() === 'SFP') return { c: isDark ? '#5AA9E6' : '#2E6FB0', label: 'Fiber / SFP' };
  const sp = p.speed ?? 0;
  if (sp >= 1000) return { c: isDark ? '#43C97D' : '#2E9E5B', label: 'Gigabit' };
  if (sp >= 100) return { c: isDark ? '#E6A63A' : '#C4841A', label: '100 Mbps' };
  if (sp > 0) return { c: isDark ? '#F0776E' : '#C4443A', label: '10 Mbps' };
  return { c: isDark ? '#43C97D' : '#2E9E5B', label: 'Up' };
}
const POE_COLOR = (isDark: boolean) => (isDark ? '#E6A63A' : '#C4841A');

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtBps(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let v = bps, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
function fmtUptime(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtAge(sec: number | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const n1 = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${Math.round(v * 10) / 10}${unit}`);

function decodeWan(status: string | null) {
  const s = (status ?? '').toLowerCase();
  if (s === 'up' || s === 'ok') return { key: 'up', label: 'Online', hint: 'Internet connection is up' };
  if (s === 'down') return { key: 'down', label: 'Offline', hint: 'Internet connection is down' };
  return { key: 'unknown', label: 'Unknown', hint: 'No WAN status reported' };
}

export default function UniFiNetwork() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'network');
  const isMobile = useMediaQuery('(max-width:700px)');

  const [snap, setSnap] = useState<SnapshotResponse | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [events, setEvents] = useState<UniFiEvent[]>([]);
  const [eventCollection, setEventCollection] = useState<EventCollection | null>(null);
  const [range, setRange] = useState<RangeKey>('24h');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DetailTarget>(null);
  // Overview answers "is the network healthy"; ports and clients are lookup
  // tools. Separate sub-pages so the overview isn't buried under 75 rows.
  const [tab, setTab] = useState<'overview' | 'telemetry' | 'ports' | 'clients' | 'logs'>(() => {
    const requested = sessionStorage.getItem(NAV_TELEMETRY_DEEP_LINK);
    sessionStorage.removeItem(NAV_TELEMETRY_DEEP_LINK);
    return requested === 'telemetry' ? 'telemetry' : 'overview';
  });

  const loadSnap = useCallback(async () => {
    try {
      const r = await apiFetch('/api/unifi');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (rk: RangeKey) => {
    try {
      const r = await apiFetch(`/api/unifi/history?range=${rk}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setHistory(Array.isArray(j.points) ? j.points : []);
    } catch { /* keep last-known */ }
  }, []);

  const loadEvents = useCallback(async (rk: RangeKey) => {
    try {
      const r = await apiFetch(`/api/unifi/events?range=${rk}&limit=100`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setEvents(Array.isArray(j.events) ? j.events : []);
      setEventCollection(j.collection ?? null);
    } catch { /* keep last-known */ }
  }, []);

  useEffect(() => {
    void loadSnap(); void loadHistory(range); void loadEvents(range);
    const id = setInterval(() => { void loadSnap(); void loadHistory(range); void loadEvents(range); }, 30_000);
    return () => clearInterval(id);
  }, [loadSnap, loadHistory, loadEvents, range]);

  const reading = snap?.reading;
  const wan = reading?.raw?.wan ?? null;
  const devices = useMemo(() => reading?.raw?.devices ?? [], [reading]);
  const clients = useMemo(() => reading?.raw?.clients ?? [], [reading]);
  const wanState = decodeWan(reading?.wan_status ?? wan?.status ?? null);

  const statusColor = useMemo(() => {
    const map: Record<string, string> = {
      up:      isDark ? '#43C97D' : '#2E9E5B',
      down:    isDark ? '#E0655A' : '#C4443A',
      unknown: t.muted,
    };
    return map[wanState.key] ?? t.muted;
  }, [wanState.key, isDark, t.muted]);

  const chartData = useMemo(() => history.map(p => ({
    ts: p.received_at,
    down: p.wan_rx_bps,
    up: p.wan_tx_bps,
  })), [history]);

  const xTick = useCallback((ts: number) => {
    const d = new Date(ts);
    return range === '24h'
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }, [range]);

  const onlineCount = reading?.devices_online ?? devices.filter(d => d.online).length;
  const switches = useMemo(() => devices
    .filter((d) => d.ports && d.ports.length > 0)
    .sort((a, b) => {
      const ka = KIND_ORDER[deviceKind(a)], kb = KIND_ORDER[deviceKind(b)];
      if (ka !== kb) return ka - kb;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.name ?? '').localeCompare(b.name ?? '');
    }), [devices]);

  // Resolve a connected-name (from a switch port) to a client or device card.
  const openByName = useCallback((name: string) => {
    const n = name.trim().toLowerCase();
    const cl = clients.find((c) => (c.name ?? '').toLowerCase() === n);
    if (cl) return setDetail({ kind: 'client', data: cl });
    const dv = devices.find((d) => (d.name ?? '').toLowerCase() === n);
    if (dv) setDetail({ kind: 'device', data: dv });
  }, [clients, devices]);

  // Busiest clients right now (needs legacy per-client rates).
  const topTalkers = useMemo(() => clients
    .filter((c) => (c.rx_bps ?? 0) + (c.tx_bps ?? 0) > 0)
    .sort((a, b) => ((b.rx_bps ?? 0) + (b.tx_bps ?? 0)) - ((a.rx_bps ?? 0) + (a.tx_bps ?? 0)))
    .slice(0, 5), [clients]);

  // Devices ordered like the topology: gateway first, then switches, APs, others.
  const sortedDevices = useMemo(() => [...devices].sort((a, b) => {
    const ka = KIND_ORDER[deviceKind(a)], kb = KIND_ORDER[deviceKind(b)];
    if (ka !== kb) return ka - kb;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name ?? '').localeCompare(b.name ?? '');
  }), [devices]);

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        eyebrow="UniFi Network"
        title="Network status & clients"
        accentPhrase="clients"
        subtitle="Live view of your UniFi network, pushed by the on-site agent. Read-only — no direct connection to the console from here."
        actions={tab !== 'logs' ? (
          <Box sx={{ display: 'flex', gap: 0.75 }}>
            {RANGES.map(rk => (
              <Chip
                key={rk}
                label={rk}
                onClick={() => setRange(rk)}
                sx={{
                  fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer',
                  bgcolor: range === rk ? t.rust : 'transparent',
                  color: range === rk ? '#fff' : t.muted,
                  border: `1px solid ${range === rk ? t.rust : t.line}`,
                  '&:hover': { bgcolor: range === rk ? t.rustDark : `${t.rust}22` },
                }}
              />
            ))}
          </Box>
        ) : undefined}
      />

      <ToggleButtonGroup
        size="small"
        exclusive
        value={tab}
        onChange={(_, value) => value && setTab(value)}
        aria-label="UniFi Network section"
        sx={{ mb: 2.5, flexWrap: 'wrap', ...toggleGroupSx(t) }}
      >
        <ToggleButton value="overview">Overview</ToggleButton>
        <ToggleButton value="telemetry">Telemetry / Outages</ToggleButton>
        {switches.length > 0 && <ToggleButton value="ports">Switch ports &amp; PoE</ToggleButton>}
        <ToggleButton value="clients">Clients{reading ? ` (${clients.length})` : ''}</ToggleButton>
        <ToggleButton value="logs">Logs</ToggleButton>
      </ToggleButtonGroup>

      {tab !== 'logs' && loading && !snap && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress size={30} sx={{ color: t.rust }} />
        </Box>
      )}

      {tab !== 'logs' && error && (
        <Banner color={statusColor} bg={t.paper} ink={t.ink} muted={t.muted}
          icon={<WarningIcon />} title="Couldn't reach the Watchtower UniFi API" text={error} />
      )}

      {tab !== 'logs' && snap && !snap.present && !error && (
        <Banner color={t.rust} bg={t.paper} ink={t.ink} muted={t.muted}
          icon={<RouterIcon />} title="Waiting for the first reading"
          text="No data yet. Start the UniFi agent on your always-on host (scripts/unifi-agent) and it will begin posting snapshots here." />
      )}

      {reading && tab !== 'logs' && tab !== 'telemetry' && (
        <>
          <NetworkSearch t={t} devices={devices} clients={clients} onOpen={setDetail} />
          {/* WAN status banner */}
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Box sx={{
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
              p: { xs: 2, md: 2.5 }, borderRadius: CARD_RADIUS,
              background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${statusColor}66`,
              boxShadow: `inset 0 2px 0 ${statusColor}`,
              mb: 2.5,
            }}>
              <Box sx={{
                width: 46, height: 46, borderRadius: CARD_RADIUS, flexShrink: 0,
                display: 'grid', placeItems: 'center',
                background: `${statusColor}22`, color: statusColor,
              }}>
                <RouterIcon />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: '1.15rem', fontWeight: 800, color: t.ink, letterSpacing: '-0.01em' }}>
                  Internet {wanState.label}
                </Typography>
                <Typography sx={{ fontSize: '0.82rem', color: t.muted, mt: 0.25 }}>
                  {wanState.hint}
                  {reading.wan_uptime != null ? ` · up ${fmtUptime(reading.wan_uptime)}` : ''}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.7rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Updated
                </Typography>
                <Typography sx={{ fontSize: '0.9rem', fontWeight: 700, color: snap?.stale ? statusColor : t.inkSoft }}>
                  {fmtAge(snap?.age_seconds)}
                </Typography>
              </Box>
            </Box>
          </motion.div>

          {snap?.stale && (
            <Banner color={isDark ? '#E6A63A' : '#C4841A'} bg={t.paper} ink={t.ink} muted={t.muted}
              icon={<WarningIcon />} title="Reading is stale"
              text="The latest snapshot is over 5 minutes old. The agent host may be offline." />
          )}

          {/* Overview tiles */}
          <Box sx={{
            display: 'grid', gap: 1.5, mb: 3,
            gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
          }}>
            <StatCard t={t} icon={<LatencyIcon />} label="WAN Latency" value={n1(reading.wan_latency_ms, ' ms')} accent={statusColor} />
            <StatCard t={t} icon={<UptimeIcon />} label="WAN Uptime" value={fmtUptime(reading.wan_uptime)} />
            <StatCard t={t} icon={<ThroughputIcon />} label="WAN Down / Up"
              value={fmtBps(reading.wan_rx_bps)} sub={`↑ ${fmtBps(reading.wan_tx_bps)}`} />
            <StatCard t={t} icon={<DevicesIcon />} label="Devices" value={`${onlineCount}/${reading.num_devices ?? devices.length}`} sub="online" />
            <StatCard t={t} icon={<ClientsIcon />} label="Clients" value={`${reading.num_clients ?? clients.length}`} sub="connected" />
            <StatCard t={t} icon={<PoeIcon />} label="PoE Ports"
              value={`${devices.reduce((s, d) => s + (d.poe_active_ports ?? 0), 0)}`} sub="delivering power" />
          </Box>

          {/* WAN throughput chart */}
          <SectionCard t={t} icon={<ThroughputIcon />} title="WAN throughput"
            subtitle={`Download and upload over the last ${range}`}>
            {chartData.length === 0 ? (
              <EmptyLine t={t} text="Not enough history yet for this range." />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="downFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={t.rust} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={t.rust} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="upFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={statusColor} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={statusColor} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="ts" tickFormatter={xTick} tick={{ fill: t.muted, fontSize: 11 }}
                    stroke={t.line} minTickGap={40} />
                  <YAxis tick={{ fill: t.muted, fontSize: 11 }} stroke={t.line} width={64}
                    tickFormatter={(v) => fmtBps(v as number)} />
                  <ChartTooltip
                    contentStyle={{
                      background: isDark ? '#162E37' : '#FFFFFF',
                      border: `1px solid ${t.line}`, borderRadius: 10, fontSize: 12, color: t.ink,
                    }}
                    labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
                    formatter={(v, name) => [fmtBps(Number(v)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: t.muted }} />
                  <Area type="monotone" dataKey="down" name="Download"
                    stroke={t.rust} strokeWidth={2} fill="url(#downFill)" connectNulls dot={false} />
                  <Area type="monotone" dataKey="up" name="Upload"
                    stroke={statusColor} strokeWidth={2} fill="url(#upFill)" connectNulls dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          {/* Top talkers */}
          {topTalkers.length > 0 && (
            <SectionCard t={t} icon={<ThroughputIcon />} title="Top talkers" subtitle="Busiest clients right now">
              {topTalkers.map((c, i) => (
                <Box key={c.id ?? i} onClick={() => setDetail({ kind: 'client', data: c })} sx={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, py: 0.6,
                  cursor: 'pointer', borderRadius: '6px', px: 0.75, mx: -0.75, '&:hover': { background: `${t.rust}11` },
                  borderBottom: i < topTalkers.length - 1 ? `1px solid ${t.line}` : 'none',
                }}>
                  <Typography sx={{ fontSize: '0.82rem', fontWeight: 600, color: t.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name ?? c.mac ?? '—'}</Typography>
                  <Typography sx={{ fontSize: '0.76rem', color: t.inkSoft, flexShrink: 0 }}>↓ {fmtBps(c.rx_bps)} · ↑ {fmtBps(c.tx_bps)}</Typography>
                </Box>
              ))}
            </SectionCard>
          )}

          {tab === 'overview' && (
            <>
              {/* Device fleet */}
              <SectionCard t={t} icon={<LanIcon />} title="Devices" subtitle={`${devices.length} adopted · ${onlineCount} online`}>
                {devices.length === 0 ? (
                  <EmptyLine t={t} text="No devices reported." />
                ) : (
                  <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))' }}>
                    {sortedDevices.map((d, i) => <DeviceCard key={d.id ?? i} t={t} d={d} isDark={isDark} onClick={() => setDetail({ kind: 'device', data: d })} />)}
                  </Box>
                )}
              </SectionCard>

              {/* Alerts / events */}
              <SectionCard t={t} icon={<AlertIcon />} title="Alerts & events" subtitle={`Last ${range}`}>
                {events.length === 0 ? (
                  <EmptyLine
                    t={t}
                    text={eventCollection?.held
                      ? 'Activity collection is held because the controller reported unread records.'
                      : eventCollection?.status === 'unverified'
                        ? 'Modern activity collection has not been verified by the on-site agent yet.'
                        : 'No modern activity records were reported in this range.'}
                  />
                ) : (
                  <EventsFeed t={t} events={events} />
                )}
              </SectionCard>
            </>
          )}

          {tab === 'ports' && switches.length > 0 && (
            <SectionCard t={t} icon={<PoeIcon />} title="Switch ports & PoE" subtitle={`${switches.length} switch${switches.length > 1 ? 'es' : ''}`}>
              <PortLegend t={t} isDark={isDark} />
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {switches.map((sw, i) => <PortMatrix key={sw.id ?? i} t={t} sw={sw} isDark={isDark} onOpenName={openByName} />)}
              </Box>
            </SectionCard>
          )}

          {tab === 'clients' && (
            <SectionCard t={t} icon={<ClientsIcon />} title="Connected clients" subtitle={`${clients.length} online`}>
              {clients.length === 0 ? (
                <EmptyLine t={t} text="No clients reported." />
              ) : (
                <ClientsPanel t={t} clients={clients} devices={devices} onSelect={(c) => setDetail({ kind: 'client', data: c })} />
              )}
            </SectionCard>
          )}
        </>
      )}

      {reading && tab === 'telemetry' && (
        <Suspense fallback={<Box sx={{ display: 'grid', gap: 1.5 }}>{[110, 300, 220].map((height) => <Skeleton key={height} variant="rounded" height={height} sx={{ borderRadius: CARD_RADIUS }} />)}</Box>}>
          <UniFiTelemetryPanel
            t={t}
            isDark={isDark}
            range={range}
            devices={devices}
            onOpenDevice={(deviceId) => {
              const device = devices.find((candidate) => candidate.id === deviceId);
              if (device) setDetail({ kind: 'device', data: device });
            }}
          />
        </Suspense>
      )}

      {tab === 'logs' && <UniFiLogsPanel t={t} isDark={isDark} />}

      <DetailDrawer t={t} isDark={isDark} detail={detail} onClose={() => setDetail(null)} onOpen={setDetail} devices={devices} clients={clients} />
    </Box>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────
type Tk = ReturnType<typeof tokensFor>;

function StatCard({ t, icon, label, value, sub, accent }: {
  t: Tk; icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string;
}) {
  return (
    <Box sx={{
      p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`,
      display: 'flex', flexDirection: 'column', gap: 0.5,
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: accent ?? t.rust }}>
        <Box sx={{ display: 'grid', placeItems: 'center', '& svg': { fontSize: 18 } }}>{icon}</Box>
        <Typography sx={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: t.muted }}>
          {label}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: '1.5rem', fontWeight: 800, color: t.ink, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
        {value}
      </Typography>
      {sub && <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>{sub}</Typography>}
    </Box>
  );
}

function SectionCard({ t, icon, title, subtitle, children }: {
  t: Tk; icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <Box sx={{ p: { xs: 1.5, md: 2.5 }, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`, mb: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: subtitle ? 0.25 : 1.5, color: t.rust }}>
        <Box sx={{ display: 'grid', placeItems: 'center', '& svg': { fontSize: 18 } }}>{icon}</Box>
        <Typography sx={{ fontSize: '0.9rem', fontWeight: 800, color: t.ink }}>{title}</Typography>
      </Box>
      {subtitle && <Typography sx={{ fontSize: '0.76rem', color: t.muted, mb: 2 }}>{subtitle}</Typography>}
      {children}
    </Box>
  );
}

function EmptyLine({ t, text }: { t: Tk; text: string }) {
  return <Typography sx={{ fontSize: '0.82rem', color: t.muted, py: 3, textAlign: 'center' }}>{text}</Typography>;
}

// Global search — jump to any device or client by name / IP / MAC.
function NetworkSearch({ t, devices, clients, onOpen }: { t: Tk; devices: UniFiDevice[]; clients: UniFiClient[]; onOpen: (d: DetailTarget) => void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = useMemo<Exclude<DetailTarget, null>[]>(() => {
    if (!query) return [];
    const dv = devices
      .filter((d) => `${d.name ?? ''} ${d.ip ?? ''} ${d.mac ?? ''} ${d.model ?? ''}`.toLowerCase().includes(query))
      .map((d) => ({ kind: 'device' as const, data: d }));
    const cl = clients
      .filter((c) => `${c.name ?? ''} ${c.ip ?? ''} ${c.mac ?? ''}`.toLowerCase().includes(query))
      .map((c) => ({ kind: 'client' as const, data: c }));
    return [...dv, ...cl].slice(0, 8);
  }, [query, devices, clients]);

  return (
    <Box sx={{ position: 'relative', mb: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderRadius: CARD_RADIUS, background: t.paper, border: `1px solid ${t.line}` }}>
        <SearchIcon sx={{ fontSize: 18, color: t.muted }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { onOpen(matches[0]); setQ(''); } }}
          placeholder="Search devices & clients…"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: t.ink, fontSize: '0.9rem', fontFamily: 'inherit' }}
        />
        {q && <Typography onClick={() => setQ('')} sx={{ cursor: 'pointer', color: t.muted, fontSize: '0.76rem' }}>clear</Typography>}
      </Box>
      {matches.length > 0 && (
        <Box sx={{ position: 'absolute', zIndex: 10, mt: 0.5, left: 0, right: 0, borderRadius: CARD_RADIUS, background: t.paper, border: `1px solid ${t.line}`, boxShadow: '0 8px 24px -12px rgba(0,0,0,0.4)', overflow: 'hidden' }}>
          {matches.map((m, i) => (
            <Box key={i} onClick={() => { onOpen(m); setQ(''); }} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, px: 1.5, py: 1, cursor: 'pointer', '&:hover': { background: `${t.rust}11` }, borderBottom: i < matches.length - 1 ? `1px solid ${t.line}` : 'none' }}>
              <Typography sx={{ fontSize: '0.84rem', color: t.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.data.name ?? m.data.mac ?? '—'}</Typography>
              <Typography sx={{ fontSize: '0.72rem', color: t.muted, flexShrink: 0 }}>{m.kind}{m.data.ip ? ` · ${m.data.ip}` : ''}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function DeviceCard({ t, d, isDark, onClick }: { t: Tk; d: UniFiDevice; isDark: boolean; onClick: () => void }) {
  const dot = d.online ? '#2E9E5B' : '#C4443A';
  const kind = deviceKind(d);
  const accent = kindColor(kind, isDark);
  return (
    <Box onClick={onClick} sx={{ p: 1.5, borderRadius: CARD_RADIUS, background: t.surface, border: `1px solid ${t.line}`, boxShadow: `inset 0 2px 0 ${accent}`, cursor: 'pointer', transition: 'border-color .15s, transform .15s', '&:hover': { borderColor: t.rust, transform: 'translateY(-1px)' } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Box sx={{ width: 9, height: 9, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: t.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {d.name ?? d.model ?? d.mac ?? 'Device'}
        </Typography>
        <Typography sx={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: accent, flexShrink: 0 }}>
          {KIND_LABEL[kind]}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>
        {[d.model, d.ip].filter(Boolean).join(' · ') || '—'}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75, flexWrap: 'wrap' }}>
        <MetaChip t={t} label="↓" value={fmtBps(d.rx_bps)} />
        <MetaChip t={t} label="↑" value={fmtBps(d.tx_bps)} />
        {d.poe_active_ports > 0 && <MetaChip t={t} label="PoE" value={`${d.poe_active_ports} port${d.poe_active_ports > 1 ? 's' : ''}`} />}
      </Box>
    </Box>
  );
}

function PortLegend({ t, isDark }: { t: Tk; isDark: boolean }) {
  const items = [
    { c: isDark ? '#43C97D' : '#2E9E5B', label: 'Gigabit' },
    { c: isDark ? '#E6A63A' : '#C4841A', label: '100 Mbps' },
    { c: isDark ? '#F0776E' : '#C4443A', label: '10 Mbps' },
    { c: isDark ? '#5AA9E6' : '#2E6FB0', label: 'Fiber / SFP' },
    { c: isDark ? '#6E6E78' : '#9A9A9A', label: 'Down' },
  ];
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 1.75, alignItems: 'center' }}>
      {items.map((it) => (
        <Box key={it.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box sx={{ width: 13, height: 13, borderRadius: '3px', background: `${it.c}33`, border: `1.5px solid ${it.c}` }} />
          <Typography sx={{ fontSize: '0.7rem', color: t.muted }}>{it.label}</Typography>
        </Box>
      ))}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <PoeIcon sx={{ fontSize: 15, color: POE_COLOR(isDark) }} />
        <Typography sx={{ fontSize: '0.7rem', color: t.muted }}>PoE powered</Typography>
      </Box>
    </Box>
  );
}

function MetaChip({ t, label, value }: { t: Tk; label: string; value: string }) {
  return (
    <Typography sx={{ fontSize: '0.72rem', color: t.inkSoft }}>
      <span style={{ color: t.muted }}>{label}</span> {value}
    </Typography>
  );
}

function PortMatrix({ t, sw, isDark, onOpenName, onPortClick }: { t: Tk; sw: UniFiDevice; isDark: boolean; onOpenName?: (name: string) => void; onPortClick?: (p: Port) => void }) {
  return (
    <Box>
      <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: t.ink, mb: 0.75 }}>
        {sw.name ?? sw.model ?? 'Switch'}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
        {sw.ports.map((p, i) => {
          const { c, label } = portColor(p, isDark);
          const on = p.up;
          const tip = `Port ${p.idx ?? i + 1} · ${label}${p.speed ? ` (${p.speed} Mbps)` : ''}${p.poe_active ? ` · PoE${p.poe_power ? ` ${p.poe_power}W` : ''}` : ''}${p.connected ? ` · ${p.connected}` : ''}`;
          return (
            <Box
              key={p.idx ?? i}
              title={tip}
              role={onPortClick ? 'button' : undefined}
              tabIndex={onPortClick ? 0 : undefined}
              aria-label={onPortClick ? tip : undefined}
              onClick={onPortClick ? () => onPortClick(p) : undefined}
              onKeyDown={onPortClick ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPortClick(p);
                }
              } : undefined}
              sx={{
                position: 'relative', minWidth: 30, height: 30, px: 0.5, borderRadius: '7px',
                display: 'grid', placeItems: 'center',
                background: on ? `${c}22` : 'transparent',
                border: `1.5px solid ${on ? c : t.line}`,
                color: on ? c : t.muted,
                fontSize: '0.7rem', fontWeight: 700, cursor: onPortClick ? 'pointer' : 'default',
                '&:hover': onPortClick ? { boxShadow: `0 0 0 2px ${c}66` } : undefined,
              }}
            >
              {p.idx ?? i + 1}
              {p.poe_active && (
                <PoeIcon sx={{ position: 'absolute', top: -7, right: -7, fontSize: 14, color: POE_COLOR(isDark), background: t.paper, borderRadius: '50%', p: '1px' }} />
              )}
            </Box>
          );
        })}
      </Box>
      {sw.ports.some((p) => p.connected) && (
        <Box sx={{ mt: 1, display: 'grid', gap: 0.25 }}>
          {sw.ports.filter((p) => p.connected).map((p) => (
            <Typography key={p.idx} sx={{ fontSize: '0.72rem', color: t.muted }}>
              <span style={{ color: t.inkSoft, fontWeight: 700 }}>Port {p.idx}</span>{' → '}
              {(p.connected ?? '').split(', ').map((nm, j, arr) => (
                <span key={j}>
                  <span onClick={() => onOpenName?.(nm)} style={{ color: t.rust, cursor: 'pointer', fontWeight: 600 }}>{nm}</span>{j < arr.length - 1 ? ', ' : ''}
                </span>
              ))}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Customizable clients table (filter, sortable columns, column picker, export)

// How a client got its address. Only 'reserved' and 'static' are certain:
// 'reserved' is controller config, and 'static' means the address falls outside
// every DHCP pool, which a DHCP server cannot do. 'DHCP' is confirmed by an
// active lease — but UniFi only reports leases for wireless clients, so an
// in-pool wired address can only be called 'DHCP?'.
const IP_SOURCE_LABEL: Record<string, string> = {
  reserved: 'Reserved',
  static:   'Static',
  dhcp:     'DHCP',
  likely:   'DHCP?',
  unknown:  '—',
};
const IP_SOURCE_HELP: Record<string, string> = {
  reserved: 'Fixed IP reservation configured in UniFi for this MAC',
  static:   'Outside every DHCP pool — must be configured on the device itself',
  dhcp:     'Active DHCP lease from the pool',
  likely:   'Inside the DHCP pool with no reservation. UniFi does not report leases for wired clients, so a device statically set to an in-pool address looks identical.',
  unknown:  'Not enough information (no DHCP pool config available)',
};
const IP_SOURCE_COLOR = (src: string, t: Tk): string =>
  src === 'reserved' ? t.rust : src === 'static' ? '#E0A24A' : src === 'dhcp' ? t.inkSoft : t.muted;

type ClientCol = { key: string; label: string; num?: boolean; ip?: boolean; get: (c: UniFiClient) => string | number | null; fmt?: (v: string | number | null) => string };
type DeviceCol = { key: string; label: string; get: (d: UniFiDevice) => string | number | null };

// Named so the sort fallback can reference it without asserting that the
// array is non-empty.
const NAME_COL: ClientCol = { key: 'name', label: 'Name', get: (c) => c.name ?? c.mac ?? '' };

const CLIENT_COLS: ClientCol[] = [
  NAME_COL,
  { key: 'ip', label: 'IP', ip: true, get: (c) => c.ip ?? '' },
  { key: 'dhcp', label: 'Address', get: (c) => IP_SOURCE_LABEL[c.ip_source ?? 'unknown'] ?? '' },
  { key: 'mac', label: 'MAC', get: (c) => c.mac ?? '' },
  { key: 'conn', label: 'Conn', get: (c) => (c.wired ? 'Wired' : 'WiFi') },
  { key: 'uplink', label: 'Connected to', get: (c) => c.uplink ?? '' },
  { key: 'port', label: 'Port', num: true, get: (c) => c.sw_port, fmt: (v) => (v == null ? '' : String(v)) },
  { key: 'signal', label: 'Signal', num: true, get: (c) => c.signal, fmt: (v) => (v == null ? '' : `${v} dBm`) },
  { key: 'rx', label: 'Down', num: true, get: (c) => c.rx_bps, fmt: (v) => fmtBps(v as number | null) },
  { key: 'tx', label: 'Up', num: true, get: (c) => c.tx_bps, fmt: (v) => fmtBps(v as number | null) },
];
const DEVICE_COLS: DeviceCol[] = [
  { key: 'name', label: 'Name', get: (d) => d.name ?? '' },
  { key: 'model', label: 'Model', get: (d) => d.model ?? '' },
  { key: 'type', label: 'Type', get: (d) => d.type ?? '' },
  { key: 'online', label: 'Online', get: (d) => (d.online ? 'yes' : 'no') },
  { key: 'ip', label: 'IP', get: (d) => d.ip ?? '' },
  { key: 'mac', label: 'MAC', get: (d) => d.mac ?? '' },
  { key: 'version', label: 'Firmware', get: (d) => d.version ?? '' },
  { key: 'uptime_s', label: 'Uptime(s)', get: (d) => d.uptime ?? '' },
  { key: 'rx_bps', label: 'Down(bps)', get: (d) => d.rx_bps ?? '' },
  { key: 'tx_bps', label: 'Up(bps)', get: (d) => d.tx_bps ?? '' },
  { key: 'poe_ports', label: 'PoE ports', get: (d) => d.poe_active_ports ?? 0 },
];
const DEFAULT_CLIENT_COLS = ['name', 'ip', 'dhcp', 'conn', 'uplink', 'signal', 'rx', 'tx'];

function ipToNum(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  return parts.reduce((acc, p) => acc * 256 + (parseInt(p, 10) || 0), 0);
}
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function ClientsPanel({ t, clients, devices, onSelect }: { t: Tk; clients: UniFiClient[]; devices: UniFiDevice[]; onSelect: (c: UniFiClient) => void }) {
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [visible, setVisible] = useState<string[]>(DEFAULT_CLIENT_COLS);
  const [colAnchor, setColAnchor] = useState<null | HTMLElement>(null);
  const [expAnchor, setExpAnchor] = useState<null | HTMLElement>(null);

  const cols = CLIENT_COLS.filter((c) => visible.includes(c.key));

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let rows = clients;
    if (q) rows = clients.filter((c) => CLIENT_COLS.some((col) => String(col.get(c) ?? '').toLowerCase().includes(q)));
    const col = CLIENT_COLS.find((c) => c.key === sortKey) ?? NAME_COL;
    const sorted = [...rows].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (col.ip) return ipToNum(String(va ?? '')) - ipToNum(String(vb ?? ''));
      if (col.num) {
        const na = va == null || va === '' ? -Infinity : Number(va);
        const nb = vb == null || vb === '' ? -Infinity : Number(vb);
        return na - nb;
      }
      return String(va ?? '').localeCompare(String(vb ?? ''));
    });
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }, [clients, filter, sortKey, sortDir]);

  const setSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const doExport = (kind: 'clients' | 'devices', fmt: 'csv' | 'json') => {
    setExpAnchor(null);
    if (kind === 'clients') {
      if (fmt === 'json') return downloadFile('unifi-clients.json', JSON.stringify(filtered, null, 2), 'application/json');
      const header = CLIENT_COLS.map((c) => c.label);
      const rows = filtered.map((c) => CLIENT_COLS.map((col) => { const v = col.get(c); return col.fmt ? col.fmt(v) : (v ?? ''); }));
      downloadFile('unifi-clients.csv', toCsv([header, ...rows]), 'text/csv');
    } else {
      if (fmt === 'json') return downloadFile('unifi-devices.json', JSON.stringify(devices, null, 2), 'application/json');
      const header = DEVICE_COLS.map((c) => c.label);
      const rows = devices.map((d) => DEVICE_COLS.map((col) => col.get(d) ?? ''));
      downloadFile('unifi-devices.csv', toCsv([header, ...rows]), 'text/csv');
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField value={filter} onChange={(e) => setFilter(e.target.value)} size="small" placeholder="Filter clients…"
          sx={{ flex: 1, minWidth: 160, '& .MuiOutlinedInput-root': { fontSize: '0.82rem', color: t.ink }, '& .MuiOutlinedInput-notchedOutline': { borderColor: t.line }, '& .MuiInputBase-input::placeholder': { color: t.muted } }} />
        <Button size="small" startIcon={<ColumnsIcon />} onClick={(e) => setColAnchor(e.currentTarget)} sx={{ color: t.muted, textTransform: 'none' }}>Columns</Button>
        <Button size="small" startIcon={<ExportIcon />} onClick={(e) => setExpAnchor(e.currentTarget)} sx={{ color: t.muted, textTransform: 'none' }}>Export</Button>
      </Box>

      <Menu anchorEl={colAnchor} open={!!colAnchor} onClose={() => setColAnchor(null)}>
        {CLIENT_COLS.map((col) => (
          <MenuItem key={col.key} dense onClick={() => setVisible((v) => (v.includes(col.key) ? v.filter((k) => k !== col.key) : [...v, col.key]))}>
            <Checkbox size="small" checked={visible.includes(col.key)} sx={{ p: 0.5, mr: 1 }} />
            <ListItemText primary={col.label} />
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={expAnchor} open={!!expAnchor} onClose={() => setExpAnchor(null)}>
        <MenuItem onClick={() => doExport('clients', 'csv')}>Clients — CSV{filter ? ' (filtered)' : ''}</MenuItem>
        <MenuItem onClick={() => doExport('clients', 'json')}>Clients — JSON{filter ? ' (filtered)' : ''}</MenuItem>
        <MenuItem onClick={() => doExport('devices', 'csv')}>Devices — CSV</MenuItem>
        <MenuItem onClick={() => doExport('devices', 'json')}>Devices — JSON</MenuItem>
      </Menu>

      <Box sx={{ overflowX: 'auto' }}>
        <Box sx={{ minWidth: Math.max(320, cols.length * 118) }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))`, gap: 1, px: 1, py: 0.5, borderBottom: `1px solid ${t.line}` }}>
            {cols.map((col) => (
              <Box key={col.key} onClick={() => setSort(col.key)} sx={{ display: 'flex', alignItems: 'center', gap: 0.25, cursor: 'pointer', userSelect: 'none' }}>
                <Typography sx={{ fontSize: '0.66rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: sortKey === col.key ? t.rust : t.muted }}>{col.label}</Typography>
                {sortKey === col.key && <Typography sx={{ fontSize: '0.6rem', color: t.rust }}>{sortDir === 'asc' ? '▲' : '▼'}</Typography>}
              </Box>
            ))}
          </Box>
          {filtered.map((c, i) => (
            <Box key={c.id ?? i} onClick={() => onSelect(c)} sx={{
              display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))`, gap: 1, px: 1, py: 0.75,
              cursor: 'pointer', borderRadius: '6px', '&:hover': { background: `${t.rust}11` },
              borderBottom: i < filtered.length - 1 ? `1px solid ${t.line}` : 'none',
            }}>
              {cols.map((col) => {
                const v = col.get(c);
                const disp = col.fmt ? col.fmt(v) : (v == null || v === '' ? '—' : String(v));
                // The address-source column reads better as a colored pill than
                // as another line of grey text.
                if (col.key === 'dhcp') {
                  const src = c.ip_source ?? 'unknown';
                  return (
                    <Box key={col.key} sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                      <Typography
                        title={IP_SOURCE_HELP[src] + (c.fixed_ip ? ` (reserved ${c.fixed_ip})` : '')}
                        sx={{
                          fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.02em',
                          px: 0.75, py: 0.15, borderRadius: 1, whiteSpace: 'nowrap',
                          color: IP_SOURCE_COLOR(src, t), bgcolor: `${IP_SOURCE_COLOR(src, t)}1E`,
                        }}
                      >
                        {IP_SOURCE_LABEL[src]}
                      </Typography>
                    </Box>
                  );
                }
                return (
                  <Typography key={col.key} title={String(v ?? '')} sx={{ fontSize: '0.78rem', color: col.key === 'name' ? t.ink : t.inkSoft, fontWeight: col.key === 'name' ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {disp || '—'}
                  </Typography>
                );
              })}
            </Box>
          ))}
        </Box>
      </Box>
      {filtered.length === 0 && <EmptyLine t={t} text="No clients match the filter." />}
    </Box>
  );
}

function EventsFeed({ t, events }: { t: Tk; events: UniFiEvent[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {events.map((e, i) => {
        const color = e.is_alarm ? (t.rust) : t.muted;
        return (
          <Box key={`${e.source}:${e.id ?? i}`} sx={{
            display: 'flex', alignItems: 'flex-start', gap: 1.25, py: 0.75,
            borderBottom: i < events.length - 1 ? `1px solid ${t.line}` : 'none',
          }}>
            <Box sx={{ width: 8, height: 8, mt: 0.6, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ fontSize: '0.82rem', color: t.ink, lineHeight: 1.35 }}>
                {e.message ?? e.title ?? e.key ?? 'Event'}
              </Typography>
              <Typography sx={{ fontSize: '0.7rem', color: t.muted }}>
                {new Date(e.event_ts).toLocaleString()}
                {e.subsystem ? ` · ${e.subsystem}` : ''}
                {e.severity ? ` · ${e.severity.toLowerCase()}` : ''}
                {e.source === 'legacy' ? ' · legacy' : ''}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Banner({ color, bg, ink, muted, icon, title, text }: {
  color: string; bg: string; ink: string; muted: string;
  icon: React.ReactNode; title: string; text: string;
}) {
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 2, p: 2.5, borderRadius: CARD_RADIUS,
      background: bg, border: `1px solid ${color}66`, boxShadow: `inset 0 2px 0 ${color}`, mb: 2.5,
    }}>
      <Box sx={{ width: 42, height: 42, borderRadius: CARD_RADIUS, flexShrink: 0, display: 'grid', placeItems: 'center', background: `${color}22`, color }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '1rem', fontWeight: 800, color: ink }}>{title}</Typography>
        <Typography sx={{ fontSize: '0.82rem', color: muted, mt: 0.25 }}>{text}</Typography>
      </Box>
    </Box>
  );
}

// ── Click-through detail drawer ──────────────────────────────────────────────
// Right-side panel that exposes EVERY field the agent captured for a device or
// client (the `raw` blob), plus a connections summary derived from the snapshot.
export function DetailDrawer({ t, isDark, detail, onClose, onOpen, devices, clients }: {
  t: Tk;
  isDark: boolean;
  detail: DetailTarget;
  onClose: () => void;
  onOpen: (d: DetailTarget) => void;
  devices: UniFiDevice[];
  clients: UniFiClient[];
}) {
  const isDevice = detail?.kind === 'device';
  const d = detail?.kind === 'device' ? detail.data : null;
  const c = detail?.kind === 'client' ? detail.data : null;
  const [selPort, setSelPort] = useState<Port | null>(null);
  useEffect(() => { setSelPort(null); }, [detail]);

  const connectedClients = d ? clients.filter((x) => x.uplink_id && x.uplink_id === d.id) : [];
  const childDevices = d ? devices.filter((x) => x.uplink_id && x.uplink_id === d.id) : [];
  const uplinkDevice = c && c.uplink_id ? devices.find((x) => x.id === c.uplink_id) ?? null : null;
  const openName = (name: string) => {
    const n = name.trim().toLowerCase();
    const cl = clients.find((x) => (x.name ?? '').toLowerCase() === n);
    if (cl) return onOpen({ kind: 'client', data: cl });
    const dv = devices.find((x) => (x.name ?? '').toLowerCase() === n);
    if (dv) onOpen({ kind: 'device', data: dv });
  };
  const legacyPortTable = (d?.raw as { legacy?: { port_table?: Array<Record<string, unknown>> } } | undefined)?.legacy?.port_table ?? null;
  const legacyPort = selPort && Array.isArray(legacyPortTable)
    ? legacyPortTable.find((p) => (p.port_idx ?? p.idx) === selPort.idx) ?? null
    : null;

  return (
    <>
    <Drawer anchor="right" open={!!detail} onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 480 }, background: t.bg, borderLeft: `1px solid ${t.line}` } }}>
      {detail && (
        <Box sx={{ p: 2.5, height: '100%', overflowY: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: t.rust }}>
                {isDevice ? 'Device' : 'Client'}
              </Typography>
              <Typography sx={{ fontSize: '1.15rem', fontWeight: 800, color: t.ink, lineHeight: 1.2, wordBreak: 'break-word' }}>
                {isDevice ? (d?.name ?? d?.model ?? d?.mac) : (c?.name ?? c?.mac)}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75, alignItems: 'center' }}>
                <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>
                  {isDevice ? (d?.model ?? '') : (c?.wired ? 'Wired' : 'Wireless')}
                </Typography>
                {(isDevice ? d?.ip : c?.ip) && <CopyChip t={t} label="IP" value={(isDevice ? d?.ip : c?.ip) as string} />}
                {(isDevice ? d?.mac : c?.mac) && <CopyChip t={t} label="MAC" value={(isDevice ? d?.mac : c?.mac) as string} />}
              </Box>
            </Box>
            <IconButton onClick={onClose} size="small" sx={{ color: t.muted }}><CloseIcon fontSize="small" /></IconButton>
          </Box>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
            {isDevice && d ? (
              <>
                <DrawerChip t={t} label={d.online ? 'Online' : 'Offline'} accent={d.online ? '#2E9E5B' : '#C4443A'} />
                <DrawerChip t={t} label={`↓ ${fmtBps(d.rx_bps)}`} />
                <DrawerChip t={t} label={`↑ ${fmtBps(d.tx_bps)}`} />
                {d.uptime != null && <DrawerChip t={t} label={`up ${fmtUptime(d.uptime)}`} />}
                {d.cpu != null && <DrawerChip t={t} label={`CPU ${n1(d.cpu, '%')}`} />}
                {d.mem != null && <DrawerChip t={t} label={`memory ${n1(d.mem, '%')}`} />}
                {d.temperature != null && <DrawerChip t={t} label={`${n1(d.temperature, '°C')}`} />}
                {d.version && <DrawerChip t={t} label={`v${d.version}`} />}
                {d.poe_active_ports > 0 && <DrawerChip t={t} label={`PoE ${d.poe_active_ports}`} />}
              </>
            ) : c ? (
              <>
                <DrawerChip t={t} label={c.wired ? 'Wired' : 'Wireless'} accent={t.rust} />
                <DrawerChip t={t} label={`↓ ${fmtBps(c.rx_bps)}`} />
                <DrawerChip t={t} label={`↑ ${fmtBps(c.tx_bps)}`} />
                {c.signal != null && <DrawerChip t={t} label={`${c.signal} dBm`} />}
              </>
            ) : null}
          </Box>

          {isDevice && d && <DeviceImage t={t} model={d.model} />}

          {isDevice && d && d.ports.length > 0 && (
            <DrawerSection t={t} title={`Ports (${d.ports.length})`}>
              <PortLegend t={t} isDark={isDark} />
              <PortMatrix t={t} sw={d} isDark={isDark} onOpenName={openName} onPortClick={setSelPort} />
            </DrawerSection>
          )}

          {isDevice && (childDevices.length > 0 || connectedClients.length > 0) && (
            <DrawerSection t={t} title={`Connected (${childDevices.length + connectedClients.length})`}>
              {childDevices.map((x) => <ConnLine key={`d${x.id}`} t={t} label={x.name ?? x.model ?? x.mac ?? '—'} sub="device" onClick={() => onOpen({ kind: 'device', data: x })} />)}
              {connectedClients.map((x) => <ConnLine key={`c${x.id}`} t={t} label={x.name ?? x.mac ?? '—'} sub={x.ip ?? (x.wired ? 'wired' : 'wireless')} onClick={() => onOpen({ kind: 'client', data: x })} />)}
            </DrawerSection>
          )}
          {c && uplinkDevice && (
            <DrawerSection t={t} title="Connected to">
              <ConnLine t={t} label={uplinkDevice.name ?? uplinkDevice.model ?? '—'} sub={c.sw_port != null ? `port ${c.sw_port}` : 'device'} onClick={() => onOpen({ kind: 'device', data: uplinkDevice })} />
            </DrawerSection>
          )}

          {isDevice && d?.id && (
            <DrawerSection t={t} title="Device history (24h)">
              <DeviceHistory t={t} id={d.id} />
            </DrawerSection>
          )}
          {!isDevice && c?.id && (
            <DrawerSection t={t} title="Throughput (24h)">
              <Sparkline t={t} kind="client" id={c.id} />
            </DrawerSection>
          )}
          <DrawerSection t={t} title="All signals">
            <RawTree t={t} data={isDevice ? d?.raw : c?.raw} />
          </DrawerSection>
        </Box>
      )}
    </Drawer>
    <PortDetailDialog
      t={t}
      port={selPort}
      legacy={legacyPort}
      deviceId={d?.id ?? null}
      deviceName={d?.name ?? d?.model ?? null}
      onClose={() => setSelPort(null)}
    />
    </>
  );
}

// Device product image (downloaded by scripts/fetch-unifi-images.mjs into
// public/unifi-devices/). Filename is the normalized model slug; hidden if the
// image is missing (onError) so unknown models just show no picture.
function deviceSlug(model: string | null): string | null {
  if (!model) return null;
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '-');
  return slug || null;
}
function DeviceImage({ t, model }: { t: Tk; model: string | null }) {
  const slug = deviceSlug(model);
  const [ok, setOk] = useState(true);
  if (!slug || !ok) return null;
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', mb: 2, p: 1.5, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}` }}>
      <img
        src={`/unifi-devices/${slug}.png`}
        alt={model ?? 'device'}
        onError={() => setOk(false)}
        style={{ width: '100%', maxHeight: 220, objectFit: 'contain', display: 'block' }}
      />
    </Box>
  );
}

// Mini 24h throughput chart for a device or client (uses /api/unifi/history).
function Sparkline({ t, kind, id }: { t: Tk; kind: 'device' | 'client'; id: string }) {
  const [pts, setPts] = useState<{ ts: number; down: number | null; up: number | null }[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const param = kind === 'device' ? 'deviceId' : 'clientId';
        const r = await apiFetch(`/api/unifi/history?range=24h&${param}=${encodeURIComponent(id)}`);
        const j = await r.json();
        const rows: { received_at: number; rx_bps: number | null; tx_bps: number | null }[] = Array.isArray(j.points) ? j.points : [];
        if (!cancel) setPts(rows.map((p) => ({ ts: p.received_at, down: p.rx_bps, up: p.tx_bps })));
      } catch { /* ignore */ }
      finally { if (!cancel) setLoaded(true); }
    })();
    return () => { cancel = true; };
  }, [kind, id]);
  if (loaded && pts.length < 2) {
    return <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>Not enough history yet.</Typography>;
  }

  return (
    <ResponsiveContainer width="100%" height={92}>
      <ComposedChart data={pts} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.rust} stopOpacity={0.35} />
            <stop offset="100%" stopColor={t.rust} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <ChartTooltip
          contentStyle={{ background: t.paper, border: `1px solid ${t.line}`, borderRadius: 8, fontSize: 11, color: t.ink }}
          labelFormatter={(ts) => new Date(ts as number).toLocaleTimeString()}
          formatter={(v, n) => [fmtBps(Number(v)), n]}
        />
        <Area type="monotone" dataKey="down" name="Down" stroke={t.rust} strokeWidth={1.5} fill="url(#sparkFill)" dot={false} connectNulls />
        <Area type="monotone" dataKey="up" name="Up" stroke={t.champagne} strokeWidth={1.5} fill="none" dot={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

interface DeviceHistoryPoint {
  received_at: number;
  rx_bps: number | null;
  tx_bps: number | null;
  poe_power: number | null;
  online: number | null;
  uptime: number | null;
  cpu: number | null;
  mem: number | null;
  temperature: number | null;
}

function DeviceHistory({ t, id }: { t: Tk; id: string }) {
  const [points, setPoints] = useState<DeviceHistoryPoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(`/api/unifi/history?range=24h&deviceId=${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (!controller.signal.aborted) setPoints(Array.isArray(body.points) ? body.points : []);
      } catch { /* last-known empty state is explicit below */ }
      finally { if (!controller.signal.aborted) setLoaded(true); }
    })();
    return () => controller.abort();
  }, [id]);

  if (!loaded) return <Skeleton variant="rounded" height={260} sx={{ borderRadius: '10px' }} />;
  if (points.length < 2) return <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>Not enough device history yet.</Typography>;
  const latest = points.at(-1);
  const restarts = points.reduce((count, point, index) => (
    index > 0
    && point.uptime != null
    && points[index - 1]?.uptime != null
    && point.uptime < (points[index - 1]?.uptime ?? 0)
      ? count + 1
      : count
  ), 0);
  const chartPoints = points.map((point) => ({ ...point, ts: point.received_at }));
  const tooltipStyle = { background: t.paper, border: `1px solid ${t.line}`, borderRadius: 8, fontSize: 11, color: t.ink };

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 0.75 }}>
        <MetaChip t={t} label="CPU" value={latest?.cpu == null ? '—' : n1(latest.cpu, '%')} />
        <MetaChip t={t} label="Mem" value={latest?.mem == null ? '—' : n1(latest.mem, '%')} />
        <MetaChip t={t} label="Temp" value={latest?.temperature == null ? '—' : n1(latest.temperature, '°C')} />
        <MetaChip t={t} label="Restarts" value={String(restarts)} />
      </Box>
      <Box>
        <Typography sx={{ color: t.muted, fontSize: '0.64rem', fontWeight: 750, mb: 0.35 }}>Throughput</Typography>
        <ResponsiveContainer width="100%" height={100}>
          <ComposedChart data={chartPoints} margin={{ top: 3, right: 3, bottom: 0, left: 0 }}>
            <ChartTooltip contentStyle={tooltipStyle} labelFormatter={(ts) => new Date(ts as number).toLocaleTimeString()} formatter={(value, name) => [fmtBps(Number(value)), name]} />
            <Area type="monotone" dataKey="rx_bps" name="Down" stroke={t.rust} fill={`${t.rust}26`} dot={false} connectNulls />
            <Line type="monotone" dataKey="tx_bps" name="Up" stroke={t.champagne} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
      <Box>
        <Typography sx={{ color: t.muted, fontSize: '0.64rem', fontWeight: 750, mb: 0.35 }}>Resources</Typography>
        <ResponsiveContainer width="100%" height={118}>
          <ComposedChart data={chartPoints} margin={{ top: 3, right: 3, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
            <YAxis yAxisId="percent" domain={[0, 100]} hide />
            <YAxis yAxisId="temperature" orientation="right" hide />
            <ChartTooltip contentStyle={tooltipStyle} labelFormatter={(ts) => new Date(ts as number).toLocaleTimeString()} />
            <Line yAxisId="percent" type="monotone" dataKey="cpu" name="CPU %" stroke={t.rust} dot={false} connectNulls />
            <Line yAxisId="percent" type="monotone" dataKey="mem" name="Memory %" stroke={t.champagne} dot={false} connectNulls />
            <Line yAxisId="temperature" type="monotone" dataKey="temperature" name="Temperature °C" stroke="#C4443A" strokeDasharray="4 3" dot={false} connectNulls />
            <Legend wrapperStyle={{ fontSize: 10 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Box>
    </Box>
  );
}

function DrawerChip({ t, label, accent }: { t: Tk; label: string; accent?: string }) {
  const col = accent ?? t.rust;
  return <Chip label={label} size="small" sx={{ height: 22, fontSize: '0.7rem', fontWeight: 700, bgcolor: `${col}1E`, color: col, border: `1px solid ${col}44` }} />;
}

// Per-port detail popup — current fields plus retained state/counter history.
function PortDetailDialog({ t, port, legacy, deviceId, deviceName, onClose }: {
  t: Tk;
  port: Port | null;
  legacy: unknown;
  deviceId: string | null;
  deviceName: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!port} onClose={onClose} maxWidth="md" fullWidth
      PaperProps={{ sx: { background: t.bg, border: `1px solid ${t.line}`, borderRadius: CARD_RADIUS } }}>
      {port && (
        <Box sx={{ p: 2.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
            <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: t.ink }}>Port {port.idx}</Typography>
            <IconButton onClick={onClose} size="small" sx={{ color: t.muted }}><CloseIcon fontSize="small" /></IconButton>
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
            <DrawerChip t={t} label={port.up ? 'Up' : 'Down'} accent={port.up ? '#2E9E5B' : '#C4443A'} />
            {port.speed != null && <DrawerChip t={t} label={`${port.speed} Mbps`} />}
            {port.connector && <DrawerChip t={t} label={port.connector} />}
            {port.poe_active && <DrawerChip t={t} label={`PoE${port.poe_power ? ` ${port.poe_power}W` : ''}`} accent={t.rust} />}
            {port.connected && <DrawerChip t={t} label={port.connected} />}
            {port.stp_state && <DrawerChip t={t} label={`STP ${port.stp_state}`} />}
            {(port.rx_errors ?? 0) + (port.tx_errors ?? 0) > 0 && <DrawerChip t={t} label={`${(port.rx_errors ?? 0) + (port.tx_errors ?? 0)} errors`} accent="#C4841A" />}
            {(port.rx_dropped ?? 0) + (port.tx_dropped ?? 0) > 0 && <DrawerChip t={t} label={`${(port.rx_dropped ?? 0) + (port.tx_dropped ?? 0)} drops`} accent="#C4841A" />}
          </Box>
          {deviceId && port.idx != null && (
            <Box sx={{ mb: 1.5 }}>
              <PortHistory t={t} deviceId={deviceId} deviceName={deviceName} portIdx={port.idx} />
            </Box>
          )}
          <Box sx={{ p: 1.25, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`, maxHeight: 380, overflowY: 'auto' }}>
            <RawTree t={t} data={legacy ?? port} />
          </Box>
        </Box>
      )}
    </Dialog>
  );
}

interface PortHistoryPoint {
  received_at: number;
  device_name: string | null;
  port_idx: number;
  port_name: string | null;
  connected: string | null;
  up: number | null;
  speed: number | null;
  full_duplex: number | null;
  poe_active: number | null;
  poe_power: number | null;
  rx_errors: number | null;
  tx_errors: number | null;
  rx_dropped: number | null;
  tx_dropped: number | null;
  stp_state: string | null;
}

function PortHistory({ t, deviceId, deviceName, portIdx }: {
  t: Tk;
  deviceId: string;
  deviceName: string | null;
  portIdx: number;
}) {
  const [points, setPoints] = useState<PortHistoryPoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(`/api/unifi/ports/history?range=30d&deviceId=${encodeURIComponent(deviceId)}&portIdx=${portIdx}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (!controller.signal.aborted) setPoints(Array.isArray(body.points) ? body.points : []);
      } catch { /* explicit empty state below */ }
      finally { if (!controller.signal.aborted) setLoaded(true); }
    })();
    return () => controller.abort();
  }, [deviceId, portIdx]);

  if (!loaded) return <Skeleton variant="rounded" height={210} sx={{ borderRadius: '10px' }} />;
  if (!points.length) return <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>No retained port history yet.</Typography>;

  const changes = points.flatMap((point, index) => {
    const prior = points[index - 1];
    if (index === 0 || !prior) return [];
    const labels = [
      point.up !== prior.up ? (point.up ? 'link up' : 'link down') : null,
      point.speed !== prior.speed && point.speed ? `${point.speed} Mbps` : null,
      point.poe_active !== prior.poe_active ? (point.poe_active ? 'PoE active' : 'PoE inactive') : null,
      point.stp_state !== prior.stp_state && point.stp_state ? `STP ${point.stp_state}` : null,
      point.connected !== prior.connected && point.connected ? `connected ${point.connected}` : null,
    ].filter(Boolean);
    const errors = (point.rx_errors ?? 0) - (prior.rx_errors ?? 0) + (point.tx_errors ?? 0) - (prior.tx_errors ?? 0);
    const drops = (point.rx_dropped ?? 0) - (prior.rx_dropped ?? 0) + (point.tx_dropped ?? 0) - (prior.tx_dropped ?? 0);
    if (errors > 0) labels.push(`+${errors} errors`);
    if (drops > 0) labels.push(`+${drops} drops`);
    return labels.length ? [{ ts: point.received_at, labels, down: point.up === 0 }] : [];
  }).reverse();
  const chart = points.map((point) => ({
    ts: point.received_at,
    errors: (point.rx_errors ?? 0) + (point.tx_errors ?? 0),
    drops: (point.rx_dropped ?? 0) + (point.tx_dropped ?? 0),
    poe: point.poe_power,
  }));

  return (
    <Box sx={{ p: 1.25, borderRadius: CARD_RADIUS, background: t.paper, border: `1px solid ${t.line}` }}>
      <Typography sx={{ color: t.ink, fontSize: '0.78rem', fontWeight: 800 }}>
        {deviceName ?? 'Device'} · port {portIdx} history
      </Typography>
      <Typography sx={{ color: t.muted, fontSize: '0.66rem', mt: 0.2 }}>
        Change-driven samples with an hourly heartbeat
      </Typography>
      <ResponsiveContainer width="100%" height={135}>
        <ComposedChart data={chart} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
          <YAxis yAxisId="counter" hide />
          <YAxis yAxisId="power" orientation="right" hide />
          <ChartTooltip
            contentStyle={{ background: t.paper, border: `1px solid ${t.line}`, borderRadius: 8, fontSize: 11, color: t.ink }}
            labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
          />
          <Area yAxisId="counter" type="stepAfter" dataKey="drops" name="Drops" stroke="#C4841A" fill="#C4841A22" connectNulls />
          <Line yAxisId="counter" type="stepAfter" dataKey="errors" name="Errors" stroke="#C4443A" dot={false} connectNulls />
          <Line yAxisId="power" type="monotone" dataKey="poe" name="PoE W" stroke={t.rust} dot={false} connectNulls />
          <Legend wrapperStyle={{ fontSize: 10 }} />
        </ComposedChart>
      </ResponsiveContainer>
      <Box sx={{ maxHeight: 150, overflowY: 'auto', mt: 0.5 }}>
        {changes.length ? changes.slice(0, 30).map((change) => (
          <Box key={change.ts} sx={{ display: 'flex', gap: 1, justifyContent: 'space-between', py: 0.45, borderTop: `1px solid ${t.line}` }}>
            <Typography sx={{ color: change.down ? '#C4443A' : t.inkSoft, fontSize: '0.68rem', fontWeight: 650 }}>{change.labels.join(' · ')}</Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.62rem', flexShrink: 0 }}>{new Date(change.ts).toLocaleString()}</Typography>
          </Box>
        )) : (
          <Typography sx={{ color: t.muted, fontSize: '0.68rem', textAlign: 'center', py: 1 }}>No material port changes recorded.</Typography>
        )}
      </Box>
    </Box>
  );
}

// Small click-to-copy chip for IP / MAC in the drawer header.
function CopyChip({ t, label, value }: { t: Tk; label?: string; value: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* ignore */ }
  };
  return (
    <Box onClick={copy} title="Copy" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, cursor: 'pointer', px: 0.75, py: 0.25, borderRadius: '6px', border: `1px solid ${t.line}`, '&:hover': { borderColor: t.rust } }}>
      {label && <Typography component="span" sx={{ fontSize: '0.62rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</Typography>}
      <Typography component="span" sx={{ fontSize: '0.72rem', color: t.inkSoft, fontFamily: 'monospace' }}>{value}</Typography>
      {done ? <CheckIcon sx={{ fontSize: 13, color: '#2E9E5B' }} /> : <CopyIcon sx={{ fontSize: 13, color: t.muted }} />}
    </Box>
  );
}

function DrawerSection({ t, title, children }: { t: Tk; title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography sx={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.muted, mb: 0.75 }}>{title}</Typography>
      <Box sx={{ p: 1.25, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}` }}>{children}</Box>
    </Box>
  );
}

function ConnLine({ t, label, sub, onClick }: { t: Tk; label: string; sub?: string; onClick?: () => void }) {
  return (
    <Box onClick={onClick} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, py: 0.5, ...(onClick ? { cursor: 'pointer', mx: -0.75, px: 0.75, borderRadius: '6px', '&:hover': { background: `${t.rust}14` } } : {}) }}>
      <Typography sx={{ fontSize: '0.8rem', color: onClick ? t.rust : t.ink, fontWeight: onClick ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
        {sub && <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>{sub}</Typography>}
        {onClick && <ChevronRightIcon sx={{ fontSize: 15, color: t.muted }} />}
      </Box>
    </Box>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function ValueSpan({ t, v }: { t: Tk; v: string }) {
  return <Typography component="span" sx={{ fontSize: '0.74rem', color: t.inkSoft, wordBreak: 'break-word' }}>{v}</Typography>;
}

// Recursive key/value renderer for the full raw object — "every possible signal".
function RawTree({ t, data, depth = 0 }: { t: Tk; data: unknown; depth?: number }) {
  if (data === null || data === undefined || typeof data !== 'object') {
    return <ValueSpan t={t} v={fmtVal(data)} />;
  }
  const entries: [string, unknown][] = Array.isArray(data)
    ? data.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return <ValueSpan t={t} v={Array.isArray(data) ? '[ ]' : '{ }'} />;
  return (
    <Box sx={{ pl: depth ? 1.25 : 0, borderLeft: depth ? `1px solid ${t.line}` : 'none' }}>
      {entries.map(([k, v]) => {
        const nested = v !== null && typeof v === 'object';
        return (
          <Box key={k} sx={{ py: 0.15, display: nested ? 'block' : 'flex', gap: 1 }}>
            <Typography component="span" sx={{ fontSize: '0.72rem', fontWeight: 700, color: t.muted, flexShrink: 0 }}>{k}</Typography>
            {nested ? <RawTree t={t} data={v} depth={depth + 1} /> : <ValueSpan t={t} v={fmtVal(v)} />}
          </Box>
        );
      })}
    </Box>
  );
}
