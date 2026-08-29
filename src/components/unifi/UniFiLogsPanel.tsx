import { apiFetch } from '../../services/apiClient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from '@mui/material';
import {
  AltRoute as RouteIcon,
  FilterAlt as FilterIcon,
  History as ActivityIcon,
  Refresh as RefreshIcon,
  SwapHoriz as FlowIcon,
} from '@mui/icons-material';
import type { tokensFor } from '../../theme/tokens';
import { CARD_HOVER_SX, CARD_RADIUS, toggleGroupSx } from '../../theme/controls';

type Tk = ReturnType<typeof tokensFor>;
type LogKind = 'activity' | 'flows';

interface Cursor {
  ts: number;
  id: number;
}

interface Retention {
  hotDays: number;
  maxRows: number;
}

interface PageMeta {
  total: number;
  matchingTotal: number;
  oldestAt: number | null;
  newestAt: number | null;
  nextCursor: Cursor | null;
  retention: Retention;
}

interface ActivityRow {
  id: number;
  event_ts: number;
  received_at: number;
  severity: string | null;
  category: string | null;
  subcategory: string | null;
  event_type: string | null;
  title: string | null;
  message: string | null;
  actor: string | null;
  target: string | null;
}

interface FlowRow {
  id: number;
  flow_ts: number;
  flow_end_ts: number | null;
  duration_ms: number | null;
  action: string | null;
  direction: string | null;
  protocol: string | null;
  service: string | null;
  risk: string | null;
  source_name: string | null;
  source_ip: string | null;
  source_mac: string | null;
  source_port: number | null;
  source_network: string | null;
  source_zone: string | null;
  destination_name: string | null;
  destination_ip: string | null;
  destination_mac: string | null;
  destination_port: number | null;
  destination_network: string | null;
  destination_zone: string | null;
  ingress_name: string | null;
  egress_name: string | null;
  bytes_rx: number | null;
  bytes_tx: number | null;
  bytes_total: number | null;
  packets_total: number | null;
  policy_names: string[];
  policy_types: string[];
}

interface RouteDrift {
  drift_key: string;
  route_name: string | null;
  drift_type: string;
  detail: string;
  first_seen_at: number;
  last_seen_at: number;
}

interface SummaryBucket {
  count: number;
  oldestAt: number | null;
  newestAt: number | null;
  retention: Retention;
}

interface IngestHealth {
  skew_ms: number | null;
  skew_trusted: number;
  gaps_untrusted: number;
  last_untrusted_at: number | null;
  updated_at: number;
}

interface CollectionGap {
  stream: string;
  from_ts: number;
  to_ts: number;
  // 'hold' is still being retried; 'unreadable' is history that is gone.
  kind?: string;
  // Dates the server could not reconcile with the agent's clock.
  clock_untrusted?: number;
  // A hold that later cleared: the records were read after all.
  resolved_at?: number | null;
  reason: string;
  first_reported_at: number;
  last_reported_at: number;
  report_count: number;
}

interface CollectionCompat {
  stream: string;
  status: string;
  page_base: number | null;
  filter_variant: string | null;
  evidence: string | null;
  negotiated_at: number | null;
  held: number;
  updated_at: number;
}

// What the agent proved about this controller's private API, in plain words.
// Never renders a host, credential, token or record — only the convention.
function describeCompat(entry: CollectionCompat): string {
  const paging = entry.page_base == null ? null : `${entry.page_base}-based paging`;
  const body = entry.filter_variant ? `${entry.filter_variant} filters` : null;
  switch (entry.status) {
    case 'proven':
      return [paging, body].filter(Boolean).join(', ') || 'proven';
    case 'empty':
      return 'no records to negotiate against';
    case 'unfiltered':
      return 'request body ignored by the controller';
    case 'ignored':
      return 'page number ignored by the controller';
    case 'unverifiable':
      return 'records carry no readable timestamp';
    case 'failed':
      return 'every request shape rejected';
    default:
      return 'unverified';
  }
}

