import {
  Alert,
  Box,
  Button,
  CircularProgress,
  LinearProgress,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import { ExpandMore as LoadMoreIcon, Refresh as RetryIcon } from '@mui/icons-material'
import type { KeyboardEvent } from 'react'
import type { LogEntry, LogResponse, LogView } from './types'
import type { ObservabilityTheme } from './theme'
import { agentLabel, formatDelay, formatTimestamp } from './utils'
import LevelBadge from './LevelBadge'

interface LogResultsProps {
  c: ObservabilityTheme
  response: LogResponse | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  view: LogView
  selectedId: number | null
  onSelect: (entry: LogEntry) => void
  onLoadMore: () => void
  onRetry: () => void
}

function selectionKeys(event: KeyboardEvent, entry: LogEntry, onSelect: (entry: LogEntry) => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    onSelect(entry)
  }
}

function EmptyRows({ c }: { c: ObservabilityTheme }) {
  return (
    <Box sx={{ px: 2, py: 8, textAlign: 'center' }}>
      <Typography sx={{ color: c.t.ink, fontWeight: 750, mb: 0.75 }}>
        No entries cross this time lens
      </Typography>
      <Typography sx={{ color: c.t.muted, fontSize: '0.84rem', maxWidth: 520, mx: 'auto' }}>
        Widen the time range or clear a source, level, or message filter. The console never substitutes sample data.
      </Typography>
    </Box>
  )
}

function LoadingRows({ c }: { c: ObservabilityTheme }) {
  return (
    <Box sx={{ px: 1.75, py: 1 }}>
      {Array.from({ length: 8 }, (_, index) => (
        <Box
          key={index}
          sx={{ display: 'grid', gridTemplateColumns: '130px 90px 1fr 80px', gap: 2, py: 1 }}
        >
          <Skeleton sx={{ bgcolor: `${c.t.muted}18` }} />
          <Skeleton sx={{ bgcolor: `${c.t.muted}18` }} />
          <Skeleton sx={{ bgcolor: `${c.t.muted}18` }} />
          <Skeleton sx={{ bgcolor: `${c.t.muted}18` }} />
        </Box>
      ))}
    </Box>
  )
}

