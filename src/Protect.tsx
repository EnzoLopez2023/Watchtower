// UniFi Protect — read-only camera + sensor dashboard.
//
// Renders the latest snapshot pushed by the same local agent that feeds the
// UniFi Network page (scripts/unifi-agent) via /api/protect. Metadata + status
// only (no live images): each camera's online state, smart-detection
// capabilities + what's enabled, and its audio/video/HDR feature flags, plus
// UP-Sense sensors (contact, motion, temperature, humidity, ambient light,
// leak) and accessories (floodlights, chimes, sirens, relays). Data is polled
// from Watchtower's own API — it never touches the NVR directly, so this works from
// anywhere Watchtower is reachable. Auto-refreshes every 30s.

import { apiFetch } from './services/apiClient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Box, Typography, Chip, CircularProgress, TextField, InputAdornment,
  ToggleButton, ToggleButtonGroup, Dialog, IconButton, Tooltip, Divider,
  LinearProgress,
} from '@mui/material';
import { motion } from 'framer-motion';
import {
  Videocam as CameraIcon,
  VideocamOff as CameraOffIcon,
  Mic as MicIcon,
  VolumeUp as SpeakerIcon,
  HdrOn as HdrIcon,
  Inventory2 as PackageIcon,
  HighQuality as HdSnapshotIcon,
  DirectionsWalk as PersonIcon,
  DirectionsCar as VehicleIcon,
  Pets as AnimalIcon,
  Badge as PlateIcon,
  Face as FaceIcon,
  Search as SearchIcon,
  Close as CloseIcon,
  Circle as DotIcon,
  Shield as ShieldIcon,
  GraphicEq as AudioIcon,
  Sensors as SensorIcon,
  Thermostat as TempIcon,
  WaterDrop as HumidityIcon,
  LightMode as BrightnessIcon,
  SensorDoor as DoorIcon,
  DirectionsRun as MotionIcon,
  WaterDamage as LeakIcon,
  BatteryAlert as BatteryLowIcon,
  BatteryFull as BatteryIcon,
  SignalCellularAlt as SignalIcon,
  Lightbulb as FloodlightIcon,
  NotificationsActive as SirenIcon,
  Garage as RelayIcon,
  Doorbell as ChimeIcon,
  WarningAmber as WarnIcon,
  Storage as StorageIcon,
  Album as DriveIcon,
  Timeline as TimelineIcon,
  Lan as IpIcon,
  GridOn as HeatmapIcon,
  TrendingUp as ForecastIcon,
} from '@mui/icons-material';
import {
  ResponsiveContainer, ComposedChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip as ChartTooltip,
} from 'recharts';
import PageHero from './components/PageHero';
import Scrim from './components/Scrim';
import { useThemeMode } from './context/ThemeContext';
import { tokensFor } from './theme/tokens';
import { toggleGroupSx, pageShellSx } from './theme/controls';

// ── Types (match routes/protect.js normalized payload) ───────────────────────
interface Camera {
  id: string | null;
  name: string | null;
  mac: string | null;
  model: string | null;
  state: string;
  online: boolean;
  has_mic: boolean;
  has_speaker: boolean;
  has_hdr: boolean;
  has_led: boolean;
  package_camera: boolean;
  full_hd_snapshot: boolean;
  // Enrichment from the console's private API / the Network MAC join. Null when
  // neither is available (an offline camera holds no DHCP lease).
  ip?: string | null;
  model_name?: string | null;
  firmware?: string | null;
  recording_mode?: string | null;
  last_motion_at?: number | null;
  up_since?: number | null;
  is_recording?: boolean | null;
  smart_supported: string[];
  smart_enabled: string[];
  smart_audio: string[];
  video_mode: string | null;
  video_modes: string[];
  hdr_type: string | null;
  mic_volume: number | null;
  mic_enabled: boolean;
  raw?: unknown;
}

// A sensor reading: `status` is Protect's own banding (low/safe/high/neutral).
interface Metric {
  value: number | null;
  status: string | null;
}
interface Sensor {
  id: string | null;
  name: string | null;
  mac: string | null;
  state: string;
  online: boolean;
  mount_type: string | null;
  temperature: Metric;
  humidity: Metric;
  light: Metric;
  is_opened: boolean | null;
  open_changed_at: number | null;
  is_motion: boolean;
  motion_at: number | null;
  leak_at: number | null;
  external_leak_at: number | null;
  alarm_at: number | null;
  tamper_at: number | null;
  battery_pct: number | null;
  battery_low: boolean;
  signal_pct: number | null;
  signal_dbm: number | null;
  enabled: {
    temperature: boolean; humidity: boolean; light: boolean;
    motion: boolean; alarm: boolean; glass_break: boolean; leak: boolean;
  };
}
interface Accessory {
  id: string | null;
  name: string | null;
  mac: string | null;
  kind: 'light' | 'chime' | 'siren' | 'relay';
  state: string;
  online: boolean;
  battery_pct: number | null;
  signal_dbm: number | null;
  is_dark?: boolean;
  is_light_on?: boolean;
  pir_motion?: boolean;
  last_motion?: number | null;
  mode?: string | null;
  siren_active?: boolean;
  volume?: number | null;
  paired_cameras?: number;
  outputs?: { id: number | null; name: string | null; type: string | null; state: string | null }[];
}
interface Drive {
  slot: number | null;
  model: string | null;
  serial: string | null;
  size: number | null;
  state: string;
  healthy: boolean | null;
  bad_sectors: number | null;
  temperature: number | null;
  power_on_hours: number | null;
}
interface Storage {
  drives?: Drive[];
  total_bytes?: number | null;
  used_bytes?: number | null;
  used_pct?: number | null;
  recording_total?: number | null;
  recording_used?: number | null;
  recording_available?: number | null;
  retention_days?: number | null;
  is_recycling?: boolean;
  cpu_temp?: number | null;
  mem_total?: number | null;
  mem_free?: number | null;
}
interface ProtectEvent {
  event_id: string;
  start_ms: number;
  end_ms: number | null;
  type: string | null;
  camera_id: string | null;
  camera_name: string | null;
  smart_types: string[];
  score: number | null;
}
interface ActivityCamera { camera: string; total: number; hours: number[] }
interface Activity {
  days: number;
  peak: number;
  total: number;
  hour_totals: number[];
  cameras: ActivityCamera[];
}
interface Forecast {
  state: 'collecting' | 'filling' | 'recycling' | 'stable';
  samples?: number;
  span_days?: number;
  bytes_per_day?: number;
  used_bytes?: number;
  total_bytes?: number;
  free_bytes?: number;
  used_pct?: number;
  days_until_full?: number | null;
}
interface ProtectSnapshot {
  ok: boolean;
  present?: boolean;
  stale?: boolean;
  age_seconds?: number;
  received_at?: number;
  nvr?: { name?: string; version?: string; arm_status?: string | null; host?: string | null; storage?: Storage | null };
  num_cameras?: number;
  cameras_online?: number;
  num_sensors?: number;
  sensors_online?: number;
  cameras?: Camera[];
  sensors?: Sensor[];
  accessories?: Accessory[];
}

