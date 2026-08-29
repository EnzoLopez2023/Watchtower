// Synology NAS health — DS1821+ and DS1513+.
//
// Reads what scripts/synology-agent collects from the DSM 7 web API. Ordered by
// what actually predicts trouble: capacity headroom first, then disk health,
// then the UPS settings that decide whether these shut down cleanly in an
// outage, then general system state.
import { apiFetch } from './services/apiClient';
import { useCallback, useEffect, useState } from 'react';
import { Box, Typography, Chip, CircularProgress, LinearProgress, Tooltip, Button } from '@mui/material';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as ChartTooltip, Legend,
} from 'recharts';
import StorageIcon from '@mui/icons-material/Storage';
import DiskIcon from '@mui/icons-material/Album';
import BoltIcon from '@mui/icons-material/Bolt';
import WarnIcon from '@mui/icons-material/WarningAmber';
import OkIcon from '@mui/icons-material/CheckCircle';
import PageHero from './components/PageHero';
import Scrim from './components/Scrim';
import { useThemeMode } from './context/ThemeContext';
import { useReadOnly } from './context/UserPermissionsContext';
import { tokensFor } from './theme/tokens';
import { CARD_HOVER_SX, CARD_RADIUS, pageShellSx } from './theme/controls';

interface Volume {
  id: string; name: string; fs_type: string | null; status: string | null; raid_type: string | null;
  total_bytes: number | null; used_bytes: number | null; used_pct: number | null;
}
interface Disk {
  id: string; name: string; model: string | null; serial: string | null; slot: number | null;
  size_bytes: number | null; temp_c: number | null; smart_status: string | null;
  health: string | null; bad_sectors: number | null; used_by: string | null;
}
interface Ups {
  enabled: boolean | null; mode: string | null; server: string | null;
  shutdown_enabled: boolean | null; shutdown_seconds: number | null;
  power_off_ups: boolean | null; charge_pct: number | null;
  runtime_seconds: number | null; status: string | null; model: string | null;
  raw_keys?: string[];
}
interface Unit {
  nas_id: string; label: string; host: string | null;
  received_at: number; age_seconds: number; stale: boolean;
  system?: {
    model: string | null; serial: string | null; dsm_version: string | null;
    uptime_seconds: number | null; temperature_c: number | null; temp_warning: boolean;
    cpu_pct: number | null; memory_pct: number | null;
  };
  volumes?: Volume[];
  disks?: Disk[];
  shares?: { name: string; used_bytes: number | null; volume: string | null; is_usb?: boolean }[];
  backup_tasks?: BackupTask[];
  bonds?: Bond[] | null;
  power_recovery?: { enabled: boolean; raw_keys?: string[] } | null;
  ups?: Ups | null;
  update?: { available: boolean; version: string | null } | null;
  diagnostics?: { agent_build?: number; errors?: Record<string, string> };
}
interface Forecast { days: number | null; bytes_per_day?: number; span_days?: number; samples?: number; reason?: string }
interface Series { nas_id: string; volume_id: string; forecast: Forecast | null }
interface BackupRun { nas_id: string; task_id: string; task_name: string | null; last_run_ts: number; result: string | null }
interface SharePoint { ts: number; nas_id: string; [share: string]: number | string }
interface Bond { name: string; mode: string | null; members: string[]; status: string | null; ip: string | null }
interface BackupTask { id: string; name: string; state: string | null; last_result: string | null; last_run_ts: number | null; next_run_ts: number | null }
interface ExternalDevice {
  nas_id: string; nas_label: string; device_id: string; kind: string | null;
  name: string | null; model: string | null; fs: string | null;
  size_bytes: number | null; used_bytes: number | null;
  first_seen: number; last_seen: number; attached: boolean;
}

// Distinct enough to tell a dozen stacked bands apart, and stable per share so
// a band keeps its colour between renders.
const BAND = ['#4FBF8B', '#33B4DA', '#E6A63A', '#C77AA0', '#7E8CE0', '#E08A7E', '#8BC34A', '#26A69A', '#B8860B', '#9575CD'];
const bandFor = (name: string, i: number) => BAND[i % BAND.length] + (name ? '' : '');

