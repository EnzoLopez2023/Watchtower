// IP Migration — progress tracker for the re-addressing in docs/NETWORK_IP_PLAN.md.
//
// A multi-week job done a few devices at a time, so the page is built around
// picking it back up cold: what's left, what you thought you'd done but hasn't
// taken effect, and where you got to last time.
//
// The checkbox records intent; the verified state is observed from the live
// UniFi snapshot. Those two disagreeing is the most useful thing here, so
// 'mismatch' is called out rather than folded into "not done".
import { apiFetch } from './services/apiClient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Typography, Chip, CircularProgress, Checkbox, LinearProgress,
  ToggleButton, ToggleButtonGroup, Tooltip, TextField, IconButton, Collapse,
} from '@mui/material';
import {
  CheckCircle as VerifiedIcon,
  RadioButtonUnchecked as PendingIcon,
  WarningAmber as MismatchIcon,
  CloudOff as OfflineIcon,
  ContentCopy as CopyIcon,
  Check as CopiedIcon,
  ExpandMore as ExpandIcon,
  NotesOutlined as NotesIcon,
} from '@mui/icons-material';
import PageHero from './components/PageHero';
import Scrim from './components/Scrim';
import { useThemeMode } from './context/ThemeContext';
import { useReadOnly } from './context/UserPermissionsContext';
import { tokensFor } from './theme/tokens';
import { toggleGroupSx, pageShellSx } from './theme/controls';

type Tk = ReturnType<typeof tokensFor>;
type State = 'verified' | 'at-target' | 'mismatch' | 'pending' | 'offline' | 'no-action';

interface Item {
  mac: string;
  name: string;
  original_ip: string | null;
  target_ip: string | null;
  marked_done: boolean;
  marked_at: number | null;
  notes: string | null;
  first_verified_at: number | null;
  already_reserved: boolean;
  observed_ip: string | null;
  ip_source: string | null;
  kind: string | null;
  state: State;
}
interface Group { code: string; label: string; order: number; items: Item[]; total: number; verified: number }

// Devices the plan has never heard of. The plan was generated from one snapshot;
// the network kept moving, and MAC randomisation means roaming clients come back
// as new devices constantly — so most of this list is noise by design, and the
// classification is what separates the two.
type UnplannedClass = 'conflict' | 'new-hardware' | 'unpinned' | 'reserved' | 'roaming';
interface Unplanned {
  mac: string;
  name: string | null;
  vendor: string | null;
  ip: string | null;
  kind: 'device' | 'client';
  ip_source: string | null;
  fixed_ip: string | null;
  block: { code: string; label: string } | null;
  conflict: { name: string; group_code: string; group_label: string } | null;
  classification: UnplannedClass;
}
interface Pool { network: string | null; start: string; stop: string; lease_seconds: number | null }

interface PlanResponse {
  ok: boolean;
  last_polled: number | null;
  last_polled_age_seconds: number | null;
  progress: { actionable: number; verified: number; marked: number; mismatched: number; remaining: number };
  pool: Pool | null;
  unplanned: Unplanned[];
  unplanned_attention: number;
  groups: Group[];
}

type Filter = 'all' | 'remaining' | 'mismatch' | 'done';

const STATE_LABEL: Record<State, string> = {
  verified: 'Verified',
  'at-target': 'Right IP, not pinned',
  mismatch: 'Not taken effect',
  pending: 'Pending',
  offline: 'Offline',
  'no-action': 'Stays on DHCP',
};
const STATE_HELP: Record<State, string> = {
  verified: 'Observed at its target address with the address pinned — reservation or device-side static.',
  'at-target': 'On the right address, but via an ordinary DHCP lease. That will not survive the pool shrinking — set the reservation.',
  mismatch: 'You marked this done, but it is still reporting a different address. It may need a reboot or lease renewal.',
  pending: 'Not done yet.',
  offline: 'Not present in the latest snapshot, so its address cannot be confirmed.',
  'no-action': 'Roaming device — intentionally left on DHCP.',
};

