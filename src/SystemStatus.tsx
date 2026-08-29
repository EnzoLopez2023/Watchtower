// System Status — the web mirror of the alerting engine's own verdicts.
//
// Renders whatever `/api/status` returns, verbatim. Every verdict shown here is
// the SAME object the alert engine pushes from, so if this page says "warn"
// the notification said "warn". No severity logic lives in this file, on
// purpose — duplicating it is how a dashboard and a notification start
// disagreeing about whether the house is on fire.

import { apiFetch } from './services/apiClient';
import { useCallback, useEffect, useState } from 'react'
import {
  Box, Card, CardContent, Chip, CircularProgress, Divider,
  IconButton, Stack, Tooltip, Typography, Alert,
} from '@mui/material'
import { Refresh as RefreshIcon } from '@mui/icons-material'
import { useTheme } from '@mui/material/styles'

type Severity = 'ok' | 'stale' | 'warn' | 'critical'

interface OfflineEntry { name: string | null; model: string | null; ip: string | null; mac: string | null }

interface Subsystem {
  key: string
  label: string
  severity: Severity
  headline: string
  detail?: string | null
  ts?: number | null
  escalation?: number
  informational?: boolean
  offline?: OfflineEntry[]
  cellular?: { totalBytes: number; carrier: string | null; limited: boolean; warning: boolean } | null
  uplinks?: { key: string; name: string; primary: boolean; active: boolean; latencyMs: number | null }[]
}

interface StatusPayload {
  generatedAt: number
  overall: { severity: Severity; issueCount: number; summary: string }
  subsystems: Subsystem[]
}

const POLL_MS = 30_000

// Warm artisan palette, matching PlexCommandCenter's useC() convention.
function useC() {
  const dark = useTheme().palette.mode === 'dark'
  return {
    dark,
    ok: dark ? '#7f9f6e' : '#5b7a4a',
    stale: dark ? '#8a8378' : '#7a7268',
    warn: dark ? '#d9a441' : '#b3801d',
    critical: dark ? '#c96442' : '#a8412a',
    text: dark ? '#e8e2d8' : '#2f2a24',
    muted: dark ? '#9b9287' : '#6f675d',
    card: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)',
    border: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
  }
}

const LABEL: Record<Severity, string> = { ok: 'OK', stale: 'Stale', warn: 'Warning', critical: 'Critical' }

function relative(ts?: number | null) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export default function SystemStatus() {
  const c = useC()
  const [data, setData] = useState<StatusPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const tone = (s: Severity) => c[s]

  if (loading && !data) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}><CircularProgress /></Box>
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <Typography variant="h4" sx={{ fontWeight: 600, color: c.text }}>System Status</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ color: c.muted }}>
          {data ? `updated ${relative(data.generatedAt)}` : ''}
        </Typography>
        <Tooltip title="Refresh now">
          <IconButton onClick={load} size="small" sx={{ color: c.muted }}><RefreshIcon fontSize="small" /></IconButton>
        </Tooltip>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>Could not load status: {error}</Alert>}

      {data && (
        <>
          <Card sx={{ mb: 2, bgcolor: c.card, border: `1px solid ${tone(data.overall.severity)}44` }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: tone(data.overall.severity), flexShrink: 0 }} />
              <Typography sx={{ fontWeight: 600, color: c.text }}>{data.overall.summary}</Typography>
            </CardContent>
          </Card>

          <Stack spacing={1.5}>
            {data.subsystems.map((s) => (
              <Card key={s.key} sx={{ bgcolor: c.card, border: `1px solid ${c.border}` }}>
                <CardContent sx={{ '&:last-child': { pb: 2 } }}>
                  <Stack direction="row" alignItems="center" spacing={1.5}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: tone(s.severity), flexShrink: 0 }} />
                    <Typography sx={{ fontWeight: 600, color: c.text }}>{s.label}</Typography>
                    {s.informational && <Chip size="small" label="info" sx={{ height: 18, fontSize: 11 }} />}
                    <Box sx={{ flex: 1 }} />
                    <Typography sx={{ color: c.muted, fontSize: 14 }}>{s.headline}</Typography>
                  </Stack>

                  {s.detail && (
                    <Typography sx={{ color: c.muted, fontSize: 13, mt: 0.75, ml: 3.25 }}>{s.detail}</Typography>
                  )}

                  {/* Named offline items — the thing "1 offline" never told you. */}
                  {!!s.offline?.length && (
                    <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 1, ml: 3.25 }}>
                      {s.offline.map((o) => (
                        <Chip
                          key={o.mac || o.name}
                          size="small"
                          label={o.ip ? `${o.name ?? 'unknown'} · ${o.ip}` : (o.name ?? 'unknown')}
                          sx={{ height: 22, fontSize: 12, color: c.warn, borderColor: `${c.warn}66` }}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                  )}

                  {/* Per-WAN state — the data whose absence made the 2026-08-02
                      cellular failover invisible to alerting. */}
                  {!!s.uplinks?.length && (
                    <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 1, ml: 3.25 }}>
                      {s.uplinks.map((u) => (
                        <Chip
                          key={u.key}
                          size="small"
                          variant="outlined"
                          label={`${u.name}${u.active ? ` · active${u.latencyMs != null ? ` · ${u.latencyMs} ms` : ''}` : ' · down'}`}
                          sx={{
                            height: 22,
                            fontSize: 12,
                            color: u.active ? (u.primary ? c.ok : c.warn) : c.muted,
                            borderColor: u.active ? (u.primary ? `${c.ok}66` : `${c.warn}66`) : c.border,
                          }}
                        />
                      ))}
                    </Stack>
                  )}

                  {s.cellular && (
                    <Typography sx={{ color: s.cellular.warning || s.cellular.limited ? c.warn : c.muted, fontSize: 12, mt: 1, ml: 3.25 }}>
                      Cellular this cycle: {(s.cellular.totalBytes / 1e6).toFixed(0)} MB
                      {s.cellular.carrier ? ` · ${s.cellular.carrier}` : ''}
                      {s.cellular.limited ? ' · DATA LIMITED' : s.cellular.warning ? ' · over warning threshold' : ''}
                    </Typography>
                  )}

                  <Divider sx={{ my: 1, borderColor: c.border }} />
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip size="small" label={LABEL[s.severity]} sx={{ height: 20, fontSize: 11, bgcolor: `${tone(s.severity)}22`, color: tone(s.severity) }} />
                    {!!s.escalation && <Chip size="small" label={`level ${s.escalation}`} variant="outlined" sx={{ height: 20, fontSize: 11, color: c.muted }} />}
                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" sx={{ color: c.muted }}>{relative(s.ts)}</Typography>
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </>
      )}
    </Box>
  )
}