type Filter = 'all' | 'online' | 'offline';

// ── Helpers ──────────────────────────────────────────────────────────────────
const prettify = (s: string): string =>
  s.replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

const SMART_ICON: Record<string, ReactNode> = {
  person: <PersonIcon sx={{ fontSize: '0.95rem' }} />,
  vehicle: <VehicleIcon sx={{ fontSize: '0.95rem' }} />,
  animal: <AnimalIcon sx={{ fontSize: '0.95rem' }} />,
  package: <PackageIcon sx={{ fontSize: '0.95rem' }} />,
  licensePlate: <PlateIcon sx={{ fontSize: '0.95rem' }} />,
  face: <FaceIcon sx={{ fontSize: '0.95rem' }} />,
};
const smartLabel = (t: string): string =>
  ({ person: 'Person', vehicle: 'Vehicle', animal: 'Animal', package: 'Package', licensePlate: 'License Plate', face: 'Face' }[t] ?? prettify(t));

function agoLabel(sec?: number): string {
  if (sec == null) return '';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

// Same as agoLabel but from an absolute unix-ms timestamp (what Protect returns
// for motion/open/leak events). Returns '' for null/0 so callers can skip.
function sinceLabel(ms?: number | null): string {
  if (!ms) return '';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 86_400) return agoLabel(sec);
  const d = Math.round(sec / 86_400);
  return `${d}d ago`;
}

// An event counts as "active" (worth an amber warning) only if it fired in the
// last hour — Protect keeps the last-triggered timestamp forever otherwise.
const ALERT_WINDOW_MS = 60 * 60 * 1000;
const isRecent = (ms?: number | null): boolean => !!ms && Date.now() - ms < ALERT_WINDOW_MS;

const MOUNT_LABEL: Record<string, string> = {
  door: 'Door', window: 'Window', garage: 'Garage', leak: 'Leak', none: 'Sensor',
};
const fmtMetric = (m: Metric | undefined, unit: string, digits = 1): string | null =>
  m?.value == null ? null : `${Number(m.value).toFixed(digits)}${unit}`;

// Drive sizes come back in bytes; TB is the only unit that reads naturally for
// an NVR, but small values (a boot SSD) deserve GB.
const fmtBytes = (b?: number | null): string => {
  if (b == null || !Number.isFinite(b)) return '—';
  const tb = b / 1e12;
  return tb >= 1 ? `${tb.toFixed(tb >= 10 ? 0 : 1)} TB` : `${Math.round(b / 1e9)} GB`;
};

// Protect event type strings → something a human would say.
const EVENT_LABEL: Record<string, string> = {
  motion: 'Motion',
  smartDetectZone: 'Smart detection',
  smartDetectLine: 'Line crossed',
  smartAudioDetect: 'Audio detection',
  ring: 'Doorbell ring',
  sensorOpened: 'Opened',
  sensorClosed: 'Closed',
  sensorMotion: 'Sensor motion',
  sensorExtremeValue: 'Sensor alert',
  sensorWaterLeak: 'Water leak',
  sensorBatteryLow: 'Battery low',
  disconnect: 'Disconnected',
  cameraPowerCycle: 'Power cycled',
  nfcCardScanned: 'NFC scanned',
  fingerprintIdentified: 'Fingerprint',
};
const eventLabel = (ty: string | null): string => (ty ? EVENT_LABEL[ty] ?? prettify(ty) : 'Event');