const UNPLANNED_LABEL: Record<UnplannedClass, string> = {
  conflict: 'Address clash',
  'new-hardware': 'New hardware',
  unpinned: 'Not pinned',
  reserved: 'Reserved',
  roaming: 'Roaming',
};
const UNPLANNED_HELP: Record<UnplannedClass, string> = {
  conflict: 'A switched-off fixed-IP mapping still points at an address the plan has promised to another device. Harmless while it stays off, a clash the moment anyone turns it back on. Clear it in UniFi.',
  'new-hardware': 'UniFi hardware adopted after the plan was written. Give it an address in the right block and add it to the plan document.',
  unpinned: 'Holding an address below the DHCP pool with no reservation, so nothing is keeping it there. Either reserve the address or let it fall back into the pool.',
  reserved: 'Given a reservation after the plan was written. Nothing to do on the network — it just needs adding to the plan document so the next regeneration keeps it.',
  roaming: 'In the DHCP pool with no reservation, which is exactly where a roaming device belongs. Nothing to do.',
};

// Same wording the UniFi Network page uses for its Address column — the raw
// `likely` in particular means nothing to anyone reading it cold.
const IP_SOURCE_LABEL: Record<string, string> = {
  reserved: 'Reserved',
  static: 'Static',
  dhcp: 'DHCP',
  likely: 'DHCP?',
  unknown: '—',
};

const leaseLabel = (s: number | null): string => {
  if (!s) return '';
  if (s < 3600) return `${Math.round(s / 60)} min lease`;
  if (s < 86400) return `${Math.round(s / 3600)} h lease`;
  return `${Math.round(s / 86400)} day lease`;
};

// The plan document writes ranges as `192.168.1.176`–`250`; repeating the whole
// address on the far side of the dash reads as two unrelated numbers.
const poolTail = (ip: string): string => {
  const m = /\.(\d+)$/.exec(ip);
  return m ? `.${m[1]}` : ip;
};

