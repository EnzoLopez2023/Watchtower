// Power Monitor — read-only UPS dashboard.
//
// Displays the latest reading pushed by the local NUT agent (scripts/ups-agent)
// plus a history chart. Data is polled from Watchtower's own API (/api/ups,
// /api/ups/history) — it never touches the UPS directly, so this page works from
// anywhere the Watchtower app is reachable. Auto-refreshes every 30s; no manual pull
// against the NUT server.

import { apiFetch } from './services/apiClient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Chip, CircularProgress, useMediaQuery } from '@mui/material';
import { motion } from 'framer-motion';
import {
  Bolt as BoltIcon,
  BatteryChargingFull as BatteryIcon,
  Timer as TimerIcon,
  Speed as LoadIcon,
  Power as InputIcon,
  Thermostat as TempIcon,
  ElectricalServices as OutputIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip as ChartTooltip, Legend,
} from 'recharts';
import PageHero from './components/PageHero';
import { useThemeMode } from './context/ThemeContext';
import { tokensFor } from './theme/tokens';
import Scrim from './components/Scrim';
import { CARD_HOVER_SX, CARD_RADIUS, pageShellSx } from './theme/controls';

// ── Types ───────────────────────────────────────────────────────────────────
interface Reading {
  received_at: number;
  device_ts: number | null;
  ups_status: string | null;
  battery_charge: number | null;
  battery_runtime: number | null;
  battery_voltage: number | null;
  ups_load: number | null;
  input_voltage: number | null;
  output_voltage: number | null;
  output_power: number | null;
  ups_temperature: number | null;
  raw: Record<string, string> | null;
}
interface UpsEntry {
  ups_id: string;
  label: string;
  age_seconds: number;
  stale: boolean;
  reading: Reading;
}
interface AgentDiag {
  agent_build?: number;
  units?: { id: string; label: string; host: string }[];
  errors?: Record<string, { error: string; at: number }>;
}
interface SnapshotResponse {
  ok: boolean;
  present: boolean;
  age_seconds?: number;
  stale?: boolean;
  reading?: Reading;
  upses?: UpsEntry[];
  diagnostics?: AgentDiag | null;
}
interface HistoryPoint {
  received_at: number;
  ups_status: string | null;
  battery_charge: number | null;
  ups_load: number | null;
  battery_runtime: number | null;
  input_voltage: number | null;
  output_power: number | null;
}
type RangeKey = '24h' | '7d' | '30d';

// ── NUT status decode ────────────────────────────────────────────────────────
// ups.status is space-separated flags (OL, OB, LB, CHRG, DISCHRG, RB, …).
const STATE = {
  online:  { key: 'online',  label: 'Online',       hint: 'Running on utility power' },
  battery: { key: 'battery', label: 'On Battery',   hint: 'Utility power lost — running on battery' },
  low:     { key: 'low',     label: 'Low Battery',  hint: 'Battery critically low — shutdown imminent' },
  unknown: { key: 'unknown', label: 'Unknown',      hint: 'No status reported' },
} as const;

