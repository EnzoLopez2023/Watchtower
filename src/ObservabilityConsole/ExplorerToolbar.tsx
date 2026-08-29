import type { FormEvent } from 'react'
import {
  Box,
  Button,
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  DataObjectOutlined as RawIcon,
  FilterAltOff as ResetIcon,
  Reorder as StreamIcon,
  Search as SearchIcon,
  TableRowsOutlined as TableIcon,
} from '@mui/icons-material'
import type { ExplorerFilters, LogLevel, LogView, SortOrder } from './types'
import type { ObservabilityTheme } from './theme'
import { LEVELS } from './utils'

interface ExplorerToolbarProps {
  c: ObservabilityTheme
  filters: ExplorerFilters
  queryDraft: string
  onQueryDraftChange: (value: string) => void
  onApplyQuery: () => void
  onLevelsChange: (levels: LogLevel[]) => void
  onOrderChange: (order: SortOrder) => void
  view: LogView
  onViewChange: (view: LogView) => void
  onReset: () => void
  matchingTotal: number | null
  loading: boolean
}

export default function ExplorerToolbar({
  c,
  filters,
  queryDraft,
  onQueryDraftChange,
  onApplyQuery,
  onLevelsChange,
  onOrderChange,
  view,
  onViewChange,
  onReset,
  matchingTotal,
  loading,
}: ExplorerToolbarProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onApplyQuery()
  }
  const hasFilters = filters.agents.length > 0
    || filters.levels.length > 0
    || filters.query.length > 0
    || filters.order !== 'newest'

  return (
    <Box sx={{ ...c.panel, p: { xs: 1.25, md: 1.5 } }}>
      <Box
        component="form"
        onSubmit={submit}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(280px, 1fr) auto auto' },
          gap: 1,
          alignItems: 'center',
        }}
      >
        <TextField
          size="small"
          value={queryDraft}
          onChange={(event) => onQueryDraftChange(event.target.value)}
          placeholder="Search exact message text"
          aria-label="Search log messages"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: c.t.muted, fontSize: 19 }} />
                </InputAdornment>
              ),
              endAdornment: queryDraft !== filters.query ? (
                <InputAdornment position="end">
                  <Button
                    type="submit"
                    size="small"
                    disabled={loading}
                    sx={{ textTransform: 'none', fontWeight: 700 }}
                  >
                    Apply
                  </Button>
                </InputAdornment>
              ) : undefined,
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: c.t.bg,
              color: c.t.ink,
              '& fieldset': { borderColor: c.t.line },
            },
          }}
        />

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0 }}>
          <ToggleButtonGroup
            size="small"
            value={filters.levels}
            onChange={(_event, levels: LogLevel[]) => onLevelsChange(levels)}
            aria-label="Log level filters"
            sx={{
              flexWrap: 'wrap',
              '& .MuiToggleButton-root': {
                gap: 0.6,
                color: c.t.inkSoft,
                borderColor: c.t.line,
                textTransform: 'none',
                fontWeight: 700,
                px: 1,
              },
              '& .Mui-selected': {
                color: `${c.t.ink} !important`,
                bgcolor: `${c.selection} !important`,
              },
            }}
          >
            {LEVELS.map((level) => (
              <ToggleButton key={level.id} value={level.id}>
                <Box
                  aria-hidden
                  sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: c.level[level.id] }}
                />
                {level.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box sx={{ display: 'flex', gap: 0.75, justifyContent: { lg: 'flex-end' } }}>
          <Select
            size="small"
            value={filters.order}
            onChange={(event) => onOrderChange(event.target.value)}
            aria-label="Log sort order"
            sx={{
              minWidth: 132,
              bgcolor: c.t.bg,
              color: c.t.ink,
              '& .MuiOutlinedInput-notchedOutline': { borderColor: c.t.line },
            }}
          >
            <MenuItem value="newest">Newest first</MenuItem>
            <MenuItem value="oldest">Oldest first</MenuItem>
          </Select>
          <Tooltip title="Clear filters and restore newest-first order">
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={!hasFilters}
                onClick={onReset}
                startIcon={<ResetIcon sx={{ fontSize: 17 }} />}
                sx={{
                  minWidth: 42,
                  color: c.t.inkSoft,
                  borderColor: c.t.line,
                  textTransform: 'none',
                  '& .MuiButton-startIcon': { mr: { xs: 0, sm: 0.75 } },
                }}
              >
                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                  Reset
                </Box>
              </Button>
            </span>
          </Tooltip>
        </Box>
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'stretch', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 1,
          mt: 1.25,
          pt: 1.25,
          borderTop: `1px solid ${c.t.line}`,
        }}
      >
        <Typography sx={{ color: c.t.muted, fontSize: '0.74rem' }}>
          {matchingTotal == null
            ? 'Waiting for results'
            : `${matchingTotal.toLocaleString()} matching ${matchingTotal === 1 ? 'entry' : 'entries'}`}
          {filters.query ? ` for “${filters.query}”` : ''}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={view}
          onChange={(_event, next: LogView | null) => next && onViewChange(next)}
          aria-label="Log result view"
          sx={{
            alignSelf: { xs: 'stretch', sm: 'auto' },
            '& .MuiToggleButton-root': {
              flex: { xs: 1, sm: 'none' },
              gap: 0.65,
              color: c.t.inkSoft,
              borderColor: c.t.line,
              textTransform: 'none',
              fontWeight: 700,
              px: 1.15,
            },
            '& .Mui-selected': {
              color: `${c.t.ink} !important`,
              bgcolor: `${c.selection} !important`,
            },
          }}
        >
          <ToggleButton value="table"><TableIcon sx={{ fontSize: 16 }} />Table</ToggleButton>
          <ToggleButton value="stream"><StreamIcon sx={{ fontSize: 16 }} />Stream</ToggleButton>
          <ToggleButton value="raw"><RawIcon sx={{ fontSize: 16 }} />Raw</ToggleButton>
        </ToggleButtonGroup>
      </Box>
    </Box>
  )
}