const ago = (ms?: number | null): string => {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function IpMigration() {
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, 'network');
  const readOnly = useReadOnly('ip-migration');

  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('remaining');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ip-plan');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-verify on a slow timer: the agent pushes every 60s, so anything faster
  // just re-reads the same snapshot.
  useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const patch = useCallback(async (mac: string, body: Record<string, unknown>) => {
    // Optimistic: ticking 88 checkboxes shouldn't wait on a round trip each time.
    setData((prev) => prev && ({
      ...prev,
      groups: prev.groups.map((g) => ({
        ...g,
        items: g.items.map((i) => (i.mac === mac ? { ...i, ...body } : i)),
      })),
    }));
    try {
      await apiFetch(`/api/ip-plan/${encodeURIComponent(mac)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      void load();
    } catch { /* the next poll reconciles */ }
  }, [load]);

  const ok = isDark ? '#43C97D' : '#2E9E5B';
  const warn = '#E0A24A';
  const bad = isDark ? '#E0655A' : '#C4443A';
  const cardBg = `linear-gradient(180deg, ${t.paper} 0%, ${t.surface} 100%)`;

  const stateColor = useCallback((s: State): string => (
    s === 'verified' ? ok
      : s === 'mismatch' ? bad
      : s === 'at-target' ? warn
      : t.muted
  ), [ok, bad, warn, t.muted]);

  const visible = useCallback((i: Item): boolean => {
    if (filter === 'all') return true;
    if (filter === 'done') return i.state === 'verified';
    if (filter === 'mismatch') return i.state === 'mismatch' || i.state === 'at-target';
    return !!i.target_ip && i.state !== 'verified';   // 'remaining'
  }, [filter]);

  const p = data?.progress;
  const pct = p && p.actionable ? (p.verified / p.actionable) * 100 : 0;

  const groups = useMemo(
    () => (data?.groups ?? []).map((g) => ({ ...g, shown: g.items.filter(visible) })).filter((g) => g.shown.length),
    [data, visible],
  );

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        eyebrow="NETWORK"
        title="IP Migration"
        accentPhrase="Migration"
        subtitle="Working through the static addressing plan. Tick a device once you've set its reservation; Watchtower confirms it against the live network."
      />

      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: t.rust }} /></Box>}
      {!loading && error && (
        <Typography sx={{ textAlign: 'center', py: 8, color: t.muted }}>Couldn’t load the plan ({error}).</Typography>
      )}

      {p && (
        <>
          {/* Progress + freshness */}
          <Box sx={{ p: 2, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}`, mb: 2.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', mb: 1 }}>
              <Typography sx={{ fontSize: '1.8rem', fontWeight: 800, color: t.ink, lineHeight: 1 }}>
                {p.verified}<Box component="span" sx={{ color: t.muted, fontSize: '1.1rem', fontWeight: 600 }}> / {p.actionable}</Box>
              </Typography>
              <Typography sx={{ color: t.muted, fontSize: '0.85rem' }}>devices verified</Typography>
              <Box sx={{ flex: 1 }} />
              <Typography sx={{ fontSize: '0.75rem', color: t.muted }}>
                network checked {ago(data?.last_polled)}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate" value={pct}
              sx={{ height: 10, borderRadius: 2, bgcolor: t.line, '& .MuiLinearProgress-bar': { bgcolor: ok, borderRadius: 2 } }}
            />
            <Box sx={{ display: 'flex', gap: 2, mt: 1.25, flexWrap: 'wrap' }}>
              <Stat t={t} label="Remaining" value={p.remaining} color={t.inkSoft} />
              <Stat t={t} label="Ticked off" value={p.marked} color={t.inkSoft} />
              {p.mismatched > 0 && <Stat t={t} label="Not taken effect" value={p.mismatched} color={bad} />}
            </Box>
          </Box>

          {p.mismatched > 0 && (
            <Box sx={{ mb: 2.5, p: 1.75, borderRadius: 2, border: `1px solid ${bad}55`, bgcolor: `${bad}12`, display: 'flex', gap: 1.25 }}>
              <MismatchIcon sx={{ color: bad }} />
              <Typography sx={{ fontSize: '0.85rem', color: t.ink }}>
                {p.mismatched} device{p.mismatched === 1 ? ' is' : 's are'} ticked off but still reporting the old address.
                A reservation only takes effect once the device renews its lease — reboot it, or wait out the lease.
              </Typography>
            </Box>
          )}

          <ToggleButtonGroup
            size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}
            sx={{ mb: 2, ...toggleGroupSx(t) }}
          >
            <ToggleButton value="remaining">Remaining ({p.remaining})</ToggleButton>
            <ToggleButton value="mismatch">Needs attention ({p.mismatched})</ToggleButton>
            <ToggleButton value="done">Verified ({p.verified})</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>

          {groups.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <VerifiedIcon sx={{ fontSize: 48, color: ok, mb: 1 }} />
              <Scrim sx={{ display: 'block', mx: 'auto', width: 'fit-content' }}>
                <Typography sx={{ color: t.ink, fontWeight: 700 }}>
                  {filter === 'remaining' ? 'Nothing left in this view.' : 'Nothing matches this filter.'}
                </Typography>
              </Scrim>
            </Box>
          )}

          {groups.map((g) => (
            <Box key={g.code} sx={{ mb: 2 }}>
              <Box
                onClick={() => setCollapsed((c) => ({ ...c, [g.code]: !c[g.code] }))}
                sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', py: 0.75, px: 1.25, mb: 0.75, borderRadius: 2, background: cardBg, border: `1px solid ${t.line}` }}
              >
                <ExpandIcon sx={{ color: t.muted, transform: collapsed[g.code] ? 'rotate(-90deg)' : 'none', transition: 'transform .15s' }} />
                <Typography sx={{ fontWeight: 800, color: t.ink }}>{g.label}</Typography>
                <Chip size="small" label={g.code} sx={{ height: 19, fontSize: '0.62rem', fontWeight: 700, bgcolor: `${t.rust}1E`, color: t.rust }} />
                <Typography sx={{ fontSize: '0.78rem', color: g.total && g.verified === g.total ? ok : t.muted }}>
                  {g.total ? `${g.verified}/${g.total} verified` : 'no action needed'}
                </Typography>
              </Box>

              <Collapse in={!collapsed[g.code]}>
                {/* Opaque surface: these rows are dense monospace over a
                    photographic wallpaper and are unreadable without it. */}
                <Box sx={{ borderRadius: 2, border: `1px solid ${t.line}`, overflow: 'hidden', background: cardBg }}>
                  {g.shown.map((i, idx) => (
                    <Row
                      key={i.mac} i={i} t={t} isDark={isDark} first={idx === 0}
                      color={stateColor(i.state)} ok={ok}
                      onToggle={() => patch(i.mac, { marked_done: !i.marked_done })}
                      onNotes={() => setNoteFor(noteFor === i.mac ? null : i.mac)}
                      notesOpen={noteFor === i.mac}
                      onSaveNotes={(v) => { void patch(i.mac, { notes: v }); setNoteFor(null); }}
                      copied={copied === i.mac}
                      onCopy={() => { void navigator.clipboard?.writeText(i.mac); setCopied(i.mac); setTimeout(() => setCopied(null), 1200); }}
                      readOnly={readOnly}
                    />
                  ))}
                </Box>
              </Collapse>
            </Box>
          ))}

          {data?.unplanned?.length ? (
            <UnplannedPanel
              t={t} isDark={isDark} rows={data.unplanned} pool={data.pool}
              attention={data.unplanned_attention} cardBg={cardBg} bad={bad} warn={warn}
              copied={copied}
              onCopy={(mac) => { void navigator.clipboard?.writeText(mac); setCopied(mac); setTimeout(() => setCopied(null), 1200); }}
            />
          ) : null}

          <Typography sx={{ mt: 3, fontSize: '0.72rem', color: t.inkSoft, textAlign: 'center' }}>
            Plan from docs/NETWORK_IP_PLAN.md · verification reads the live UniFi snapshot, so a tick alone never marks something green
          </Typography>
        </>
      )}
    </Box>
  );
}