export default function Protect() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'network');

  const [snap, setSnap] = useState<ProtectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<Camera | null>(null);
  const [history, setHistory] = useState<{ received_at: number; num_cameras: number; cameras_online: number }[]>([]);
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [events, setEvents] = useState<ProtectEvent[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [activityDays, setActivityDays] = useState<7 | 14 | 30>(7);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  // Current state vs. history are different questions, so they get their own
  // sub-pages rather than one very long scroll.
  const [tab, setTab] = useState<'cameras' | 'activity'>('cameras');

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/protect');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // History and events are secondary: they load separately so a failure in
  // either leaves the camera grid intact.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/protect/history?range=${range}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.points) setHistory(d.points); })
      .catch(() => { /* chart just stays empty */ });
    return () => { cancelled = true; };
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    const pull = () => apiFetch('/api/protect/events?hours=24&limit=60')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && Array.isArray(d?.events)) setEvents(d.events); })
      .catch(() => { /* timeline just stays empty */ });
    void pull();
    const id = setInterval(pull, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Hour-of-day only means anything in the viewer's timezone, and the server
  // runs in UTC — so send our offset rather than let it guess.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/protect/activity?days=${activityDays}&tz=${new Date().getTimezoneOffset()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.cameras) setActivity(d); })
      .catch(() => { /* heatmap just stays hidden */ });
    return () => { cancelled = true; };
  }, [activityDays]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/protect/storage-forecast')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.state) setForecast(d); })
      .catch(() => { /* forecast just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const online = isDark ? '#43C97D' : '#2E9E5B';
  const offline = isDark ? '#E0655A' : '#C4443A';

  const cameras = useMemo(() => snap?.cameras ?? [], [snap]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras
      .filter((c) => (filter === 'all' ? true : filter === 'online' ? c.online : !c.online))
      .filter((c) => {
        if (!q) return true;
        return [c.name, c.mac, c.model, c.ip, c.model_name, ...(c.smart_supported ?? [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [cameras, query, filter]);

  const total = snap?.num_cameras ?? cameras.length;
  const onlineCount = snap?.cameras_online ?? cameras.filter((c) => c.online).length;
  const offlineCount = total - onlineCount;
  const smartCount = cameras.filter((c) => (c.smart_enabled ?? []).length > 0).length;

  // Sensors + accessories share the search box with cameras so one query
  // narrows the whole page.
  const sensors = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (snap?.sensors ?? [])
      .filter((s) => !q || [s.name, s.mac, s.mount_type].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [snap, query]);
  const accessories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (snap?.accessories ?? [])
      .filter((a) => !q || [a.name, a.mac, a.kind].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
      .sort((a, b) => (a.kind ?? '').localeCompare(b.kind ?? '') || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [snap, query]);
  const sensorTotal = snap?.num_sensors ?? (snap?.sensors ?? []).length;
  // Present only when the agent reached the console's private API — the
  // documented Integration API exposes no storage data whatsoever.
  const storage = snap?.nvr?.storage ?? null;

  const present = snap?.present;
  const nvrName = snap?.nvr?.name || 'UniFi Protect';
  const nvrVer = snap?.nvr?.version;
  const armStatus = snap?.nvr?.arm_status || null;

  const cardBg = `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`;

  return (
    <Box sx={pageShellSx(true)}>
      <PageHero
        eyebrow="UNIFI PROTECT"
        title="Camera Security"
        accentPhrase="Security"
        subtitle={
          present
            ? <>{nvrName}{nvrVer ? ` · v${nvrVer}` : ''} · updated {agoLabel(snap?.age_seconds)}{snap?.stale ? ' · stale' : ''}</>
            : 'Live camera status from your UniFi Protect NVR.'
        }
        actions={
          present ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip
                icon={<ShieldIcon sx={{ fontSize: '1rem' }} />}
                label={`${onlineCount}/${total} online`}
                sx={{ bgcolor: `${online}22`, color: t.ink, fontWeight: 700, border: `1px solid ${online}55` }}
              />
              {armStatus && (
                <Chip
                  label={`Armed: ${prettify(armStatus)}`}
                  sx={{
                    bgcolor: armStatus === 'breach' ? `${offline}22` : `${t.champagne}22`,
                    color: t.ink, fontWeight: 700,
                    border: `1px solid ${armStatus === 'breach' ? offline : t.champagne}55`,
                  }}
                />
              )}
            </Box>
          ) : undefined
        }
      />

      {loading && !snap && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
          <CircularProgress sx={{ color: t.rust }} />
        </Box>
      )}

      {error && !snap && (
        <Box sx={{ textAlign: 'center', py: 8, color: t.muted }}>
          <Typography>Couldn’t reach the Watchtower Protect API ({error}).</Typography>
        </Box>
      )}

      {snap && !present && (
        <Box sx={{ textAlign: 'center', py: 10, color: t.muted }}>
          <CameraIcon sx={{ fontSize: 48, opacity: 0.4, mb: 1 }} />
          <Scrim sx={{ display: 'block', mx: 'auto', width: 'fit-content', maxWidth: 520 }}>
            <Typography variant="h6" sx={{ color: t.inkSoft, fontWeight: 600 }}>Waiting for the first reading…</Typography>
            <Typography sx={{ mt: 1 }}>
              Once the UniFi agent pushes a Protect snapshot, your cameras appear here.
              Make sure the agent has <code>protectHost</code> + an API key set.
            </Typography>
          </Scrim>
        </Box>
      )}

      {present && (
        <>
          {/* Stat cards stay on both tabs — they're the page's headline. */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 1.5, mb: 2.5 }}>
            <StatCard t={t} label="Cameras" value={total} accent={t.rust} icon={<CameraIcon />} />
            <StatCard t={t} label="Online" value={onlineCount} accent={online} icon={<DotIcon />} />
            <StatCard t={t} label="Offline" value={offlineCount} accent={offlineCount ? offline : t.muted} icon={<CameraOffIcon />} />
            <StatCard t={t} label="Smart detect" value={smartCount} accent={t.champagne} icon={<ShieldIcon />} />
            {sensorTotal > 0 && (
              <StatCard t={t} label="Sensors" value={sensorTotal} accent={t.inkSoft} icon={<SensorIcon />} />
            )}
          </Box>

          <ToggleButtonGroup
            size="small" exclusive value={tab} onChange={(_, v) => v && setTab(v)}
            sx={{ mb: 2.5, ...toggleGroupSx(t) }}
          >
            <ToggleButton value="cameras">Cameras</ToggleButton>
            <ToggleButton value="activity">Activity{events.length ? ` (${events.length})` : ''}</ToggleButton>
          </ToggleButtonGroup>
        </>
      )}

      {present && tab === 'cameras' && (
        <>

          {/* NVR health — only when the private API supplied storage data */}
          {storage && <NvrHealth storage={storage} t={t} cardBg={cardBg} online={online} offline={offline} forecast={forecast} />}

          {/* Uptime history */}
          {history.length > 1 && (
            <Box sx={{ mb: 3, p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}` }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
                <SectionHeading t={t} icon={<TimelineIcon />} title="Cameras online" caption="from the agent's polling history" />
                <ToggleButtonGroup
                  size="small" exclusive value={range} onChange={(_, v) => v && setRange(v)}
                  sx={toggleGroupSx(t)}
                >
                  <ToggleButton value="24h">24h</ToggleButton>
                  <ToggleButton value="7d">7d</ToggleButton>
                  <ToggleButton value="30d">30d</ToggleButton>
                </ToggleButtonGroup>
              </Box>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="protectOnlineFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={online} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={online} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="received_at" stroke={t.line} minTickGap={40}
                    tick={{ fill: t.muted, fontSize: 11 }}
                    tickFormatter={(v) => new Date(v as number).toLocaleString([], range === '24h'
                      ? { hour: 'numeric' }
                      : { month: 'numeric', day: 'numeric' })}
                  />
                  {/* Anchor the axis to the fleet size so a single dropout is
                      visible rather than being auto-scaled into a cliff. */}
                  <YAxis
                    tick={{ fill: t.muted, fontSize: 11 }} stroke={t.line} width={32}
                    allowDecimals={false} domain={[0, (dmax: number) => Math.max(dmax, total)]}
                  />
                  <ChartTooltip
                    contentStyle={{ background: t.paper, border: `1px solid ${t.line}`, borderRadius: 10, fontSize: 12, color: t.ink }}
                    labelFormatter={(v) => new Date(v as number).toLocaleString()}
                    formatter={(v) => [String(v), 'Online']}
                  />
                  <Area type="stepAfter" dataKey="cameras_online" stroke={online} strokeWidth={2} fill="url(#protectOnlineFill)" isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Box>
          )}

          {/* Controls */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 2.5, alignItems: 'center' }}>
            <TextField
              size="small"
              placeholder="Search cameras by name, IP or MAC…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              sx={{ minWidth: 240, flex: '1 1 240px', '& .MuiOutlinedInput-root': { bgcolor: t.paper } }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ color: t.muted }} fontSize="small" /></InputAdornment> }}
            />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={filter}
              onChange={(_, v) => v && setFilter(v)}
              sx={toggleGroupSx(t)}
            >
              <ToggleButton value="all">All ({total})</ToggleButton>
              <ToggleButton value="online">Online ({onlineCount})</ToggleButton>
              <ToggleButton value="offline">Offline ({offlineCount})</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {/* Camera grid */}
          {filtered.length === 0 ? (
            <Typography sx={{ color: t.muted, py: 4, textAlign: 'center' }}>No cameras match your filter.</Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2 }}>
              {filtered.map((cam, i) => (
                <CameraCard key={cam.id ?? cam.mac ?? i} cam={cam} t={t} isDark={isDark} online={online} offline={offline} cardBg={cardBg} onOpen={() => setDetail(cam)} index={i} />
              ))}
            </Box>
          )}

          {/* Sensors — contact/motion plus ambient temp, humidity and light */}
          {sensors.length > 0 && (
            <>
              <SectionHeading t={t} icon={<SensorIcon />} title="Sensors" caption={`${sensors.length} paired`} />
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 2 }}>
                {sensors.map((s, i) => (
                  <SensorCard key={s.id ?? s.mac ?? i} s={s} t={t} online={online} offline={offline} cardBg={cardBg} index={i} />
                ))}
              </Box>
            </>
          )}

          {/* Accessories — floodlights, chimes, sirens, relays */}
          {accessories.length > 0 && (
            <>
              <SectionHeading t={t} icon={<FloodlightIcon />} title="Accessories" caption={`${accessories.length} device${accessories.length === 1 ? '' : 's'}`} />
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2 }}>
                {accessories.map((a, i) => (
                  <AccessoryCard key={a.id ?? a.mac ?? i} a={a} t={t} online={online} offline={offline} cardBg={cardBg} index={i} />
                ))}
              </Box>
            </>
          )}
        </>
      )}

      {/* Activity sub-page — the history rather than the current state. */}
      {present && tab === 'activity' && (
        <>
          {activity && activity.cameras.length > 0 && (
            <ActivityHeatmap activity={activity} t={t} cardBg={cardBg} days={activityDays} onDays={setActivityDays} />
          )}

          {events.length > 0 ? (
            <>
              <SectionHeading t={t} icon={<TimelineIcon />} title="Recent activity" caption={`${events.length} in the last 24h`} />
              <Box sx={{ mb: 3, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}`, overflow: 'hidden' }}>
                {events.map((e, i) => (
                  <EventRow key={e.event_id} e={e} t={t} first={i === 0} />
                ))}
              </Box>
            </>
          ) : (
            <Box sx={{ textAlign: 'center', py: 8, color: t.muted }}>
              <TimelineIcon sx={{ fontSize: 44, opacity: 0.4, mb: 1 }} />
              <Scrim sx={{ display: 'block', mx: 'auto', width: 'fit-content', maxWidth: 520 }}>
                <Typography sx={{ color: t.inkSoft, fontWeight: 600 }}>No events recorded yet</Typography>
                <Typography sx={{ mt: 0.5, fontSize: '0.85rem' }}>
                  Motion, smart detections and doorbell rings appear here as the agent collects them.
                </Typography>
              </Scrim>
            </Box>
          )}
        </>
      )}

      <CameraDetail cam={detail} t={t} online={online} offline={offline} onClose={() => setDetail(null)} />
    </Box>
  );
}

