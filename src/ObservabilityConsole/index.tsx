/*
THESIS: Time is the shared lens between anomaly and evidence; this is not a nested observability product shell.
OWN-WORLD: Watchtower signal tokens, opaque instrument surfaces, measured rules, and semantic colors that hold in light and dark.
STORY: Scope a window and sources, inspect exact entries, then compare the same corpus in Analytics without losing context.
FIRST VIEWPORT: Compact identity and live controls lead into one wide activity lens, followed by Explore or Analytics in the shared page column.
FORM: A time-lens workbench with a persistent measured strip, evidence workspace, and responsive sidecar detail panel.
*/

import { apiFetch } from '../services/apiClient';
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import {
  PauseCircleOutline as PauseIcon,
  PlayCircleOutline as LiveIcon,
  Refresh as RefreshIcon,
  Router as NetworkIcon,
} from '@mui/icons-material'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import { pageShellSx } from '../theme/controls'
import { getAnalytics, getLogs } from './api'
import AnalyticsDashboard from './AnalyticsDashboard'
import ExplorerToolbar from './ExplorerToolbar'
import LogDetailPanel from './LogDetailPanel'
import LogResults from './LogResults'
import TimeLens from './TimeLens'
import { useObservabilityTheme } from './theme'
import type {
  AgentName,
  AnalyticsResponse,
  AuthedFetch,
  ConsoleMode,
  ExplorerFilters,
  LogEntry,
  LogLevel,
  LogResponse,
  LogView,
  SortOrder,
  TimeRange,
} from './types'
import { formatTimestamp, presetRange } from './utils'
import { NAV_TELEMETRY_DEEP_LINK, pathForView } from '../app/navigation'

const POLL_MS = 15_000

