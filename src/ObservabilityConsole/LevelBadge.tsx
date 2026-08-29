import { Box, Typography } from '@mui/material'
import type { LogLevel } from './types'
import type { ObservabilityTheme } from './theme'
import { levelLabel } from './utils'

interface LevelBadgeProps {
  level: LogLevel
  c: ObservabilityTheme
  compact?: boolean
}

export default function LevelBadge({ level, c, compact = false }: LevelBadgeProps) {
  const color = c.level[level]
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.65,
        minWidth: compact ? 0 : 74,
        px: compact ? 0 : 0.9,
        py: compact ? 0 : 0.35,
        borderRadius: compact ? 0 : '7px',
        bgcolor: compact ? 'transparent' : `${color}16`,
      }}
    >
      <Box
        aria-hidden
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: color,
          boxShadow: c.dark ? `0 0 7px ${color}66` : 'none',
          flexShrink: 0,
        }}
      />
      <Typography
        component="span"
        sx={{
          color,
          fontSize: compact ? '0.68rem' : '0.7rem',
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          lineHeight: 1.2,
        }}
      >
        {levelLabel(level)}
      </Typography>
    </Box>
  )
}
