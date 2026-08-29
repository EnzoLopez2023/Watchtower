import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Skeleton,
  Typography,
} from '@mui/material'
import {
  ArrowForward as InspectIcon,
  Refresh as RetryIcon,
} from '@mui/icons-material'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  AgentName,
  AnalyticsResponse,
  Insight,
  LogLevel,
} from './types'
import type { ObservabilityTheme } from './theme'
import {
  agentLabel,
  formatCount,
  formatDelay,
  formatDelta,
  formatPercent,
  levelLabel,
} from './utils'

interface AnalyticsDashboardProps {
  c: ObservabilityTheme
  analytics: AnalyticsResponse | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onDrill: (filter: { agent?: AgentName; level?: LogLevel; query?: string }) => void
}

function PanelTitle({
  title,
  description,
  c,
}: {
  title: string
  description: string
  c: ObservabilityTheme
}) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography component="h2" sx={{ color: c.t.ink, fontSize: '0.92rem', fontWeight: 800 }}>
        {title}
      </Typography>
      <Typography sx={{ color: c.t.muted, fontSize: '0.72rem', mt: 0.25 }}>
        {description}
      </Typography>
    </Box>
  )
}

function ChartEmpty({ c }: { c: ObservabilityTheme }) {
  return (
    <Box sx={{ height: 240, display: 'grid', placeItems: 'center' }}>
      <Typography sx={{ color: c.t.muted, fontSize: '0.8rem' }}>
        No entries in this window
      </Typography>
    </Box>
  )
}

function LoadingAnalytics({ c }: { c: ObservabilityTheme }) {
  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ ...c.panel, p: 2 }}>
        <Skeleton height={78} sx={{ bgcolor: `${c.t.muted}18` }} />
      </Box>
      <Box sx={{ ...c.panel, p: 2 }}>
        <Skeleton height={310} sx={{ bgcolor: `${c.t.muted}18` }} />
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1.5 }}>
        <Box sx={{ ...c.panel, p: 2 }}><Skeleton height={260} sx={{ bgcolor: `${c.t.muted}18` }} /></Box>
        <Box sx={{ ...c.panel, p: 2 }}><Skeleton height={260} sx={{ bgcolor: `${c.t.muted}18` }} /></Box>
      </Box>
    </Box>
  )
}

function InsightRow({
  insight,
  c,
  onDrill,
}: {
  insight: Insight
  c: ObservabilityTheme
  onDrill: AnalyticsDashboardProps['onDrill']
}) {
  const tone = c.insight[insight.tone]
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '10px minmax(0, 1fr) auto',
        gap: 1.25,
        alignItems: 'start',
        py: 1.35,
        borderBottom: `1px solid ${c.t.line}`,
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: tone,
          mt: 0.65,
          boxShadow: c.dark ? `0 0 8px ${tone}66` : 'none',
        }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ color: c.t.ink, fontSize: '0.81rem', fontWeight: 750, lineHeight: 1.4 }}>
          {insight.title}
        </Typography>
        <Typography sx={{ color: c.t.muted, fontSize: '0.72rem', lineHeight: 1.5, mt: 0.25 }}>
          {insight.detail}
        </Typography>
      </Box>
      {insight.filter && (
        <Button
          size="small"
          endIcon={<InspectIcon sx={{ fontSize: 15 }} />}
          onClick={() => onDrill(insight.filter!)}
          sx={{ color: tone, textTransform: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}
        >
          Inspect
        </Button>
      )}
    </Box>
  )
}