function TableView({
  c,
  entries,
  selectedId,
  onSelect,
}: {
  c: ObservabilityTheme
  entries: LogEntry[]
  selectedId: number | null
  onSelect: (entry: LogEntry) => void
}) {
  return (
    <TableContainer sx={{ maxHeight: 'min(68vh, 760px)' }}>
      <Table stickyHeader size="small" aria-label="Agent log entries">
        <TableHead>
          <TableRow>
            {[
              ['Event time', 158],
              ['Level', 102],
              ['Source', 118],
              ['Message', undefined],
              ['Ingest delay', 112],
            ].map(([label, width]) => (
              <TableCell
                key={String(label)}
                sx={{
                  width,
                  bgcolor: c.t.surface,
                  color: c.t.muted,
                  borderColor: c.t.line,
                  py: 1,
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map((entry) => {
            const selected = selectedId === entry.id
            return (
              <TableRow
                key={entry.id}
                hover
                tabIndex={0}
                aria-selected={selected}
                onClick={() => onSelect(entry)}
                onKeyDown={(event) => selectionKeys(event, entry, onSelect)}
                sx={{
                  cursor: 'pointer',
                  bgcolor: selected ? c.selection : 'transparent',
                  '&:hover': { bgcolor: selected ? c.selection : c.hover },
                  '&:focus-visible': { outline: `2px solid ${c.accent}`, outlineOffset: -2 },
                  '& td': { borderColor: c.t.line },
                }}
              >
                <TableCell
                  sx={{
                    color: c.t.inkSoft,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '0.74rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatTimestamp(entry.ts)}
                </TableCell>
                <TableCell><LevelBadge level={entry.level} c={c} /></TableCell>
                <TableCell>
                  <Typography
                    sx={{
                      color: c.source[entry.agent],
                      fontSize: '0.78rem',
                      fontWeight: 750,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {agentLabel(entry.agent)}
                  </Typography>
                </TableCell>
                <TableCell sx={{ maxWidth: 0 }}>
                  <Typography
                    title={entry.message}
                    sx={{
                      color: c.t.ink,
                      fontSize: '0.8rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.message}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography
                    sx={{
                      color: entry.ingestion_delay_ms < 0 ? c.level.warn : c.t.inkSoft,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.73rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatDelay(entry.ingestion_delay_ms)}
                  </Typography>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

function StreamView({
  c,
  entries,
  selectedId,
  onSelect,
}: {
  c: ObservabilityTheme
  entries: LogEntry[]
  selectedId: number | null
  onSelect: (entry: LogEntry) => void
}) {
  return (
    <Box
      role="list"
      aria-label="Agent log stream"
      sx={{ maxHeight: 'min(68vh, 760px)', overflowY: 'auto' }}
    >
      {entries.map((entry) => {
        const selected = selectedId === entry.id
        return (
          <Box
            key={entry.id}
            role="listitem"
            component="button"
            type="button"
            onClick={() => onSelect(entry)}
            sx={{
              appearance: 'none',
              width: '100%',
              border: 0,
              borderBottom: `1px solid ${c.t.line}`,
              bgcolor: selected ? c.selection : 'transparent',
              color: c.t.ink,
              display: 'grid',
              gridTemplateColumns: { xs: '92px 1fr', md: '152px 78px 112px minmax(0, 1fr)' },
              gap: { xs: 0.75, md: 1.25 },
              alignItems: 'baseline',
              px: 1.5,
              py: 0.82,
              textAlign: 'left',
              cursor: 'pointer',
              '&:hover': { bgcolor: selected ? c.selection : c.hover },
              '&:focus-visible': { outline: `2px solid ${c.accent}`, outlineOffset: -2 },
            }}
          >
            <Typography
              component="span"
              sx={{
                color: c.t.muted,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.7rem',
                whiteSpace: 'nowrap',
              }}
            >
              {formatTimestamp(entry.ts, true)}
            </Typography>
            <Box sx={{ display: { xs: 'flex', md: 'contents' }, gap: 1, alignItems: 'baseline', minWidth: 0 }}>
              <LevelBadge level={entry.level} c={c} compact />
              <Typography
                component="span"
                sx={{
                  color: c.source[entry.agent],
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.72rem',
                  whiteSpace: 'nowrap',
                }}
              >
                [{entry.agent}]
              </Typography>
              <Typography
                component="span"
                sx={{
                  color: c.t.ink,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.73rem',
                  flex: 1,
                  overflowWrap: 'anywhere',
                  minWidth: 0,
                }}
              >
                {entry.message}
              </Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function RawView({
  c,
  entries,
  selectedId,
  onSelect,
}: {
  c: ObservabilityTheme
  entries: LogEntry[]
  selectedId: number | null
  onSelect: (entry: LogEntry) => void
}) {
  return (
    <Box
      role="list"
      aria-label="Raw JSON log entries"
      sx={{ maxHeight: 'min(68vh, 760px)', overflowY: 'auto', bgcolor: c.t.bg }}
    >
      {entries.map((entry) => (
        <Box
          key={entry.id}
          role="listitem"
          component="button"
          type="button"
          onClick={() => onSelect(entry)}
          sx={{
            display: 'block',
            width: '100%',
            appearance: 'none',
            border: 0,
            borderBottom: `1px solid ${c.t.line}`,
            bgcolor: selectedId === entry.id ? c.selection : 'transparent',
            color: c.t.ink,
            p: 1.5,
            textAlign: 'left',
            cursor: 'pointer',
            '&:hover': { bgcolor: selectedId === entry.id ? c.selection : c.hover },
            '&:focus-visible': { outline: `2px solid ${c.accent}`, outlineOffset: -2 },
          }}
        >
          <Box
            component="pre"
            sx={{
              m: 0,
              color: c.t.inkSoft,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.72rem',
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {JSON.stringify(entry, null, 2)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export default function LogResults({
  c,
  response,
  loading,
  loadingMore,
  error,
  view,
  selectedId,
  onSelect,
  onLoadMore,
  onRetry,
}: LogResultsProps) {
  if (error && !response) {
    return (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" onClick={onRetry} startIcon={<RetryIcon />}>
            Retry
          </Button>
        )}
      >
        Could not load log entries: {error}
      </Alert>
    )
  }

  return (
    <Box sx={{ ...c.panel, overflow: 'hidden', minWidth: 0 }}>
      {loading && <LinearProgress sx={{ height: 2, bgcolor: c.t.surface }} />}
      {error && response && (
        <Alert severity="warning" sx={{ borderRadius: 0 }}>
          Refresh failed; showing the last successful result. {error}
        </Alert>
      )}
      {!response ? (
        <LoadingRows c={c} />
      ) : response.lines.length === 0 ? (
        <EmptyRows c={c} />
      ) : (
        <>
          {view === 'table' && (
            <TableView c={c} entries={response.lines} selectedId={selectedId} onSelect={onSelect} />
          )}
          {view === 'stream' && (
            <StreamView c={c} entries={response.lines} selectedId={selectedId} onSelect={onSelect} />
          )}
          {view === 'raw' && (
            <RawView c={c} entries={response.lines} selectedId={selectedId} onSelect={onSelect} />
          )}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              px: 1.5,
              py: 1,
              borderTop: `1px solid ${c.t.line}`,
              bgcolor: c.t.surface,
            }}
          >
            <Typography sx={{ color: c.t.muted, fontSize: '0.7rem' }}>
              Showing {response.lines.length.toLocaleString()} of {response.matchingTotal.toLocaleString()}
            </Typography>
            {response.nextCursor && (
              <Button
                size="small"
                variant="outlined"
                disabled={loading || loadingMore}
                onClick={onLoadMore}
                startIcon={loadingMore ? <CircularProgress size={14} /> : <LoadMoreIcon />}
                sx={{ color: c.t.inkSoft, borderColor: c.t.line, textTransform: 'none', fontWeight: 700 }}
              >
                {response.order === 'newest' ? 'Load older' : 'Load newer'}
              </Button>
            )}
          </Box>
        </>
      )}
    </Box>
  )
}
