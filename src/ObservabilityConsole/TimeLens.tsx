import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  AnalyticsOutlined as AnalyticsIcon,
  DataObjectOutlined as ExploreIcon,
  Tune as TuneIcon,
} from '@mui/icons-material'
import type {
  AgentName,
  AnalyticsResponse,
  ConsoleMode,
  TimePreset,
  TimeRange,
  VolumePoint,
} from './types'
import type { ObservabilityTheme } from './theme'
import {
  AGENTS,
  fromLocalInput,
  presetRange,
  rangeLabel,
  toLocalInput,
} from './utils'

const PRESETS: Exclude<TimePreset, 'custom'>[] = ['1h', '6h', '24h', '7d', '30d']

interface TimeLensProps {
  c: ObservabilityTheme
  mode: ConsoleMode
  onModeChange: (mode: ConsoleMode) => void
  range: TimeRange
  onRangeChange: (range: TimeRange) => void
  agents: AgentName[]
  onAgentsChange: (agents: AgentName[]) => void
  analytics: AnalyticsResponse | null
  loading: boolean
}

function compactVolume(points: VolumePoint[], maxPoints = 64) {
  if (points.length <= maxPoints) return points
  const stride = Math.ceil(points.length / maxPoints)
  const output: VolumePoint[] = []
  for (let index = 0; index < points.length; index += stride) {
    const slice = points.slice(index, index + stride)
    const head = slice[0]
    if (!head) continue
    output.push(slice.reduce<VolumePoint>((acc, point) => ({
      ts: acc.ts,
      debug: acc.debug + point.debug,
      info: acc.info + point.info,
      warn: acc.warn + point.warn,
      error: acc.error + point.error,
      total: acc.total + point.total,
    }), { ts: head.ts, debug: 0, info: 0, warn: 0, error: 0, total: 0 }))
  }
  return output
}

