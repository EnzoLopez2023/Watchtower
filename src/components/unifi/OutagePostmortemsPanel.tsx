import { apiFetch } from '../../services/apiClient';
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  Skeleton,
  Typography,
} from '@mui/material'
import {
  Article as ReportIcon,
  Bolt as PowerIcon,
  CheckCircle as RecoveredIcon,
  ChevronRight as ChevronIcon,
  CloudOff as InternetIcon,
  HelpOutline as UnknownIcon,
  Refresh as RefreshIcon,
  SensorsOff as CollectorIcon,
  TimerOutlined as TimerIcon,
} from '@mui/icons-material'
import type { HearthTokens } from '../../theme/tokens'
import { CARD_HOVER_SX, CARD_RADIUS } from '../../theme/controls'

type IncidentStatus = 'open' | 'recovery_pending' | 'finalized'
type Classification = 'power' | 'internet' | 'collector_down' | 'unknown'
type Confidence = 'low' | 'medium' | 'high'

interface IncidentSummary {
  id: string
  scope: string
  status: IncidentStatus
  classification: Classification
  confidence: Confidence
  startedAt: number
  lastEvidenceAt: number
  recoveredAt: number | null
  finalizeAfter: number | null
  finalizedAt: number | null
  classifications: Classification[]
  pendingSeconds: number | null
  reportId: string | null
  executiveSummary: string | null
}

interface EvidenceItem {
  evidenceKey: string
  source: string
  signal: string
  state: string
  occurredAt: number
  receivedAt: number
  confidence: Confidence
  summary: string
  detail: string | null
}

interface TimelineItem {
  at: number
  receivedAt: number
  source: string
  signal: string
  state: string
  confidence: Confidence
  summary: string
  detail: string | null
}

interface PostmortemReport {
  executiveSummary: string
  classification: Classification
  confidence: Confidence
  impact: { summary: string }
  timing: {
    startedAt: number
    powerRestoredAt: number | null
    internetRestoredAt: number | null
    recoveredAt: number | null
    stableAt: number | null
    durationMs: number | null
    recoveryHoldMs: number
  }
  timeline: TimelineItem[]
  detection: { summary: string; notificationOutcome: string }
  cause: {
    rootCause: string
    contributingFactors: Array<{ classification: string; summary: string }>
  }
  recovery: { summary: string }
  whatWorked: string[]
  whatFailed: string[]
  correctiveActions: Array<{ priority: string; owner: string; action: string }>
  dataGaps: string[]
  methodology: { sources: string[]; note: string }
}

interface IncidentDetail extends IncidentSummary {
  evidence: EvidenceItem[]
  report: PostmortemReport | null
}

interface IncidentResponse {
  recoveryHoldSeconds: number
  pendingCount: number
  incidents: IncidentSummary[]
}