// ── Activity heatmap ─────────────────────────────────────────────────────────
// Camera × hour-of-day. Reveals two things a list of events can't: which cameras
// carry the traffic, and which ones see nothing at all (usually a sign they're
// misaimed, or have detection switched off).
function ActivityHeatmap({ activity, t, cardBg, days, onDays }: {
  activity: Activity; t: ReturnType<typeof tokensFor>; cardBg: string;
  days: 7 | 14 | 30; onDays: (d: 7 | 14 | 30) => void;
}) {
  const peak = Math.max(1, activity.peak);
  // Square-root scaling: a couple of very busy cells would otherwise wash out
  // every quieter camera into an indistinguishable dark row.
  const shade = (n: number) => (n === 0 ? 0 : 0.12 + 0.88 * Math.sqrt(n / peak));
  const busiestHour = activity.hour_totals.indexOf(Math.max(...activity.hour_totals));

  return (
    <Box sx={{ mb: 3, p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}` }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
        <SectionHeading
          t={t} icon={<HeatmapIcon />} title="Activity by hour"
          caption={activity.total ? `${activity.total} events · busiest around ${busiestHour}:00` : 'no events yet'}
        />
        <ToggleButtonGroup
          size="small" exclusive value={days} onChange={(_, v) => v && onDays(v)}
          sx={toggleGroupSx(t)}
        >
          <ToggleButton value={7}>7d</ToggleButton>
          <ToggleButton value={14}>14d</ToggleButton>
          <ToggleButton value={30}>30d</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ overflowX: 'auto' }}>
        <Box sx={{ minWidth: 520 }}>
          {/* Hour ruler — every 3rd hour, so the labels don't collide */}
          <Box sx={{ display: 'grid', gridTemplateColumns: '132px repeat(24, 1fr)', gap: '2px', mb: 0.5 }}>
            <Box />
            {Array.from({ length: 24 }, (_, h) => (
              <Typography key={h} sx={{ fontSize: '0.58rem', color: t.muted, textAlign: 'center' }}>
                {h % 3 === 0 ? h : ''}
              </Typography>
            ))}
          </Box>

          {activity.cameras.map((c) => (
            <Box key={c.camera} sx={{ display: 'grid', gridTemplateColumns: '132px repeat(24, 1fr)', gap: '2px', mb: '2px', alignItems: 'center' }}>
              <Typography
                title={c.camera}
                sx={{ fontSize: '0.7rem', color: t.inkSoft, pr: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {c.camera}
              </Typography>
              {c.hours.map((n, h) => (
                <Tooltip key={h} title={`${c.camera} · ${h}:00–${h + 1}:00 · ${n} event${n === 1 ? '' : 's'}`} arrow>
                  <Box sx={{
                    height: 14, borderRadius: '2px',
                    bgcolor: n === 0 ? `${t.line}55` : t.rust,
                    opacity: n === 0 ? 1 : shade(n),
                  }} />
                </Tooltip>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// ── Storage forecast ─────────────────────────────────────────────────────────
function StorageForecast({ f, t, offline }: {
  f: Forecast; t: ReturnType<typeof tokensFor>; offline: string;
}) {
  const amber = '#E0A24A';
  let headline: string;
  let detail: string;
  let accent = t.inkSoft;

  if (f.state === 'collecting') {
    headline = 'Measuring fill rate…';
    detail = `${f.samples ?? 0} sample${f.samples === 1 ? '' : 's'} so far. A forecast needs at least six hours of history.`;
  } else if (f.state === 'recycling') {
    headline = 'Recycling oldest footage';
    detail = 'The array is full, so Protect is overwriting the oldest recordings. "Days until full" no longer applies — retention is what matters now.';
    accent = amber;
  } else if (f.state === 'filling' && f.days_until_full != null) {
    const d = f.days_until_full;
    headline = d < 1 ? 'Full within a day'
      : d < 60 ? `Full in about ${Math.round(d)} days`
      : `Full in about ${Math.round(d / 30)} months`;
    detail = `Growing ${fmtBytes(f.bytes_per_day)}/day · ${fmtBytes(f.free_bytes)} free`
      + ` · fitted over ${f.span_days != null ? f.span_days.toFixed(1) : '?'} days`;
    accent = d < 14 ? offline : d < 45 ? amber : t.inkSoft;
  } else {
    headline = 'Usage is flat';
    detail = `No measurable growth over the last ${f.span_days != null ? f.span_days.toFixed(1) : '?'} days.`;
  }

  return (
    <Box sx={{ mt: 2, p: 1.5, borderRadius: 2, border: `1px solid ${accent}44`, bgcolor: `${accent}0F`, display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
      <ForecastIcon sx={{ fontSize: '1.1rem', color: accent, mt: 0.2, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: t.ink }}>{headline}</Typography>
        <Typography sx={{ fontSize: '0.74rem', color: t.muted, mt: 0.15 }}>{detail}</Typography>
      </Box>
    </Box>
  );
}

// ── NVR health ───────────────────────────────────────────────────────────────
// Disk health is deliberately prominent: a failing drive in an NVR is silent
// until you need the footage. Everything here comes from the private API, so
// the whole block is skipped when that isn't reachable.
function NvrHealth({ storage, t, cardBg, online, offline, forecast }: {
  storage: Storage; t: ReturnType<typeof tokensFor>; cardBg: string; online: string; offline: string;
  forecast: Forecast | null;
}) {
  const drives = storage.drives ?? [];
  const pct = storage.used_pct;
  const anyBad = drives.some((d) => d.healthy === false);
  const barColor = anyBad ? offline : pct != null && pct >= 90 ? '#E0A24A' : online;
  // Not every firmware exposes a per-drive list. Absent drives is not a fault,
  // so don't phrase it like one.
  const caption = anyBad ? 'a drive reports a fault'
    : drives.length ? `${drives.length} drive${drives.length === 1 ? '' : 's'}`
    : storage.is_recycling ? 'recycling — oldest footage rolls off'
    : 'recording space';

  return (
    <Box sx={{ mb: 3, p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${anyBad ? offline : t.line}` }}>
      <SectionHeading t={t} icon={<StorageIcon />} title="NVR health" caption={caption} />
      {pct != null && (
        <Box sx={{ mb: drives.length ? 2 : 0 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5, gap: 1, flexWrap: 'wrap' }}>
            <Typography sx={{ fontSize: '0.8rem', color: t.muted }}>
              {fmtBytes(storage.used_bytes)} of {fmtBytes(storage.total_bytes)} used
              {storage.recording_available != null && ` · ${fmtBytes(storage.recording_available)} free`}
              {storage.retention_days != null && ` · ~${storage.retention_days}d retention`}
              {storage.cpu_temp != null && ` · CPU ${storage.cpu_temp}°C`}
            </Typography>
            <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: t.ink }}>{pct.toFixed(0)}%</Typography>
          </Box>
          <LinearProgress
            variant="determinate" value={Math.min(100, Math.max(0, pct))}
            sx={{ height: 8, borderRadius: 2, bgcolor: `${t.line}`, '& .MuiLinearProgress-bar': { bgcolor: barColor, borderRadius: 2 } }}
          />
        </Box>
      )}
      {drives.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 1.5 }}>
          {drives.map((d, i) => (
            <Box key={d.serial ?? i} sx={{ p: 1.25, borderRadius: 2, border: `1px solid ${d.healthy === false ? offline : t.line}`, bgcolor: t.paper }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                <DriveIcon sx={{ fontSize: '1rem', color: d.healthy === false ? offline : online }} />
                <Typography sx={{ fontWeight: 700, fontSize: '0.85rem', color: t.ink }}>
                  Bay {(d.slot ?? i) + 1} · {fmtBytes(d.size)}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: '0.72rem', color: t.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.model ?? 'Unknown model'}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
                <Chip
                  size="small" label={d.healthy === false ? 'Fault' : prettify(d.state || 'normal')}
                  sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${d.healthy === false ? offline : online}22`, color: d.healthy === false ? offline : online }}
                />
                {d.temperature != null && (
                  <Chip size="small" label={`${d.temperature}°C`} sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${t.line}66`, color: t.inkSoft }} />
                )}
                {/* Power-on hours is the honest proxy for drive age. */}
                {d.power_on_hours != null && (
                  <Chip size="small" label={`${Math.round(d.power_on_hours / 8766)}y on`} sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${t.line}66`, color: t.inkSoft }} />
                )}
                {!!d.bad_sectors && (
                  <Chip size="small" label={`${d.bad_sectors} bad`} sx={{ height: 20, fontSize: '0.65rem', bgcolor: `${offline}22`, color: offline }} />
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {forecast && <StorageForecast f={forecast} t={t} offline={offline} />}
    </Box>
  );
}

// ── Event row ────────────────────────────────────────────────────────────────
function EventRow({ e, t, first }: { e: ProtectEvent; t: ReturnType<typeof tokensFor>; first: boolean }) {
  const smart = e.smart_types ?? [];
  const accent = e.type === 'ring' ? t.champagne
    : smart.length ? t.rust
    : e.type === 'disconnect' ? t.muted
    : t.inkSoft;
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1.25, px: 1.75, py: 1,
      borderTop: first ? 'none' : `1px solid ${t.line}`,
    }}>
      <Box sx={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: `${accent}1E`, color: accent, flexShrink: 0 }}>
        {smart.length ? SMART_ICON[smart[0] ?? ''] ?? <ShieldIcon sx={{ fontSize: '0.95rem' }} /> : <MotionIcon sx={{ fontSize: '0.95rem' }} />}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: t.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {smart.length ? smart.map(smartLabel).join(', ') : eventLabel(e.type)}
          {e.camera_name && <Box component="span" sx={{ color: t.muted, fontWeight: 400 }}> · {e.camera_name}</Box>}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: '0.75rem', color: t.muted, flexShrink: 0 }}>{sinceLabel(e.start_ms)}</Typography>
    </Box>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────
function StatCard({ t, label, value, accent, icon }: { t: ReturnType<typeof tokensFor>; label: string; value: number; accent: string; icon: ReactNode }) {  return (
    <Box sx={{ p: 1.75, borderRadius: 2, border: `1px solid ${t.line}`, background: `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`, display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box sx={{ width: 38, height: 38, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${accent}1E`, color: accent, flexShrink: 0 }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '1.5rem', lineHeight: 1, fontWeight: 800, color: t.ink }}>{value}</Typography>
        <Typography sx={{ fontSize: '0.72rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.05em', mt: 0.25 }}>{label}</Typography>
      </Box>
    </Box>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────