export default function ObservabilityConsole() {
  const c = useObservabilityTheme()
  const mobileDetail = useMediaQuery('(max-width:899.95px)')
  const navigate = useNavigate()

  const [consoleMode, setConsoleMode] = useState<ConsoleMode>('explore')
  const [range, setRange] = useState<TimeRange>(() => presetRange('24h'))
  const [filters, setFilters] = useState<ExplorerFilters>({
    agents: [],
    levels: [],
    query: '',
    order: 'newest',
  })
  const [queryDraft, setQueryDraft] = useState('')
  const [view, setView] = useState<LogView>('table')
  const [live, setLive] = useState(true)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const [logs, setLogs] = useState<LogResponse | null>(null)
  const [logsQueryKey, setLogsQueryKey] = useState<string | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null)
  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsLoadingMore, setLogsLoadingMore] = useState(false)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [analyticsError, setAnalyticsError] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)

  const logSequence = useRef(0)
  const analyticsSequence = useRef(0)
  const activeLogsQueryKey = JSON.stringify({
    range: [range.from, range.to],
    agents: filters.agents,
    levels: filters.levels,
    query: filters.query,
    order: filters.order,
  })

  // The bearer token is attached centrally by services/apiClient; this wrapper
  // only preserves the console's own handling of an authorization failure so a
  // rejected request still surfaces the server message rather than an empty page.
  const authedFetch = useCallback<AuthedFetch>(async (url, init) => {
    const response = await apiFetch(url, init)
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
      throw new Error(body.error ?? body.message ?? 'Observability access required.')
    }
    return response
  }, [])

  const loadLogs = useCallback(async () => {
    const sequence = ++logSequence.current
    setLogsLoadingMore(false)
    setLogsLoading(true)
    try {
      const response = await getLogs(authedFetch, range, filters, null)
      if (sequence !== logSequence.current) return
      setLogs(response)
      setLogsQueryKey(activeLogsQueryKey)
      setLogsError(null)
      setLastUpdatedAt(Date.now())
    } catch (error) {
      if (sequence !== logSequence.current) return
      setLogsError(error instanceof Error ? error.message : 'Could not load log entries.')
    } finally {
      if (sequence === logSequence.current) setLogsLoading(false)
    }
  }, [activeLogsQueryKey, authedFetch, filters, range])

  const loadAnalytics = useCallback(async () => {
    const sequence = ++analyticsSequence.current
    setAnalyticsLoading(true)
    try {
      const response = await getAnalytics(authedFetch, range, filters)
      if (sequence !== analyticsSequence.current) return
      setAnalytics(response)
      setAnalyticsError(null)
      setLastUpdatedAt(Date.now())
    } catch (error) {
      if (sequence !== analyticsSequence.current) return
      setAnalyticsError(error instanceof Error ? error.message : 'Could not load analytics.')
    } finally {
      if (sequence === analyticsSequence.current) setAnalyticsLoading(false)
    }
  }, [authedFetch, filters, range])

  useEffect(() => {
    void loadAnalytics()
  }, [loadAnalytics, refreshNonce])

  useEffect(() => {
    if (consoleMode === 'explore') void loadLogs()
  }, [consoleMode, loadLogs, refreshNonce])

  const refresh = useCallback(() => {
    if (range.preset === 'custom') {
      setRefreshNonce((value) => value + 1)
      return
    }
    setRange(presetRange(range.preset))
  }, [range.preset])

  useEffect(() => {
    if (!live) return
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    return () => window.clearInterval(interval)
  }, [live, refresh])

  const loadMore = useCallback(async () => {
    if (
      !logs?.nextCursor
      || logsLoading
      || logsLoadingMore
      || logsQueryKey !== activeLogsQueryKey
    ) return
    const sequence = ++logSequence.current
    setLogsLoadingMore(true)
    try {
      const response = await getLogs(authedFetch, range, filters, logs.nextCursor)
      if (sequence !== logSequence.current) return
      setLogs((current) => {
        if (!current) return response
        const existing = new Set(current.lines.map((entry) => entry.id))
        return {
          ...response,
          lines: [...current.lines, ...response.lines.filter((entry) => !existing.has(entry.id))],
        }
      })
      setLogsError(null)
      setLastUpdatedAt(Date.now())
    } catch (error) {
      if (sequence !== logSequence.current) return
      setLogsError(error instanceof Error ? error.message : 'Could not load more entries.')
    } finally {
      if (sequence === logSequence.current) setLogsLoadingMore(false)
    }
  }, [
    activeLogsQueryKey,
    authedFetch,
    filters,
    logs,
    logsLoading,
    logsLoadingMore,
    logsQueryKey,
    range,
  ])

  const changeRange = (next: TimeRange) => {
    setSelected(null)
    setRange(next)
  }

  const changeAgents = (agents: AgentName[]) => {
    setSelected(null)
    setFilters((current) => ({ ...current, agents }))
  }

  const changeLevels = (levels: LogLevel[]) => {
    setSelected(null)
    setFilters((current) => ({ ...current, levels }))
  }

  const changeOrder = (order: SortOrder) => {
    setSelected(null)
    setFilters((current) => ({ ...current, order }))
  }

  const applyQuery = () => {
    setSelected(null)
    const query = queryDraft.trim()
    if (query === filters.query) {
      setRefreshNonce((value) => value + 1)
      return
    }
    setFilters((current) => ({ ...current, query }))
  }

  const resetFilters = () => {
    setSelected(null)
    setQueryDraft('')
    setFilters({ agents: [], levels: [], query: '', order: 'newest' })
  }

  const drillIntoExplore = (filter: {
    agent?: AgentName
    level?: LogLevel
    query?: string
  }) => {
    setSelected(null)
    setConsoleMode('explore')
    if (filter.query != null) setQueryDraft(filter.query)
    setFilters((current) => ({
      ...current,
      agents: filter.agent ? [filter.agent] : current.agents,
      levels: filter.level ? [filter.level] : current.levels,
      query: filter.query ?? current.query,
      order: 'newest',
    }))
  }

  const entries = logs?.lines ?? []
  const selectedId = selected?.id ?? null
  const openNetworkTelemetry = () => {
    // The deep link the UniFi page reads on mount, so arriving from here lands
    // on Telemetry rather than the default tab.
    sessionStorage.setItem(NAV_TELEMETRY_DEEP_LINK, 'telemetry')
    void navigate(pathForView('unifi-network'))
  }

  return (
    <Box sx={pageShellSx(true)}>
      <PageHero
        compact
        eyebrow="Infrastructure"
        title="Observability Console"
        accentPhrase="Observability"
        subtitle="Follow five on-site agents from signal to evidence, with one shared time lens across raw logs and analytics."
        actions={(
          <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
            <Button
              size="small"
              variant="outlined"
              onClick={openNetworkTelemetry}
              startIcon={<NetworkIcon />}
              sx={{
                color: c.accent,
                borderColor: `${c.accent}88`,
                textTransform: 'none',
                fontWeight: 750,
                bgcolor: c.t.paper,
              }}
            >
              Network telemetry
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setLive((value) => !value)}
              startIcon={live ? <LiveIcon /> : <PauseIcon />}
              aria-pressed={live}
              sx={{
                color: live ? c.level.info : c.t.inkSoft,
                borderColor: live ? `${c.level.info}88` : c.t.line,
                textTransform: 'none',
                fontWeight: 750,
                bgcolor: live ? `${c.level.info}12` : c.t.paper,
              }}
            >
              {live ? 'Live · 15s' : 'Paused'}
            </Button>
            <Tooltip title="Refresh now">
              <IconButton
                size="small"
                onClick={refresh}
                aria-label="Refresh observability data"
                sx={{ color: c.t.inkSoft, border: `1px solid ${c.t.line}`, bgcolor: c.t.paper }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      />

      <Box sx={{ display: 'grid', gap: 1.5 }}>
        <TimeLens
          c={c}
          mode={consoleMode}
          onModeChange={setConsoleMode}
          range={range}
          onRangeChange={changeRange}
          agents={filters.agents}
          onAgentsChange={changeAgents}
          analytics={analytics}
          loading={analyticsLoading}
        />

        {lastUpdatedAt && (
          <Typography
            aria-live="polite"
            sx={{ color: c.t.muted, fontSize: '0.68rem', textAlign: 'right', mt: -0.75 }}
          >
            Last successful refresh {formatTimestamp(lastUpdatedAt)}
          </Typography>
        )}

        {consoleMode === 'explore' ? (
          <>
            <ExplorerToolbar
              c={c}
              filters={filters}
              queryDraft={queryDraft}
              onQueryDraftChange={setQueryDraft}
              onApplyQuery={applyQuery}
              onLevelsChange={changeLevels}
              onOrderChange={changeOrder}
              view={view}
              onViewChange={setView}
              onReset={resetFilters}
              matchingTotal={logs?.matchingTotal ?? null}
              loading={logsLoading}
            />

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: !mobileDetail && selected ? 'minmax(0, 1fr) minmax(340px, 390px)' : 'minmax(0, 1fr)',
                gap: 1.5,
                alignItems: 'start',
              }}
            >
              <LogResults
                c={c}
                response={logs}
                loading={logsLoading}
                loadingMore={logsLoadingMore}
                error={logsError}
                view={view}
                selectedId={selectedId}
                onSelect={setSelected}
                onLoadMore={() => void loadMore()}
                onRetry={() => void loadLogs()}
              />
              {!mobileDetail && (
                <LogDetailPanel
                  c={c}
                  entry={selected}
                  entries={entries}
                  mobile={false}
                  onClose={() => setSelected(null)}
                  onSelect={setSelected}
                  onFilter={drillIntoExplore}
                />
              )}
            </Box>

            {mobileDetail && (
              <LogDetailPanel
                c={c}
                entry={selected}
                entries={entries}
                mobile
                onClose={() => setSelected(null)}
                onSelect={setSelected}
                onFilter={drillIntoExplore}
              />
            )}
          </>
        ) : (
          <AnalyticsDashboard
            c={c}
            analytics={analytics}
            loading={analyticsLoading}
            error={analyticsError}
            onRetry={() => void loadAnalytics()}
            onDrill={drillIntoExplore}
          />
        )}

        <Box
          sx={{
            display: 'flex',
            alignItems: { xs: 'flex-start', sm: 'center' },
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 0.5,
            color: c.t.muted,
            px: 0.5,
          }}
        >
          <Typography sx={{ fontSize: '0.7rem' }}>
            Agent logs are retained for {analytics?.retention.maxAgeDays ?? logs?.retention.maxAgeDays ?? 30} days.
          </Typography>
          <Typography sx={{ fontSize: '0.7rem', display: { xs: 'none', sm: 'block' } }}>·</Typography>
          <Typography sx={{ fontSize: '0.7rem' }}>
            Error share counts error-level lines; ingestion delay is event time to Watchtower receipt.
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}