function decodeStatus(status: string | null) {
  const flags = (status ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  const has = (f: string) => flags.includes(f);
  const primary = has('LB') ? STATE.low : has('OB') ? STATE.battery : has('OL') ? STATE.online : STATE.unknown;
  const chips: string[] = [];
  if (has('CHRG')) chips.push('Charging');
  if (has('DISCHRG')) chips.push('Discharging');
  if (has('RB')) chips.push('Replace battery');
  if (has('BYPASS')) chips.push('Bypass');
  if (has('CAL')) chips.push('Calibrating');
  if (has('OVER')) chips.push('Overload');
  if (has('TRIM')) chips.push('Trimming voltage');
  if (has('BOOST')) chips.push('Boosting voltage');
  return { ...primary, flags, chips };
}

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtRuntime(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

const RANGES: RangeKey[] = ['24h', '7d', '30d'];

export default function UpsMonitor() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'power');
  const isMobile = useMediaQuery('(max-width:700px)');

  const [snap, setSnap] = useState<SnapshotResponse | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [range, setRange] = useState<RangeKey>('24h');
  // Which UPS the detail section is showing. Null until the first snapshot
  // arrives, then defaults to the first unit.
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSnap = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ups');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (rk: RangeKey, upsId: string | null) => {
    try {
      const r = await apiFetch(`/api/ups/history?range=${rk}${upsId ? `&ups=${encodeURIComponent(upsId)}` : ''}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setHistory(Array.isArray(j.points) ? j.points : []);
    } catch {
      /* keep last-known history */
    }
  }, []);

  // Initial load + 30s auto-refresh (snapshot + current range).
  useEffect(() => {
    void loadSnap();
    void loadHistory(range, selected);
    const id = setInterval(() => { void loadSnap(); void loadHistory(range, selected); }, 30_000);
    return () => clearInterval(id);
  }, [loadSnap, loadHistory, range, selected]);

  const upses: UpsEntry[] = useMemo(() => snap?.upses ?? [], [snap]);

  // Settle on a selection once the units are known.
  useEffect(() => {
    const first = upses[0];
    if (!selected && first) setSelected(first.ups_id);
  }, [upses, selected]);

  const active = useMemo(
    () => upses.find((u) => u.ups_id === selected) ?? upses[0] ?? null,
    [upses, selected],
  );

  // Units the agent is configured for but currently cannot read.
  const unreachable = useMemo(
    () => Object.entries(snap?.diagnostics?.errors ?? {}),
    [snap],
  );
  const labelFor = useCallback(
    (id: string) => snap?.diagnostics?.units?.find((u) => u.id === id)?.label ?? id,
    [snap],
  );
  // Fall back to the legacy top-level reading so the page still works against
  // an older server response that has no `upses` array.
  const reading = active?.reading ?? snap?.reading;
  const status = decodeStatus(reading?.ups_status ?? null);

  // Semantic status colors (independent of palette; status is never color-alone).
  const statusColor = useMemo(() => {
    const map = {
      online:  isDark ? '#43C97D' : '#2E9E5B',
      battery: isDark ? '#E6A63A' : '#C4841A',
      low:     isDark ? '#E0655A' : '#C4443A',
      unknown: t.muted,
    };
    return map[status.key];
  }, [status.key, isDark, t.muted]);

  const chartData = useMemo(() => history.map(p => ({
    ts: p.received_at,
    battery: p.battery_charge,
    load: p.ups_load,
  })), [history]);

  const xTick = useCallback((ts: number) => {
    const d = new Date(ts);
    return range === '24h'
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }, [range]);

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        eyebrow="Power Monitor"
        title="UPS status & battery"
        accentPhrase="battery"
        subtitle="Live readings from your UPS, pushed by the on-site agent. Read-only — no direct connection to the UPS from here."
        actions={
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
        }
      />

      {loading && !snap && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress size={30} sx={{ color: t.rust }} />
        </Box>
      )}

      {error && (
        <Banner color={statusColor} bg={t.paper} border={t.line} ink={t.ink} muted={t.muted}
          icon={<WarningIcon />} title="Couldn't reach the Watchtower UPS API" text={error} />
      )}

      {snap && !snap.present && !error && (
        <Banner color={t.rust} bg={t.paper} border={t.line} ink={t.ink} muted={t.muted}
          icon={<BoltIcon />} title="Waiting for the first reading"
          text="No data yet. Start the UPS agent on your always-on host (scripts/ups-agent) and it will begin posting readings here." />
      )}

      {reading && (
        <>
          {/* A configured UPS that can never be polled never reaches the server,
              so without this it would just be quietly absent from the page. */}
          {unreachable.length > 0 && (
            <Banner color={isDark ? '#E6A63A' : '#C4841A'} bg={t.paper} border={t.line} ink={t.ink} muted={t.muted}
              icon={<WarningIcon />}
              title={`${unreachable.length} configured UPS ${unreachable.length === 1 ? 'is' : 'are'} not reporting`}
              text={unreachable.map(([id, e]) => `${labelFor(id)}: ${e.error}`).join(' · ')} />
          )}

          {/* Unit selector — only when there is more than one to choose between.
              Both stay visible at a glance; clicking switches the detail below. */}
          {upses.length > 1 && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(240px, 1fr))' }, gap: 1.5, mb: 2.5 }}>
              {upses.map((u) => (
                <UpsPicker
                  key={u.ups_id} u={u} t={t} isDark={isDark}
                  active={u.ups_id === active?.ups_id}
                  onClick={() => setSelected(u.ups_id)}
                />
              ))}
            </Box>
          )}

          {/* Status banner */}
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Box sx={{
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
              p: { xs: 2, md: 2.5 }, borderRadius: CARD_RADIUS,
              background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`,
              borderLeft: `5px solid ${statusColor}`,
              mb: 2.5,
            }}>
              <Box sx={{
                width: 46, height: 46, borderRadius: CARD_RADIUS, flexShrink: 0,
                display: 'grid', placeItems: 'center',
                background: `${statusColor}22`, color: statusColor,
              }}>
                <BoltIcon />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontSize: '1.15rem', fontWeight: 800, color: t.ink, letterSpacing: '-0.01em' }}>
                    {status.label}
                  </Typography>
                  {status.chips.map(c => (
                    <Chip key={c} label={c} size="small" sx={{
                      height: 20, fontSize: '0.66rem', fontWeight: 700,
                      bgcolor: `${t.rust}1E`, color: t.rust, border: `1px solid ${t.rust}44`,
                    }} />
                  ))}
                </Box>
                <Typography sx={{ fontSize: '0.82rem', color: t.muted, mt: 0.25 }}>
                  {status.hint}
                  {reading.ups_status ? ` · raw: ${reading.ups_status}` : ''}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                <Typography sx={{ fontSize: '0.7rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Updated
                </Typography>
                <Typography sx={{ fontSize: '0.9rem', fontWeight: 700, color: (active?.stale ?? snap?.stale) ? statusColor : t.inkSoft }}>
                  {fmtAge(active?.age_seconds ?? snap?.age_seconds)}
                </Typography>
              </Box>
            </Box>
          </motion.div>

          {(active?.stale ?? snap?.stale) && (
            <Banner color={isDark ? '#E6A63A' : '#C4841A'} bg={t.paper} border={t.line} ink={t.ink} muted={t.muted}
              icon={<WarningIcon />} title="Reading is stale"
              text="The latest reading is over 2 hours old. The agent host may be offline — or running on battery during an outage." />
          )}

          {/* Stat grid */}
          <Box sx={{
            display: 'grid', gap: 1.5, mb: 3,
            gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
          }}>
            <StatCard t={t} icon={<BatteryIcon />} label="Battery" value={n1(reading.battery_charge, '%')}
              sub={reading.battery_voltage != null ? `${n1(reading.battery_voltage, ' V')}` : undefined} accent={statusColor} />
            <StatCard t={t} icon={<TimerIcon />} label="Runtime" value={fmtRuntime(reading.battery_runtime)} sub="at current load" />
            <StatCard t={t} icon={<LoadIcon />} label="Load" value={n1(reading.ups_load, '%')}
              sub={reading.output_power != null ? `${n1(reading.output_power, ' W')}` : undefined} />
            <StatCard t={t} icon={<InputIcon />} label="Input" value={n1(reading.input_voltage, ' V')} sub="mains" />
            <StatCard t={t} icon={<OutputIcon />} label="Output" value={n1(reading.output_voltage, ' V')}
              sub={reading.output_power != null ? `${n1(reading.output_power, ' W')}` : undefined} />
            <StatCard t={t} icon={<TempIcon />} label="Temp" value={n1(reading.ups_temperature, '°C')} />
          </Box>

          {/* History chart */}
          <Box sx={{
            p: { xs: 1.5, md: 2.5 }, borderRadius: CARD_RADIUS,
            background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`,
          }}>
            <Typography sx={{ fontSize: '0.9rem', fontWeight: 800, color: t.ink, mb: 0.5 }}>
              History
            </Typography>
            <Typography sx={{ fontSize: '0.76rem', color: t.muted, mb: 2 }}>
              Battery charge and load over the last {range}
            </Typography>
            {chartData.length === 0 ? (
              <Typography sx={{ fontSize: '0.82rem', color: t.muted, py: 4, textAlign: 'center' }}>
                Not enough history yet for this range.
              </Typography>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="batteryFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={statusColor} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={statusColor} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="ts" tickFormatter={xTick} tick={{ fill: t.muted, fontSize: 11 }}
                    stroke={t.line} minTickGap={40} />
                  <YAxis yAxisId="pct" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
                    tick={{ fill: t.muted, fontSize: 11 }} stroke={t.line} width={44} unit="%" />
                  <ChartTooltip
                    contentStyle={{
                      background: t.paper,
                      border: `1px solid ${t.line}`, borderRadius: 10, fontSize: 12, color: t.ink,
                    }}
                    labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
                    formatter={(v, name) => [v == null ? '—' : `${Math.round(Number(v))}%`, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: t.muted }} />
                  <Area yAxisId="pct" type="monotone" dataKey="battery" name="Battery %"
                    stroke={statusColor} strokeWidth={2} fill="url(#batteryFill)" connectNulls dot={false} />
                  <Line yAxisId="pct" type="monotone" dataKey="load" name="Load %"
                    stroke={t.rust} strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </Box>

          {/* Outage history, derived from readings already stored */}
          <OutageTimeline t={t} isDark={isDark} upsId={selected} />

          {/* Full device details — every variable reported by the UPS */}
          {reading.raw && Object.keys(reading.raw).length > 0 && (
            <DeviceDetails t={t} raw={reading.raw} isMobile={isMobile} />
          )}
        </>
      )}
    </Box>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────
// ── Outage timeline ──────────────────────────────────────────────────────────
// Periods spent on battery, derived from readings already stored.
//
// The agent writes on change plus an hourly heartbeat, so a short outage often
// leaves a single "on battery" row. Durations are therefore shown as an upper
// bound rather than a figure: last night's real ~12-minute outage produced one
// sample, where "last seen minus first seen" would have read 0 minutes.
interface Outage {
  started_at: number;
  ended_at: number | null;
  observed_seconds: number;
  max_seconds: number | null;
  samples: number;
  min_charge: number | null;
  min_runtime: number | null;
  low_battery: boolean;
  ongoing: boolean;
  coarse: boolean;
}
interface OutageUnit {
  ups_id: string;
  label: string;
  outages: Outage[];
  summary: { count: number; total_observed_seconds: number; longest_max_seconds: number; last_at: number | null; ongoing: boolean };
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function OutageTimeline({ t, isDark, upsId }: {
  t: ReturnType<typeof tokensFor>; isDark: boolean; upsId: string | null;
}) {
  const [units, setUnits] = useState<OutageUnit[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/ups/outages?days=90')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && Array.isArray(j?.units)) setUnits(j.units); })
      .catch(() => { if (!cancelled) setUnits([]); });
    return () => { cancelled = true; };
  }, []);

  if (units === null) return null;
  const unit = units.find((u) => u.ups_id === upsId) ?? units[0];
  if (!unit) return null;

  // Only genuine alerts keep a fixed colour: "the power is out" must not become
  // unreadable because a theme was pinned. Everything else is token-derived, so
  // the theme button in the top right controls it.
  const bad = isDark ? '#F0776E' : '#C4443A';

  return (
    <Box sx={{ mt: 3 }}>
      <Scrim sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, color: t.ink }}>
          Outage history
        </Typography>
        <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
        {unit.label} · last 90 days ·{' '}
        {unit.summary.count === 0
          ? 'no time on battery'
          : `${unit.summary.count} time${unit.summary.count === 1 ? '' : 's'} on battery`}
        </Typography>
      </Scrim>

      {unit.summary.count === 0 ? (
        <Box sx={{ p: 2, borderRadius: 2, border: `1px solid ${t.line}`, background: t.paper }}>
          <Typography sx={{ fontSize: '0.82rem', color: t.muted }}>
            Mains power has been continuous for every reading on record.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {unit.outages.map((o) => (
            <Box
              key={o.started_at}
              sx={{
                p: 1.5, borderRadius: 2, background: t.paper, ...CARD_HOVER_SX,
                border: `1px solid ${o.ongoing ? bad : t.line}`,
                borderLeft: `3px solid ${o.ongoing ? bad : o.low_battery ? bad : t.rust}`,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: t.ink }}>
                  {new Date(o.started_at).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </Typography>
                <Typography sx={{ fontSize: '0.85rem', color: o.ongoing ? bad : t.inkSoft, fontWeight: 600 }}>
                  {o.ongoing
                    ? 'on battery now'
                    : o.max_seconds != null
                      ? `up to ${fmtDuration(o.max_seconds)}`
                      : fmtDuration(o.observed_seconds)}
                </Typography>
                {o.low_battery && (
                  <Chip size="small" label="low battery" sx={{ height: 18, fontSize: '0.65rem', color: bad, background: `${bad}22` }} />
                )}
              </Box>
              <Typography sx={{ fontSize: '0.74rem', color: t.muted, mt: 0.25 }}>
                {o.min_charge != null && `battery down to ${Math.round(o.min_charge)}%`}
                {o.min_runtime != null && ` · ${fmtRuntime(o.min_runtime)} left at worst`}
                {o.coarse
                  // Say so rather than implying the bound is a measurement.
                  ? ' · only one reading captured, so the exact duration is unknown'
                  : ` · ${o.samples} readings, at least ${fmtDuration(o.observed_seconds)} on battery`}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      {unit.summary.count > 0 && !unit.summary.ongoing && (
        <Scrim sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>
            Currently on mains.
          </Typography>
        </Scrim>
      )}
    </Box>
  );
}

// ── UPS picker ───────────────────────────────────────────────────────────────
// A compact always-visible summary per unit. The point is that both are legible
// at a glance — you shouldn't have to click to find out one is on battery.
function UpsPicker({ u, t, isDark, active, onClick }: {
  u: UpsEntry; t: ReturnType<typeof tokensFor>; isDark: boolean; active: boolean; onClick: () => void;
}) {
  const st = decodeStatus(u.reading.ups_status ?? null);
  const color = st.key === 'online' ? (isDark ? '#43C97D' : '#2E9E5B')
    : st.key === 'battery' ? (isDark ? '#E6A63A' : '#C4841A')
    : st.key === 'low' ? (isDark ? '#E0655A' : '#C4443A')
    : t.muted;
  const model = u.reading.raw?.['ups.model'];
  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      sx={{
        cursor: 'pointer', p: 1.5, borderRadius: CARD_RADIUS,
        background: t.paper, ...CARD_HOVER_SX,
        border: `1px solid ${active ? t.rust : t.line}`,
        borderLeft: `4px solid ${color}`,
        // Selection ring rides on top of the shared card shadow rather than
        // replacing it, so a selected unit still lifts like every other card.
        boxShadow: active ? `0 0 0 1px ${t.rust}55, var(--card-shadow)` : 'var(--card-shadow)',
        transition: 'border-color .15s, box-shadow 180ms ease, transform 180ms ease',
        '&:hover': {
          borderColor: `${t.rust}88`,
          boxShadow: active ? `0 0 0 1px ${t.rust}55, var(--card-shadow-hover)` : 'var(--card-shadow-hover)',
          transform: 'translateY(-2px)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontWeight: 800, color: t.ink, fontSize: '0.92rem', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {u.label}
        </Typography>
        <Chip size="small" label={st.label}
          sx={{ height: 20, fontSize: '0.66rem', fontWeight: 700, bgcolor: `${color}1E`, color }} />
      </Box>
      <Box sx={{ display: 'flex', gap: 1.5, mt: 0.75, flexWrap: 'wrap' }}>
        <Metric t={t} label="Battery" value={u.reading.battery_charge != null ? `${u.reading.battery_charge}%` : '—'} />
        <Metric t={t} label="Load" value={u.reading.ups_load != null ? `${u.reading.ups_load}%` : '—'} />
        <Metric t={t} label="Runtime" value={fmtRuntime(u.reading.battery_runtime)} />
      </Box>
      {(model || u.stale) && (
        <Typography sx={{ fontSize: '0.68rem', color: u.stale ? color : t.muted, mt: 0.5 }}>
          {u.stale ? `Stale · ${fmtAge(u.age_seconds)}` : String(model)}
        </Typography>
      )}
    </Box>
  );
}

function Metric({ t, label, value }: { t: ReturnType<typeof tokensFor>; label: string; value: string }) {
  return (
    <Box>
      <Typography sx={{ fontSize: '0.62rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</Typography>
      <Typography sx={{ fontSize: '0.88rem', fontWeight: 700, color: t.ink }}>{value}</Typography>
    </Box>
  );
}

function StatCard({ t, icon, label, value, sub, accent }: {  t: ReturnType<typeof tokensFor>;
  icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string;
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

// Friendly labels for known NUT variables; unknown keys fall back to the raw name.
const VAR_LABELS: Record<string, string> = {
  'ups.mfr': 'Manufacturer', 'ups.model': 'Model', 'ups.serial': 'Serial number',
  'ups.id': 'UPS ID', 'ups.type': 'Type', 'ups.status': 'Status', 'ups.load': 'Load',
  'ups.temperature': 'Temperature', 'ups.test.result': 'Self-test result',
  'ups.test.date': 'Self-test date', 'ups.test.interval': 'Self-test interval',
  'battery.charge': 'Charge', 'battery.voltage': 'Voltage', 'battery.runtime': 'Runtime',
  'battery.low': 'Low threshold',
  'input.voltage': 'Voltage', 'input.frequency': 'Frequency', 'input.voltage.nominal': 'Nominal voltage',
  'input.transfer.high': 'Transfer high', 'input.transfer.low': 'Transfer low',
  'output.voltage': 'Voltage', 'output.current': 'Current', 'output.power': 'Power',
  'output.power.nominal': 'Nominal power', 'output.frequency': 'Frequency',
};

const GROUP_TITLES: Record<string, string> = {
  ups: 'Device', battery: 'Battery', input: 'Input', output: 'Output',
  driver: 'Driver', server: 'Server',
};
const GROUP_ORDER = ['ups', 'battery', 'input', 'output'];

// Light touch: append a human hint to raw seconds so "2592000" reads sensibly,
// without hiding the exact value the UPS reported.
function withHint(key: string, value: string): string {
  if ((key === 'battery.runtime' || key === 'ups.test.interval') && /^\d+$/.test(value)) {
    const s = Number(value);
    if (key === 'ups.test.interval' && s % 86400 === 0) return `${value}  (${s / 86400} days)`;
    const m = Math.round(s / 60);
    return m >= 60 ? `${value}  (${Math.floor(m / 60)}h ${m % 60}m)` : `${value}  (${m} min)`;
  }
  return value;
}

function DeviceDetails({ t, raw, isMobile }: {
  t: ReturnType<typeof tokensFor>; raw: Record<string, string>; isMobile: boolean;
}) {
  // Group every reported variable by its prefix (the token before the first dot).
  const groups = new Map<string, [string, string][]>();
  for (const key of Object.keys(raw).sort()) {
    const prefix = key.split('.')[0] ?? key;
    const bucket = groups.get(prefix) ?? [];
    bucket.push([key, raw[key] ?? '']);
    groups.set(prefix, bucket);
  }
  const orderedPrefixes = [
    ...GROUP_ORDER.filter(p => groups.has(p)),
    ...[...groups.keys()].filter(p => !GROUP_ORDER.includes(p)).sort(),
  ];

  return (
    <Box sx={{ mt: 3 }}>
      {/* Same rule as the outage section: outside a card means on a scrim. */}
      <Scrim sx={{ mb: 2 }}>
        <Typography sx={{ fontSize: '0.9rem', fontWeight: 800, color: t.ink }}>
          Device details
        </Typography>
        <Typography sx={{ fontSize: '0.76rem', color: t.muted }}>
          Every value reported by the UPS ({Object.keys(raw).length} variables)
        </Typography>
      </Scrim>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)' }}>
        {orderedPrefixes.map(prefix => (
          <Box key={prefix} sx={{
            p: { xs: 1.5, md: 2 }, borderRadius: CARD_RADIUS,
            background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`,
          }}>
            <Typography sx={{
              fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: t.rust, mb: 1,
            }}>
              {GROUP_TITLES[prefix] ?? prefix}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              {groups.get(prefix)!.map(([key, value], i, arr) => (
                <Box key={key} sx={{
                  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2,
                  py: 0.75, borderBottom: i < arr.length - 1 ? `1px solid ${t.line}` : 'none',
                }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontSize: '0.82rem', color: t.inkSoft, fontWeight: 600 }}>
                      {VAR_LABELS[key] ?? key}
                    </Typography>
                    <Typography sx={{ fontSize: '0.64rem', color: t.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                      {key}
                    </Typography>
                  </Box>
                  <Typography sx={{
                    fontSize: '0.85rem', color: t.ink, fontWeight: 700, textAlign: 'right',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-word',
                  }}>
                    {withHint(key, value)}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Banner({ color, bg, border, ink, muted, icon, title, text }: {
  color: string; bg: string; border: string; ink: string; muted: string;
  icon: React.ReactNode; title: string; text: string;
}) {
  return (
    <Box sx={{
      display: 'flex', alignItems: 'flex-start', gap: 1.5, p: 2, mb: 2.5,
      borderRadius: CARD_RADIUS, background: bg, border: `1px solid ${border}`, borderLeft: `5px solid ${color}`,
    }}>
      <Box sx={{ color, mt: '2px', '& svg': { fontSize: 20 } }}>{icon}</Box>
      <Box>
        <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: ink }}>{title}</Typography>
        <Typography sx={{ fontSize: '0.82rem', color: muted, mt: 0.25 }}>{text}</Typography>
      </Box>
    </Box>
  );
}