function SectionHeading({ t, icon, title, caption }: { t: ReturnType<typeof tokensFor>; icon: ReactNode; title: string; caption?: string }) {
  return (
    // block: this heading ends in a full-width rule, so the plate must not
    // shrink-wrap the text and leave the rule stranded on the wallpaper.
    <Scrim block sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 4, mb: 2 }}>
      <Box sx={{ color: t.rust, display: 'grid', placeItems: 'center' }}>{icon}</Box>
      <Typography sx={{ fontWeight: 800, fontSize: '1.05rem', color: t.ink }}>{title}</Typography>
      {caption && <Typography sx={{ fontSize: '0.75rem', color: t.muted }}>· {caption}</Typography>}
      <Box sx={{ flex: 1, height: '1px', bgcolor: t.line, ml: 1 }} />
    </Scrim>
  );
}

// ── Sensor card ──────────────────────────────────────────────────────────────
// Small labelled readout used for temp / humidity / light.
function MetricPill({ t, icon, text, accent }: { t: ReturnType<typeof tokensFor>; icon: ReactNode; text: string; accent: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, borderRadius: 1.5, bgcolor: `${accent}14`, border: `1px solid ${accent}33` }}>
      <Box sx={{ color: accent, display: 'grid', placeItems: 'center', '& svg': { fontSize: '0.9rem' } }}>{icon}</Box>
      <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: t.ink, whiteSpace: 'nowrap' }}>{text}</Typography>
    </Box>
  );
}