function Stat({ t, label, value, color }: { t: Tk; label: string; value: number; color: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
      <Typography sx={{ fontWeight: 800, color, fontSize: '0.95rem' }}>{value}</Typography>
      <Typography sx={{ color: t.muted, fontSize: '0.75rem' }}>{label}</Typography>
    </Box>
  );
}

function Row({ i, t, isDark, first, color, ok, onToggle, onCopy, copied, onNotes, notesOpen, onSaveNotes, readOnly }: {
  i: Item; t: Tk; isDark: boolean; first: boolean; color: string; ok: string;
  onToggle: () => void; onCopy: () => void; copied: boolean;
  onNotes: () => void; notesOpen: boolean; onSaveNotes: (v: string) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(i.notes ?? '');
  const verified = i.state === 'verified';
  const icon = verified ? <VerifiedIcon sx={{ fontSize: '1rem', color }} />
    : i.state === 'mismatch' ? <MismatchIcon sx={{ fontSize: '1rem', color }} />
    : i.state === 'offline' ? <OfflineIcon sx={{ fontSize: '1rem', color }} />
    : <PendingIcon sx={{ fontSize: '1rem', color }} />;

  return (
    <Box sx={{
      borderTop: first ? 'none' : `1px solid ${t.line}`,
      // Verified rows wash green so a finished group reads at a glance.
      bgcolor: verified ? (isDark ? `${ok}14` : `${ok}12`) : 'transparent',
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.85, flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
        <Tooltip title={readOnly ? 'You have view-only access' : i.target_ip ? 'Mark that you set this in UniFi' : 'No action needed'} arrow>
          <span>
            <Checkbox
              size="small" checked={i.marked_done} onChange={onToggle} disabled={readOnly || !i.target_ip}
              sx={{ color: t.muted, p: 0.5, '&.Mui-checked': { color: ok } }}
            />
          </span>
        </Tooltip>

        <Box sx={{ minWidth: 0, flex: '1 1 190px' }}>
          <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: t.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.name}>
            {i.name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: '0.66rem', color: t.muted, fontFamily: 'monospace' }}>{i.mac}</Typography>
            <IconButton size="small" onClick={onCopy} sx={{ p: 0.15, color: copied ? ok : t.muted }}>
              {copied ? <CopiedIcon sx={{ fontSize: '0.7rem' }} /> : <CopyIcon sx={{ fontSize: '0.7rem' }} />}
            </IconButton>
          </Box>
        </Box>

        {/* from → to, with what the network currently reports */}
        <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 0.75, fontFamily: 'monospace', fontSize: '0.76rem' }}>
          <Typography sx={{ color: t.muted, fontSize: '0.76rem', fontFamily: 'monospace', textDecoration: verified ? 'line-through' : 'none' }}>
            {i.original_ip ?? '—'}
          </Typography>
          <Typography sx={{ color: t.muted }}>→</Typography>
          <Typography sx={{ color: verified ? ok : t.ink, fontWeight: 700, fontSize: '0.8rem', fontFamily: 'monospace' }}>
            {i.target_ip ?? 'DHCP'}
          </Typography>
        </Box>

        <Box sx={{ flex: '0 0 auto', minWidth: 128, display: 'flex', alignItems: 'center', gap: 0.5, justifyContent: 'flex-end' }}>
          {/* The router is pinned by being the router, not by a reservation —
              saying otherwise would be inaccurate. */}
          <Tooltip
            title={i.kind === 'gateway'
              ? 'This is the router. Its LAN address is set in the network config, not leased, so it cannot drift — its device record reports the WAN address instead.'
              : STATE_HELP[i.state]}
            arrow
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
              {icon}
              <Typography sx={{ fontSize: '0.7rem', fontWeight: 700, color }}>{STATE_LABEL[i.state]}</Typography>
            </Box>
          </Tooltip>
          <IconButton size="small" onClick={onNotes} sx={{ p: 0.25, color: i.notes ? t.rust : t.muted }}>
            <NotesIcon sx={{ fontSize: '0.9rem' }} />
          </IconButton>
        </Box>

        {/* Currently-observed address, when it differs from the target */}
        <Box sx={{ flex: '0 0 auto', minWidth: 96, textAlign: 'right' }}>
          <Typography sx={{ fontSize: '0.68rem', color: t.muted, fontFamily: 'monospace' }}>
            {i.observed_ip && i.observed_ip !== i.target_ip ? `now ${i.observed_ip}` : ''}
            {i.observed_ip === i.target_ip && i.ip_source ? i.ip_source : ''}
          </Typography>
          {i.first_verified_at && (
            <Typography sx={{ fontSize: '0.62rem', color: t.muted }}>{ago(i.first_verified_at)}</Typography>
          )}
        </Box>
      </Box>

      <Collapse in={notesOpen}>
        <Box sx={{ px: 1.5, pb: 1.25, display: 'flex', gap: 1 }}>
          <TextField
            size="small" fullWidth placeholder="Note — e.g. needs a reboot, behind the Coop switch…"
            value={draft} onChange={(e) => setDraft(e.target.value)} disabled={readOnly}
            onKeyDown={(e) => { if (e.key === 'Enter' && !readOnly) onSaveNotes(draft); }}
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: t.paper, fontSize: '0.8rem' } }}
          />
          {!readOnly && (
            <Chip label="Save" onClick={() => onSaveNotes(draft)} sx={{ bgcolor: t.rust, color: '#fff', fontWeight: 700 }} />
          )}
        </Box>
      </Collapse>

      {i.notes && !notesOpen && (
        <Typography sx={{ px: 5.5, pb: 0.85, fontSize: '0.72rem', color: t.muted, fontStyle: 'italic' }}>{i.notes}</Typography>
      )}
    </Box>
  );
}

