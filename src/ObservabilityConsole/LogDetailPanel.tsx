import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Drawer,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  ChevronLeft as PreviousIcon,
  ChevronRight as NextIcon,
  Close as CloseIcon,
  ContentCopy as CopyIcon,
  FilterAltOutlined as FilterIcon,
} from '@mui/icons-material'
import type { AgentName, LogEntry, LogLevel } from './types'
import type { ObservabilityTheme } from './theme'
import {
  agentLabel,
  formatDelay,
  formatFullTimestamp,
  levelLabel,
} from './utils'
import LevelBadge from './LevelBadge'

interface LogDetailPanelProps {
  c: ObservabilityTheme
  entry: LogEntry | null
  entries: LogEntry[]
  mobile: boolean
  onClose: () => void
  onSelect: (entry: LogEntry) => void
  onFilter: (filter: { agent?: AgentName; level?: LogLevel; query?: string }) => void
}

function FactRow({
  label,
  value,
  c,
  mono = false,
  color,
}: {
  label: string
  value: string
  c: ObservabilityTheme
  mono?: boolean
  color?: string
}) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '112px minmax(0, 1fr)',
        gap: 1.5,
        py: 1.1,
        borderBottom: `1px solid ${c.t.line}`,
      }}
    >
      <Typography
        sx={{
          color: c.t.muted,
          fontSize: '0.67rem',
          fontWeight: 800,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Typography>
      <Typography
        sx={{
          color: color ?? c.t.ink,
          fontSize: '0.78rem',
          fontWeight: 650,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          textAlign: 'right',
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </Typography>
    </Box>
  )
}

export default function LogDetailPanel({
  c,
  entry,
  entries,
  mobile,
  onClose,
  onSelect,
  onFilter,
}: LogDetailPanelProps) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const index = useMemo(
    () => entry ? entries.findIndex((candidate) => candidate.id === entry.id) : -1,
    [entries, entry],
  )
  const previous = index > 0 ? entries[index - 1] : null
  const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : null

  useEffect(() => {
    setCopied(false)
    setCopyError(null)
  }, [entry?.id])

  if (!entry) return null

  const raw = JSON.stringify(entry, null, 2)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopyError(null)
      setCopied(true)
    } catch {
      setCopied(false)
      setCopyError('Clipboard access was blocked. Select the raw entry text to copy it manually.')
    }
  }

  const content = (
    <Box
      component={mobile ? 'div' : 'aside'}
      aria-label="Selected log entry details"
      sx={{
        ...(!mobile && c.panel),
        height: mobile ? '100%' : 'fit-content',
        maxHeight: mobile ? '100%' : 'min(78vh, 900px)',
        overflowY: 'auto',
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1.1,
          bgcolor: c.t.surface,
          borderBottom: `1px solid ${c.t.line}`,
        }}
      >
        <LevelBadge level={entry.level} c={c} />
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Previous loaded entry">
          <span>
            <IconButton
              size="small"
              disabled={!previous}
              onClick={() => previous && onSelect(previous)}
              aria-label="Previous loaded entry"
              sx={{ color: c.t.inkSoft }}
            >
              <PreviousIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Next loaded entry">
          <span>
            <IconButton
              size="small"
              disabled={!next}
              onClick={() => next && onSelect(next)}
              aria-label="Next loaded entry"
              sx={{ color: c.t.inkSoft }}
            >
              <NextIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={onClose} aria-label="Close detail panel" sx={{ color: c.t.muted }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ p: { xs: 1.5, md: 1.75 } }}>
        <Typography
          component="h2"
          sx={{
            color: c.t.ink,
            fontFamily: 'var(--hearth-heading)',
            fontSize: '1.15rem',
            fontWeight: 750,
            lineHeight: 1.35,
            overflowWrap: 'anywhere',
          }}
        >
          {entry.message}
        </Typography>
        <Typography sx={{ color: c.t.muted, fontSize: '0.72rem', mt: 0.6 }}>
          Entry #{entry.id.toLocaleString()}
        </Typography>

        <Box sx={{ mt: 2 }}>
          <FactRow label="Source" value={agentLabel(entry.agent)} c={c} color={c.source[entry.agent]} />
          <FactRow label="Level" value={levelLabel(entry.level)} c={c} color={c.level[entry.level]} />
          <FactRow label="Event time" value={formatFullTimestamp(entry.ts)} c={c} />
          <FactRow label="Received" value={formatFullTimestamp(entry.received_at)} c={c} />
          <FactRow
            label="Ingest delay"
            value={formatDelay(entry.ingestion_delay_ms)}
            c={c}
            mono
            color={entry.ingestion_delay_ms < 0 ? c.level.warn : c.t.ink}
          />
        </Box>

        {entry.ingestion_delay_ms < 0 && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            This source timestamp is ahead of Watchtower’s receipt clock. The entry is excluded from latency aggregates.
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.75 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FilterIcon sx={{ fontSize: 16 }} />}
            onClick={() => onFilter({ agent: entry.agent })}
            sx={{ color: c.source[entry.agent], borderColor: `${c.source[entry.agent]}66`, textTransform: 'none' }}
          >
            Only {agentLabel(entry.agent)}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FilterIcon sx={{ fontSize: 16 }} />}
            onClick={() => onFilter({ level: entry.level })}
            sx={{ color: c.level[entry.level], borderColor: `${c.level[entry.level]}66`, textTransform: 'none' }}
          >
            Only {levelLabel(entry.level)}
          </Button>
        </Box>

        <Box sx={{ mt: 2.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
            <Typography sx={{ color: c.t.ink, fontSize: '0.78rem', fontWeight: 800 }}>
              Raw entry
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              onClick={copy}
              startIcon={<CopyIcon sx={{ fontSize: 15 }} />}
              sx={{ color: c.t.inkSoft, textTransform: 'none' }}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
          </Box>
          <Box
            component="pre"
            sx={{
              ...c.inset,
              m: 0,
              p: 1.25,
              color: c.t.inkSoft,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.69rem',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {raw}
          </Box>
          {copyError && (
            <Typography role="alert" sx={{ color: c.level.error, fontSize: '0.7rem', mt: 0.75 }}>
              {copyError}
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  )

  if (!mobile) return content

  return (
    <Drawer
      anchor="right"
      open={Boolean(entry)}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 'min(100vw, 430px)',
            bgcolor: c.t.paper,
            color: c.t.ink,
            backgroundImage: 'none',
          },
        },
      }}
    >
      {content}
    </Drawer>
  )
}