export default function AnalyticsDashboard({
  c,
  analytics,
  loading,
  error,
  onRetry,
  onDrill,
}: AnalyticsDashboardProps) {
  if (error && !analytics) {
    return (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" onClick={onRetry} startIcon={<RetryIcon />}>
            Retry
          </Button>
        )}
      >
        Could not load analytics: {error}
      </Alert>
    )
  }
  if (!analytics) return <LoadingAnalytics c={c} />

  const { summary } = analytics
  const metricRows = [
    {
      label: 'Entries',
      value: formatCount(summary.total),
      detail: formatDelta(summary.volumeChange),
      tone: c.accent,
    },
    {
      label: 'Error entries',
      value: formatCount(summary.errors),
      detail: summary.previous
        ? `${formatCount(summary.previous.errors)} in the prior window`
        : 'Prior window outside retention',
      tone: c.level.error,
    },
    {
      label: 'Error share',
      value: formatPercent(summary.errorRate),
      detail: formatDelta(summary.errorRateChange, 'points'),
      tone: c.level.error,
    },
    {
      label: 'Ingestion delay',
      value: formatDelay(summary.avgLatencyMs),
      detail: `P95 ${formatDelay(summary.p95LatencyMs)}`,
      tone: c.level.info,
    },
  ]
  const totalLevels = analytics.levels.reduce((sum, row) => sum + row.count, 0)
  const hasVolume = analytics.volume.some((point) => point.total > 0)
  const chartTick = { fill: c.t.muted, fontSize: 11 }
  const tooltipStyle = {
    backgroundColor: c.t.paper,
    border: `1px solid ${c.t.line}`,
    borderRadius: 10,
    color: c.t.ink,
    boxShadow: c.dark ? '0 10px 24px rgba(0,0,0,0.35)' : '0 10px 24px rgba(32,38,44,0.14)',
  }

  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      {loading && <LinearProgress sx={{ height: 2, bgcolor: c.t.surface }} />}
      {error && (
        <Alert severity="warning">
          Analytics refresh failed; showing the last successful result. {error}
        </Alert>
      )}

      <Box
        sx={{
          ...c.panel,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, 1fr)' },
          overflow: 'hidden',
        }}
      >
        {metricRows.map((metric, index) => (
          <Box
            key={metric.label}
            sx={{
              minWidth: 0,
              px: { xs: 1.35, md: 1.75 },
              py: 1.6,
              borderLeft: {
                xs: index % 2 === 1 ? `1px solid ${c.t.line}` : 0,
                lg: index > 0 ? `1px solid ${c.t.line}` : 0,
              },
              borderTop: {
                xs: index > 1 ? `1px solid ${c.t.line}` : 0,
                lg: 0,
              },
            }}
          >
            <Typography
              sx={{
                color: c.t.muted,
                fontSize: '0.66rem',
                fontWeight: 800,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
              }}
            >
              {metric.label}
            </Typography>
            <Typography
              sx={{
                color: metric.tone,
                fontFamily: 'var(--hearth-heading)',
                fontSize: { xs: '1.35rem', md: '1.6rem' },
                fontWeight: 800,
                lineHeight: 1.15,
                mt: 0.65,
              }}
            >
              {metric.value}
            </Typography>
            <Typography sx={{ color: c.t.muted, fontSize: '0.68rem', mt: 0.5 }}>
              {metric.detail}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ ...c.panel, p: { xs: 1.4, md: 2 } }}>
        <PanelTitle
          title="Volume over time"
          description="All matching entries, stacked by log level across the selected event-time window."
          c={c}
        />
        {!hasVolume ? <ChartEmpty c={c} /> : (
          <Box sx={{ width: '100%', height: { xs: 270, md: 320 } }}>
            <ResponsiveContainer>
              <AreaChart data={analytics.volume} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke={c.grid} vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tick={chartTick}
                  tickFormatter={(value) => new Date(Number(value)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  stroke={c.t.line}
                  minTickGap={32}
                />
                <YAxis tick={chartTick} stroke={c.t.line} allowDecimals={false} />
                <ChartTooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                />
                <Legend wrapperStyle={{ color: c.t.muted, fontSize: 12, paddingTop: 10 }} />
                {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
                  <Area
                    key={level}
                    type="monotone"
                    dataKey={level}
                    name={levelLabel(level)}
                    stackId="volume"
                    stroke={c.level[level]}
                    fill={c.level[level]}
                    fillOpacity={level === 'debug' ? 0.2 : 0.34}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.9fr 1.1fr' }, gap: 1.5 }}>
        <Box sx={{ ...c.panel, p: { xs: 1.4, md: 2 } }}>
          <PanelTitle
            title="Level breakdown"
            description="Share of the selected result set. Color is reinforced by labels and counts."
            c={c}
          />
          {totalLevels === 0 ? <ChartEmpty c={c} /> : (
            <>
              <Box
                aria-label="Level distribution"
                sx={{
                  height: 22,
                  display: 'flex',
                  overflow: 'hidden',
                  borderRadius: '7px',
                  bgcolor: c.t.bg,
                  mb: 2,
                }}
              >
                {analytics.levels.map((row) => row.count > 0 && (
                  <Box
                    key={row.level}
                    title={`${levelLabel(row.level)}: ${row.count}`}
                    sx={{
                      width: `${(row.count / totalLevels) * 100}%`,
                      bgcolor: c.level[row.level],
                      minWidth: row.count ? 3 : 0,
                    }}
                  />
                ))}
              </Box>
              {analytics.levels.map((row) => (
                <Box
                  key={row.level}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '10px 1fr auto auto',
                    gap: 1,
                    alignItems: 'center',
                    py: 0.8,
                    borderBottom: `1px solid ${c.t.line}`,
                    '&:last-of-type': { borderBottom: 0 },
                  }}
                >
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c.level[row.level] }} />
                  <Typography sx={{ color: c.t.inkSoft, fontSize: '0.78rem', fontWeight: 700 }}>
                    {levelLabel(row.level)}
                  </Typography>
                  <Typography sx={{ color: c.t.muted, fontSize: '0.72rem' }}>
                    {formatPercent(totalLevels ? row.count / totalLevels : 0)}
                  </Typography>
                  <Typography
                    sx={{
                      color: c.t.ink,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.74rem',
                      minWidth: 44,
                      textAlign: 'right',
                    }}
                  >
                    {row.count.toLocaleString()}
                  </Typography>
                </Box>
              ))}
            </>
          )}
        </Box>

        <Box sx={{ ...c.panel, p: { xs: 1.4, md: 2 } }}>
          <PanelTitle
            title="Top sources"
            description="Entry volume by agent. Use a source below the chart to carry it into Explore."
            c={c}
          />
          {analytics.sources.length === 0 ? <ChartEmpty c={c} /> : (
            <>
              <Box sx={{ width: '100%', height: 230 }}>
                <ResponsiveContainer>
                  <BarChart
                    data={analytics.sources}
                    layout="vertical"
                    margin={{ top: 0, right: 12, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid stroke={c.grid} horizontal={false} />
                    <XAxis type="number" tick={chartTick} stroke={c.t.line} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="agent"
                      width={82}
                      tick={chartTick}
                      tickFormatter={(value) => value === 'shutdown' ? 'Shutdown' : agentLabel(value as AgentName)}
                      stroke={c.t.line}
                    />
                    <ChartTooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => [Number(value).toLocaleString(), 'Entries']}
                      labelFormatter={(value) => agentLabel(value as AgentName)}
                    />
                    <Bar dataKey="total" name="Entries" fill={c.accent} radius={[0, 5, 5, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.6, mt: 1 }}>
                {analytics.sources.map((source) => (
                  <Button
                    key={source.agent}
                    size="small"
                    onClick={() => onDrill({ agent: source.agent })}
                    endIcon={<InspectIcon sx={{ fontSize: 14 }} />}
                    sx={{ color: c.source[source.agent], textTransform: 'none', fontWeight: 700 }}
                  >
                    {agentLabel(source.agent)}
                  </Button>
                ))}
              </Box>
            </>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.15fr 0.85fr' }, gap: 1.5 }}>
        <Box sx={{ ...c.panel, p: { xs: 1.4, md: 2 } }}>
          <PanelTitle
            title="Ingestion latency"
            description="Event-to-receipt delay. Future source clocks are excluded and reported separately."
            c={c}
          />
          {analytics.latency.every((point) => point.count === 0) ? <ChartEmpty c={c} /> : (
            <Box sx={{ width: '100%', height: 285 }}>
              <ResponsiveContainer>
                <LineChart data={analytics.latency} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={c.grid} vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tick={chartTick}
                    tickFormatter={(value) => new Date(Number(value)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    stroke={c.t.line}
                    minTickGap={32}
                  />
                  <YAxis
                    tick={chartTick}
                    tickFormatter={(value) => formatDelay(Number(value))}
                    stroke={c.t.line}
                    width={62}
                  />
                  <ChartTooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
                    formatter={(value, name) => [formatDelay(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ color: c.t.muted, fontSize: 12, paddingTop: 10 }} />
                  <Line
                    type="monotone"
                    dataKey="avgLatencyMs"
                    name="Average"
                    stroke={c.level.info}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="p95LatencyMs"
                    name="P95"
                    stroke={c.level.warn}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </Box>
          )}
        </Box>

        <Box sx={{ ...c.panel, p: { xs: 1.4, md: 2 } }}>
          <PanelTitle
            title="Observed patterns"
            description="Deterministic comparisons and repeated evidence, not generated health verdicts."
            c={c}
          />
          {analytics.insights.length === 0 ? (
            <Box sx={{ py: 5, textAlign: 'center' }}>
              <Typography sx={{ color: c.t.ink, fontWeight: 750 }}>
                No standout pattern in this window
              </Typography>
              <Typography sx={{ color: c.t.muted, fontSize: '0.76rem', mt: 0.5 }}>
                The console will not manufacture an insight when the evidence is ordinary.
              </Typography>
            </Box>
          ) : analytics.insights.map((insight) => (
            <InsightRow key={insight.id} insight={insight} c={c} onDrill={onDrill} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