const classificationMeta: Record<Classification, {
  label: string
  color: string
  icon: typeof PowerIcon
}> = {
  power: { label: 'Power', color: '#C4841A', icon: PowerIcon },
  internet: { label: 'Internet', color: '#C4443A', icon: InternetIcon },
  collector_down: { label: 'Collector down', color: '#7C5CD6', icon: CollectorIcon },
  unknown: { label: 'Unknown', color: '#6E6E78', icon: UnknownIcon },
}

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds == null) return '—'
  const minutes = Math.max(0, Math.round(milliseconds / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const formatCountdown = (seconds: number) => {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

const timeLabel = (value: number | null) => (
  value == null ? 'Not confirmed' : new Date(value).toLocaleString()
)

function Section({ t, title, children }: {
  t: HearthTokens
  title: string
  children: React.ReactNode
}) {
  return (
    <Box sx={{ pt: 1.5, mt: 1.5, borderTop: `1px solid ${t.line}` }}>
      <Typography sx={{ color: t.ink, fontSize: '0.78rem', fontWeight: 850, mb: 0.65 }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

function Fact({ t, label, value }: { t: HearthTokens; label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ color: t.muted, fontSize: '0.62rem', fontWeight: 800 }}>
        {label}
      </Typography>
      <Typography sx={{ color: t.inkSoft, fontSize: '0.72rem', overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Box>
  )
}

function IncidentListRow({ t, incident, selected, onSelect, clock }: {
  t: HearthTokens
  incident: IncidentSummary
  selected: boolean
  onSelect: () => void
  clock: number
}) {
  const meta = classificationMeta[incident.classification]
  const Icon = meta.icon
  const countdown = incident.finalizeAfter == null
    ? null
    : Math.max(0, Math.ceil((incident.finalizeAfter - clock) / 1000))
  return (
    <ButtonBase
      onClick={onSelect}
      sx={{
        width: '100%',
        display: 'grid',
        gridTemplateColumns: '28px minmax(0,1fr) auto',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 1,
        textAlign: 'left',
        borderRadius: '8px',
        bgcolor: selected ? `${meta.color}12` : 'transparent',
        border: `1px solid ${selected ? `${meta.color}55` : 'transparent'}`,
        '&:hover': { bgcolor: `${meta.color}0D` },
        '&:focus-visible': { outline: `2px solid ${meta.color}`, outlineOffset: 1 },
      }}
    >
      <Box sx={{
        width: 28,
        height: 28,
        borderRadius: '7px',
        display: 'grid',
        placeItems: 'center',
        color: meta.color,
        bgcolor: `${meta.color}16`,
      }}>
        <Icon sx={{ fontSize: 17 }} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ color: t.ink, fontSize: '0.74rem', fontWeight: 800 }}>
          {meta.label} · {new Date(incident.startedAt).toLocaleDateString()}
        </Typography>
        <Typography sx={{
          color: t.muted,
          fontSize: '0.64rem',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {incident.status === 'open'
            ? 'Evidence is still accumulating'
            : incident.status === 'recovery_pending' && countdown != null
              ? `Stable recovery · report in ${formatCountdown(countdown)}`
              : incident.executiveSummary || `Recovered ${timeLabel(incident.recoveredAt)}`}
        </Typography>
      </Box>
      <ChevronIcon sx={{ color: selected ? meta.color : t.muted, fontSize: 18 }} />
    </ButtonBase>
  )
}

function EvidenceTimeline({ t, items }: { t: HearthTokens; items: TimelineItem[] | EvidenceItem[] }) {
  if (!items.length) {
    return (
      <Typography sx={{ color: t.muted, fontSize: '0.72rem' }}>
        No transition evidence has been linked yet.
      </Typography>
    )
  }
  return (
    <Box sx={{ display: 'grid' }}>
      {items.map((item, index) => {
        const at = 'at' in item ? item.at : item.occurredAt
        const color = item.state === 'outage'
          ? '#C4443A'
          : item.state === 'healthy'
            ? '#2E9E5B'
            : t.rust
        return (
          <Box
            key={`${item.source}:${at}:${index}`}
            sx={{
              display: 'grid',
              gridTemplateColumns: '9px minmax(0,1fr)',
              gap: 1,
              py: 0.75,
              borderBottom: index < items.length - 1 ? `1px solid ${t.line}` : 'none',
            }}
          >
            <Box sx={{ width: 8, height: 8, mt: 0.55, borderRadius: '50%', bgcolor: color }} />
            <Box sx={{ minWidth: 0 }}>
              <Box sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                justifyContent: 'space-between',
                gap: 0.25,
              }}>
                <Typography sx={{ color: t.ink, fontSize: '0.72rem', fontWeight: 750 }}>
                  {item.summary}
                </Typography>
                <Typography sx={{ color: t.muted, fontSize: '0.61rem', flexShrink: 0 }}>
                  {new Date(at).toLocaleString()}
                </Typography>
              </Box>
              {item.detail && (
                <Typography sx={{ color: t.inkSoft, fontSize: '0.66rem', mt: 0.15 }}>
                  {item.detail}
                </Typography>
              )}
              <Typography sx={{ color: t.muted, fontSize: '0.58rem', mt: 0.25 }}>
                {item.source} · {item.confidence} confidence · received {new Date(item.receivedAt).toLocaleString()}
              </Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function IncidentDetailView({ t, detail, clock }: {
  t: HearthTokens
  detail: IncidentDetail
  clock: number
}) {
  const meta = classificationMeta[detail.classification]
  const Icon = meta.icon
  const countdown = detail.finalizeAfter == null
    ? null
    : Math.max(0, Math.ceil((detail.finalizeAfter - clock) / 1000))
  const report = detail.report

  return (
    <Box sx={{ minWidth: 0, px: { xs: 0, md: 1.5 }, py: { xs: 1.5, md: 0 } }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ display: 'flex', gap: 1, minWidth: 0 }}>
          <Icon sx={{ color: meta.color, mt: 0.2 }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ color: t.ink, fontSize: '0.96rem', fontWeight: 900 }}>
              {meta.label} incident
            </Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.68rem' }}>
              Began {new Date(detail.startedAt).toLocaleString()}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Chip
            size="small"
            label={`${detail.confidence} confidence`}
            sx={{ height: 22, fontSize: '0.62rem', color: meta.color, bgcolor: `${meta.color}14` }}
          />
          <Chip
            size="small"
            label={detail.status === 'finalized' ? 'Final' : detail.status === 'open' ? 'Open' : 'Recovery hold'}
            sx={{ height: 22, fontSize: '0.62rem' }}
          />
        </Box>
      </Box>

      {detail.status === 'recovery_pending' && countdown != null && (
        <Box
          aria-live="polite"
          sx={{
            mt: 1.25,
            px: 1.25,
            py: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            borderRadius: '8px',
            bgcolor: '#2E9E5B10',
            border: '1px solid #2E9E5B44',
          }}
        >
          <TimerIcon sx={{ color: '#2E9E5B', fontSize: 19 }} />
          <Box>
            <Typography sx={{ color: '#2E9E5B', fontSize: '0.74rem', fontWeight: 850 }}>
              Stable recovery · {formatCountdown(countdown)} remaining
            </Typography>
            <Typography sx={{ color: t.inkSoft, fontSize: '0.65rem' }}>
              A regression cancels finalization and keeps this incident open.
            </Typography>
          </Box>
        </Box>
      )}

      {report ? (
        <>
          <Typography sx={{ color: t.ink, fontSize: '0.8rem', lineHeight: 1.6, mt: 1.5, maxWidth: '75ch' }}>
            {report.executiveSummary}
          </Typography>

          <Section t={t} title="Impact and timing">
            <Typography sx={{ color: t.inkSoft, fontSize: '0.72rem', lineHeight: 1.55, mb: 1 }}>
              {report.impact.summary}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,minmax(0,1fr))', lg: 'repeat(3,minmax(0,1fr))' }, gap: 1 }}>
              <Fact t={t} label="START" value={timeLabel(report.timing.startedAt)} />
              <Fact t={t} label="POWER RESTORED" value={timeLabel(report.timing.powerRestoredAt)} />
              <Fact t={t} label="INTERNET RESTORED" value={timeLabel(report.timing.internetRestoredAt)} />
              <Fact t={t} label="RECOVERY CONFIRMED" value={timeLabel(report.timing.recoveredAt)} />
              <Fact t={t} label="STABLE AT" value={timeLabel(report.timing.stableAt)} />
              <Fact t={t} label="DURATION" value={formatDuration(report.timing.durationMs)} />
            </Box>
          </Section>

          <Section t={t} title="Cause, detection, and recovery">
            <Box sx={{ display: 'grid', gap: 0.8 }}>
              <Fact t={t} label="EVIDENCE-QUALIFIED CAUSE" value={report.cause.rootCause} />
              <Fact t={t} label="DETECTION" value={report.detection.summary} />
              <Fact t={t} label="NOTIFICATION OUTCOME" value={report.detection.notificationOutcome} />
              <Fact t={t} label="RECOVERY" value={report.recovery.summary} />
            </Box>
          </Section>

          <Section t={t} title="Evidence timeline">
            <EvidenceTimeline t={t} items={report.timeline} />
          </Section>

          <Section t={t} title="What worked / what failed">
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2,minmax(0,1fr))' }, gap: 1.5 }}>
              <Box>
                <Typography sx={{ color: '#2E9E5B', fontSize: '0.66rem', fontWeight: 850, mb: 0.45 }}>
                  WORKED
                </Typography>
                {report.whatWorked.map((item) => (
                  <Typography key={item} sx={{ color: t.inkSoft, fontSize: '0.68rem', mb: 0.35 }}>
                    • {item}
                  </Typography>
                ))}
              </Box>
              <Box>
                <Typography sx={{ color: '#C4443A', fontSize: '0.66rem', fontWeight: 850, mb: 0.45 }}>
                  FAILED OR UNPROVEN
                </Typography>
                {report.whatFailed.map((item) => (
                  <Typography key={item} sx={{ color: t.inkSoft, fontSize: '0.68rem', mb: 0.35 }}>
                    • {item}
                  </Typography>
                ))}
              </Box>
            </Box>
          </Section>

          <Section t={t} title="Corrective actions and data gaps">
            <Box sx={{ display: 'grid', gap: 0.65 }}>
              {report.correctiveActions.map((action) => (
                <Box key={`${action.priority}:${action.action}`} sx={{ display: 'grid', gridTemplateColumns: '34px 72px minmax(0,1fr)', gap: 0.75 }}>
                  <Typography sx={{ color: meta.color, fontSize: '0.66rem', fontWeight: 900 }}>{action.priority}</Typography>
                  <Typography sx={{ color: t.muted, fontSize: '0.66rem', fontWeight: 750 }}>{action.owner}</Typography>
                  <Typography sx={{ color: t.inkSoft, fontSize: '0.68rem' }}>{action.action}</Typography>
                </Box>
              ))}
            </Box>
            <Box sx={{ mt: 1 }}>
              {report.dataGaps.map((gap) => (
                <Typography key={gap} sx={{ color: t.muted, fontSize: '0.65rem', mb: 0.25 }}>
                  Data gap · {gap}
                </Typography>
              ))}
            </Box>
          </Section>

          <Section t={t} title="Evidence methodology">
            <Typography sx={{ color: t.inkSoft, fontSize: '0.68rem', lineHeight: 1.55 }}>
              {report.methodology.note}
            </Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.62rem', mt: 0.4 }}>
              Sources: {report.methodology.sources.join(', ') || 'retained monitoring transitions'}
            </Typography>
          </Section>
        </>
      ) : (
        <Section t={t} title={detail.status === 'open' ? 'Live evidence' : 'Report pending'}>
          <Typography sx={{ color: t.inkSoft, fontSize: '0.72rem', lineHeight: 1.55, mb: 1 }}>
            {detail.status === 'open'
              ? 'Watchtower is preserving transition evidence while the incident remains active.'
              : 'Recovery has been observed. The deterministic report will be written after the stability hold completes.'}
          </Typography>
          <EvidenceTimeline t={t} items={detail.evidence} />
        </Section>
      )}
    </Box>
  )
}

export default function OutagePostmortemsPanel({ t }: { t: HearthTokens }) {
  const [incidents, setIncidents] = useState<IncidentSummary[]>([])
  const [recoveryHoldSeconds, setRecoveryHoldSeconds] = useState(420)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<IncidentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [retry, setRetry] = useState(0)

  const loadList = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await apiFetch('/api/unifi/outage-incidents?limit=25', { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json() as IncidentResponse
      const next = Array.isArray(data.incidents) ? data.incidents : []
      setIncidents(next)
      setRecoveryHoldSeconds(data.recoveryHoldSeconds || 420)
      setSelectedId((current) => (
        current && next.some((incident) => incident.id === current)
          ? current
          : next[0]?.id ?? null
      ))
      setError(null)
    } catch (loadError) {
      if (signal.aborted) return
      setError(loadError instanceof Error ? loadError.message : 'Could not load outage post-mortems.')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadList(controller.signal)
    const poll = window.setInterval(() => void loadList(controller.signal), 30_000)
    return () => {
      controller.abort()
      window.clearInterval(poll)
    }
  }, [loadList, retry])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    const controller = new AbortController()
    setDetail((current) => current?.id === selectedId ? current : null)
    setDetailLoading(true)
    apiFetch(`/api/unifi/outage-incidents/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ incident: IncidentDetail }>
      })
      .then((data) => {
        setDetail(data.incident)
        setError(null)
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load the selected post-mortem.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false)
      })
    return () => controller.abort()
  }, [selectedId, incidents])

  const mutable = useMemo(
    () => incidents.find((incident) => incident.status !== 'finalized') ?? null,
    [incidents],
  )

  return (
    <Box sx={{
      minWidth: 0,
      overflow: 'hidden',
      borderRadius: CARD_RADIUS,
      background: t.paper,
      border: `1px solid ${t.line}`,
      ...CARD_HOVER_SX,
    }}>
      <Box sx={{
        px: { xs: 1.5, md: 2 },
        py: 1.5,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 1,
        borderBottom: `1px solid ${t.line}`,
      }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <ReportIcon sx={{ color: t.rust, mt: 0.1 }} />
          <Box>
            <Typography sx={{ color: t.ink, fontSize: '0.94rem', fontWeight: 850 }}>
              Automated outage post-mortems
            </Typography>
            <Typography sx={{ color: t.muted, fontSize: '0.7rem', mt: 0.2 }}>
              Evidence is preserved during the incident; reports finalize after {Math.round(recoveryHoldSeconds / 60)} stable minutes.
            </Typography>
          </Box>
        </Box>
        {mutable && (
          <Chip
            icon={mutable.status === 'recovery_pending' ? <TimerIcon /> : <RefreshIcon />}
            label={mutable.status === 'recovery_pending' ? 'Recovery hold' : 'Incident open'}
            size="small"
            sx={{
              height: 24,
              flexShrink: 0,
              color: mutable.status === 'recovery_pending' ? '#2E9E5B' : '#C4443A',
              bgcolor: mutable.status === 'recovery_pending' ? '#2E9E5B12' : '#C4443A12',
            }}
          />
        )}
      </Box>

      {loading ? (
        <Box sx={{ p: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '280px minmax(0,1fr)' }, gap: 2 }}>
          <Skeleton variant="rounded" height={180} sx={{ borderRadius: '8px' }} />
          <Skeleton variant="rounded" height={280} sx={{ borderRadius: '8px' }} />
        </Box>
      ) : error && !incidents.length ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography sx={{ color: '#C4443A', fontSize: '0.78rem', fontWeight: 800 }}>
            Post-mortem history could not load
          </Typography>
          <Typography sx={{ color: t.muted, fontSize: '0.68rem', mt: 0.4 }}>{error}</Typography>
          <Button
            onClick={() => setRetry((value) => value + 1)}
            startIcon={<RefreshIcon />}
            sx={{ mt: 1, color: t.rust, textTransform: 'none' }}
          >
            Try again
          </Button>
        </Box>
      ) : !incidents.length ? (
        <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
          <RecoveredIcon sx={{ color: '#2E9E5B', mb: 0.75 }} />
          <Typography sx={{ color: t.ink, fontSize: '0.8rem', fontWeight: 800 }}>
            No persisted outage incidents yet
          </Typography>
          <Typography sx={{ color: t.muted, fontSize: '0.7rem', mt: 0.4, maxWidth: '62ch', mx: 'auto' }}>
            Power, internet, collector, and unknown incidents will appear here automatically. A report is created only after recovery remains stable.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '300px minmax(0,1fr)' }, minWidth: 0 }}>
          <Box sx={{
            p: 1,
            display: 'grid',
            alignContent: 'start',
            gap: 0.25,
            borderRight: { xs: 'none', md: `1px solid ${t.line}` },
            borderBottom: { xs: `1px solid ${t.line}`, md: 'none' },
            maxHeight: { xs: 260, md: 720 },
            overflowY: 'auto',
          }}>
            {incidents.map((incident) => (
              <IncidentListRow
                key={incident.id}
                t={t}
                incident={incident}
                selected={selectedId === incident.id}
                onSelect={() => setSelectedId(incident.id)}
                clock={clock}
              />
            ))}
          </Box>
          <Box sx={{ p: { xs: 1.5, md: 2 }, minWidth: 0, maxHeight: { md: 720 }, overflowY: 'auto' }}>
            {error && (
              <Typography sx={{ color: '#C4443A', fontSize: '0.68rem', fontWeight: 750, mb: 1 }}>
                Refresh failed; showing the last loaded report.
              </Typography>
            )}
            {detailLoading || !detail || detail.id !== selectedId ? (
              <Box sx={{ display: 'grid', gap: 1 }}>
                <Skeleton width="45%" />
                <Skeleton />
                <Skeleton />
                <Skeleton variant="rounded" height={180} sx={{ borderRadius: '8px' }} />
              </Box>
            ) : (
              <IncidentDetailView t={t} detail={detail} clock={clock} />
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}