function SensorCard({ s, t, online, offline, cardBg, index }: {
  s: Sensor; t: ReturnType<typeof tokensFor>; online: string; offline: string; cardBg: string; index: number;
}) {
  const dot = s.online ? online : offline;
  const amber = '#D89B34';
  const mount = MOUNT_LABEL[s.mount_type ?? 'none'] ?? prettify(s.mount_type ?? 'Sensor');

  const temp = fmtMetric(s.temperature, '°C');
  const hum = fmtMetric(s.humidity, '%', 0);
  const lux = fmtMetric(s.light, ' lx', 0);

  // Only surface an alert for something that actually fired recently.
  const alerts: string[] = [];
  if (isRecent(s.leak_at) || isRecent(s.external_leak_at)) alerts.push('Leak detected');
  if (isRecent(s.alarm_at)) alerts.push('Alarm triggered');
  if (isRecent(s.tamper_at)) alerts.push('Tampering');

  const openState = s.is_opened == null ? null : s.is_opened ? 'Open' : 'Closed';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: Math.min(index * 0.02, 0.3) }}>
      <Box sx={{ p: 2, borderRadius: 2, border: `1px solid ${alerts.length ? amber : t.line}`, background: cardBg, opacity: s.online ? 1 : 0.78 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Box sx={{ color: s.is_opened ? amber : t.inkSoft, display: 'grid', placeItems: 'center' }}>
            {s.mount_type === 'leak' ? <LeakIcon /> : <DoorIcon />}
          </Box>
          <Typography sx={{ fontWeight: 800, fontSize: '0.95rem', color: t.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.name ?? s.mac ?? 'Sensor'}
          </Typography>
          <DotIcon sx={{ fontSize: '0.6rem', color: dot }} />
        </Box>

        <Typography sx={{ fontSize: '0.75rem', color: t.muted, mb: 1.25 }}>
          {mount}
          {openState && <> · <Box component="span" sx={{ color: s.is_opened ? amber : t.inkSoft, fontWeight: 700 }}>{openState}</Box></>}
          {s.open_changed_at ? ` ${sinceLabel(s.open_changed_at)}` : ''}
        </Typography>

        {(temp || hum || lux) && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1.25 }}>
            {temp && <MetricPill t={t} icon={<TempIcon />} text={temp} accent={t.rust} />}
            {hum && <MetricPill t={t} icon={<HumidityIcon />} text={hum} accent="#3D8FBF" />}
            {lux && <MetricPill t={t} icon={<BrightnessIcon />} text={lux} accent={t.champagne} />}
          </Box>
        )}

        {alerts.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, color: amber }}>
            <WarnIcon sx={{ fontSize: '0.95rem' }} />
            <Typography sx={{ fontSize: '0.76rem', fontWeight: 700 }}>{alerts.join(' · ')}</Typography>
          </Box>
        )}

        <Divider sx={{ borderColor: t.line, my: 1 }} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', fontSize: '0.72rem', color: t.muted }}>
          {s.enabled?.motion && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, color: s.is_motion ? amber : t.muted }}>
              <MotionIcon sx={{ fontSize: '0.9rem' }} />
              <span>{s.is_motion ? 'Motion now' : s.motion_at ? sinceLabel(s.motion_at) : 'No motion'}</span>
            </Box>
          )}
          {s.battery_pct != null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4, color: s.battery_low ? offline : t.muted }}>
              {s.battery_low ? <BatteryLowIcon sx={{ fontSize: '0.9rem' }} /> : <BatteryIcon sx={{ fontSize: '0.9rem' }} />}
              <span>{s.battery_pct}%</span>
            </Box>
          )}
          {s.signal_dbm != null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
              <SignalIcon sx={{ fontSize: '0.9rem' }} />
              <span>{s.signal_dbm} dBm</span>
            </Box>
          )}
        </Box>
      </Box>
    </motion.div>
  );
}

// ── Accessory card (floodlight / chime / siren / relay) ──────────────────────
const ACCESSORY_ICON: Record<string, ReactNode> = {
  light: <FloodlightIcon />,
  chime: <ChimeIcon />,
  siren: <SirenIcon />,
  relay: <RelayIcon />,
};