export default function TimeLens({
  c,
  mode,
  onModeChange,
  range,
  onRangeChange,
  agents,
  onAgentsChange,
  analytics,
  loading,
}: TimeLensProps) {
  const [customOpen, setCustomOpen] = useState(range.preset === 'custom')
  const [fromInput, setFromInput] = useState(toLocalInput(range.from))
  const [toInput, setToInput] = useState(toLocalInput(range.to))

  useEffect(() => {
    setFromInput(toLocalInput(range.from))
    setToInput(toLocalInput(range.to))
  }, [range.from, range.to])

  const volume = useMemo(
    () => compactVolume(analytics?.volume ?? []),
    [analytics?.volume],
  )
  const maxVolume = Math.max(1, ...volume.map((point) => point.total))
  const sourceCounts = new Map(
    (analytics?.sources ?? []).map((source) => [source.agent, source.total]),
  )
  const customFrom = fromLocalInput(fromInput)
  const customTo = fromLocalInput(toInput, true)
  const customError = customFrom == null || customTo == null
    ? 'Enter both dates.'
    : customFrom > customTo
      ? 'Start must be earlier than end.'
      : null

  const toggleAgent = (agent: AgentName) => {
    if (agents.includes(agent)) {
      onAgentsChange(agents.filter((item) => item !== agent))
    } else {
      onAgentsChange([...agents, agent])
    }
  }

  const applyCustom = () => {
    if (customError || customFrom == null || customTo == null) return
    onRangeChange({ from: customFrom, to: customTo, preset: 'custom' })
  }

  return (
    <Box sx={{ ...c.panel, overflow: 'hidden' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'stretch', md: 'center' },
          flexDirection: { xs: 'column', md: 'row' },
          gap: 1.25,
          px: { xs: 1.25, md: 1.75 },
          py: 1.25,
        }}
      >
        <ToggleButtonGroup
          exclusive
          size="small"
          value={mode}
          onChange={(_event, value: ConsoleMode | null) => value && onModeChange(value)}
          aria-label="Observability mode"
          sx={{
            bgcolor: c.t.bg,
            border: `1px solid ${c.t.line}`,
            borderRadius: '9px',
            p: 0.35,
            '& .MuiToggleButton-root': {
              gap: 0.75,
              border: 0,
              borderRadius: '7px !important',
              color: c.t.inkSoft,
              px: 1.4,
              py: 0.55,
              textTransform: 'none',
              fontWeight: 700,
            },
            '& .Mui-selected': {
              color: `${c.t.ink} !important`,
              bgcolor: `${c.selection} !important`,
            },
          }}
        >
          <ToggleButton value="explore">
            <ExploreIcon sx={{ fontSize: 17 }} />
            Explore
          </ToggleButton>
          <ToggleButton value="analytics">
            <AnalyticsIcon sx={{ fontSize: 17 }} />
            Analytics
          </ToggleButton>
        </ToggleButtonGroup>

        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' }, borderColor: c.t.line }} />

        <Box
          role="group"
          aria-label="Time range"
          sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}
        >
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              size="small"
              variant={range.preset === preset ? 'contained' : 'text'}
              onClick={() => {
                setCustomOpen(false)
                onRangeChange(presetRange(preset))
              }}
              sx={{
                minWidth: 44,
                px: 1,
                color: range.preset === preset ? c.t.bg : c.t.inkSoft,
                bgcolor: range.preset === preset ? c.accent : 'transparent',
                textTransform: 'none',
                fontWeight: 700,
                '&:hover': {
                  bgcolor: range.preset === preset ? c.accent : c.hover,
                },
              }}
            >
              {preset}
            </Button>
          ))}
          <Button
            size="small"
            variant={range.preset === 'custom' ? 'contained' : 'text'}
            startIcon={<TuneIcon sx={{ fontSize: 15 }} />}
            onClick={() => setCustomOpen((open) => !open)}
            sx={{
              color: range.preset === 'custom' ? c.t.bg : c.t.inkSoft,
              bgcolor: range.preset === 'custom' ? c.accent : 'transparent',
              textTransform: 'none',
              fontWeight: 700,
              '&:hover': {
                bgcolor: range.preset === 'custom' ? c.accent : c.hover,
              },
            }}
          >
            Custom
          </Button>
        </Box>

        <Box sx={{ flex: 1 }} />
        <Typography sx={{ color: c.t.muted, fontSize: '0.74rem', whiteSpace: 'nowrap' }}>
          {rangeLabel(range)}
        </Typography>
      </Box>

      <Collapse in={customOpen}>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            alignItems: 'center',
            px: { xs: 1.25, md: 1.75 },
            py: 1.25,
            borderTop: `1px solid ${c.t.line}`,
            bgcolor: c.t.surface,
          }}
        >
          <TextField
            size="small"
            type="datetime-local"
            label="From"
            value={fromInput}
            onChange={(event) => setFromInput(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 220 }}
          />
          <TextField
            size="small"
            type="datetime-local"
            label="Through"
            value={toInput}
            onChange={(event) => setToInput(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ minWidth: 220 }}
          />
          <Button
            variant="contained"
            size="small"
            disabled={Boolean(customError)}
            onClick={applyCustom}
            sx={{ minHeight: 40, textTransform: 'none', fontWeight: 700 }}
          >
            Apply range
          </Button>
          {customError && (
            <Typography role="alert" sx={{ color: c.level.error, fontSize: '0.75rem' }}>
              {customError}
            </Typography>
          )}
        </Box>
      </Collapse>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) auto' },
          gap: 1.5,
          px: { xs: 1.25, md: 1.75 },
          pt: 1.35,
          pb: 1.25,
          borderTop: `1px solid ${c.t.line}`,
          bgcolor: c.t.surface,
        }}
      >
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.75 }}>
            <Typography sx={{ color: c.t.ink, fontSize: '0.78rem', fontWeight: 800 }}>
              Activity across the selected window
            </Typography>
            <Typography sx={{ color: c.t.muted, fontSize: '0.68rem' }}>
              stacked by level
            </Typography>
          </Box>
          <Box
            aria-label={loading ? 'Loading activity volume' : 'Log volume across the selected time range'}
            sx={{
              height: 62,
              display: 'flex',
              alignItems: 'flex-end',
              gap: volume.length > 48 ? '2px' : '4px',
              px: 0.25,
              borderBottom: `1px solid ${c.grid}`,
              position: 'relative',
              opacity: loading ? 0.45 : 1,
              transition: 'opacity 160ms ease',
            }}
          >
            {volume.length === 0 ? (
              <Typography sx={{ color: c.t.muted, fontSize: '0.74rem', alignSelf: 'center', mx: 'auto' }}>
                No activity in this window
              </Typography>
            ) : volume.map((point) => (
              <Tooltip
                key={point.ts}
                arrow
                title={`${new Date(point.ts).toLocaleString()} · ${point.total.toLocaleString()} entries`}
              >
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 2,
                    height: `${Math.max(5, (point.total / maxVolume) * 100)}%`,
                    display: 'flex',
                    flexDirection: 'column-reverse',
                    overflow: 'hidden',
                    borderRadius: '3px 3px 0 0',
                    outline: 'none',
                  }}
                >
                  {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
                    point[level] > 0 && (
                      <Box
                        key={level}
                        sx={{
                          flex: point[level],
                          minHeight: 1,
                          bgcolor: c.level[level],
                          opacity: level === 'debug' ? 0.68 : 0.9,
                        }}
                      />
                    )
                  ))}
                </Box>
              </Tooltip>
            ))}
          </Box>
        </Box>

        <Box sx={{ minWidth: { lg: 420 } }}>
          <Typography sx={{ color: c.t.ink, fontSize: '0.78rem', fontWeight: 800, mb: 0.75 }}>
            Source scope
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.65 }}>
            <Chip
              label="All sources"
              onClick={() => onAgentsChange([])}
              variant={agents.length === 0 ? 'filled' : 'outlined'}
              aria-pressed={agents.length === 0}
              sx={{
                color: agents.length === 0 ? c.t.ink : c.t.muted,
                bgcolor: agents.length === 0 ? c.selection : 'transparent',
                borderColor: c.t.line,
                fontWeight: agents.length === 0 ? 700 : 500,
                '&:hover': { bgcolor: c.hover },
              }}
            />
            {AGENTS.map((agent) => {
              const selected = agents.includes(agent.id)
              return (
                <Chip
                  key={agent.id}
                  label={`${agent.short} · ${(sourceCounts.get(agent.id) ?? 0).toLocaleString()}`}
                  onClick={() => toggleAgent(agent.id)}
                  variant={selected ? 'filled' : 'outlined'}
                  aria-pressed={selected}
                  sx={{
                    color: selected ? c.t.ink : c.t.muted,
                    bgcolor: selected ? `${c.source[agent.id]}18` : 'transparent',
                    borderColor: `${c.source[agent.id]}66`,
                    fontWeight: selected ? 700 : 500,
                    '&:hover': { bgcolor: `${c.source[agent.id]}25` },
                  }}
                />
              )
            })}
          </Box>
          <Typography sx={{ color: c.t.muted, fontSize: '0.66rem', mt: 0.75 }}>
            Select one or more agents, or restore the full five-source corpus.
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}