/** Did this backup run succeed? DSM's wording varies, so match loosely. */
const runOk = (result: string | null) => !result || /success|done|finish|ok/i.test(result);

const tb = (n: number | null | undefined) => (n == null ? '—' : `${(n / 1e12).toFixed(2)} TB`);
const uptime = (s: number | null | undefined) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  return d >= 1 ? `${d}d` : `${Math.floor(s / 3600)}h`;
};

/** SMART/health strings vary by DSM build, so match loosely and fail toward "look at this". */
function diskOk(d: Disk): boolean {
  const s = `${d.smart_status ?? ''} ${d.health ?? ''}`.toLowerCase();
  if (!s.trim()) return true;
  return !/(fail|crash|critical|warning|abnormal|bad)/.test(s) && (d.bad_sectors ?? 0) === 0;
}

export default function Synology() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'steel');
  const readOnly = useReadOnly('synology');

  const [units, setUnits] = useState<Unit[] | null>(null);
  const [series, setSeries] = useState<Series[]>([]);
  const [sharePoints, setSharePoints] = useState<SharePoint[]>([]);
  const [shareNames, setShareNames] = useState<string[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [external, setExternal] = useState<ExternalDevice[]>([]);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/synology');
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setUnits(j.present ? j.units : []);
      const h = await apiFetch('/api/synology/history?days=180');
      const hj = await h.json();
      if (h.ok && Array.isArray(hj.series)) setSeries(hj.series);
      const s = await apiFetch('/api/synology/shares?days=90');
      const sj = await s.json();
      if (s.ok) { setSharePoints(sj.points ?? []); setShareNames(sj.shares ?? []); }
      const b = await apiFetch('/api/synology/backups?days=60');
      const bj = await b.json();
      if (b.ok) setRuns(bj.runs ?? []);
      const e = await apiFetch('/api/synology/external');
      const ej = await e.json();
      if (e.ok) setExternal(ej.devices ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUnits([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Drop a device that is gone for good. Only offered once it is detached; the
  // server refuses attached ones because the agent would just re-add them.
  const forget = useCallback(async (d: ExternalDevice) => {
    const key = `${d.nas_id}:${d.device_id}`;
    setForgetting(key);
    try {
      const r = await apiFetch(`/api/synology/external/${encodeURIComponent(d.nas_id)}/${encodeURIComponent(d.device_id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setExternal((prev) => prev.filter((x) => `${x.nas_id}:${x.device_id}` !== key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setForgetting(null);
    }
  }, []);

  const bad = isDark ? '#F0776E' : '#C4443A';
  const ok = isDark ? '#43C97D' : '#2E9E5B';
  const warn = isDark ? '#E6A63A' : '#B8860B';

  const forecastFor = (nasId: string, volId: string) =>
    series.find((s) => s.nas_id === nasId && s.volume_id === volId)?.forecast ?? null;

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        eyebrow="Synology"
        title="Both NASes, in one place"
        accentPhrase="in one place"
        subtitle="Capacity headroom, disk health, and the UPS settings that decide whether these shut down cleanly. Read-only — collected on the LAN by the on-site agent."
      />

      {units === null && (
        <Box sx={{ textAlign: 'center', py: 8 }}><CircularProgress sx={{ color: t.rust }} /></Box>
      )}

      {units !== null && units.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <StorageIcon sx={{ fontSize: 48, opacity: 0.4, mb: 1, color: t.muted }} />
          <Scrim sx={{ display: 'block', mx: 'auto', width: 'fit-content', maxWidth: 560 }}>
            <Typography variant="h6" sx={{ color: t.inkSoft, fontWeight: 600 }}>
              {error ? 'Could not reach the Watchtower Synology API' : 'Waiting for the first reading'}
            </Typography>
            <Typography sx={{ mt: 1, color: t.muted, fontSize: '0.88rem' }}>
              {error
                ? error
                : 'Install the Synology agent on the machine that runs the UniFi and UPS agents, then both NASes appear here.'}
            </Typography>
          </Scrim>
        </Box>
      )}

      {units?.map((u) => {
        const sys = u.system ?? {} as NonNullable<Unit['system']>;
        const disks = u.disks ?? [];
        const volumes = u.volumes ?? [];
        const failing = disks.filter((d) => !diskOk(d));
        const collectErrors = Object.keys(u.diagnostics?.errors ?? {});

        return (
          <Box key={u.nas_id} sx={{ mb: 4 }}>
            <Scrim sx={{ mb: 1.5 }}>
              <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: t.ink }}>
                {u.label}
              </Typography>
              <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
                {/* firmware_ver already starts with "DSM", so do not prefix it again. */}
                {sys.model ?? '—'} · {String(sys.dsm_version ?? '—').replace(/^DSM\s*/i, 'DSM ')} · up {uptime(sys.uptime_seconds)}
                {u.host ? ` · ${u.host}` : ''}
                {u.stale ? ' · stale' : ''}
              </Typography>
            </Scrim>

            {/* A stale unit's numbers are history, not status — say so before they are read as current. */}
            {u.stale && (
              <Box sx={{ p: 1.5, mb: 1.5, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, borderLeft: `3px solid ${warn}`, border: `1px solid ${t.line}` }}>
                <Typography sx={{ fontSize: '0.82rem', color: t.ink }}>
                  Last heard from {Math.round(u.age_seconds / 60)} minutes ago — everything below is that old.
                </Typography>
              </Box>
            )}

            {/* Volumes: headroom first, with a forecast only where one is earned. */}
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, mb: 1.5 }}>
              {volumes.map((v) => {
                const f = forecastFor(u.nas_id, v.id);
                const pct = v.used_pct ?? 0;
                const barColour = pct >= 90 ? bad : pct >= 75 ? warn : ok;
                return (
                  <Box key={v.id} sx={{ p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}` }}>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.75 }}>
                      <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem' }}>{v.name}</Typography>
                      <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>
                        {v.fs_type ?? ''}{v.raid_type ? ` · ${v.raid_type}` : ''}
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, pct)}
                      sx={{ height: 8, borderRadius: 99, bgcolor: t.surface, '& .MuiLinearProgress-bar': { bgcolor: barColour, borderRadius: 99 } }}
                    />
                    <Typography sx={{ mt: 0.75, fontSize: '0.8rem', color: t.inkSoft }}>
                      {tb(v.used_bytes)} of {tb(v.total_bytes)} · {pct}%
                    </Typography>
                    <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>
                      {/* Never invent a projection: the API returns a reason instead of a number
                          when there is too little history or usage is not growing. */}
                      {f?.days != null
                        ? `full in about ${f.days} days at the current rate (${f.span_days}d of history)`
                        : f?.reason === 'not filling'
                          ? 'not filling — usage is flat or shrinking'
                          : 'not enough history yet for a projection'}
                    </Typography>
                  </Box>
                );
              })}
            </Box>

            {/* Disks */}
            <Box sx={{ p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}`, mb: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <DiskIcon sx={{ fontSize: 18, color: t.rust }} />
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem' }}>
                  {disks.length} disk{disks.length === 1 ? '' : 's'}
                </Typography>
                {failing.length > 0
                  ? <Chip size="small" label={`${failing.length} need attention`} sx={{ height: 20, fontSize: '0.7rem', color: bad, bgcolor: `${bad}22` }} />
                  : disks.length > 0 && <Chip size="small" icon={<OkIcon sx={{ fontSize: '0.8rem !important', color: `${ok} !important` }} />} label="all healthy" sx={{ height: 20, fontSize: '0.7rem', color: ok, bgcolor: `${ok}18` }} />}
              </Box>
              <Box sx={{ display: 'grid', gap: 0.75, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
                {disks.map((d) => {
                  const healthy = diskOk(d);
                  return (
                    <Box key={d.id} sx={{
                      display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.6,
                      borderRadius: '8px', border: `1px solid ${t.line}`,
                      borderLeft: `3px solid ${healthy ? t.line : bad}`,
                    }}>
                      {!healthy && <WarnIcon sx={{ fontSize: 15, color: bad }} />}
                      <Typography sx={{ fontSize: '0.78rem', color: t.ink, fontWeight: 600, minWidth: 62 }}>{d.name}</Typography>
                      <Typography sx={{ fontSize: '0.74rem', color: t.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.model ?? '—'} · {tb(d.size_bytes)}
                      </Typography>
                      <Typography sx={{ fontSize: '0.74rem', color: (d.temp_c ?? 0) >= 50 ? warn : t.muted }}>
                        {d.temp_c != null ? `${d.temp_c}°C` : '—'}
                      </Typography>
                      <Typography sx={{ fontSize: '0.72rem', color: healthy ? t.muted : bad, minWidth: 52, textAlign: 'right' }}>
                        {d.smart_status ?? d.health ?? '—'}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>
            </Box>

            {/* UPS — the documented claim, checked rather than assumed.
                "Unknown" is shown as its own state: reporting an unmatched DSM
                field as "safe shutdown is off" would invent a safety finding. */}
            <Box sx={{
              p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX,
              border: `1px solid ${t.line}`,
              borderLeft: `3px solid ${u.ups?.shutdown_enabled === true ? ok : u.ups?.shutdown_enabled === false ? bad : warn}`,
            }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <BoltIcon sx={{ fontSize: 18, color: t.rust }} />
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem' }}>UPS shutdown</Typography>
              </Box>
              {u.ups ? (
                u.ups.shutdown_enabled == null ? (
                  <Typography sx={{ fontSize: '0.82rem', color: t.inkSoft }}>
                    DSM did not return a recognised shutdown setting on this build, so this is
                    unknown rather than off. Run the agent with <code>--dump</code> to see the
                    field names it does return.
                  </Typography>
                ) : (
                  <Typography sx={{ fontSize: '0.82rem', color: t.inkSoft }}>
                    {u.ups.shutdown_enabled
                      ? `Shuts down after ${u.ups.shutdown_seconds != null ? `${Math.round(u.ups.shutdown_seconds / 60)} min` : 'the configured delay'} on battery${u.ups.server ? ` · UPS server ${u.ups.server}` : ''}.`
                      : 'UPS support is NOT enabled — this NAS will run until the battery dies.'}
                    {u.ups.mode ? ` Mode: ${u.ups.mode}.` : ''}
                    {u.ups.charge_pct != null && ` Battery ${u.ups.charge_pct}%`}
                    {u.ups.runtime_seconds != null && `, ${Math.round(u.ups.runtime_seconds / 60)} min runtime.`}
                  </Typography>
                )
              ) : (
                <Typography sx={{ fontSize: '0.82rem', color: t.muted }}>
                  DSM returned no UPS settings for this unit.
                </Typography>
              )}
            </Box>

            {/* Two config checks, both of which describe what happens during an
                outage — the state you cannot test without causing one. */}
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, mt: 1.5 }}>
              <Box sx={{
                p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX,
                border: `1px solid ${t.line}`,
                borderLeft: `3px solid ${u.power_recovery == null ? warn : u.power_recovery.enabled ? ok : bad}`,
              }}>
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem', mb: 0.5 }}>
                  Power recovery
                </Typography>
                <Typography sx={{ fontSize: '0.82rem', color: t.inkSoft }}>
                  {u.power_recovery == null
                    ? 'DSM did not return this setting on this build — unknown.'
                    : u.power_recovery.enabled
                      ? 'Restarts automatically when mains returns.'
                      : 'Will NOT restart on its own — after a clean UPS shutdown it stays off until powered on by hand.'}
                </Typography>
              </Box>

              <Box sx={{
                p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX,
                border: `1px solid ${t.line}`,
                borderLeft: `3px solid ${u.bonds == null ? t.line : !u.bonds.length ? t.line : u.bonds.every((b) => b.members.length > 1) ? ok : warn}`,
              }}>
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem', mb: 0.5 }}>
                  Link aggregation
                </Typography>
                {u.bonds == null ? (
                  // The API errors with 4302 on both units. That is "DSM did not
                  // answer", not "no aggregation", and claiming the latter would
                  // be the same mistake as the UPS one.
                  <Typography sx={{ fontSize: '0.82rem', color: t.muted }}>
                    Not reported by this DSM build.
                  </Typography>
                ) : u.bonds.length ? (
                  u.bonds.map((b) => (
                    <Typography key={b.name} sx={{ fontSize: '0.82rem', color: t.inkSoft }}>
                      {b.name}: {b.mode ?? 'mode ?'} · {b.members.length
                        ? `${b.members.length} member${b.members.length === 1 ? '' : 's'} (${b.members.join(' + ')})`
                        : 'no members reported'}
                      {/* A one-member bond is the exact shape of the fault that
                          made a NAS unreachable while the switch showed link. */}
                      {b.members.length === 1 && ' — only one leg, check the switch aggregation'}
                    </Typography>
                  ))
                ) : (
                  <Typography sx={{ fontSize: '0.82rem', color: t.muted }}>
                    No bond configured — each NIC stands alone.
                  </Typography>
                )}
              </Box>
            </Box>

            {/* Backups — a job that silently stopped running is invisible until
                the day you need it. */}
            {(u.backup_tasks?.length ?? 0) > 0 && (
              <Box sx={{ p: 2, mt: 1.5, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}` }}>
                <Typography sx={{ fontWeight: 700, color: t.ink, fontSize: '0.9rem', mb: 1 }}>
                  Backup tasks
                </Typography>
                {u.backup_tasks!.map((task) => {
                  const taskRuns = runs
                    .filter((r) => r.nas_id === u.nas_id && r.task_id === task.id)
                    .slice(0, 30)
                    .reverse();
                  return (
                    <Box key={task.id} sx={{ mb: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontSize: '0.84rem', fontWeight: 600, color: t.ink }}>{task.name}</Typography>
                        <Typography sx={{ fontSize: '0.75rem', color: runOk(task.last_result) ? t.muted : bad }}>
                          {/* DSM's backup task list carries no run history on either unit, so a
                              missing timestamp means "not reported" — rendering it as "never"
                              claimed the backup had never run, which is not something we know. */}
                          {task.last_run_ts
                            ? `last run ${new Date(task.last_run_ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                            : 'last run not reported by DSM'}
                          {task.last_result ? ` · ${task.last_result}` : ''}
                        </Typography>
                      </Box>
                      {taskRuns.length > 0 && (
                        <Box sx={{ display: 'flex', gap: 0.4, mt: 0.5 }}>
                          {taskRuns.map((r) => (
                            <Tooltip key={r.last_run_ts} arrow title={`${new Date(r.last_run_ts * 1000).toLocaleString()} — ${r.result ?? 'no result'}`}>
                              <Box sx={{ width: 10, height: 16, borderRadius: '2px', bgcolor: runOk(r.result) ? ok : bad, opacity: 0.85 }} />
                            </Tooltip>
                          ))}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}

            {(collectErrors.length > 0 || u.update?.available) && (
              <Box sx={{ mt: 1 }}>
                {u.update?.available && (
                  <Typography sx={{ fontSize: '0.76rem', color: warn }}>
                    DSM update available{u.update.version ? `: ${u.update.version}` : ''}.
                  </Typography>
                )}
                {collectErrors.length > 0 && (
                  // Say which parts are missing rather than rendering a blank
                  // section that looks like "nothing to report".
                  <Typography sx={{ fontSize: '0.74rem', color: t.muted }}>
                    Not collected this cycle: {collectErrors.join(', ')}.
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        );
      })}

      {/* Shared-folder growth. Volume capacity says the disk is filling; this
          says which folder is doing it, which is the half you can act on. */}
      {units !== null && units.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Scrim sx={{ mb: 1.5 }}>
            <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: t.ink }}>
              Shared folder growth
            </Typography>
            <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
              Last 90 days · sampled a few times a day
              {/* DSM 7.1 does not return share sizes at all, so say which units
                  are missing from the chart rather than letting it look like
                  they have no data of their own. */}
              {units.some((u) => (u.shares ?? []).every((s) => s.used_bytes == null) && (u.shares?.length ?? 0) > 0)
                && ` · ${units.filter((u) => (u.shares ?? []).every((s) => s.used_bytes == null) && (u.shares?.length ?? 0) > 0).map((u) => u.label).join(', ')} not shown — that DSM version does not report share sizes`}
            </Typography>
          </Scrim>

          <Box sx={{ p: 2, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX, border: `1px solid ${t.line}` }}>
            {sharePoints.length < 2 ? (
              <Typography sx={{ fontSize: '0.82rem', color: t.muted, py: 3, textAlign: 'center' }}>
                {/* Say why it is empty. A blank chart reads as "no data exists"
                    rather than "not enough history yet". */}
                Not enough history yet — shares are sampled a few times a day, so
                this fills in over the first couple of days.
              </Typography>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={sharePoints}>
                  <CartesianGrid stroke={t.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={(ts) => new Date(ts as number).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    tick={{ fill: t.muted, fontSize: 11 }} stroke={t.line} minTickGap={40}
                  />
                  <YAxis
                    tickFormatter={(v) => `${((v as number) / 1e12).toFixed(1)} TB`}
                    tick={{ fill: t.muted, fontSize: 11 }} stroke={t.line} width={62}
                  />
                  <ChartTooltip
                    contentStyle={{ background: isDark ? '#25231A' : '#FFFFFF', border: `1px solid ${t.line}`, borderRadius: 10, fontSize: 12, color: t.ink }}
                    labelFormatter={(ts) => new Date(ts as number).toLocaleDateString()}
                    formatter={(v, name) => [tb(Number(v)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: t.muted }} />
                  {shareNames.map((name, i) => (
                    <Area
                      key={name} type="monotone" dataKey={name} name={name}
                      stackId="shares" stroke={bandFor(name, i)} fill={bandFor(name, i)}
                      fillOpacity={0.55} strokeWidth={1} connectNulls
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Box>
      )}
      {/* External storage — remembered, not just current. A backup drive that
          was unplugged three weeks ago is invisible in DSM's own lists. */}
      {units !== null && units.length > 0 && external.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Scrim sx={{ mb: 1.5 }}>
            <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: t.ink }}>
              USB &amp; external storage
            </Typography>
            <Typography sx={{ fontSize: '0.78rem', color: t.muted }}>
              Every device seen, including ones no longer attached
            </Typography>
          </Scrim>

          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }}>
            {external.map((d) => (
              <Box key={`${d.nas_id}:${d.device_id}`} sx={{
                p: 1.5, borderRadius: CARD_RADIUS, background: t.paper, ...CARD_HOVER_SX,
                border: `1px solid ${t.line}`,
                borderLeft: `3px solid ${d.attached ? ok : warn}`,
              }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontSize: '0.85rem', fontWeight: 700, color: t.ink }}>
                    {d.name ?? d.device_id}
                  </Typography>
                  <Chip size="small" label={d.kind ?? 'device'} sx={{ height: 18, fontSize: '0.65rem', color: t.muted, bgcolor: `${t.rust}18` }} />
                  {!d.attached && (
                    <Chip size="small" label="not attached" sx={{ height: 18, fontSize: '0.65rem', color: warn, bgcolor: `${warn}22` }} />
                  )}
                  <Typography sx={{ fontSize: '0.72rem', color: t.muted }}>{d.nas_label}</Typography>
                  {/* A drive that moved ports leaves its old entry behind for good,
                      because DSM gives no serial to recognise it by. Only the person
                      who unplugged it knows, so only they can clear it. */}
                  {!d.attached && !readOnly && (
                    <Tooltip arrow title="Remove this device from the list. It will come back if it is ever plugged in again.">
                      <Button
                        size="small"
                        onClick={() => forget(d)}
                        disabled={forgetting === `${d.nas_id}:${d.device_id}`}
                        sx={{ ml: 'auto', minWidth: 0, px: 1, py: 0, fontSize: '0.68rem', color: t.muted, textTransform: 'none' }}
                      >
                        {forgetting === `${d.nas_id}:${d.device_id}` ? 'Forgetting…' : 'Forget'}
                      </Button>
                    </Tooltip>
                  )}
                </Box>
                <Typography sx={{ fontSize: '0.75rem', color: t.inkSoft, mt: 0.25 }}>
                  {d.model ?? 'unknown model'}
                  {d.fs ? ` · ${d.fs}` : ''}
                  {d.size_bytes ? ` · ${tb(d.used_bytes)} of ${tb(d.size_bytes)}` : ''}
                </Typography>
                <Typography sx={{ fontSize: '0.72rem', color: d.attached ? t.muted : warn }}>
                  {d.attached
                    ? `attached · first seen ${new Date(d.first_seen).toLocaleDateString()}`
                    : `last seen ${new Date(d.last_seen).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