interface LogsSummary {
  activity: SummaryBucket;
  flows: SummaryBucket;
  filters?: {
    activity: { categories: string[]; severities: string[] };
    flows: { actions: string[]; protocols: string[] };
  };
  gaps?: CollectionGap[];
  ingestHealth?: IngestHealth | null;
  compat?: CollectionCompat[];
  trafficRoutes: {
    initialized: boolean;
    establishedAt: number | null;
    lastObservedAt?: number | null;
    baseline: Array<{ route_id: string; route_name: string | null }>;
    drift: RouteDrift[];
  };
  archive: {
    enabled: boolean;
    configurationError?: string | null;
    settleHours: number | null;
    streams: Array<{
      stream: string;
      attempted_days: number;
      archived_days: number;
      last_archived_at: number | null;
      last_error_at: number | null;
    }>;
    latestError: {
      stream: string;
      day_start: number;
      last_attempt_at: number;
      last_error: string;
    } | null;
  };
}

interface Filters {
  q: string;
  from: string;
  to: string;
  category: string;
  severity: string;
  action: string;
  protocol: string;
}

const EMPTY_FILTERS: Filters = {
  q: '',
  from: '',
  to: '',
  category: '',
  severity: '',
  action: '',
  protocol: '',
};

const emptyMeta = (hotDays: number, maxRows: number): PageMeta => ({
  total: 0,
  matchingTotal: 0,
  oldestAt: null,
  newestAt: null,
  nextCursor: null,
  retention: { hotDays, maxRows },
});