// ── Not in the plan ──────────────────────────────────────────────────────────
// The counterpart to the checklist: not "what have I not done yet" but "what
// turned up while I wasn't looking". Roaming clients dominate the raw list and
// mean nothing — every MAC rotation produces another one — so they are folded
// away by default rather than filtered out, because "13 roaming, nothing to do"
// is itself the answer to the question.
function UnplannedPanel({ t, isDark, rows, pool, attention, cardBg, bad, warn, copied, onCopy }: {
  t: Tk; isDark: boolean; rows: Unplanned[]; pool: Pool | null; attention: number;
  cardBg: string; bad: string; warn: string;
  copied: string | null; onCopy: (mac: string) => void;
}) {
  const [open, setOpen] = useState(attention > 0);
  const [showRoaming, setShowRoaming] = useState(false);

  const roaming = rows.filter((u) => u.classification === 'roaming');
  const shown = showRoaming ? rows : rows.filter((u) => u.classification !== 'roaming');

  const colorFor = (c: UnplannedClass): string => (
    c === 'conflict' ? bad
      : c === 'new-hardware' || c === 'unpinned' ? warn
      : c === 'reserved' ? t.rust
      : t.muted
  );

  return (
    <Box sx={{ mt: 3 }}>
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', py: 0.75, px: 1.25, mb: 0.75, borderRadius: 2, background: cardBg, border: `1px solid ${attention > 0 ? `${warn}66` : t.line}` }}
      >
        <ExpandIcon sx={{ color: t.muted, transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
        <Typography sx={{ fontWeight: 800, color: t.ink }}>Not in the plan</Typography>
        <Chip size="small" label={rows.length} sx={{ height: 19, fontSize: '0.62rem', fontWeight: 700, bgcolor: `${t.rust}1E`, color: t.rust }} />
        <Typography sx={{ fontSize: '0.78rem', color: attention > 0 ? warn : t.muted }}>
          {attention > 0
            ? `${attention} worth a look · ${roaming.length} roaming`
            : `all ${roaming.length} roaming — nothing to do`}
        </Typography>
      </Box>

      <Collapse in={open}>
        <Box sx={{ borderRadius: 2, border: `1px solid ${t.line}`, overflow: 'hidden', background: cardBg }}>
          <Typography sx={{ px: 1.5, pt: 1.25, pb: 1, fontSize: '0.75rem', color: t.muted }}>
            On the network but absent from the plan. Phones and laptops rotate their MAC address, so a roaming
            client reappears as a new device every few days and lands here rather than in the DHCP pool group.
            {pool && (
              <Box component="span" sx={{ color: t.inkSoft }}>
                {' '}Pool is <Box component="span" sx={{ fontFamily: 'monospace' }}>{pool.start}–{poolTail(pool.stop)}</Box>
                {pool.lease_seconds ? `, ${leaseLabel(pool.lease_seconds)}` : ''}.
              </Box>
            )}
          </Typography>

          {shown.map((u) => (
            <UnplannedRow
              key={u.mac} u={u} t={t} isDark={isDark} color={colorFor(u.classification)}
              copied={copied === u.mac} onCopy={() => onCopy(u.mac)}
            />
          ))}

          {roaming.length > 0 && (
            <Box sx={{ borderTop: `1px solid ${t.line}`, px: 1.5, py: 0.85 }}>
              <Typography
                onClick={() => setShowRoaming((v) => !v)}
                sx={{ fontSize: '0.73rem', color: t.rust, fontWeight: 700, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
              >
                {showRoaming ? 'Hide' : 'Show'} {roaming.length} roaming device{roaming.length === 1 ? '' : 's'}
              </Typography>
            </Box>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

function UnplannedRow({ u, t, isDark, color, copied, onCopy }: {
  u: Unplanned; t: Tk; isDark: boolean; color: string; copied: boolean; onCopy: () => void;
}) {
  const attention = u.classification !== 'roaming';
  // A fixed IP recorded against a device that isn't using it is a mapping
  // someone switched off and left behind. Worth stating even when it collides
  // with nothing, because it is the reason the address will move on a whim.
  const staleFixed = !!u.fixed_ip && u.ip_source !== 'reserved';
  const unapplied = u.ip_source === 'reserved' && !!u.fixed_ip && u.fixed_ip !== u.ip;
  return (
    <Box sx={{
      borderTop: `1px solid ${t.line}`,
      bgcolor: u.classification === 'conflict' ? (isDark ? `${color}14` : `${color}10`) : 'transparent',
    }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.85, flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flex: '0 0 auto', ml: 0.5 }} />

        <Box sx={{ minWidth: 0, flex: '1 1 190px' }}>
          <Typography
            sx={{ fontSize: '0.85rem', fontWeight: 600, color: u.name ? t.ink : t.inkSoft, fontStyle: u.name ? 'normal' : 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={u.name ?? u.vendor ?? u.mac}
          >
            {u.name ?? (u.vendor ? `Unnamed ${u.vendor}` : 'Unnamed device')}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography sx={{ fontSize: '0.66rem', color: t.muted, fontFamily: 'monospace' }}>{u.mac}</Typography>
            <IconButton size="small" onClick={onCopy} sx={{ p: 0.15, color: copied ? t.rust : t.muted }}>
              {copied ? <CopiedIcon sx={{ fontSize: '0.7rem' }} /> : <CopyIcon sx={{ fontSize: '0.7rem' }} />}
            </IconButton>
            {u.name && u.vendor && (
              <Typography sx={{ fontSize: '0.66rem', color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {u.vendor}</Typography>
            )}
          </Box>
        </Box>

        <Box sx={{ flex: '0 0 auto', minWidth: 132 }}>
          <Typography sx={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700, color: t.ink }}>{u.ip ?? '—'}</Typography>
          <Typography sx={{ fontSize: '0.66rem', color: t.muted }}>
            {u.block ? `${u.block.label}${u.block.code === 'DYN' ? '' : ' block'}` : 'outside the plan'}
            {u.ip_source ? ` · ${IP_SOURCE_LABEL[u.ip_source] ?? u.ip_source}` : ''}
          </Typography>
        </Box>

        <Box sx={{ flex: '0 0 auto', minWidth: 108, display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title={UNPLANNED_HELP[u.classification]} arrow>
            <Chip
              size="small"
              label={UNPLANNED_LABEL[u.classification]}
              sx={{
                height: 20, fontSize: '0.65rem', fontWeight: 700, color,
                bgcolor: `${color}1E`, border: `1px solid ${color}${attention ? '55' : '2A'}`,
              }}
            />
          </Tooltip>
        </Box>
      </Box>

      {staleFixed && (
        <Typography sx={{ px: 3.5, pb: 0.9, fontSize: '0.72rem', color: t.inkSoft }}>
          Switched-off reservation still points at{' '}
          <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: u.conflict ? color : t.muted }}>{u.fixed_ip}</Box>
          {u.conflict
            ? <> — the plan promises that address to <b>{u.conflict.name}</b> ({u.conflict.group_label}).</>
            : ' — nothing else claims it, but it will apply the moment anyone re-enables it.'}
        </Typography>
      )}

      {unapplied && (
        <Typography sx={{ px: 3.5, pb: 0.9, fontSize: '0.72rem', color: t.inkSoft }}>
          Reserved for{' '}
          <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, color: t.ink }}>{u.fixed_ip}</Box>
          {' '}but still answering on {u.ip} — it needs a reboot or a lease renewal.
        </Typography>
      )}
    </Box>
  );
}