function AccessoryCard({ a, t, online, offline, cardBg, index }: {
  a: Accessory; t: ReturnType<typeof tokensFor>; online: string; offline: string; cardBg: string; index: number;
}) {
  const dot = a.online ? online : offline;
  const amber = '#D89B34';

  // One line of the most useful live state for each accessory kind.
  let detail = prettify(a.kind);
  let active = false;
  if (a.kind === 'light') {
    active = !!a.is_light_on;
    detail = `${a.is_light_on ? 'On' : 'Off'}${a.is_dark ? ' · dark' : ''}${a.mode ? ` · ${prettify(a.mode)}` : ''}`;
  } else if (a.kind === 'siren') {
    active = !!a.siren_active;
    detail = a.siren_active ? 'Sounding' : `Idle${a.volume != null ? ` · vol ${a.volume}` : ''}`;
  } else if (a.kind === 'chime') {
    detail = `${a.paired_cameras ?? 0} camera${a.paired_cameras === 1 ? '' : 's'} paired`;
  } else if (a.kind === 'relay') {
    const outs = a.outputs ?? [];
    active = outs.some((o) => o.state === 'on');
    detail = outs.length
      ? outs.map((o) => `${o.name ?? prettify(o.type ?? 'output')}: ${o.state === 'on' ? 'On' : 'Off'}`).join(' · ')
      : 'No outputs';
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, delay: Math.min(index * 0.02, 0.3) }}>
      <Box sx={{ p: 2, borderRadius: 2, border: `1px solid ${active ? amber : t.line}`, background: cardBg, opacity: a.online ? 1 : 0.78 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
          <Box sx={{ color: active ? amber : t.inkSoft, display: 'grid', placeItems: 'center' }}>{ACCESSORY_ICON[a.kind]}</Box>
          <Typography sx={{ fontWeight: 800, fontSize: '0.95rem', color: t.ink, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name ?? a.mac ?? prettify(a.kind)}
          </Typography>
          <DotIcon sx={{ fontSize: '0.6rem', color: dot }} />
        </Box>
        <Typography sx={{ fontSize: '0.76rem', color: t.muted }}>{detail}</Typography>
        {a.kind === 'light' && a.last_motion ? (
          <Typography sx={{ fontSize: '0.72rem', color: t.muted, mt: 0.5 }}>Last motion {sinceLabel(a.last_motion)}</Typography>
        ) : null}
      </Box>
    </motion.div>
  );
}

// ── Camera card ──────────────────────────────────────────────────────────────
function CapIcon({ on, icon, label, color }: { on: boolean; icon: ReactNode; label: string; color: string }) {
  if (!on) return null;
  return (
    <Tooltip title={label} arrow>
      <Box sx={{ color, display: 'grid', placeItems: 'center' }} aria-label={label}>{icon}</Box>
    </Tooltip>
  );
}

function CameraCard({ cam, t, isDark, online, offline, cardBg, onOpen, index }: {
  cam: Camera; t: ReturnType<typeof tokensFor>; isDark: boolean; online: string; offline: string; cardBg: string; onOpen: () => void; index: number;
}) {
  const dot = cam.online ? online : offline;
  const enabled = new Set(cam.smart_enabled ?? []);
  const supported = cam.smart_supported ?? [];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.02, 0.3) }}
      style={{ height: '100%' }}
    >
      <Box
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        sx={{
          // Fill the grid cell so every card in a row is the same height:
          // capability chips wrap to different line counts per camera.
          height: '100%', display: 'flex', flexDirection: 'column',
          cursor: 'pointer', p: 2, borderRadius: 2, border: `1px solid ${t.line}`, background: cardBg,
          opacity: cam.online ? 1 : 0.78, transition: 'transform .15s, box-shadow .15s, border-color .15s',
          borderLeft: `3px solid ${dot}`,
          '&:hover': { transform: 'translateY(-2px)', boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(0,0,0,0.12)', borderColor: `${t.rust}66` },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
          <Box sx={{ width: 46, height: 46, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${t.rust}18`, color: cam.online ? t.rust : t.muted, flexShrink: 0 }}>
            {cam.online ? <CameraIcon /> : <CameraOffIcon />}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontWeight: 700, color: t.ink, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cam.name ?? ''}>
              {cam.name || 'Unnamed camera'}
            </Typography>
            {/* IP leads when we have it — it's the field you actually need when
                something's wrong. MAC stays as the fallback identifier. */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25, flexWrap: 'wrap' }}>
              {cam.ip && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3, color: t.inkSoft }}>
                  <IpIcon sx={{ fontSize: '0.8rem' }} />
                  <Typography sx={{ fontSize: '0.74rem', fontFamily: 'monospace' }}>{cam.ip}</Typography>
                </Box>
              )}
              <Typography sx={{ fontSize: '0.74rem', color: t.muted, fontFamily: 'monospace' }}>
                {cam.mac || '—'}
              </Typography>
            </Box>
            {(cam.model_name || cam.firmware) && (
              <Typography sx={{ fontSize: '0.7rem', color: t.muted, mt: 0.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cam.model_name}{cam.model_name && cam.firmware ? ' · ' : ''}{cam.firmware && `fw ${cam.firmware}`}
              </Typography>
            )}
          </Box>
          <Chip
            size="small"
            icon={<DotIcon sx={{ fontSize: '0.7rem !important', color: `${dot} !important` }} />}
            label={cam.online ? 'Online' : 'Offline'}
            sx={{ bgcolor: `${dot}1E`, color: t.ink, fontWeight: 600, fontSize: '0.7rem', height: 22 }}
          />
        </Box>

        {supported.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
            {supported.map((s) => {
              const on = enabled.has(s);
              return (
                <Chip
                  key={s}
                  size="small"
                  icon={SMART_ICON[s] as React.ReactElement | undefined}
                  label={smartLabel(s)}
                  variant={on ? 'filled' : 'outlined'}
                  sx={{
                    height: 22, fontSize: '0.68rem', fontWeight: on ? 600 : 500,
                    color: on ? t.ink : t.muted,
                    bgcolor: on ? `${t.champagne}22` : 'transparent',
                    borderColor: on ? `${t.champagne}66` : t.line,
                    '& .MuiChip-icon': { color: on ? t.champagne : t.muted },
                  }}
                />
              );
            })}
          </Box>
        )}

        {/* mt:auto pins the capability strip to the bottom, so cards with fewer
            detection chips still align with their neighbours. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mt: 'auto', pt: 1.5, minHeight: 20 }}>
          <CapIcon on={cam.has_mic} icon={<MicIcon sx={{ fontSize: '1.05rem' }} />} label="Microphone" color={t.inkSoft} />
          <CapIcon on={cam.has_speaker} icon={<SpeakerIcon sx={{ fontSize: '1.05rem' }} />} label="Two-way speaker" color={t.inkSoft} />
          <CapIcon on={cam.has_hdr} icon={<HdrIcon sx={{ fontSize: '1.05rem' }} />} label="HDR" color={t.inkSoft} />
          <CapIcon on={cam.package_camera} icon={<PackageIcon sx={{ fontSize: '1.05rem' }} />} label="Package camera" color={t.inkSoft} />
          <CapIcon on={cam.full_hd_snapshot} icon={<HdSnapshotIcon sx={{ fontSize: '1.05rem' }} />} label="Full-HD snapshot" color={t.inkSoft} />
          {cam.video_mode && (
            <Chip size="small" label={prettify(cam.video_mode)} sx={{ ml: 'auto', height: 20, fontSize: '0.66rem', color: t.muted, bgcolor: 'transparent', border: `1px solid ${t.line}` }} />
          )}
        </Box>
      </Box>
    </motion.div>
  );
}

// ── Detail dialog ────────────────────────────────────────────────────────────
function Row({ t, label, children }: { t: ReturnType<typeof tokensFor>; label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 1.5, py: 0.75, alignItems: 'baseline' }}>
      <Typography sx={{ fontSize: '0.78rem', color: t.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</Typography>
      <Box sx={{ color: t.ink, fontSize: '0.9rem', minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

function TypeChips({ t, types, accent }: { t: ReturnType<typeof tokensFor>; types: string[]; accent: string }) {
  if (!types.length) return <Typography sx={{ color: t.muted, fontSize: '0.85rem' }}>None</Typography>;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {types.map((s) => (
        <Chip key={s} size="small" icon={SMART_ICON[s] as React.ReactElement | undefined} label={smartLabel(s)}
          sx={{ height: 22, fontSize: '0.7rem', bgcolor: `${accent}1E`, color: t.ink, '& .MuiChip-icon': { color: accent } }} />
      ))}
    </Box>
  );
}

function CameraDetail({ cam, t, online, offline, onClose }: {
  cam: Camera | null; t: ReturnType<typeof tokensFor>; online: string; offline: string; onClose: () => void;
}) {
  if (!cam) return null;
  const dot = cam.online ? online : offline;
  return (
    <Dialog open={!!cam} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { bgcolor: t.paper, backgroundImage: 'none', borderRadius: 2, border: `1px solid ${t.line}` } }}>
      <Box sx={{ p: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${t.rust}18`, color: cam.online ? t.rust : t.muted }}>
            {cam.online ? <CameraIcon /> : <CameraOffIcon />}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" sx={{ color: t.ink, fontWeight: 700, lineHeight: 1.2 }}>{cam.name || 'Unnamed camera'}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25 }}>
              <DotIcon sx={{ fontSize: '0.7rem', color: dot }} />
              <Typography sx={{ fontSize: '0.82rem', color: t.muted }}>{cam.online ? 'Online' : 'Offline'}</Typography>
            </Box>
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ color: t.muted }}><CloseIcon /></IconButton>
        </Box>

        <Divider sx={{ borderColor: t.line, my: 1 }} />

        <Row t={t} label="MAC"><span style={{ fontFamily: 'monospace' }}>{cam.mac || '—'}</span></Row>
        {cam.ip && <Row t={t} label="IP address"><span style={{ fontFamily: 'monospace' }}>{cam.ip}</span></Row>}
        <Row t={t} label="Type">{cam.model_name || prettify(cam.model || 'camera')}</Row>
        {cam.firmware && <Row t={t} label="Firmware">{cam.firmware}</Row>}
        {cam.recording_mode && <Row t={t} label="Recording">{prettify(cam.recording_mode)}</Row>}
        {cam.last_motion_at != null && <Row t={t} label="Last motion">{sinceLabel(cam.last_motion_at) || '—'}</Row>}
        {cam.up_since != null && <Row t={t} label="Up since">{new Date(cam.up_since).toLocaleString()}</Row>}
        <Row t={t} label="Video mode">
          {cam.video_mode ? prettify(cam.video_mode) : '—'}
          {cam.video_modes.length > 1 && <Typography component="span" sx={{ color: t.muted, fontSize: '0.8rem', ml: 1 }}>({cam.video_modes.map(prettify).join(', ')})</Typography>}
        </Row>
        {cam.has_hdr && <Row t={t} label="HDR">{cam.hdr_type ? prettify(cam.hdr_type) : 'Supported'}</Row>}
        {cam.has_mic && <Row t={t} label="Microphone">{cam.mic_enabled ? 'On' : 'Off'}{cam.mic_volume != null ? ` · volume ${cam.mic_volume}` : ''}</Row>}

        <Divider sx={{ borderColor: t.line, my: 1 }} />

        <Row t={t} label="Detecting"><TypeChips t={t} types={cam.smart_enabled} accent={t.champagne} /></Row>
        <Row t={t} label="Can detect"><TypeChips t={t} types={cam.smart_supported} accent={t.rust} /></Row>
        {cam.smart_audio.length > 0 && (
          <Row t={t} label="Audio">
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {cam.smart_audio.map((a) => (
                <Chip key={a} size="small" icon={<AudioIcon sx={{ fontSize: '0.85rem' }} />} label={prettify(a)}
                  sx={{ height: 22, fontSize: '0.7rem', bgcolor: `${t.rust}14`, color: t.ink, '& .MuiChip-icon': { color: t.rust } }} />
              ))}
            </Box>
          </Row>
        )}

        <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, flexWrap: 'wrap' }}>
          {[
            { on: cam.has_mic, icon: <MicIcon sx={{ fontSize: '1rem' }} />, label: 'Mic' },
            { on: cam.has_speaker, icon: <SpeakerIcon sx={{ fontSize: '1rem' }} />, label: 'Speaker' },
            { on: cam.has_hdr, icon: <HdrIcon sx={{ fontSize: '1rem' }} />, label: 'HDR' },
            { on: cam.package_camera, icon: <PackageIcon sx={{ fontSize: '1rem' }} />, label: 'Package cam' },
            { on: cam.full_hd_snapshot, icon: <HdSnapshotIcon sx={{ fontSize: '1rem' }} />, label: 'Full-HD snapshot' },
          ].filter((c) => c.on).map((c) => (
            <Box key={c.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: t.inkSoft, fontSize: '0.78rem' }}>
              {c.icon}{c.label}
            </Box>
          ))}
        </Box>
      </Box>
    </Dialog>
  );
}