function fmtDate(value: number | null): string {
  if (value == null) return 'Never';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function fmtBytes(value: number | null): string {
  if (value == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${amount >= 100 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function endpointLabel(name: string | null, ip: string | null, port: number | null): string {
  const host = name || ip || 'Unknown endpoint';
  const address = name && ip ? ip : null;
  return `${host}${port != null ? `:${port}` : ''}${address ? ` · ${address}` : ''}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  if (!body) throw new Error('Watchtower returned an empty response');
  return body;
}

function filterParams(filters: Filters, kind: LogKind): URLSearchParams {
  const params = new URLSearchParams({ limit: '200' });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.from) params.set('from', String(new Date(filters.from).getTime()));
  if (filters.to) params.set('to', String(new Date(filters.to).getTime() + 60_000 - 1));
  if (kind === 'activity') {
    if (filters.category) params.set('category', filters.category);
    if (filters.severity) params.set('severity', filters.severity);
  } else {
    if (filters.action) params.set('action', filters.action);
    if (filters.protocol) params.set('protocol', filters.protocol);
  }
  return params;
}

export default function UniFiLogsPanel({ t, isDark }: { t: Tk; isDark: boolean }) {
  const compact = useMediaQuery('(max-width:800px)');
  const [kind, setKind] = useState<LogKind>('activity');
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [activityMeta, setActivityMeta] = useState<PageMeta>(() => emptyMeta(90, 250_000));
  const [flowMeta, setFlowMeta] = useState<PageMeta>(() => emptyMeta(14, 500_000));
  const [summary, setSummary] = useState<LogsSummary | null>(null);
  const [summaryLoadedAt, setSummaryLoadedAt] = useState(() => Date.now());
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadSummary = useCallback(async () => {
    try {
      const response = await apiFetch('/api/unifi/logs/summary');
      setSummary(await responseJson<LogsSummary>(response));
      setSummaryLoadedAt(Date.now());
      setSummaryError(null);
    } catch (loadError) {
      setSummaryError(loadError instanceof Error ? loadError.message : 'Could not load UniFi log status');
      throw loadError;
    }
  }, []);

  const loadPage = useCallback(async (
    requestedKind: LogKind,
    append = false,
    cursor: Cursor | null = null,
  ) => {
    const sequence = ++requestSequence.current;
    if (append) setLoadingOlder(true);
    else setLoading(true);
    try {
      const params = filterParams(applied, requestedKind);
      if (cursor) {
        params.set('beforeTs', String(cursor.ts));
        params.set('beforeId', String(cursor.id));
      }
      const response = await apiFetch(`/api/unifi/logs/${requestedKind}?${params.toString()}`);
      if (requestedKind === 'activity') {
        const page = await responseJson<PageMeta & { activity: ActivityRow[] }>(response);
        if (sequence !== requestSequence.current) return;
        setActivity((current) => append ? [...current, ...page.activity] : page.activity);
        setActivityMeta(page);
      } else {
        const page = await responseJson<PageMeta & { flows: FlowRow[] }>(response);
        if (sequence !== requestSequence.current) return;
        setFlows((current) => append ? [...current, ...page.flows] : page.flows);
        setFlowMeta(page);
      }
      setPageError(null);
    } catch (loadError) {
      if (sequence === requestSequence.current) {
        setPageError(loadError instanceof Error ? loadError.message : 'Could not load UniFi logs');
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [applied]);

  const refresh = useCallback(async () => {
    await Promise.allSettled([loadSummary(), loadPage(kind)]);
  }, [kind, loadPage, loadSummary]);

  useEffect(() => {
    void loadSummary().catch(() => undefined);
  }, [loadSummary]);

  useEffect(() => {
    void loadPage(kind);
  }, [kind, loadPage]);

  const rows = kind === 'activity' ? activity : flows;
  const meta = kind === 'activity' ? activityMeta : flowMeta;
  const categories = useMemo(
    () => summary?.filters?.activity.categories
      ?? [...new Set(activity.map((row) => row.category).filter((value): value is string => Boolean(value)))].sort(),
    [activity, summary],
  );
  const severities = useMemo(
    () => summary?.filters?.activity.severities
      ?? [...new Set(activity.map((row) => row.severity).filter((value): value is string => Boolean(value)))].sort(),
    [activity, summary],
  );
  const actions = useMemo(
    () => summary?.filters?.flows.actions
      ?? [...new Set(flows.map((row) => row.action).filter((value): value is string => Boolean(value)))].sort(),
    [flows, summary],
  );
  const protocols = useMemo(
    () => summary?.filters?.flows.protocols
      ?? [...new Set(flows.map((row) => row.protocol).filter((value): value is string => Boolean(value)))].sort(),
    [flows, summary],
  );

  const applyFilters = () => {
    if (draft.from && draft.to && new Date(draft.from).getTime() > new Date(draft.to).getTime()) {
      setPageError('From must be earlier than Through.');
      return;
    }
    setApplied(draft);
  };

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPageError(null);
  };

  const drift = summary?.trafficRoutes.drift ?? [];
  // A hold that has been settled is history, not a live fault.
  const gaps = (summary?.gaps ?? []).filter((gap) => !gap.resolved_at);
  const health = summary?.ingestHealth ?? null;
  // This is a present-tense fault, so every input is bounded to recent reports:
  // a lifetime counter would keep the banner up forever once the operator had
  // actually fixed the clock.
  const skewMs = health?.skew_ms ?? null;
  const clockFault = health != null
    && ((skewMs != null && skewMs > 60_000) || health.skew_trusted === 0 || health.gaps_untrusted > 0);
  // A held window is still being re-read, so it is not lost history yet.
  const heldGaps = gaps.filter((gap) => gap.kind === 'hold').length;
  const compat = summary?.compat ?? [];
  const routeLastObservedAt = summary?.trafficRoutes.lastObservedAt
    ?? summary?.trafficRoutes.establishedAt
    ?? null;
  const routeObservationStale = Boolean(
    summary?.trafficRoutes.initialized
    && (routeLastObservedAt == null || summaryLoadedAt - routeLastObservedAt > 15 * 60 * 1000),
  );
  const lastArchivedAt = summary?.archive.streams.reduce<number | null>(
    (latest, stream) => (
      stream.last_archived_at != null && (latest == null || stream.last_archived_at > latest)
        ? stream.last_archived_at
        : latest
    ),
    null,
  ) ?? null;
  const warning = isDark ? '#E6A63A' : '#A66A0A';
  const danger = isDark ? '#E47B70' : '#A94038';
  const error = summaryError ?? pageError;

  return (
    <Box>
      <Box
        sx={{
          mb: 2.5,
          borderRadius: CARD_RADIUS,
          border: `1px solid ${t.line}`,
          background: t.paper,
          ...CARD_HOVER_SX,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr 1fr', md: '1fr 1fr 1.25fr 1fr' },
            '& > div': {
              px: { xs: 1.5, md: 2 },
              py: 1.5,
              borderRight: `1px solid ${t.line}`,
            },
            '& > div:nth-of-type(2)': {
              borderRight: { xs: 0, md: `1px solid ${t.line}` },
            },
            '& > div:nth-of-type(-n+2)': {
              borderBottom: { xs: `1px solid ${t.line}`, md: 0 },
            },
            '& > div:last-of-type': { borderRight: 0 },
          }}
        >
          <SummaryValue
            t={t}
            label="Activity retained"
            value={summary ? fmtCount(summary.activity.count) : '—'}
            detail={summary ? `Newest ${fmtDate(summary.activity.newestAt)}` : 'Loading collection status'}
          />
          <SummaryValue
            t={t}
            label="Traffic flows retained"
            value={summary ? fmtCount(summary.flows.count) : '—'}
            detail={summary ? `Newest ${fmtDate(summary.flows.newestAt)}` : 'Loading collection status'}
          />
          <SummaryValue
            t={t}
            label="Traffic Route baseline"
            value={!summary
              ? '—'
              : !summary.trafficRoutes.initialized
                ? 'Waiting'
                : drift.length
                  ? `${drift.length} drift${drift.length === 1 ? '' : 's'}`
                  : routeObservationStale ? 'Check stale' : 'Matches'}
            detail={!summary?.trafficRoutes.initialized
              ? 'The first successful route collection establishes the baseline'
              : routeObservationStale
                ? `Last verified ${fmtDate(routeLastObservedAt)}`
                : `Verified ${fmtDate(routeLastObservedAt)} · ${summary.trafficRoutes.baseline.length} routes`}
            tone={drift.length || routeObservationStale ? danger : undefined}
          />
          <SummaryValue
            t={t}
            label="One-year archive"
            value={!summary
              ? '—'
              : summary.archive.configurationError
                ? 'Configuration error'
                : !summary.archive.enabled
                  ? 'Not configured'
                  : summary.archive.latestError ? 'Needs attention' : 'Protected'}
            detail={summary?.archive.configurationError
              ?? (!summary?.archive.enabled
              ? 'Searchable hot retention remains active'
              : summary.archive.latestError
                ? `${summary.archive.latestError.stream}: ${summary.archive.latestError.last_error}`
                : lastArchivedAt
                  ? `Last completed ${fmtDate(lastArchivedAt)}`
                  : `Waiting for the ${summary.archive.settleHours}-hour settle window`)}
            tone={summary?.archive.configurationError || summary?.archive.latestError ? danger : undefined}
          />
        </Box>
      </Box>

      {drift.length > 0 && (
        <Alert
          severity="warning"
          icon={<RouteIcon />}
          sx={{
            mb: 2.5,
            border: `1px solid ${warning}66`,
            bgcolor: `${warning}12`,
            color: t.ink,
            alignItems: 'flex-start',
            '& .MuiAlert-icon': { color: warning },
          }}
        >
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 800, mb: 0.75 }}>
            Traffic Route configuration differs from its baseline
          </Typography>
          {drift.map((item) => (
            <Box key={item.drift_key} sx={{ mt: 0.6 }}>
              <Typography component="span" sx={{ fontSize: '0.76rem', fontWeight: 750 }}>
                {item.route_name || item.drift_type}
              </Typography>
              <Typography component="span" sx={{ fontSize: '0.76rem', color: t.inkSoft }}>
                {' — '}{item.detail}
              </Typography>
            </Box>
          ))}
        </Alert>
      )}

      {clockFault && (
        <Alert
          severity="warning"
          icon={<ActivityIcon />}
          sx={{
            mb: 2.5,
            border: `1px solid ${warning}66`,
            bgcolor: `${warning}12`,
            color: t.ink,
            alignItems: 'flex-start',
            '& .MuiAlert-icon': { color: warning },
          }}
        >
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 800, mb: 0.5 }}>
            Collector clock disagrees with the server
          </Typography>
          <Typography sx={{ fontSize: '0.76rem', color: t.inkSoft }}>
            {health?.skew_trusted === 0
              ? 'The agent reported a collection time too far from the server clock to reconcile.'
              : skewMs != null && `The agent's clock is ahead of the server by ${Math.round(skewMs / 1000)}s.`}
            {(health?.gaps_untrusted ?? 0) > 0
              && ` ${health?.gaps_untrusted} collection window(s) were stored with the agent's own`
                + ' unverified dates because no offset could place them in time.'}
          </Typography>
        </Alert>
      )}

      {gaps.length > 0 && (
        <Alert
          severity="warning"
          icon={<ActivityIcon />}
          sx={{
            mb: 2.5,
            border: `1px solid ${warning}66`,
            bgcolor: `${warning}12`,
            color: t.ink,
            alignItems: 'flex-start',
            '& .MuiAlert-icon': { color: warning },
          }}
        >
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 800, mb: 0.75 }}>
            {gaps.length === 1 ? 'One window' : `${gaps.length} windows`} could not be collected completely
            {heldGaps > 0 && ` — ${heldGaps} still being retried`}
          </Typography>
          {gaps.slice(0, 10).map((gap) => (
            <Box key={`${gap.stream}:${gap.kind ?? 'unreadable'}:${gap.from_ts}`} sx={{ mt: 0.6 }}>
              <Typography component="span" sx={{ fontSize: '0.76rem', fontWeight: 750 }}>
                {gap.stream === 'flows' ? 'Traffic flows' : 'Activity'}
                {' '}{fmtDate(gap.from_ts)} → {fmtDate(gap.to_ts)}
                {gap.kind === 'hold' ? ' (retrying)' : ' (lost)'}
                {gap.clock_untrusted ? ' (dates unverified)' : ''}
              </Typography>
              <Typography component="span" sx={{ fontSize: '0.76rem', color: t.inkSoft }}>
                {' — '}{gap.reason}
              </Typography>
            </Box>
          ))}
        </Alert>
      )}

      {compat.length > 0 && (
        <Box
          sx={{
            mb: 2.5,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 1.1,
            borderRadius: CARD_RADIUS,
            border: `1px solid ${t.line}`,
            background: t.paper,
          }}
        >
          <Typography sx={{ fontSize: '0.74rem', fontWeight: 800, color: t.inkSoft, letterSpacing: '.04em' }}>
            COLLECTOR COMPATIBILITY
          </Typography>
          {compat.map((entry) => {
            const proven = entry.status === 'proven';
            const benign = proven || entry.status === 'empty';
            const tone = benign ? t.inkSoft : warning;
            return (
              <Chip
                key={entry.stream}
                size="small"
                label={`${entry.stream === 'flows' ? 'Traffic flows' : 'Activity'}: ${describeCompat(entry)}`}
                title={[
                  entry.evidence ? `Evidence: ${entry.evidence}` : null,
                  entry.negotiated_at ? `Negotiated ${fmtDate(entry.negotiated_at)}` : 'Never negotiated',
                  entry.held ? 'Checkpoint held — the window will be re-read' : null,
                ].filter(Boolean).join('\n')}
                sx={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  color: tone,
                  border: `1px solid ${tone}55`,
                  bgcolor: benign ? 'transparent' : `${warning}12`,
                }}
              />
            );
          })}
        </Box>
      )}

      <Box
        sx={{
          borderRadius: CARD_RADIUS,
          border: `1px solid ${t.line}`,
          background: t.paper,
          ...CARD_HOVER_SX,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: 'space-between',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 1.25,
            p: { xs: 1.5, md: 2 },
            borderBottom: `1px solid ${t.line}`,
          }}
        >
          <ToggleButtonGroup
            size="small"
            exclusive
            value={kind}
            onChange={(_, value: LogKind | null) => value && setKind(value)}
            aria-label="UniFi log source"
            sx={toggleGroupSx(t)}
          >
            <ToggleButton value="activity">
              <ActivityIcon sx={{ fontSize: 16, mr: 0.75 }} />
              Activity
            </ToggleButton>
            <ToggleButton value="flows">
              <FlowIcon sx={{ fontSize: 16, mr: 0.75 }} />
              Traffic flows
            </ToggleButton>
          </ToggleButtonGroup>
          <Button
            size="small"
            variant="outlined"
            startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
            onClick={() => void refresh()}
            disabled={loading}
            sx={{ alignSelf: { xs: 'flex-start', sm: 'auto' }, textTransform: 'none' }}
          >
            Refresh
          </Button>
        </Box>

        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'minmax(220px, 2fr) 1fr 1fr',
              lg: 'minmax(260px, 2fr) repeat(4, minmax(150px, 1fr)) auto',
            },
            gap: 1,
            p: { xs: 1.5, md: 2 },
            bgcolor: t.surface,
            borderBottom: `1px solid ${t.line}`,
          }}
        >
          <TextField
            size="small"
            label={kind === 'activity' ? 'Search event, actor, or target' : 'Search endpoint, service, or policy'}
            value={draft.q}
            onChange={(event) => setDraft((current) => ({ ...current, q: event.target.value }))}
            inputProps={{ maxLength: 160 }}
          />
          <TextField
            size="small"
            type="datetime-local"
            label="From"
            value={draft.from}
            onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="datetime-local"
            label="Through"
            value={draft.to}
            onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            InputLabelProps={{ shrink: true }}
          />
          {kind === 'activity' ? (
            <>
              <FilterSelect label="Category" value={draft.category} values={categories}
                onChange={(value) => setDraft((current) => ({ ...current, category: value }))} />
              <FilterSelect label="Severity" value={draft.severity} values={severities}
                onChange={(value) => setDraft((current) => ({ ...current, severity: value }))} />
            </>
          ) : (
            <>
              <FilterSelect label="Action" value={draft.action} values={actions}
                onChange={(value) => setDraft((current) => ({ ...current, action: value }))} />
              <FilterSelect label="Protocol" value={draft.protocol} values={protocols}
                onChange={(value) => setDraft((current) => ({ ...current, protocol: value }))} />
            </>
          )}
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
            <Button type="submit" size="small" variant="contained" startIcon={<FilterIcon />} sx={{ textTransform: 'none' }}>
              Apply
            </Button>
            <Button type="button" size="small" onClick={resetFilters} sx={{ color: t.muted, textTransform: 'none' }}>
              Clear
            </Button>
          </Box>
        </Box>

        {error && (
          <Alert
            severity="error"
            sx={{ borderRadius: 0, borderBottom: `1px solid ${t.line}` }}
            action={<Button color="inherit" size="small" onClick={() => void refresh()}>Retry</Button>}
          >
            {error}
          </Alert>
        )}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            flexWrap: 'wrap',
            px: { xs: 1.5, md: 2 },
            py: 1.25,
            borderBottom: `1px solid ${t.line}`,
          }}
        >
          <Typography sx={{ color: t.inkSoft, fontSize: '0.75rem' }}>
            Showing {fmtCount(rows.length)} of {fmtCount(meta.matchingTotal)} matching · {fmtCount(meta.total)} retained
          </Typography>
          <Typography sx={{ color: t.muted, fontSize: '0.7rem' }}>
            {meta.retention.hotDays} days searchable · {fmtCount(meta.retention.maxRows)}-row safety cap
          </Typography>
        </Box>

        {loading && rows.length === 0 ? (
          <Box sx={{ p: 2 }} aria-label="Loading UniFi logs">
            {[0, 1, 2, 3, 4].map((item) => (
              <Skeleton key={item} height={46} sx={{ bgcolor: `${t.muted}18` }} />
            ))}
          </Box>
        ) : rows.length === 0 ? (
          <Box sx={{ px: 2, py: 6, textAlign: 'center' }}>
            {kind === 'activity' ? <ActivityIcon sx={{ color: t.muted, fontSize: 30 }} /> : <FlowIcon sx={{ color: t.muted, fontSize: 30 }} />}
            <Typography sx={{ color: t.ink, fontSize: '0.9rem', fontWeight: 800, mt: 1 }}>
              {Object.values(applied).some(Boolean) ? 'No records match these filters' : `No ${kind === 'activity' ? 'activity records' : 'traffic flows'} collected yet`}
            </Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.76rem', mt: 0.5, maxWidth: 520, mx: 'auto' }}>
              {Object.values(applied).some(Boolean)
                ? 'Broaden the time window or clear one of the filters.'
                : 'The on-site UniFi agent will populate this view after its next successful collection.'}
            </Typography>
          </Box>
        ) : compact ? (
          <Box sx={{ p: 1.25 }}>
            {kind === 'activity'
              ? activity.map((row) => <ActivityCard key={row.id} row={row} t={t} isDark={isDark} />)
              : flows.map((row) => <FlowCard key={row.id} row={row} t={t} isDark={isDark} />)}
          </Box>
        ) : kind === 'activity' ? (
          <ActivityTable rows={activity} t={t} isDark={isDark} />
        ) : (
          <FlowTable rows={flows} t={t} isDark={isDark} />
        )}

        {meta.nextCursor && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 1.5, borderTop: `1px solid ${t.line}` }}>
            <Button
              size="small"
              variant="outlined"
              disabled={loadingOlder}
              onClick={() => void loadPage(kind, true, meta.nextCursor)}
              startIcon={loadingOlder ? <CircularProgress size={14} color="inherit" /> : undefined}
              sx={{ textTransform: 'none' }}
            >
              Load older records
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function SummaryValue({ t, label, value, detail, tone }: {
  t: Tk;
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <Box>
      <Typography sx={{ color: t.muted, fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase' }}>
        {label}
      </Typography>
      <Typography sx={{ color: tone || t.ink, fontSize: '1.18rem', fontWeight: 850, mt: 0.25 }}>
        {value}
      </Typography>
      <Typography sx={{
        color: t.inkSoft,
        fontSize: '0.69rem',
        mt: 0.25,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {detail}
      </Typography>
    </Box>
  );
}

function FilterSelect({ label, value, values, onChange }: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <FormControl size="small">
      <InputLabel>{label}</InputLabel>
      <Select value={value} label={label} onChange={(event) => onChange(String(event.target.value))}>
        <MenuItem value=""><em>Any</em></MenuItem>
        {values.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

function SeverityChip({ value, isDark }: { value: string | null; isDark: boolean }) {
  const normalized = value?.toLowerCase() || 'info';
  const color = /critical|error|high|alarm/.test(normalized)
    ? (isDark ? '#E47B70' : '#A94038')
    : /warn|medium/.test(normalized)
      ? (isDark ? '#E6A63A' : '#A66A0A')
      : (isDark ? '#77AECB' : '#356F91');
  return (
    <Chip
      size="small"
      label={value || 'info'}
      sx={{ height: 21, fontSize: '0.63rem', fontWeight: 800, color, bgcolor: `${color}16`, border: `1px solid ${color}45` }}
    />
  );
}

function ActionChip({ value, isDark }: { value: string | null; isDark: boolean }) {
  const blocked = /block|deny|drop|reject/i.test(value || '');
  const color = blocked
    ? (isDark ? '#E47B70' : '#A94038')
    : (isDark ? '#79BE8B' : '#357B4E');
  return (
    <Chip
      size="small"
      label={value || 'unknown'}
      sx={{ height: 21, fontSize: '0.63rem', fontWeight: 800, color, bgcolor: `${color}16`, border: `1px solid ${color}45` }}
    />
  );
}

const headCellSx = (t: Tk) => ({
  bgcolor: t.surface,
  color: t.muted,
  borderColor: t.line,
  fontSize: '0.65rem',
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
});

function ActivityTable({ rows, t, isDark }: { rows: ActivityRow[]; t: Tk; isDark: boolean }) {
  return (
    <TableContainer sx={{ maxHeight: 620 }}>
      <Table stickyHeader size="small" aria-label="UniFi activity log">
        <TableHead>
          <TableRow>
            {['Time', 'Severity', 'Event', 'Actor / target'].map((label) => (
              <TableCell key={label} sx={headCellSx(t)}>{label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} hover sx={{ '& td': { borderColor: t.line, verticalAlign: 'top' } }}>
              <TableCell sx={{ color: t.muted, fontSize: '0.68rem', whiteSpace: 'nowrap' }}>{fmtDate(row.event_ts)}</TableCell>
              <TableCell><SeverityChip value={row.severity} isDark={isDark} /></TableCell>
              <TableCell sx={{ minWidth: 320 }}>
                <Typography sx={{ color: t.ink, fontSize: '0.74rem', fontWeight: 750 }}>
                  {row.title || row.event_type || 'UniFi activity'}
                </Typography>
                <Typography sx={{ color: t.inkSoft, fontSize: '0.68rem', mt: 0.25, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                  {row.message || [row.category, row.subcategory].filter(Boolean).join(' · ') || 'No additional detail'}
                </Typography>
              </TableCell>
              <TableCell sx={{ color: t.inkSoft, fontSize: '0.7rem', minWidth: 180 }}>
                {[row.actor, row.target].filter(Boolean).join(' → ') || '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function FlowTable({ rows, t, isDark }: { rows: FlowRow[]; t: Tk; isDark: boolean }) {
  return (
    <TableContainer sx={{ maxHeight: 620 }}>
      <Table stickyHeader size="small" aria-label="UniFi traffic flows">
        <TableHead>
          <TableRow>
            {['Time', 'Decision', 'Source', 'Destination', 'Traffic / policy'].map((label) => (
              <TableCell key={label} sx={headCellSx(t)}>{label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} hover sx={{ '& td': { borderColor: t.line, verticalAlign: 'top' } }}>
              <TableCell sx={{ color: t.muted, fontSize: '0.68rem', whiteSpace: 'nowrap' }}>{fmtDate(row.flow_ts)}</TableCell>
              <TableCell>
                <ActionChip value={row.action} isDark={isDark} />
                <Typography sx={{ color: t.muted, fontSize: '0.62rem', mt: 0.45 }}>{[row.protocol, row.direction].filter(Boolean).join(' · ')}</Typography>
              </TableCell>
              <TableCell sx={{ minWidth: 190 }}>
                <Typography sx={{ color: t.ink, fontSize: '0.72rem', fontWeight: 700 }}>
                  {endpointLabel(row.source_name, row.source_ip, row.source_port)}
                </Typography>
                <Typography sx={{ color: t.muted, fontSize: '0.64rem' }}>{[row.source_network, row.source_zone].filter(Boolean).join(' · ') || '—'}</Typography>
              </TableCell>
              <TableCell sx={{ minWidth: 190 }}>
                <Typography sx={{ color: t.ink, fontSize: '0.72rem', fontWeight: 700 }}>
                  {endpointLabel(row.destination_name, row.destination_ip, row.destination_port)}
                </Typography>
                <Typography sx={{ color: t.muted, fontSize: '0.64rem' }}>{[row.destination_network, row.destination_zone].filter(Boolean).join(' · ') || '—'}</Typography>
              </TableCell>
              <TableCell sx={{ color: t.inkSoft, fontSize: '0.68rem', minWidth: 180 }}>
                <Typography sx={{ color: t.inkSoft, fontSize: '0.68rem' }}>
                  {fmtBytes(row.bytes_total ?? ((row.bytes_rx ?? 0) + (row.bytes_tx ?? 0)))}
                  {row.service ? ` · ${row.service}` : ''}
                </Typography>
                <Typography sx={{ color: t.muted, fontSize: '0.63rem', mt: 0.25, whiteSpace: 'normal' }}>
                  {row.policy_names.join(', ') || [row.ingress_name, row.egress_name].filter(Boolean).join(' → ') || 'No matched policy reported'}
                </Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ActivityCard({ row, t, isDark }: { row: ActivityRow; t: Tk; isDark: boolean }) {
  return (
    <Box sx={{ p: 1.25, '& + &': { borderTop: `1px solid ${t.line}` } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <SeverityChip value={row.severity} isDark={isDark} />
        <Typography sx={{ color: t.muted, fontSize: '0.64rem' }}>{fmtDate(row.event_ts)}</Typography>
      </Box>
      <Typography sx={{ color: t.ink, fontSize: '0.78rem', fontWeight: 750, mt: 0.8 }}>
        {row.title || row.event_type || 'UniFi activity'}
      </Typography>
      <Typography sx={{ color: t.inkSoft, fontSize: '0.69rem', mt: 0.3, overflowWrap: 'anywhere' }}>
        {row.message || 'No additional detail'}
      </Typography>
      {(row.actor || row.target) && (
        <Typography sx={{ color: t.muted, fontSize: '0.64rem', mt: 0.6 }}>
          {[row.actor, row.target].filter(Boolean).join(' → ')}
        </Typography>
      )}
    </Box>
  );
}

function FlowCard({ row, t, isDark }: { row: FlowRow; t: Tk; isDark: boolean }) {
  return (
    <Box sx={{ p: 1.25, '& + &': { borderTop: `1px solid ${t.line}` } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <ActionChip value={row.action} isDark={isDark} />
        <Typography sx={{ color: t.muted, fontSize: '0.64rem' }}>{fmtDate(row.flow_ts)}</Typography>
      </Box>
      <Typography sx={{ color: t.ink, fontSize: '0.75rem', fontWeight: 750, mt: 0.8, overflowWrap: 'anywhere' }}>
        {endpointLabel(row.source_name, row.source_ip, row.source_port)}
      </Typography>
      <Typography sx={{ color: t.muted, fontSize: '0.64rem', my: 0.25 }}>to</Typography>
      <Typography sx={{ color: t.ink, fontSize: '0.75rem', fontWeight: 750, overflowWrap: 'anywhere' }}>
        {endpointLabel(row.destination_name, row.destination_ip, row.destination_port)}
      </Typography>
      <Typography sx={{ color: t.inkSoft, fontSize: '0.65rem', mt: 0.7 }}>
        {[row.protocol, row.service, fmtBytes(row.bytes_total)].filter(Boolean).join(' · ')}
      </Typography>
      {row.policy_names.length > 0 && (
        <Typography sx={{ color: t.muted, fontSize: '0.63rem', mt: 0.25 }}>
          {row.policy_names.join(', ')}
        </Typography>
      )}
    </Box>
  );
}
