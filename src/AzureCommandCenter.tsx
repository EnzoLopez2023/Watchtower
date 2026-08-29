import { apiFetch } from './services/apiClient';
import { CARD_RADIUS } from './theme/controls'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Box, Typography, Chip, CircularProgress, IconButton, Tooltip, TextField, InputAdornment,
  Select, MenuItem, FormControl, Button, Dialog,
} from '@mui/material'
import {
  Refresh as RefreshIcon,
  Cloud as CloudIcon,
  Inventory2 as ResourcesIcon,
  AppShortcut as WebAppIcon,
  Memory as PlanIcon,
  Storage as AcrIcon,
  AutoAwesome as AiIcon,
  AttachMoney as CostIcon,
  Search as SearchIcon,
  Close as CloseIcon,
  CheckCircle as OkIcon,
  Error as ErrorIcon,
  Warning as WarnIcon,
  ChevronRight as ChevronIcon,
  Folder as RgIcon,
} from '@mui/icons-material'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer,
  AreaChart, Area, Line, ComposedChart, Legend,
} from 'recharts'
import { motion, AnimatePresence, useMotionValue, useTransform, animate, useScroll } from 'framer-motion'
import SectionLabel from './components/SectionLabel'
import { useThemeMode } from './context/ThemeContext'
import { tokensFor } from './theme/tokens'
import { withAlpha } from './theme/contrast'

// ── Theme-aware palette ────────────────────────────────────────────────────
// Neutrals and the accent come from the tokens in force, so the palette, accent
// and text colour pinned to this page in the theme flyout actually reach it —
// this block used to be a hard-coded ramp that nothing could override.
//
// green/red/blue/amber stay fixed: they carry resource state (running, failed,
// degraded), and a status that changes meaning with the theme is worse than one
// that clashes with it. az* are Microsoft brand colours for the background mesh.
function useC() {
  const { mode, palette } = useThemeMode()
  const d = mode === 'dark'
  const t = tokensFor(d, palette)
  const border = t.line
  return {
    dark: d,
    bg:      t.bg,
    surface: t.surface,
    paper:   t.paper,
    border,
    ink:     t.ink,
    muted:   t.muted,
    rust:    d ? t.rustLight : t.rustDark,
    rustBg:  withAlpha(d ? t.rustLight : t.rustDark, d ? 0.18 : 0.10),
    green:   d ? '#7CAE6A' : '#4F7A3E',
    red:     d ? '#D47A6A' : '#B05945',
    blue:    d ? '#7AA8C4' : '#4A7A9B',
    amber:   d ? '#DCB87A' : '#9A7A20',
    // Azure brand accents — used by the animated background mesh
    azBlue:    d ? '#41AAFF' : '#0078D4',
    azGlow:    d ? 'rgba(65,170,255,0.32)' : 'rgba(0,120,212,0.20)',
    azDeep:    d ? '#0a1432' : '#cde4ff',
  }
}

const MONO = '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace'

type Tab = 'overview' | 'resources' | 'webapps' | 'plans' | 'acr' | 'cognitive' | 'cost'

// ── API response types ────────────────────────────────────────────────────

interface ResourceGroupSummary { name: string; location: string; tags: Record<string,string>; resourceCount: number }
interface Overview {
  subscription:   { id: string; tenantId: string }
  counts:         { resourceGroups: number; resources: number; webApps: number; appServicePlans: number; acrRegistries: number; cognitiveAccounts: number }
  resourceGroups: ResourceGroupSummary[]
  webAppsByState: Record<string, number>
  aggregates: {
    totalMemoryBytes: number
    webAppMemorySamples: Array<{ name: string; state?: string; bytes: number | null; bytesPeak30?: number | null; bytesAvg30?: number | null; sampleAt?: string | null }>
    calculation?: string
  }
}
interface BudgetData {
  cycle: { startDate: string; endDate: string; daysElapsed: number; daysLeft: number; cycleDays: number }
  currency: string
  mtdSpend: number
  dailyAvg: number
  projectedTotal: number
  vsEnterpriseCredit: number
  userBudgets: Array<{ name: string; amount: { amount: number; unit: string } | number; timeGrain: string; currentSpend: number | null }>
}
interface ResourceRow {
  id: string; name: string; type: string; kind?: string; location: string
  tags: Record<string,string>; resourceGroup: string | null
}
interface ResourceDetail {
  id: string; name: string; type: string; kind?: string; location: string
  tags: Record<string,string>; sku: unknown; properties: Record<string, unknown> | null
  plan: unknown; identity: unknown; managedBy?: string
  createdTime?: string; changedTime?: string
}
interface WebAppRow {
  name: string; resourceGroup: string; location: string; state: string; kind?: string
  defaultHostName: string; enabledHostNames?: string[]; httpsOnly: boolean
  linuxFxVersion?: string; planName: string | null; lastModifiedTime?: string
}
interface SeriesPoint { t: string; v: number }
interface WebAppDetail {
  name: string; state: string; kind?: string; location: string; resourceId?: string
  defaultHostName: string; enabledHostNames?: string[]; httpsOnly: boolean
  linuxFxVersion?: string; alwaysOn?: boolean; numberOfWorkers?: number
  acrUseManagedIdentityCreds?: boolean; clientCertEnabled?: boolean; clientAffinityEnabled?: boolean
  reserved?: boolean; minTlsVersion?: string; ftpsState?: string; http20Enabled?: boolean
  planId?: string; planName?: string | null
  lastModifiedTime?: string; createdTime?: string
  appSettings: string[]
  hostnameBindings: Array<{ name: string; sslState?: string; thumbprint?: string; customHostNameDnsRecordType?: string; hostNameType?: string }>
  slots: Array<{ name: string; state: string }>
  identity: { principalId: string; tenantId: string; type: string } | null
  tags: Record<string, string>
  memory24h:     { avg: number | null; max: number | null }
  cpuSeconds24h: { avg: number | null; max: number | null }
  requests24h:   { avg: number | null; max: number | null }
  errors24h:     { avg: number | null; max: number | null }
  series: { memory: SeriesPoint[]; cpu: SeriesPoint[]; requests: SeriesPoint[]; errors: SeriesPoint[] }
}
interface PlanRow {
  // Identity
  name: string; resourceGroup: string; location: string; kind?: string
  // SKU
  skuName?: string; skuTier?: string; skuSize?: string; skuFamily?: string
  capacity?: number
  skuSpec?: { cores: string; ram: string; storage: string; family: string; hourly: number; monthly: number } | null
  pricing?: { hourly: number; monthly: number } | null
  // OS / runtime flags
  reserved?: boolean   // linux = true
  isXenon?: boolean
  hyperV?: boolean
  isSpot?: boolean
  spotExpirationTime?: string
  freeOfferExpirationTime?: string
  // Scale
  perSiteScaling?: boolean
  elasticScaleEnabled?: boolean
  maximumElasticWorkerCount?: number
  maximumNumberOfWorkers?: number
  numberOfWorkers?: number
  targetWorkerCount?: number
  targetWorkerSizeId?: number
  workerTierName?: string
  // Reliability
  zoneRedundant?: boolean
  status?: string
  provisioningState?: string
  // Geography + housekeeping
  geoRegion?: string
  adminSiteName?: string
  numberOfSites?: number
  tags?: Record<string, string>
  // Metric summaries
  cpu24h:        { avg: number | null }
  cpu24hPeak:    { max: number | null }
  memory24h:     { avg: number | null }
  memory24hPeak: { max: number | null }
  diskQueue24h?: { max: number | null }
  httpQueue24h?: { max: number | null }
  bytesIn24h?:   { latest: number | null }
  bytesOut24h?:  { latest: number | null }
  // Sites on the plan
  sites?: Array<{
    name: string; state?: string; kind?: string; defaultHostName?: string
    httpsOnly?: boolean; linuxFxVersion?: string; resourceGroup: string
  }>
  // Sparkline series
  series?: {
    cpu: SeriesPoint[]
    memory: SeriesPoint[]
    diskQueue: SeriesPoint[]; httpQueue: SeriesPoint[]
    bytesReceived: SeriesPoint[]; bytesSent: SeriesPoint[]
  }
}
interface AcrRow {
  name: string; resourceGroup: string; location: string; sku?: string
  loginServer: string; adminEnabled?: boolean; createdAt?: string; publicNetworkAccess?: string
}
interface AcrRun {
  runId: string; status: string; runType?: string
  createTime?: string; startTime?: string; finishTime?: string
  imageManifests: string[]
}
interface DeploymentReference {
  name: string
  resourceGroup: string | null
  settingKeys: string[]
  kind?: 'runtime' | 'build-time' | string
  via?: string
}
interface CognitiveAccount {
  name: string; resourceGroup: string; location: string; kind?: string; sku?: string
  endpoint?: string; provisioningState?: string
  deployments: Array<{
    name: string; model?: string; version?: string; format?: string; sku?: string; capacity?: number; state?: string;
    referencedBy?: DeploymentReference[];
  }>
}
interface CostData {
  mode?: string; label?: string; days: number; from?: string; to?: string
  total: number; currency: string
  daily: Array<{ date: string; cost: number }>
  services: Array<{ service: string; cost: number }>
  // Long-form rows: one entry per (date, service) pair. Frontend pivots into
  // a wide row per day to feed recharts. Optional because cached responses
  // from before this field existed may not include it.
  dailyByService?: Array<{ date: string; service: string; cost: number }>
}

interface AcrSourceTriggerEvent {
  providerType?: string; eventType?: string; commitId?: string
  repositoryUrl?: string; branchName?: string
}
interface AcrSourceTrigger {
  eventType?: string; isGitCommitTrigger?: boolean
  sourceTriggerEvent?: AcrSourceTriggerEvent
}
interface AcrRunDetail {
  runId: string; status: string; runType?: string
  createTime?: string; startTime?: string; finishTime?: string; lastUpdatedTime?: string
  isArchiveEnabled?: boolean; provisioningState?: string; runErrorMessage?: string
  taskName?: string
  agentConfiguration?: { cpu?: number } | null
  platform?: { os?: string; architecture?: string } | null
  sourceTrigger?: AcrSourceTrigger | null; sourceRegistryAuth?: string | null
  imageUpdateTrigger?: unknown; timerTrigger?: unknown
  outputImages: Array<{ registry?: string; repository?: string; tag?: string; digest?: string }>
  customRegistries?: unknown
  logAvailable?: boolean; logTail?: string | null
}

interface CognitiveDeploymentDetail {
  name: string; id?: string; etag?: string
  sku?: { name?: string; tier?: string; capacity?: number } | null
  provisioningState?: string
  model: { format?: string; name?: string; version?: string; publisher?: string | null; source?: string | null }
  capabilities?: Record<string, string> | null
  raiPolicyName?: string | null
  versionUpgradeOption?: string | null
  currentCapacity?: number | null
  rateLimits?: Array<{ key?: string; renewalPeriod?: number; count?: number }> | null
  scaleSettings?: { scaleType?: string; capacity?: number } | null
  dynamicThrottlingEnabled?: boolean | null
  callRateLimit?: unknown
  parentDeploymentName?: string | null
  raw?: unknown
}

interface CostServiceDetail {
  service: string; mode?: string; label?: string; from?: string; to?: string
  total: number; currency: string
  daily: Array<{ date: string; cost: number }>
  resources: Array<{ resourceId: string; name: string; cost: number }>
  meters: Array<{ meter: string; cost: number }>
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string { return v == null ? '—' : `${v.toFixed(1)}%` }
function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}
function fmtBytes(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v < 1024) return `${v} B`
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`
  return `${(v / 1024 ** 3).toFixed(2)} GB`
}
function fmtMoney(v: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v)
}
function fmtMoneyCompact(v: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v)
}
function fmtDateTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtDateShort(iso?: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function shortType(type: string): string { return type.split('/').slice(1).join('/') }
function stateColor(state: string, C: ReturnType<typeof useC>) {
  if (state === 'Running') return C.green
  if (state === 'Stopped') return C.muted
  return C.amber
}

// ── Animated number ──────────────────────────────────────────────────────
function CountUp({ value, decimals = 0, prefix = '', suffix = '' }: { value: number; decimals?: number; prefix?: string; suffix?: string }) {
  const mv = useMotionValue(0)
  const [display, setDisplay] = useState('0')
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] })
    const unsub = mv.on('change', v => setDisplay(v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })))
    return () => { controls.stop(); unsub() }
  }, [value, decimals, mv])
  return <>{prefix}{display}{suffix}</>
}

function MoneyUp({ value, currency = 'USD' }: { value: number; currency?: string }) {
  const mv = useMotionValue(0)
  const [display, setDisplay] = useState(fmtMoney(0, currency))
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] })
    const unsub = mv.on('change', v => setDisplay(fmtMoney(v, currency)))
    return () => { controls.stop(); unsub() }
  }, [value, currency, mv])
  return <>{display}</>
}

// ── Animated Azure-themed background ──────────────────────────────────────
//
// SVG hex pattern + radial glow that drifts on scroll. Stays absolute behind
// the content so cards "float" on top.
function BackgroundParallax({ scrollContainer }: { scrollContainer?: React.RefObject<HTMLElement> }) {
  const C = useC()
  const { scrollY } = useScroll({ container: scrollContainer })
  const yMesh   = useTransform(scrollY, [0, 1000], [0, -180])
  const yGlow1  = useTransform(scrollY, [0, 1000], [0, -120])
  const yGlow2  = useTransform(scrollY, [0, 1000], [0, -80])
  const yLines  = useTransform(scrollY, [0, 1000], [0, -240])
  const opacity = C.dark ? 0.9 : 0.55
  return (
    <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      {/* Base gradient backplate — transparent so the themed 'sky' wallpaper
          (App-level) shows through; the hex mesh + glows below stay as overlays. */}
      <Box sx={{ position: 'absolute', inset: 0, background: 'transparent' }} />

      {/* Hex mesh — pure SVG, drifts on scroll */}
      <motion.div style={{ position: 'absolute', inset: 0, y: yMesh, opacity }}>
        <svg width="100%" height="140%" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
          <defs>
            <pattern id="hex" x="0" y="0" width="56" height="48" patternUnits="userSpaceOnUse">
              <path d="M28 0 L56 16 L56 32 L28 48 L0 32 L0 16 Z" fill="none" stroke={C.azBlue} strokeWidth="0.6" opacity="0.55" />
            </pattern>
            <radialGradient id="hexFade" cx="60%" cy="20%" r="80%">
              <stop offset="0%"   stopColor="white" stopOpacity="0.7" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </radialGradient>
            <mask id="hexMask">
              <rect width="100%" height="100%" fill="url(#hexFade)" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="url(#hex)" mask="url(#hexMask)" />
        </svg>
      </motion.div>

      {/* Two soft glow orbs */}
      <motion.div style={{
        position: 'absolute', top: '-10%', right: '-12%', width: 480, height: 480,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${C.azGlow} 0%, transparent 60%)`,
        filter: 'blur(40px)', y: yGlow1,
      }} animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }} />
      <motion.div style={{
        position: 'absolute', top: '40%', left: '-8%', width: 360, height: 360,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${C.rustBg} 0%, transparent 60%)`,
        filter: 'blur(50px)', y: yGlow2,
      }} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut', delay: 4 }} />

      {/* Faint horizontal scanlines for extra "techie" texture */}
      <motion.div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `repeating-linear-gradient(0deg, ${C.dark ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.020)'} 0px, transparent 2px, transparent 4px)`,
        y: yLines,
      }} />
    </Box>
  )
}

// ── Card wrapper that lifts on hover ─────────────────────────────────────
function FloatingCard({ children, onClick, sx, glow = false, delay = 0 }: { children: React.ReactNode; onClick?: () => void; sx?: object; glow?: boolean; delay?: number }) {
  const C = useC()
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
      whileHover={onClick ? { y: -3 } : undefined}
      style={{ position: 'relative' }}
    >
      <Box onClick={onClick} sx={{
        position: 'relative',
        bgcolor: C.dark ? 'rgba(30,31,42,0.78)' : 'rgba(251,245,230,0.92)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: `1px solid ${C.border}`,
        borderRadius: CARD_RADIUS,
        boxShadow: glow
          ? `0 0 0 1px ${C.azGlow}, 0 18px 40px -20px ${C.azGlow}`
          : C.dark ? '0 12px 32px -22px rgba(0,0,0,0.7)' : '0 12px 32px -22px rgba(92,42,74,0.18)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.2s, box-shadow 0.2s',
        '&:hover': onClick ? {
          borderColor: C.azBlue,
          boxShadow: `0 0 0 1px ${C.azGlow}, 0 20px 44px -18px ${C.azGlow}`,
        } : undefined,
        ...sx,
      }}>
        {children}
      </Box>
    </motion.div>
  )
}

// ── Stat card (used heavily on Overview) ─────────────────────────────────
function StatCard({ label, value, sublabel, color, decimals, prefix, suffix, money, currency, delay = 0, onClick }: {
  label: string; value: number; sublabel?: React.ReactNode; color?: string; decimals?: number;
  prefix?: string; suffix?: string; money?: boolean; currency?: string; delay?: number; onClick?: () => void;
}) {
  const C = useC()
  return (
    <FloatingCard onClick={onClick} delay={delay} sx={{ p: 2 }}>
      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.1em', mb: 0.5 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: '1.75rem', fontWeight: 800, color: color || C.azBlue, lineHeight: 1, fontFeatureSettings: '"tnum"', fontFamily: MONO }}>
        {money
          ? <MoneyUp value={value} currency={currency} />
          : <CountUp value={value} decimals={decimals} prefix={prefix} suffix={suffix} />}
      </Typography>
      {sublabel != null && (
        <Typography sx={{ fontSize: '0.72rem', color: C.muted, mt: 0.5 }}>{sublabel}</Typography>
      )}
    </FloatingCard>
  )
}

// Section captions sit between cards, directly on the page wallpaper, so they
// go through the shared SectionLabel: it takes its colour from the tokens in
// force (rather than this page's local hard-coded ramp, which the theme flyout
// cannot reach) and draws a scrim plate behind itself. `inCard` turns the plate
// off for the two headers nested inside a FloatingCard, which has its own surface.
function SectionHeader({ label, action, inCard = false }: { label: string; action?: React.ReactNode; inCard?: boolean }) {
  return (
    <SectionLabel
      action={action}
      plate={inCard ? false : undefined}
      sx={{ mb: 1.5, mt: 1, position: 'relative', zIndex: 1 }}
    >
      {label}
    </SectionLabel>
  )
}

// Generic resource detail dialog body — renders any object as a key-value
// list, recursing one level into nested objects. Used by both the Resources
// tab and the Overview "click a RG" popup.
function KVList({ obj, max = 32 }: { obj: Record<string, unknown> | null | undefined; max?: number }) {
  const C = useC()
  if (!obj || Object.keys(obj).length === 0) return <Typography sx={{ color: C.muted, fontSize: '0.82rem' }}>—</Typography>
  const entries = Object.entries(obj).slice(0, max)
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '180px 1fr', columnGap: 1.5, rowGap: 0.5 }}>
      {entries.map(([k, v]) => {
        const isObj = v && typeof v === 'object' && !Array.isArray(v)
        return (
          <>
            <Typography key={`k-${k}`} sx={{ fontSize: '0.7rem', color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, alignSelf: 'start', mt: 0.25 }}>
              {k}
            </Typography>
            <Box key={`v-${k}`} sx={{ minWidth: 0 }}>
              {isObj ? (
                <Box sx={{ pl: 1, borderLeft: `2px solid ${C.border}`, ml: -0.5 }}>
                  <KVList obj={v as Record<string, unknown>} max={12} />
                </Box>
              ) : (
                <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>
                  {typeof v === 'string' ? v : v == null ? '—' : JSON.stringify(v)}
                </Typography>
              )}
            </Box>
          </>
        )
      })}
    </Box>
  )
}

// ── Main component ───────────────────────────────────────────────────────

export default function AzureCommandCenter() {
  const C = useC()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  // Per-tab data
  const [overview, setOverview]     = useState<Overview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [budget, setBudget]         = useState<BudgetData | null>(null)
  const [resources, setResources]   = useState<ResourceRow[]>([])
  const [resourcesLoading, setResourcesLoading] = useState(false)
  const [resourceFilter, setResourceFilter] = useState('')
  const [resourceTypeFilter, setResourceTypeFilter] = useState('')
  const [openResource, setOpenResource] = useState<ResourceRow | null>(null)
  const [resourceDetail, setResourceDetail] = useState<ResourceDetail | null>(null)
  const [resourceDetailLoading, setResourceDetailLoading] = useState(false)
  const [openRg, setOpenRg]         = useState<ResourceGroupSummary | null>(null)
  const [rgResources, setRgResources] = useState<ResourceRow[]>([])
  const [rgResourcesLoading, setRgResourcesLoading] = useState(false)
  const [webapps, setWebapps]       = useState<WebAppRow[]>([])
  const [webappsLoading, setWebappsLoading] = useState(false)
  const [openWebApp, setOpenWebApp] = useState<WebAppRow | null>(null)
  const [webAppDetail, setWebAppDetail] = useState<WebAppDetail | null>(null)
  const [webAppDetailLoading, setWebAppDetailLoading] = useState(false)
  const [plans, setPlans]           = useState<PlanRow[]>([])
  const [plansLoading, setPlansLoading] = useState(false)
  const [acrs, setAcrs]             = useState<AcrRow[]>([])
  const [acrRuns, setAcrRuns]       = useState<Record<string, AcrRun[]>>({})
  const [acrLoading, setAcrLoading] = useState(false)
  const [cognitive, setCognitive]   = useState<CognitiveAccount[]>([])
  const [cognitiveLoading, setCognitiveLoading] = useState(false)
  const [cost, setCost]             = useState<CostData | null>(null)
  const [costDays, setCostDays]     = useState(30)
  const [costMode, setCostMode]     = useState<'days' | 'cycle'>('days')
  const [costLoading, setCostLoading] = useState(false)
  const [costError, setCostError]   = useState<string | null>(null)
  const [openMemory, setOpenMemory] = useState(false)
  const [openRun, setOpenRun]       = useState<{ rg: string; reg: string; runId: string } | null>(null)
  const [runDetail, setRunDetail]   = useState<AcrRunDetail | null>(null)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const [openDeployment, setOpenDeployment] = useState<{ rg: string; account: string; name: string } | null>(null)
  const [depDetail, setDepDetail]   = useState<CognitiveDeploymentDetail | null>(null)
  const [depDetailLoading, setDepDetailLoading] = useState(false)
  const [openService, setOpenService] = useState<string | null>(null)
  const [serviceDetail, setServiceDetail] = useState<CostServiceDetail | null>(null)
  const [serviceDetailLoading, setServiceDetailLoading] = useState(false)
  // Liveness — Overview tab + the cycle progress bar both want a
  // visible "Updated Xs ago" so the user can tell whether the data is
  // current or being silently held over.
  const [overviewUpdatedAt, setOverviewUpdatedAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())

  const loaded = useRef<Record<Tab, boolean>>({} as Record<Tab, boolean>)
  // Monotonic id so the Cost loader can ignore out-of-order responses: when
  // the user clicks through 7d→…→90d→CTD, each fires an uncached (slow) Azure
  // query and they can resolve in any order. Only the latest call may setCost,
  // otherwise a stale earlier click can overwrite the current selection.
  const costReqId = useRef(0)

  // ── Loaders ─────────────────────────────────────────────────────────────
  // silent=true → background refresh: skip the loading spinner so polling
  // doesn't flash every minute, but still update state + updatedAt.
  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setOverviewLoading(true)
    try {
      const [oR, bR] = await Promise.all([apiFetch('/api/azure/overview'), apiFetch('/api/azure/budget')])
      if (oR.ok) setOverview(await oR.json())
      if (bR.ok) setBudget(await bR.json())
      setOverviewUpdatedAt(Date.now())
    } finally { if (!silent) setOverviewLoading(false) }
  }, [])

  const loadResources = useCallback(async () => {
    setResourcesLoading(true)
    try { const r = await apiFetch('/api/azure/resources'); if (r.ok) { const d = await r.json(); setResources(d.data) } }
    finally { setResourcesLoading(false) }
  }, [])

  const loadWebApps = useCallback(async () => {
    setWebappsLoading(true)
    try { const r = await apiFetch('/api/azure/webapps'); if (r.ok) { const d = await r.json(); setWebapps(d.data) } }
    finally { setWebappsLoading(false) }
  }, [])

  const loadPlans = useCallback(async () => {
    setPlansLoading(true)
    try { const r = await apiFetch('/api/azure/plans'); if (r.ok) { const d = await r.json(); setPlans(d.data) } }
    finally { setPlansLoading(false) }
  }, [])

  const loadAcr = useCallback(async () => {
    setAcrLoading(true)
    try {
      const r = await apiFetch('/api/azure/acr')
      if (!r.ok) return
      const { data } = await r.json() as { data: AcrRow[] }
      setAcrs(data)
      const runMap: Record<string, AcrRun[]> = {}
      await Promise.all(data.map(async reg => {
        const rr = await apiFetch(`/api/azure/acr/${reg.resourceGroup}/${reg.name}/runs?limit=10`)
        if (rr.ok) { const rd = await rr.json(); runMap[reg.name] = rd.data }
      }))
      setAcrRuns(runMap)
    } finally { setAcrLoading(false) }
  }, [])

  const loadCognitive = useCallback(async () => {
    setCognitiveLoading(true)
    try { const r = await apiFetch('/api/azure/cognitive'); if (r.ok) { const d = await r.json(); setCognitive(d.data) } }
    finally { setCognitiveLoading(false) }
  }, [])

  const loadCost = useCallback(async (mode: 'days' | 'cycle', days: number) => {
    const reqId = ++costReqId.current
    setCostLoading(true)
    setCostError(null)
    const url = mode === 'cycle' ? '/api/azure/cost?mode=cycle' : `/api/azure/cost?days=${days}`
    try {
      // Azure Cost Management is heavily rate-limited (429). Retry a couple
      // times with backoff before surfacing an error. The reqId guard means a
      // newer selection always wins — a stale earlier request can never
      // clobber the current view, even mid-retry.
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await apiFetch(url)
        if (reqId !== costReqId.current) return // superseded by a newer click
        if (r.ok) { setCost(await r.json()); return }
        if (r.status === 429 || r.status >= 500) {
          await new Promise(res => setTimeout(res, 800 * (attempt + 1)))
          if (reqId !== costReqId.current) return
          continue
        }
        break // non-retryable error
      }
      if (reqId === costReqId.current) {
        setCostError('Azure cost data is rate-limited right now — try again in a moment.')
      }
    } catch {
      if (reqId === costReqId.current) setCostError('Failed to load cost data.')
    } finally {
      if (reqId === costReqId.current) setCostLoading(false)
    }
  }, [])

  // Lazy-load each tab on first activation
  useEffect(() => {
    if (loaded.current[tab]) return
    loaded.current[tab] = true
    switch (tab) {
      case 'overview':  void loadOverview(); break
      case 'resources': void loadResources(); break
      case 'webapps':   void loadWebApps(); break
      // Plans co-loads webapps so the "Sites on this plan" cards can deep-link
      // into the same web-app detail dialog used elsewhere — without this the
      // first-visit-plans path leaves `webapps` empty and the click-through
      // silently no-ops.
      case 'plans':     void loadPlans(); if (!loaded.current.webapps) { loaded.current.webapps = true; void loadWebApps() } break
      case 'acr':       void loadAcr(); break
      case 'cognitive': void loadCognitive(); break
      case 'cost':      void loadCost(costMode, costDays); break
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Reload when the time filter changes — bug fix from before, plus now
  // also handles the new "Current cycle" mode.
  useEffect(() => {
    if (tab === 'cost') void loadCost(costMode, costDays)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costDays, costMode])

  // Background refresh for the Overview tab — silent refetch every 60s and
  // on tab focus / visibility-change. Without this the live aggregate and
  // cycle progress freeze at whatever was on screen at first paint.
  useEffect(() => {
    if (tab !== 'overview') return
    let cancelled = false
    const tick = () => { if (!document.hidden && !cancelled) void loadOverview(true) }
    const id = window.setInterval(tick, 60000)
    const onFocus = () => { if (!cancelled) void loadOverview(true) }
    const onVis = () => { if (!document.hidden && !cancelled) void loadOverview(true) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tab, loadOverview])

  // Tick the "Updated Xs ago" label between fetches so it visibly advances.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 15000)
    return () => window.clearInterval(id)
  }, [])

  // Web App detail fetch
  useEffect(() => {
    if (!openWebApp) { setWebAppDetail(null); return }
    let cancelled = false
    setWebAppDetailLoading(true); setWebAppDetail(null)
    void apiFetch(`/api/azure/webapps/${openWebApp.resourceGroup}/${openWebApp.name}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setWebAppDetail(d) })
      .finally(() => { if (!cancelled) setWebAppDetailLoading(false) })
    return () => { cancelled = true }
  }, [openWebApp])

  // Resource detail fetch
  useEffect(() => {
    if (!openResource) { setResourceDetail(null); return }
    let cancelled = false
    setResourceDetailLoading(true); setResourceDetail(null)
    void apiFetch(`/api/azure/resource?id=${encodeURIComponent(openResource.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setResourceDetail(d) })
      .finally(() => { if (!cancelled) setResourceDetailLoading(false) })
    return () => { cancelled = true }
  }, [openResource])

  // RG detail fetch — fetch all resources in the clicked RG
  useEffect(() => {
    if (!openRg) { setRgResources([]); return }
    let cancelled = false
    setRgResourcesLoading(true); setRgResources([])
    void apiFetch(`/api/azure/resources?rg=${encodeURIComponent(openRg.name)}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(d => { if (!cancelled) setRgResources(d.data || []) })
      .finally(() => { if (!cancelled) setRgResourcesLoading(false) })
    return () => { cancelled = true }
  }, [openRg])

  // ACR run detail fetch
  useEffect(() => {
    if (!openRun) { setRunDetail(null); return }
    let cancelled = false
    setRunDetailLoading(true); setRunDetail(null)
    void apiFetch(`/api/azure/acr/${openRun.rg}/${openRun.reg}/runs/${openRun.runId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setRunDetail(d) })
      .finally(() => { if (!cancelled) setRunDetailLoading(false) })
    return () => { cancelled = true }
  }, [openRun])

  // Cognitive deployment detail fetch
  useEffect(() => {
    if (!openDeployment) { setDepDetail(null); return }
    let cancelled = false
    setDepDetailLoading(true); setDepDetail(null)
    void apiFetch(`/api/azure/cognitive/${openDeployment.rg}/${openDeployment.account}/deployments/${openDeployment.name}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setDepDetail(d) })
      .finally(() => { if (!cancelled) setDepDetailLoading(false) })
    return () => { cancelled = true }
  }, [openDeployment])

  // Cost-by-service detail fetch — uses the same range that's currently
  // active in the Cost tab so the service drilldown matches the parent view.
  useEffect(() => {
    if (!openService) { setServiceDetail(null); return }
    let cancelled = false
    setServiceDetailLoading(true); setServiceDetail(null)
    const url = costMode === 'cycle'
      ? `/api/azure/cost/service?service=${encodeURIComponent(openService)}&mode=cycle`
      : `/api/azure/cost/service?service=${encodeURIComponent(openService)}&days=${costDays}`
    void apiFetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setServiceDetail(d) })
      .finally(() => { if (!cancelled) setServiceDetailLoading(false) })
    return () => { cancelled = true }
  }, [openService, costMode, costDays])

  const refreshActive = () => {
    loaded.current[tab] = false
    switch (tab) {
      case 'overview':  void loadOverview(); break
      case 'resources': void loadResources(); break
      case 'webapps':   void loadWebApps(); break
      case 'plans':     void loadPlans(); break
      case 'acr':       void loadAcr(); break
      case 'cognitive': void loadCognitive(); break
      case 'cost':      void loadCost(costMode, costDays); break
    }
  }

  // ── Computed views ────────────────────────────────────────────────────
  const uniqueTypes = Array.from(new Set(resources.map(r => r.type))).sort()
  const filteredResources = resources.filter(r => {
    if (resourceTypeFilter && r.type !== resourceTypeFilter) return false
    if (resourceFilter) {
      const f = resourceFilter.toLowerCase()
      return r.name.toLowerCase().includes(f) ||
             (r.resourceGroup || '').toLowerCase().includes(f) ||
             r.type.toLowerCase().includes(f)
    }
    return true
  })

  // Aggregations used on Overview
  const aggWebMemory = overview?.aggregates?.totalMemoryBytes ?? 0
  const totalWebApps = overview?.counts?.webApps ?? 0
  const runningWebApps = overview?.webAppsByState?.['Running'] ?? 0

  const TAB_LABELS: Record<Tab, string> = {
    overview: 'Overview', resources: 'Resources', webapps: 'Web Apps',
    plans: 'Plans', acr: 'ACR', cognitive: 'AI / OpenAI', cost: 'Cost',
  }
  const TAB_ICONS: Record<Tab, React.ReactNode> = {
    overview:  <CloudIcon sx={{ fontSize: 16 }} />,
    resources: <ResourcesIcon sx={{ fontSize: 16 }} />,
    webapps:   <WebAppIcon sx={{ fontSize: 16 }} />,
    plans:     <PlanIcon sx={{ fontSize: 16 }} />,
    acr:       <AcrIcon sx={{ fontSize: 16 }} />,
    cognitive: <AiIcon sx={{ fontSize: 16 }} />,
    cost:      <CostIcon sx={{ fontSize: 16 }} />,
  }

  return (
    <Box ref={containerRef} sx={{ position: 'relative', minHeight: '100%', color: C.ink, overflow: 'auto', maxHeight: '100vh' }}>
      <BackgroundParallax />

      <Box sx={{ position: 'relative', zIndex: 1, p: 3 }}>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2.5 }}>
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
              <Box sx={{ position: 'relative' }}>
                <CloudIcon sx={{ color: C.azBlue, fontSize: 30, filter: `drop-shadow(0 0 16px ${C.azGlow})` }} />
              </Box>
              <Box>
                <Typography sx={{ fontWeight: 700, fontSize: '1.3rem', color: C.ink, lineHeight: 1.1, letterSpacing: '-0.01em' }}>
                  Azure Command Center
                </Typography>
                <Typography sx={{ fontSize: '0.72rem', color: C.muted, fontFamily: MONO }}>
                  sub · {overview?.subscription?.id?.slice(0, 8)}…{overview?.subscription?.id?.slice(-12) || ''}
                </Typography>
              </Box>
            </Box>
          </motion.div>
          <Tooltip title="Refresh current tab">
            <IconButton onClick={refreshActive} sx={{ color: C.muted, '&:hover': { color: C.azBlue } }}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Tab bar */}
        <Box sx={{ display: 'flex', gap: 0, mb: 3, borderBottom: `1px solid ${C.border}`, overflowX: 'auto', position: 'relative' }}>
          {(['overview', 'resources', 'webapps', 'plans', 'acr', 'cognitive', 'cost'] as Tab[]).map(t => (
            <Box key={t} onClick={() => setTab(t)} sx={{
              display: 'flex', alignItems: 'center', gap: 0.75,
              px: 2, py: 1, cursor: 'pointer', fontSize: '0.85rem', whiteSpace: 'nowrap',
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? C.azBlue : C.muted,
              borderBottom: tab === t ? `2px solid ${C.azBlue}` : '2px solid transparent',
              '&:hover': { color: tab === t ? C.azBlue : C.ink },
              transition: 'color 0.2s',
            }}>
              {TAB_ICONS[t]}{TAB_LABELS[t]}
            </Box>
          ))}
        </Box>

        <AnimatePresence mode="wait">
          {/* ── Overview ── */}
          {tab === 'overview' && (
            <motion.div key="overview" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              {overviewLoading && !overview ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : overview && (
                <Box>
                  {/* Resource counts — clickable, navigate to the matching tab */}
                  <SectionHeader label="At a glance" />
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5, mb: 3 }}>
                    <StatCard label="Resource groups" value={overview.counts.resourceGroups} delay={0.02} onClick={() => setTab('resources')} />
                    <StatCard label="Resources" value={overview.counts.resources} delay={0.06} onClick={() => setTab('resources')} />
                    <StatCard label="Web apps" value={overview.counts.webApps} sublabel={`${runningWebApps} running`} color={C.green} delay={0.10} onClick={() => setTab('webapps')} />
                    <StatCard label="App Svc plans" value={overview.counts.appServicePlans} delay={0.14} onClick={() => setTab('plans')} />
                    <StatCard label="ACR registries" value={overview.counts.acrRegistries} delay={0.18} onClick={() => setTab('acr')} />
                    <StatCard label="Cognitive accts" value={overview.counts.cognitiveAccounts} delay={0.22} onClick={() => setTab('cognitive')} />
                  </Box>

                  {/* Live aggregates: memory + cost cycle */}
                  <SectionHeader
                    label="Live aggregates"
                    action={overviewUpdatedAt && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: C.green, boxShadow: `0 0 6px ${C.green}` }} />
                        <Typography sx={{ fontSize: '0.66rem', color: C.muted, fontFamily: MONO }}>
                          updated {fmtAgo(nowTick - overviewUpdatedAt)}
                        </Typography>
                      </Box>
                    )}
                  />
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5, mb: 3 }}>
                    <StatCard
                      label="Total web app memory"
                      value={Math.round(aggWebMemory / (1024 * 1024))}
                      suffix=" MB"
                      sublabel={`across ${overview.aggregates?.webAppMemorySamples?.filter(s => s.bytes != null).length ?? totalWebApps} apps · click for breakdown`}
                      color={C.azBlue}
                      delay={0.05}
                      onClick={() => setOpenMemory(true)}
                    />
                    {budget && (
                      <>
                        <StatCard
                          label="MTD spend"
                          value={budget.mtdSpend}
                          money
                          currency={budget.currency}
                          sublabel={`${budget.cycle.daysElapsed} of ${budget.cycle.cycleDays} days in cycle`}
                          color={C.rust}
                          delay={0.09}
                        />
                        <StatCard
                          label="Projected (cycle)"
                          value={budget.projectedTotal}
                          money
                          currency={budget.currency}
                          sublabel={`${fmtMoneyCompact(budget.dailyAvg, budget.currency)}/day avg`}
                          color={C.amber}
                          delay={0.13}
                        />
                        <StatCard
                          label="VS Enterprise credit"
                          value={budget.vsEnterpriseCredit}
                          money
                          currency={budget.currency}
                          sublabel={`Resets ${fmtDateShort(budget.cycle.endDate)} (in ${budget.cycle.daysLeft}d)`}
                          color={C.green}
                          delay={0.17}
                        />
                      </>
                    )}
                  </Box>

                  {/* Cost-vs-credit progress bar */}
                  {budget && (
                    <FloatingCard delay={0.18} sx={{ p: 2.5, mb: 3 }}>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 1 }}>
                        <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: C.ink }}>
                          Cycle progress
                        </Typography>
                        <Typography sx={{ fontSize: '0.72rem', color: C.muted, fontFamily: MONO }}>
                          {fmtMoney(budget.mtdSpend, budget.currency)} / {fmtMoney(budget.vsEnterpriseCredit, budget.currency)}
                        </Typography>
                      </Box>
                      <Box sx={{ position: 'relative', height: 10, bgcolor: C.surface, borderRadius: '99px', overflow: 'hidden' }}>
                        {/* Day-of-cycle marker */}
                        <Box sx={{
                          position: 'absolute', top: 0, bottom: 0, left: `${(budget.cycle.daysElapsed / budget.cycle.cycleDays) * 100}%`,
                          width: 2, bgcolor: C.amber, opacity: 0.7,
                        }} />
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.min(100, (budget.mtdSpend / budget.vsEnterpriseCredit) * 100)}%` }}
                          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
                          style={{
                            height: '100%',
                            background: `linear-gradient(90deg, ${C.azBlue} 0%, ${C.rust} 100%)`,
                            borderRadius: '99px',
                          }}
                        />
                      </Box>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
                        <Typography sx={{ fontSize: '0.7rem', color: C.muted, fontFamily: MONO }}>
                          start: {fmtDateShort(budget.cycle.startDate)}
                        </Typography>
                        <Typography sx={{ fontSize: '0.7rem', color: C.amber, fontFamily: MONO }}>
                          today
                        </Typography>
                        <Typography sx={{ fontSize: '0.7rem', color: C.muted, fontFamily: MONO }}>
                          reset: {fmtDateShort(budget.cycle.endDate)}
                        </Typography>
                      </Box>
                    </FloatingCard>
                  )}

                  {/* Web app health rollup */}
                  <SectionHeader label="Web app health" />
                  <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
                    {Object.entries(overview.webAppsByState).map(([state, count], i) => (
                      <motion.div
                        key={state}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.4, delay: 0.03 * i }}
                      >
                        <Box sx={{
                          display: 'flex', alignItems: 'center', gap: 0.75,
                          bgcolor: C.dark ? 'rgba(30,31,42,0.78)' : 'rgba(251,245,230,0.92)',
                          border: `1px solid ${C.border}`,
                          backdropFilter: 'blur(10px)',
                          borderRadius: CARD_RADIUS, px: 1.5, py: 0.75,
                        }}>
                          {state === 'Running' ? <OkIcon sx={{ fontSize: 18, color: C.green }} /> :
                           state === 'Stopped' ? <ErrorIcon sx={{ fontSize: 18, color: C.muted }} /> :
                           <WarnIcon sx={{ fontSize: 18, color: C.amber }} />}
                          <Typography sx={{ fontSize: '0.82rem', color: C.ink }}>{count} {state}</Typography>
                        </Box>
                      </motion.div>
                    ))}
                  </Box>

                  {/* Resource groups — clickable */}
                  <SectionHeader label="Resource groups" />
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 }}>
                    {overview.resourceGroups.map((rg, i) => (
                      <FloatingCard key={rg.name} onClick={() => setOpenRg(rg)} delay={0.05 + i * 0.04} sx={{ p: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1 }}>
                          <RgIcon sx={{ color: C.azBlue, fontSize: 22 }} />
                          <Typography sx={{ flex: 1, fontSize: '0.96rem', fontWeight: 700, color: C.ink, fontFamily: MONO, wordBreak: 'break-all' }}>
                            {rg.name}
                          </Typography>
                          <ChevronIcon sx={{ fontSize: 18, color: C.muted }} />
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                          <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{rg.location}</Typography>
                          <Typography sx={{ fontSize: '0.96rem', fontWeight: 700, color: C.azBlue, fontFamily: MONO }}>
                            <CountUp value={rg.resourceCount} />
                            <Typography component="span" sx={{ fontSize: '0.7rem', color: C.muted, ml: 0.5 }}>res</Typography>
                          </Typography>
                        </Box>
                      </FloatingCard>
                    ))}
                  </Box>
                </Box>
              )}
            </motion.div>
          )}

          {/* ── Resources ── */}
          {tab === 'resources' && (
            <motion.div key="resources" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              <SectionHeader label={`${resources.length} resources across the subscription`} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
                <TextField
                  size="small" placeholder="Filter by name, RG, or type" value={resourceFilter}
                  onChange={e => setResourceFilter(e.target.value)}
                  InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18, color: C.muted }} /></InputAdornment> }}
                  sx={{ flex: 1, minWidth: 240, '& .MuiOutlinedInput-root': { bgcolor: C.paper, fontSize: '0.85rem' } }}
                />
                <FormControl size="small" sx={{ minWidth: 240 }}>
                  <Select value={resourceTypeFilter} onChange={e => setResourceTypeFilter(e.target.value)} displayEmpty
                    sx={{ bgcolor: C.paper, fontSize: '0.85rem' }}>
                    <MenuItem value="">All types ({uniqueTypes.length})</MenuItem>
                    {uniqueTypes.map(t => <MenuItem key={t} value={t}>{shortType(t)} ({resources.filter(r => r.type === t).length})</MenuItem>)}
                  </Select>
                </FormControl>
                <Typography sx={{ fontSize: '0.78rem', color: C.muted }}>{filteredResources.length} of {resources.length}</Typography>
              </Box>
              {resourcesLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <FloatingCard sx={{ overflow: 'hidden' }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr 100px 24px', px: 2, py: 1, borderBottom: `1px solid ${C.border}`, bgcolor: C.surface }}>
                    {['Name', 'RG', 'Type', 'Location', ''].map(h => (
                      <Typography key={h} sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</Typography>
                    ))}
                  </Box>
                  <Box sx={{ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }}>
                    {filteredResources.map((r, i) => (
                      <Box key={r.id} onClick={() => setOpenResource(r)} sx={{
                        display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr 100px 24px',
                        px: 2, py: 1, alignItems: 'center', cursor: 'pointer',
                        borderBottom: i < filteredResources.length - 1 ? `1px solid ${C.border}` : 'none',
                        bgcolor: i % 2 === 0 ? 'transparent' : `${C.surface}40`,
                        transition: 'background-color 0.15s, transform 0.15s',
                        '&:hover': { bgcolor: `${C.azGlow}` },
                      }}>
                        <Typography noWrap sx={{ fontSize: '0.85rem', color: C.ink, fontWeight: 500, fontFamily: MONO }}>{r.name}</Typography>
                        <Typography noWrap sx={{ fontSize: '0.75rem', color: C.muted, fontFamily: MONO }}>{r.resourceGroup || '—'}</Typography>
                        <Tooltip title={r.type} placement="top">
                          <Typography noWrap sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO }}>{shortType(r.type)}</Typography>
                        </Tooltip>
                        <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{r.location}</Typography>
                        <ChevronIcon sx={{ fontSize: 16, color: C.muted }} />
                      </Box>
                    ))}
                  </Box>
                </FloatingCard>
              )}
            </motion.div>
          )}

          {/* ── Web Apps ── */}
          {tab === 'webapps' && (
            <motion.div key="webapps" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              {/* Summary */}
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 1.5, mb: 3 }}>
                <StatCard label="Web apps" value={webapps.length} delay={0.02} />
                <StatCard label="Running" value={webapps.filter(w => w.state === 'Running').length} color={C.green} delay={0.06} />
                <StatCard label="HTTPS-only" value={webapps.filter(w => w.httpsOnly).length} color={C.azBlue} delay={0.10} />
                <StatCard label="Linux containers" value={webapps.filter(w => (w.kind || '').includes('linux')).length} delay={0.14} />
              </Box>
              {webappsLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 1.5 }}>
                  {webapps.map((w, i) => (
                    <FloatingCard key={w.name} onClick={() => setOpenWebApp(w)} delay={0.03 * i} sx={{ p: 2 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Box sx={{
                          width: 9, height: 9, borderRadius: '50%',
                          bgcolor: stateColor(w.state, C),
                          boxShadow: w.state === 'Running' ? `0 0 12px ${C.green}` : 'none',
                        }} />
                        <Typography sx={{ flex: 1, fontWeight: 600, fontSize: '0.95rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-all' }}>{w.name}</Typography>
                        <ChevronIcon sx={{ fontSize: 18, color: C.muted }} />
                      </Box>
                      <Typography sx={{ fontSize: '0.72rem', color: C.muted, fontFamily: MONO, mb: 0.5 }}>{w.defaultHostName}</Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1 }}>
                        <Chip label={w.state} size="small" sx={{ height: 18, fontSize: '0.62rem', bgcolor: `${stateColor(w.state, C)}22`, color: stateColor(w.state, C) }} />
                        {w.linuxFxVersion && (
                          <Chip label={w.linuxFxVersion.replace(/^DOCKER\|/, '').split('/').pop() || w.linuxFxVersion}
                            size="small" sx={{ height: 18, fontSize: '0.62rem', bgcolor: C.rustBg, color: C.rust, fontFamily: MONO }} />
                        )}
                        {w.planName && <Chip label={w.planName} size="small" sx={{ height: 18, fontSize: '0.62rem', bgcolor: C.surface, color: C.muted }} />}
                      </Box>
                    </FloatingCard>
                  ))}
                </Box>
              )}
            </motion.div>
          )}

          {/* ── Plans ── */}
          {tab === 'plans' && (
            <motion.div key="plans" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 1.5, mb: 3 }}>
                <StatCard label="Plans" value={plans.length} delay={0.02} />
                <StatCard label="Total sites" value={plans.reduce((s, p) => s + (p.numberOfSites || 0), 0)} delay={0.06} />
                <StatCard label="Max CPU peak" value={Math.max(0, ...plans.map(p => p.cpu24hPeak.max || 0))} decimals={1} suffix="%" color={C.amber} delay={0.10} />
                <StatCard label="Max Mem peak" value={Math.max(0, ...plans.map(p => p.memory24hPeak.max || 0))} decimals={1} suffix="%" color={C.red} delay={0.14} />
              </Box>
              {plansLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'grid', gap: 1.5 }}>
                  {plans.map((p, i) => {
                    return (
                      <PlanCardFull key={p.name} plan={p} delay={0.04 * i} C={C} onOpenWebApp={(w) => setOpenWebApp(w)} webapps={webapps} />
                    )
                  })}
                </Box>
              )}
            </motion.div>
          )}

          {/* ── ACR ── */}
          {tab === 'acr' && (
            <motion.div key="acr" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 1.5, mb: 3 }}>
                <StatCard label="Registries" value={acrs.length} delay={0.02} />
                <StatCard label="Total recent runs" value={Object.values(acrRuns).reduce((s, r) => s + r.length, 0)} delay={0.06} />
                <StatCard label="Failed runs (recent)" value={Object.values(acrRuns).flat().filter(r => r.status === 'Failed').length} color={C.red} delay={0.10} />
                <StatCard label="Succeeded (recent)" value={Object.values(acrRuns).flat().filter(r => r.status === 'Succeeded').length} color={C.green} delay={0.14} />
              </Box>
              {acrLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {acrs.map((reg, ri) => {
                    const runs = acrRuns[reg.name] || []
                    return (
                      <FloatingCard key={reg.name} delay={0.04 * ri} sx={{ p: 2.5 }}>
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
                          <Typography sx={{ fontWeight: 700, fontSize: '1rem', color: C.ink, fontFamily: MONO }}>{reg.name}</Typography>
                          <Chip label={reg.sku} size="small" sx={{ bgcolor: C.azGlow, color: C.azBlue, fontSize: '0.7rem' }} />
                          <Typography sx={{ fontSize: '0.78rem', color: C.muted, fontFamily: MONO }}>{reg.loginServer}</Typography>
                          {reg.adminEnabled && <Chip label="admin enabled" size="small" sx={{ bgcolor: `${C.amber}22`, color: C.amber, fontSize: '0.66rem' }} />}
                        </Box>
                        <SectionHeader label={`Recent builds (${runs.length})`} inCard />
                        <Box sx={{ overflowX: 'auto' }}>
                          <Box sx={{ minWidth: 700 }}>
                            <Box sx={{ display: 'grid', gridTemplateColumns: '80px 100px 1fr 140px 140px', px: 1.5, py: 0.75, borderBottom: `1px solid ${C.border}`, bgcolor: C.surface }}>
                              {['Run', 'Status', 'Image', 'Started', 'Duration'].map(h => (
                                <Typography key={h} sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</Typography>
                              ))}
                            </Box>
                            {runs.map((r, i) => {
                              const dur = r.startTime && r.finishTime ? (new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()) / 1000 : null
                              return (
                                <Box key={r.runId} onClick={() => setOpenRun({ rg: reg.resourceGroup, reg: reg.name, runId: r.runId })} sx={{
                                  display: 'grid', gridTemplateColumns: '80px 100px 1fr 140px 140px',
                                  px: 1.5, py: 0.75, alignItems: 'center', cursor: 'pointer',
                                  borderBottom: i < runs.length - 1 ? `1px solid ${C.border}` : 'none',
                                  transition: 'background-color 0.15s',
                                  '&:hover': { bgcolor: C.azGlow },
                                }}>
                                  <Typography sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO }}>{r.runId}</Typography>
                                  <Chip label={r.status} size="small" sx={{
                                    height: 18, fontSize: '0.6rem',
                                    bgcolor: r.status === 'Succeeded' ? `${C.green}22` : r.status === 'Failed' ? `${C.red}22` : C.surface,
                                    color: r.status === 'Succeeded' ? C.green : r.status === 'Failed' ? C.red : C.muted,
                                    justifySelf: 'start',
                                  }} />
                                  <Typography noWrap sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO }}>{r.imageManifests.join(', ') || '—'}</Typography>
                                  <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{fmtDateTime(r.startTime)}</Typography>
                                  <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{dur != null ? `${Math.floor(dur)}s` : '—'}</Typography>
                                </Box>
                              )
                            })}
                            {runs.length === 0 && <Box sx={{ py: 2, textAlign: 'center' }}><Typography sx={{ color: C.muted, fontSize: '0.82rem' }}>No recent runs</Typography></Box>}
                          </Box>
                        </Box>
                      </FloatingCard>
                    )
                  })}
                </Box>
              )}
            </motion.div>
          )}

          {/* ── Cognitive ── */}
          {tab === 'cognitive' && (
            <motion.div key="cognitive" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 1.5, mb: 3 }}>
                <StatCard label="Accounts" value={cognitive.length} delay={0.02} />
                <StatCard label="Total deployments" value={cognitive.reduce((s, a) => s + a.deployments.length, 0)} color={C.azBlue} delay={0.06} />
                <StatCard label="OpenAI" value={cognitive.filter(a => (a.kind || '').toLowerCase().includes('openai')).length} delay={0.10} />
                <StatCard label="AI Services" value={cognitive.filter(a => (a.kind || '').toLowerCase().includes('aiservices') || (a.kind || '').toLowerCase().includes('cognitiveservices')).length} delay={0.14} />
              </Box>
              {cognitiveLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {cognitive.map((a, i) => (
                    <FloatingCard key={`${a.resourceGroup}:${a.name}`} delay={0.04 * i} sx={{ p: 2.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 700, fontSize: '1rem', color: C.ink, fontFamily: MONO }}>{a.name}</Typography>
                        <Chip label={a.kind} size="small" sx={{ bgcolor: C.azGlow, color: C.azBlue, fontSize: '0.7rem' }} />
                        <Chip label={a.sku} size="small" sx={{ bgcolor: C.surface, color: C.muted, fontSize: '0.7rem' }} />
                        <Typography sx={{ fontSize: '0.78rem', color: C.muted, ml: 'auto' }}>{a.location} · {a.resourceGroup}</Typography>
                      </Box>
                      {a.endpoint && (
                        <Typography sx={{ fontSize: '0.75rem', color: C.muted, fontFamily: MONO, mb: 1.5, wordBreak: 'break-all' }}>{a.endpoint}</Typography>
                      )}
                      <SectionHeader label={`Deployments (${a.deployments.length})`} inCard />
                      {a.deployments.length === 0 ? (
                        <Typography sx={{ fontSize: '0.82rem', color: C.muted, py: 1 }}>No deployments visible</Typography>
                      ) : (
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1 }}>
                          {a.deployments.map(d => {
                            const refs = d.referencedBy ?? []
                            return (
                              <Box
                                key={d.name}
                                onClick={() => setOpenDeployment({ rg: a.resourceGroup, account: a.name, name: d.name })}
                                sx={{
                                  bgcolor: C.surface, borderRadius: '8px', p: 1.5, cursor: 'pointer',
                                  transition: 'transform 0.15s, box-shadow 0.15s',
                                  '&:hover': { transform: 'translateY(-1px)', boxShadow: `0 6px 18px -10px ${C.azGlow}` },
                                }}
                              >
                                <Typography sx={{ fontWeight: 600, fontSize: '0.86rem', color: C.ink, fontFamily: MONO }}>{d.name}</Typography>
                                <Typography sx={{ fontSize: '0.72rem', color: C.muted }}>
                                  {d.model}{d.version ? ` · ${d.version}` : ''}{d.format ? ` (${d.format})` : ''}
                                </Typography>
                                <Box sx={{ display: 'flex', gap: 1, mt: 0.5, alignItems: 'center' }}>
                                  {d.sku && <Chip label={d.sku} size="small" sx={{ height: 16, fontSize: '0.6rem', bgcolor: C.paper, color: C.muted }} />}
                                  {d.capacity != null && <Typography sx={{ fontSize: '0.7rem', color: C.muted }}>cap {d.capacity}</Typography>}
                                  <ChevronIcon sx={{ fontSize: 14, color: C.muted, ml: 'auto' }} />
                                </Box>
                                {refs.length > 0 ? (
                                  <Box sx={{ mt: 1, pt: 1, borderTop: `1px solid ${C.border}` }}>
                                    <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 0.5 }}>
                                      Used by {refs.length}
                                    </Typography>
                                    <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap' }}>
                                      {refs.map(r => {
                                        const isBuild = r.kind === 'build-time'
                                        const tip = r.via || r.settingKeys.join(', ') || (isBuild ? 'Build-time / dev-only usage' : '')
                                        return (
                                          <Tooltip key={`${r.name}-${r.kind ?? 'rt'}`} title={tip} placement="top">
                                            <Chip
                                              label={r.name.replace(/^app-/, '').replace(/-prod-[a-z0-9]+$/, '') + (isBuild ? ' · build' : '')}
                                              size="small"
                                              sx={{
                                                height: 17, fontSize: '0.6rem', fontFamily: MONO,
                                                bgcolor: isBuild ? `${C.amber}22` : C.azGlow,
                                                color: isBuild ? C.amber : C.azBlue,
                                                fontWeight: 600,
                                                '& .MuiChip-label': { px: 0.75 },
                                              }}
                                            />
                                          </Tooltip>
                                        )
                                      })}
                                    </Box>
                                  </Box>
                                ) : (
                                  <Typography sx={{ fontSize: '0.62rem', color: C.muted, mt: 0.75, fontStyle: 'italic' }}>
                                    Not referenced in any web app's settings or build scripts
                                  </Typography>
                                )}
                              </Box>
                            )
                          })}
                        </Box>
                      )}
                    </FloatingCard>
                  ))}
                </Box>
              )}
            </motion.div>
          )}

          {/* ── Cost ── */}
          {tab === 'cost' && (
            <motion.div key="cost" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
                {[7, 15, 30, 60, 90].map(d => (
                  <Button key={d} onClick={() => { setCostMode('days'); setCostDays(d) }} size="small"
                    sx={{
                      textTransform: 'none', fontSize: '0.78rem',
                      color: costMode === 'days' && costDays === d ? C.azBlue : C.muted,
                      bgcolor: costMode === 'days' && costDays === d ? C.azGlow : 'transparent',
                      '&:hover': { bgcolor: C.azGlow, color: C.azBlue },
                    }}>
                    {d}d
                  </Button>
                ))}
                <Box sx={{ height: 18, width: 1, bgcolor: C.border, mx: 0.5 }} />
                <Tooltip title="Cycle to date — current billing cycle so far">
                  <Button onClick={() => setCostMode('cycle')} size="small"
                    sx={{
                      textTransform: 'none', fontSize: '0.78rem',
                      color: costMode === 'cycle' ? C.azBlue : C.muted,
                      bgcolor: costMode === 'cycle' ? C.azGlow : 'transparent',
                      '&:hover': { bgcolor: C.azGlow, color: C.azBlue },
                    }}>
                    CTD
                  </Button>
                </Tooltip>
                <Box sx={{ flex: 1 }} />
                {cost && (
                  <Box sx={{ textAlign: 'right' }}>
                    <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {cost.label || `${costDays}-day spend`}
                    </Typography>
                    <Typography sx={{ fontSize: '1.7rem', fontWeight: 800, color: C.azBlue, lineHeight: 1, fontFamily: MONO }}><MoneyUp value={cost.total} currency={cost.currency} /></Typography>
                  </Box>
                )}
              </Box>
              {/* Summary cards */}
              {cost && cost.daily.length > 0 && (
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 1.5, mb: 3 }}>
                  <StatCard label="Daily avg" value={cost.total / Math.max(1, cost.daily.length)} money currency={cost.currency} delay={0.05} />
                  <StatCard label="Highest day" value={Math.max(...cost.daily.map(d => d.cost))} money currency={cost.currency} delay={0.09} />
                  <StatCard label="Lowest day" value={Math.min(...cost.daily.map(d => d.cost))} money currency={cost.currency} delay={0.13} />
                  <StatCard label="Top service" value={cost.services[0]?.cost ?? 0} money currency={cost.currency} sublabel={cost.services[0]?.service || '—'} delay={0.17} />
                </Box>
              )}
              {costLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : costError ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 6 }}>
                  <WarnIcon sx={{ fontSize: 28, color: C.amber }} />
                  <Typography sx={{ fontSize: '0.85rem', color: C.muted, textAlign: 'center' }}>{costError}</Typography>
                  <Button onClick={() => loadCost(costMode, costDays)} size="small"
                    sx={{ textTransform: 'none', color: C.azBlue, bgcolor: C.azGlow, '&:hover': { bgcolor: C.azGlow } }}>
                    Retry
                  </Button>
                </Box>
              ) : !cost ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box>
                  <SectionHeader label="Daily spend" />
                  <FloatingCard sx={{ p: 2, mb: 3 }}>
                    <DailySpendChart cost={cost} C={C} />
                  </FloatingCard>

                  <SectionHeader label="By service" />
                  <FloatingCard sx={{ overflow: 'hidden' }}>
                    {cost.services.slice(0, 20).map((s, i) => {
                      const pct = (s.cost / cost.total) * 100
                      return (
                        <Box key={s.service} onClick={() => setOpenService(s.service)} sx={{
                          position: 'relative', cursor: 'pointer',
                          px: 2, py: 1.25,
                          borderBottom: i < Math.min(cost.services.length, 20) - 1 ? `1px solid ${C.border}` : 'none',
                          transition: 'background-color 0.15s',
                          '&:hover': { bgcolor: `${C.azGlow}` },
                        }}>
                          <Box sx={{ position: 'absolute', inset: 0, bgcolor: `${C.azBlue}10`, width: `${pct}%` }} />
                          <Box sx={{ position: 'relative', display: 'grid', gridTemplateColumns: '2fr 80px 1fr 20px', alignItems: 'center' }}>
                            <Typography sx={{ fontSize: '0.85rem', color: C.ink }}>{s.service}</Typography>
                            <Typography sx={{ fontSize: '0.78rem', color: C.muted, fontFamily: MONO, textAlign: 'right' }}>{pct.toFixed(1)}%</Typography>
                            <Typography sx={{ fontSize: '0.85rem', color: C.azBlue, fontWeight: 600, fontFamily: MONO, textAlign: 'right' }}>{fmtMoney(s.cost, cost.currency)}</Typography>
                            <ChevronIcon sx={{ fontSize: 16, color: C.muted, justifySelf: 'end' }} />
                          </Box>
                        </Box>
                      )
                    })}
                  </FloatingCard>
                </Box>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Box>

      {/* ── Web App detail Dialog ── */}
      <Dialog open={!!openWebApp} onClose={() => setOpenWebApp(null)} maxWidth="lg" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openWebApp && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <WebAppIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO }}>{openWebApp.name}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{openWebApp.resourceGroup} · {openWebApp.location} · {openWebApp.state}</Typography>
              </Box>
              <IconButton onClick={() => setOpenWebApp(null)} size="small" sx={{ color: C.muted, '&:hover': { color: C.azBlue } }}>
                <CloseIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              {webAppDetailLoading || !webAppDetail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} sx={{ color: C.azBlue }} /></Box>
              ) : <WebAppDetailBody detail={webAppDetail} C={C} />}
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── Resource detail Dialog ── */}
      <Dialog open={!!openResource} onClose={() => setOpenResource(null)} maxWidth="md" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openResource && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <ResourcesIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-all' }}>{openResource.name}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO }}>{openResource.type}</Typography>
              </Box>
              <IconButton onClick={() => setOpenResource(null)} size="small" sx={{ color: C.muted }}>
                <CloseIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1.5, mb: 2 }}>
                {[
                  ['Name', openResource.name],
                  ['Type', shortType(openResource.type)],
                  ['Kind', openResource.kind || '—'],
                  ['Location', openResource.location],
                  ['Resource group', openResource.resourceGroup || '—'],
                ].map(([k, v]) => (
                  <Box key={k as string}>
                    <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
                    <Typography sx={{ fontSize: '0.85rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>{v}</Typography>
                  </Box>
                ))}
              </Box>
              {resourceDetailLoading || !resourceDetail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={20} sx={{ color: C.azBlue }} /></Box>
              ) : (
                <>
                  {Object.keys(resourceDetail.tags || {}).length > 0 && (
                    <Box sx={{ mb: 2 }}>
                      <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>Tags</Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {Object.entries(resourceDetail.tags).map(([k, v]) => (
                          <Chip key={k} label={`${k}: ${v}`} size="small" sx={{ height: 20, fontSize: '0.66rem', bgcolor: C.surface, color: C.muted, fontFamily: MONO }} />
                        ))}
                      </Box>
                    </Box>
                  )}
                  {resourceDetail.sku && (
                    <Box sx={{ mb: 2 }}>
                      <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>SKU</Typography>
                      <KVList obj={resourceDetail.sku as Record<string, unknown>} />
                    </Box>
                  )}
                  {resourceDetail.properties && (
                    <Box>
                      <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>Properties</Typography>
                      <KVList obj={resourceDetail.properties} />
                    </Box>
                  )}
                </>
              )}
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── Total memory breakdown Dialog ── */}
      <Dialog open={openMemory} onClose={() => setOpenMemory(false)} maxWidth="md" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {overview && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <PlanIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink }}>Total web app memory</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>
                  {fmtBytes(overview.aggregates.totalMemoryBytes)} across {overview.aggregates.webAppMemorySamples.filter(s => s.bytes != null).length} apps
                </Typography>
              </Box>
              <IconButton onClick={() => setOpenMemory(false)} size="small" sx={{ color: C.muted }}>
                <CloseIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              <Box sx={{ p: 1.5, mb: 2, bgcolor: C.surface, borderRadius: '8px', borderLeft: `3px solid ${C.azBlue}` }}>
                <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: C.azBlue, mb: 0.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>How this is calculated</Typography>
                <Typography sx={{ fontSize: '0.82rem', color: C.ink, lineHeight: 1.5 }}>
                  {overview.aggregates.calculation || 'Sum of each web app\'s most recent MemoryWorkingSet (5-min granularity, last 30 min window). Concurrent snapshot — not a sum of peaks.'}
                </Typography>
              </Box>

              <Box sx={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.2fr 90px', px: 1.5, py: 0.75, borderBottom: `1px solid ${C.border}`, bgcolor: C.surface, borderRadius: '8px 8px 0 0' }}>
                {['Web app', 'Current', 'Avg 30m', 'Peak 30m', 'State'].map(h => (
                  <Typography key={h} sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{h}</Typography>
                ))}
              </Box>
              {overview.aggregates.webAppMemorySamples.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).map((s, i, arr) => (
                <Box key={s.name} sx={{
                  display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.2fr 90px',
                  px: 1.5, py: 1, alignItems: 'center',
                  borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : 'none',
                }}>
                  <Typography sx={{ fontSize: '0.84rem', color: C.ink, fontFamily: MONO }}>{s.name}</Typography>
                  <Typography sx={{ fontSize: '0.84rem', color: C.azBlue, fontWeight: 600, fontFamily: MONO }}>{fmtBytes(s.bytes)}</Typography>
                  <Typography sx={{ fontSize: '0.78rem', color: C.muted, fontFamily: MONO }}>{fmtBytes(s.bytesAvg30 ?? null)}</Typography>
                  <Typography sx={{ fontSize: '0.78rem', color: C.muted, fontFamily: MONO }}>{fmtBytes(s.bytesPeak30 ?? null)}</Typography>
                  <Chip label={s.state || '—'} size="small" sx={{ height: 18, fontSize: '0.6rem', bgcolor: `${stateColor(s.state || '', C)}22`, color: stateColor(s.state || '', C), justifySelf: 'start' }} />
                </Box>
              ))}
              <Box sx={{
                display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.2fr 90px',
                px: 1.5, py: 1.25, mt: 1, alignItems: 'center', bgcolor: C.azGlow, borderRadius: '8px',
              }}>
                <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color: C.ink, textTransform: 'uppercase', letterSpacing: '0.08em' }}>TOTAL</Typography>
                <Typography sx={{ fontSize: '0.95rem', color: C.azBlue, fontWeight: 800, fontFamily: MONO }}>
                  {fmtBytes(overview.aggregates.totalMemoryBytes)}
                </Typography>
                <Box />
                <Box />
                <Box />
              </Box>
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── ACR run detail Dialog ── */}
      <Dialog open={!!openRun} onClose={() => setOpenRun(null)} maxWidth="lg" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openRun && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <AcrIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO }}>Build {openRun.runId}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{openRun.reg} · {openRun.rg}</Typography>
              </Box>
              <IconButton onClick={() => setOpenRun(null)} size="small" sx={{ color: C.muted }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              {runDetailLoading || !runDetail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5 }}>
                    {[
                      ['Status', runDetail.status],
                      ['Run type', runDetail.runType],
                      ['Provisioning', runDetail.provisioningState],
                      ['Created', fmtDateTime(runDetail.createTime)],
                      ['Started', fmtDateTime(runDetail.startTime)],
                      ['Finished', fmtDateTime(runDetail.finishTime)],
                      ['Duration', runDetail.startTime && runDetail.finishTime ? `${Math.floor((new Date(runDetail.finishTime).getTime() - new Date(runDetail.startTime).getTime()) / 1000)}s` : '—'],
                      ['Task', runDetail.taskName || '—'],
                      ['Agent CPU', runDetail.agentConfiguration?.cpu ?? '—'],
                      ['Platform', runDetail.platform ? `${runDetail.platform.os || ''} ${runDetail.platform.architecture || ''}` : '—'],
                      ['Archive', runDetail.isArchiveEnabled ? 'yes' : 'no'],
                    ].map(([k, v]) => (
                      <Box key={k as string}>
                        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
                        <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>{v ?? '—'}</Typography>
                      </Box>
                    ))}
                  </Box>

                  {runDetail.runErrorMessage && (
                    <Box sx={{ p: 1.5, bgcolor: `${C.red}22`, borderLeft: `3px solid ${C.red}`, borderRadius: '6px' }}>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.red, mb: 0.5, textTransform: 'uppercase' }}>Error</Typography>
                      <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, whiteSpace: 'pre-wrap' }}>{runDetail.runErrorMessage}</Typography>
                    </Box>
                  )}

                  {/* Source trigger — only populated for AcrTask runs wired
                      to a Git source. Manual `az acr build` from CI has no
                      sourceTrigger, so the block silently hides. */}
                  {runDetail.sourceTrigger?.sourceTriggerEvent && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Source trigger
                      </Typography>
                      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5, p: 1.5, bgcolor: C.surface, borderRadius: '8px' }}>
                        {([
                          ['Provider', runDetail.sourceTrigger.sourceTriggerEvent.providerType],
                          ['Event', runDetail.sourceTrigger.sourceTriggerEvent.eventType || runDetail.sourceTrigger.eventType],
                          ['Branch', runDetail.sourceTrigger.sourceTriggerEvent.branchName],
                          ['Commit', runDetail.sourceTrigger.sourceTriggerEvent.commitId?.slice(0, 12)],
                          ['Repo', runDetail.sourceTrigger.sourceTriggerEvent.repositoryUrl],
                        ] as Array<[string, string | undefined]>).filter(([, v]) => v).map(([k, v]) => (
                          <Box key={k}>
                            <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
                            <Typography sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-all' }}>{v}</Typography>
                          </Box>
                        ))}
                      </Box>
                    </Box>
                  )}

                  {runDetail.outputImages.length > 0 && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Output images ({runDetail.outputImages.length})
                      </Typography>
                      {runDetail.outputImages.map((img, i) => (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
                          <Typography sx={{ fontSize: '0.84rem', color: C.ink, fontFamily: MONO }}>
                            {img.registry}/{img.repository}:{img.tag}
                          </Typography>
                          {img.digest && (
                            <Tooltip title={img.digest}>
                              <Chip label={img.digest.slice(0, 19) + '…'} size="small" sx={{ height: 18, fontSize: '0.6rem', fontFamily: MONO, bgcolor: C.surface, color: C.muted }} />
                            </Tooltip>
                          )}
                        </Box>
                      ))}
                    </Box>
                  )}

                  {(runDetail.logTail || runDetail.logAvailable) && (
                    <BuildLogViewer
                      rg={openRun.rg}
                      reg={openRun.reg}
                      runId={openRun.runId}
                      logTail={runDetail.logTail || ''}
                      logAvailable={Boolean(runDetail.logAvailable)}
                      isFailed={runDetail.status === 'Failed'}
                      C={C}
                    />
                  )}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── Cognitive deployment detail Dialog ── */}
      <Dialog open={!!openDeployment} onClose={() => setOpenDeployment(null)} maxWidth="md" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openDeployment && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <AiIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO }}>{openDeployment.name}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{openDeployment.account} · {openDeployment.rg}</Typography>
              </Box>
              <IconButton onClick={() => setOpenDeployment(null)} size="small" sx={{ color: C.muted }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              {depDetailLoading || !depDetail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5 }}>
                    {[
                      ['Model', depDetail.model?.name],
                      ['Version', depDetail.model?.version],
                      ['Format', depDetail.model?.format],
                      ['Publisher', depDetail.model?.publisher],
                      ['Source', depDetail.model?.source],
                      ['SKU', depDetail.sku?.name],
                      ['SKU tier', depDetail.sku?.tier],
                      ['Capacity', depDetail.sku?.capacity],
                      ['Current capacity', depDetail.currentCapacity],
                      ['Provisioning', depDetail.provisioningState],
                      ['Dynamic throttling', depDetail.dynamicThrottlingEnabled == null ? '—' : depDetail.dynamicThrottlingEnabled ? 'on' : 'off'],
                      ['Upgrade option', depDetail.versionUpgradeOption],
                      ['RAI policy', depDetail.raiPolicyName],
                      ['Parent deploy', depDetail.parentDeploymentName],
                    ].map(([k, v]) => (
                      <Box key={k as string}>
                        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
                        <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>{v ?? '—'}</Typography>
                      </Box>
                    ))}
                  </Box>

                  {depDetail.capabilities && Object.keys(depDetail.capabilities).length > 0 && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Capabilities
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {Object.entries(depDetail.capabilities).map(([k, v]) => (
                          <Chip key={k} label={`${k}: ${v}`} size="small" sx={{ height: 20, fontSize: '0.66rem', bgcolor: C.surface, color: C.muted, fontFamily: MONO }} />
                        ))}
                      </Box>
                    </Box>
                  )}

                  {depDetail.rateLimits && depDetail.rateLimits.length > 0 && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Rate limits ({depDetail.rateLimits.length})
                      </Typography>
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1 }}>
                        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase' }}>Key</Typography>
                        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase' }}>Renewal (s)</Typography>
                        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase' }}>Count</Typography>
                        {depDetail.rateLimits.map((rl, i) => (
                          <>
                            <Typography key={`k-${i}`} sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO }}>{rl.key || '—'}</Typography>
                            <Typography key={`r-${i}`} sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO }}>{rl.renewalPeriod ?? '—'}</Typography>
                            <Typography key={`c-${i}`} sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO }}>{rl.count ?? '—'}</Typography>
                          </>
                        ))}
                      </Box>
                    </Box>
                  )}

                  {depDetail.scaleSettings && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Scale settings
                      </Typography>
                      <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO }}>
                        type: {depDetail.scaleSettings.scaleType || '—'} · capacity: {depDetail.scaleSettings.capacity ?? '—'}
                      </Typography>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── Cost service detail Dialog ── */}
      <Dialog open={!!openService} onClose={() => setOpenService(null)} maxWidth="lg" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openService && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <CostIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink }}>{openService}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>
                  {serviceDetail?.label || (costMode === 'cycle' ? 'Current billing cycle' : `Last ${costDays} days`)}
                </Typography>
              </Box>
              {serviceDetail && (
                <Box sx={{ textAlign: 'right', mr: 1 }}>
                  <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total</Typography>
                  <Typography sx={{ fontSize: '1.2rem', color: C.azBlue, fontWeight: 800, fontFamily: MONO, lineHeight: 1 }}>
                    {fmtMoney(serviceDetail.total, serviceDetail.currency)}
                  </Typography>
                </Box>
              )}
              <IconButton onClick={() => setOpenService(null)} size="small" sx={{ color: C.muted }}><CloseIcon sx={{ fontSize: 20 }} /></IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              {serviceDetailLoading || !serviceDetail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <Box>
                    <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>Daily spend</Typography>
                    <Box sx={{ bgcolor: C.surface, borderRadius: '8px', p: 1.5 }}>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={serviceDetail.daily.map(d => ({ date: d.date.slice(5), cost: d.cost }))}>
                          <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                          <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 11 }} />
                          <YAxis tick={{ fill: C.muted, fontSize: 11 }} />
                          <ChartTooltip
                            contentStyle={{ background: C.paper, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: '0.78rem' }}
                            formatter={(v) => [fmtMoney(Number(v), serviceDetail.currency), 'Spend']}
                          />
                          <Bar dataKey="cost" fill={C.azBlue} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </Box>
                  </Box>

                  {serviceDetail.resources.length > 0 && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Top resources ({serviceDetail.resources.length})
                      </Typography>
                      <Box sx={{ bgcolor: C.surface, borderRadius: '8px', overflow: 'hidden' }}>
                        {serviceDetail.resources.slice(0, 15).map((r, i, arr) => {
                          const pct = (r.cost / serviceDetail.total) * 100
                          return (
                            <Box key={r.resourceId + i} sx={{
                              position: 'relative', px: 1.5, py: 1,
                              borderBottom: i < Math.min(arr.length, 15) - 1 ? `1px solid ${C.border}` : 'none',
                            }}>
                              <Box sx={{ position: 'absolute', inset: 0, bgcolor: `${C.azBlue}10`, width: `${pct}%` }} />
                              <Box sx={{ position: 'relative', display: 'grid', gridTemplateColumns: '2fr 80px 1fr' }}>
                                <Tooltip title={r.resourceId} placement="top">
                                  <Typography noWrap sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO }}>{r.name}</Typography>
                                </Tooltip>
                                <Typography sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO, textAlign: 'right' }}>{pct.toFixed(1)}%</Typography>
                                <Typography sx={{ fontSize: '0.82rem', color: C.azBlue, fontWeight: 600, fontFamily: MONO, textAlign: 'right' }}>{fmtMoney(r.cost, serviceDetail.currency)}</Typography>
                              </Box>
                            </Box>
                          )
                        })}
                      </Box>
                    </Box>
                  )}

                  {serviceDetail.meters.length > 0 && (
                    <Box>
                      <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
                        Top meters ({serviceDetail.meters.length}) — what kind of usage
                      </Typography>
                      <Box sx={{ bgcolor: C.surface, borderRadius: '8px', overflow: 'hidden' }}>
                        {serviceDetail.meters.slice(0, 15).map((m, i, arr) => {
                          const pct = (m.cost / serviceDetail.total) * 100
                          return (
                            <Box key={m.meter + i} sx={{
                              position: 'relative', px: 1.5, py: 1,
                              borderBottom: i < Math.min(arr.length, 15) - 1 ? `1px solid ${C.border}` : 'none',
                            }}>
                              <Box sx={{ position: 'absolute', inset: 0, bgcolor: `${C.azBlue}10`, width: `${pct}%` }} />
                              <Box sx={{ position: 'relative', display: 'grid', gridTemplateColumns: '2fr 80px 1fr' }}>
                                <Typography noWrap sx={{ fontSize: '0.82rem', color: C.ink }}>{m.meter}</Typography>
                                <Typography sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO, textAlign: 'right' }}>{pct.toFixed(1)}%</Typography>
                                <Typography sx={{ fontSize: '0.82rem', color: C.azBlue, fontWeight: 600, fontFamily: MONO, textAlign: 'right' }}>{fmtMoney(m.cost, serviceDetail.currency)}</Typography>
                              </Box>
                            </Box>
                          )
                        })}
                      </Box>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Dialog>

      {/* ── RG detail Dialog (Overview → click an RG card) ── */}
      <Dialog open={!!openRg} onClose={() => setOpenRg(null)} maxWidth="md" fullWidth
        PaperProps={{ sx: { bgcolor: C.paper, border: `1px solid ${C.border}`, borderRadius: CARD_RADIUS, backgroundImage: 'none' } }}>
        {openRg && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2.5, borderBottom: `1px solid ${C.border}` }}>
              <RgIcon sx={{ color: C.azBlue }} />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO }}>{openRg.name}</Typography>
                <Typography sx={{ fontSize: '0.74rem', color: C.muted }}>{openRg.location} · {openRg.resourceCount} resources</Typography>
              </Box>
              <IconButton onClick={() => setOpenRg(null)} size="small" sx={{ color: C.muted }}>
                <CloseIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Box>
            <Box sx={{ p: 2.5, maxHeight: '75vh', overflowY: 'auto' }}>
              {rgResourcesLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress size={24} sx={{ color: C.azBlue }} /></Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {rgResources.map(r => (
                    <Box key={r.id} onClick={() => { setOpenRg(null); setOpenResource(r) }} sx={{
                      display: 'grid', gridTemplateColumns: '2fr 1.5fr 80px 24px',
                      px: 1.5, py: 1, alignItems: 'center', cursor: 'pointer', borderRadius: '8px',
                      transition: 'background-color 0.15s',
                      '&:hover': { bgcolor: C.azGlow },
                    }}>
                      <Typography noWrap sx={{ fontSize: '0.85rem', color: C.ink, fontFamily: MONO, fontWeight: 500 }}>{r.name}</Typography>
                      <Tooltip title={r.type} placement="top">
                        <Typography noWrap sx={{ fontSize: '0.74rem', color: C.muted, fontFamily: MONO }}>{shortType(r.type)}</Typography>
                      </Tooltip>
                      <Typography sx={{ fontSize: '0.72rem', color: C.muted }}>{r.location}</Typography>
                      <ChevronIcon sx={{ fontSize: 16, color: C.muted }} />
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Dialog>
    </Box>
  )
}

// ── WebApp detail body — extracted to keep the main render readable ──────
function WebAppDetailBody({ detail, C }: { detail: WebAppDetail; C: ReturnType<typeof useC> }) {
  const facts: Array<[string, React.ReactNode]> = [
    ['State', detail.state],
    ['Kind', detail.kind || '—'],
    ['Image', detail.linuxFxVersion?.replace(/^DOCKER\|/, '') || '—'],
    ['Workers', detail.numberOfWorkers ?? '—'],
    ['Always on', detail.alwaysOn ? 'yes' : 'no'],
    ['HTTPS only', detail.httpsOnly ? 'yes' : 'no'],
    ['HTTP/2', detail.http20Enabled ? 'yes' : 'no'],
    ['Client cert', detail.clientCertEnabled ? 'yes' : 'no'],
    ['Affinity cookies', detail.clientAffinityEnabled ? 'yes' : 'no'],
    ['Min TLS', detail.minTlsVersion || '—'],
    ['FTPS', detail.ftpsState || '—'],
    ['ACR via MI', detail.acrUseManagedIdentityCreds ? 'yes' : 'no'],
    ['Plan', detail.planName || '—'],
    ['Last modified', fmtDateTime(detail.lastModifiedTime)],
  ]
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1.5 }}>
        {facts.map(([k, v]) => (
          <Box key={k}>
            <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
            <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>{v}</Typography>
          </Box>
        ))}
      </Box>

      {/* 24h micro-charts */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 1.5 }}>
        <MetricMini title="Memory (24h)" series={detail.series.memory} color={C.azBlue} latest={detail.memory24h.max} fmtLatest={fmtBytes} latestLabel="peak" C={C} />
        <MetricMini title="CPU seconds (24h)" series={detail.series.cpu} color={C.amber} latest={detail.cpuSeconds24h.max} fmtLatest={(v) => v != null ? `${Math.round(v)}s` : '—'} latestLabel="peak" C={C} />
        <MetricMini title="Requests (24h)" series={detail.series.requests} color={C.green} latest={detail.requests24h.avg != null ? detail.requests24h.avg * detail.series.requests.length : null} fmtLatest={(v) => v != null ? Math.round(v).toLocaleString() : '—'} latestLabel="total" C={C} />
        <MetricMini title="HTTP 5xx (24h)" series={detail.series.errors} color={C.red} latest={detail.errors24h.avg != null ? detail.errors24h.avg * detail.series.errors.length : null} fmtLatest={(v) => v != null ? Math.round(v).toLocaleString() : '—'} latestLabel="total" C={C} />
      </Box>

      {/* Hostnames */}
      <Box>
        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
          Hostnames ({detail.hostnameBindings.length})
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {detail.hostnameBindings.map(h => (
            <Box key={h.name} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO }}>{h.name}</Typography>
              {h.sslState && <Chip label={h.sslState} size="small" sx={{ height: 16, fontSize: '0.6rem', bgcolor: h.sslState === 'SniEnabled' ? `${C.green}22` : C.surface, color: h.sslState === 'SniEnabled' ? C.green : C.muted }} />}
              {h.hostNameType && <Chip label={h.hostNameType} size="small" sx={{ height: 16, fontSize: '0.6rem', bgcolor: C.surface, color: C.muted }} />}
              {h.thumbprint && <Typography sx={{ fontSize: '0.66rem', color: C.muted, fontFamily: MONO }}>{h.thumbprint.slice(0, 12)}…</Typography>}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Slots */}
      {detail.slots.length > 0 && (
        <Box>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
            Deployment slots ({detail.slots.length})
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {detail.slots.map(s => (
              <Chip key={s.name} label={`${s.name} (${s.state})`} size="small" sx={{ bgcolor: C.surface, color: C.muted, fontFamily: MONO }} />
            ))}
          </Box>
        </Box>
      )}

      {/* Identity */}
      {detail.identity && (
        <Box>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
            Managed Identity
          </Typography>
          <Typography sx={{ fontSize: '0.78rem', color: C.ink, fontFamily: MONO }}>
            {detail.identity.type} · {detail.identity.principalId}
          </Typography>
        </Box>
      )}

      {/* App settings */}
      <Box>
        <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
          App settings ({detail.appSettings.length}) — names only
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {detail.appSettings.map(k => (
            <Chip key={k} label={k} size="small" sx={{ height: 20, fontSize: '0.66rem', bgcolor: C.surface, color: C.muted, fontFamily: MONO }} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}

// ── Plan card — full detail view ─────────────────────────────────────────
function PlanCardFull({ plan: p, delay, C, onOpenWebApp, webapps }: {
  plan: PlanRow;
  delay: number;
  C: ReturnType<typeof useC>;
  onOpenWebApp: (w: WebAppRow) => void;
  webapps: WebAppRow[];
}) {
  const cpuMax = p.cpu24hPeak?.max ?? 0
  const memAvg = p.memory24h?.avg ?? 0
  const memMax = p.memory24hPeak?.max ?? 0
  const sites = p.sites ?? []

  // Map a site name back to the full WebAppRow if it exists in the webapps
  // list so the click-through hits the same dialog used elsewhere.
  const findWebApp = (name: string) => webapps.find(w => w.name === name)

  const facts = ([
    ['SKU', `${p.skuName}${p.capacity && p.capacity > 1 ? ` × ${p.capacity}` : ''}`],
    ['Tier', p.skuTier],
    ['Family', p.skuFamily || p.skuSpec?.family],
    ['OS', p.reserved ? 'Linux' : p.isXenon ? 'Windows (container)' : 'Windows'],
    ['Cores', p.skuSpec?.cores],
    ['RAM', p.skuSpec?.ram],
    ['Storage', p.skuSpec?.storage],
    ['Status', p.status],
    ['Provisioning', p.provisioningState],
    ['Region', p.geoRegion || p.location],
    ['Sites', p.numberOfSites],
    ['Workers (now)', p.numberOfWorkers],
    ['Workers (target)', p.targetWorkerCount],
    ['Workers (max)', p.maximumNumberOfWorkers],
    ['Per-site scaling', p.perSiteScaling ? 'yes' : 'no'],
    ['Elastic scale', p.elasticScaleEnabled ? `yes (max ${p.maximumElasticWorkerCount ?? '—'})` : 'no'],
    ['Zone redundant', p.zoneRedundant ? 'yes' : 'no'],
    ['Hyper-V', p.hyperV ? 'yes' : 'no'],
    ['Spot', p.isSpot ? 'yes' : 'no'],
    ['Hourly', p.pricing ? `$${p.pricing.hourly.toFixed(3)}` : '—'],
    ['Monthly est', p.pricing ? `$${p.pricing.monthly.toFixed(2)}` : '—'],
  ] as Array<[string, React.ReactNode]>).filter(([, v]) => v != null && v !== '')

  return (
    <FloatingCard delay={delay} sx={{ p: 2.5 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 700, fontSize: '1.05rem', color: C.ink, fontFamily: MONO }}>{p.name}</Typography>
        <Chip label={`${p.skuName}${p.capacity && p.capacity > 1 ? ` × ${p.capacity}` : ''}`} size="small" sx={{ bgcolor: C.azGlow, color: C.azBlue, fontSize: '0.7rem' }} />
        <Chip label={p.reserved ? 'Linux' : 'Windows'} size="small" sx={{ bgcolor: C.surface, color: C.muted, fontSize: '0.7rem' }} />
        {p.zoneRedundant && <Chip label="zone redundant" size="small" sx={{ bgcolor: `${C.green}22`, color: C.green, fontSize: '0.66rem' }} />}
        {p.perSiteScaling && <Chip label="per-site scaling" size="small" sx={{ bgcolor: `${C.amber}22`, color: C.amber, fontSize: '0.66rem' }} />}
        {p.isSpot && <Chip label="spot" size="small" sx={{ bgcolor: `${C.amber}22`, color: C.amber, fontSize: '0.66rem' }} />}
        <Typography sx={{ fontSize: '0.75rem', color: C.muted, ml: 'auto', fontFamily: MONO }}>{p.location} · {p.resourceGroup}</Typography>
      </Box>

      {/* Specs grid */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1.5, mb: 3, p: 1.5, bgcolor: C.surface, borderRadius: CARD_RADIUS }}>
        {facts.map(([k, v]) => (
          <Box key={k}>
            <Typography sx={{ fontSize: '0.6rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</Typography>
            <Typography sx={{ fontSize: '0.82rem', color: C.ink, fontFamily: MONO, wordBreak: 'break-word' }}>{v}</Typography>
          </Box>
        ))}
      </Box>

      {/* CPU + Mem progress bars (existing) */}
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mb: 3 }}>
        {[
          { label: 'CPU peak 24h', value: cpuMax, avg: p.cpu24h?.avg ?? 0, danger: 90, warn: 70 },
          { label: 'Mem peak 24h', value: memMax, avg: memAvg, danger: 90, warn: 80 },
        ].map(metric => {
          const color = metric.value >= metric.danger ? C.red : metric.value >= metric.warn ? C.amber : C.green
          return (
            <Box key={metric.label}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.5 }}>
                <Typography sx={{ fontSize: '0.65rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{metric.label}</Typography>
                <Typography sx={{ fontSize: '1rem', fontWeight: 700, color, fontFamily: MONO }}>
                  <CountUp value={metric.value} decimals={1} suffix="%" />
                </Typography>
              </Box>
              <Box sx={{ height: 8, bgcolor: C.surface, borderRadius: '99px', overflow: 'hidden' }}>
                <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, metric.value)}%` }} transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }} style={{ height: '100%', background: color, borderRadius: '99px' }} />
              </Box>
              <Typography sx={{ fontSize: '0.66rem', color: C.muted, mt: 0.5 }}>avg {fmtPct(metric.avg)}</Typography>
            </Box>
          )
        })}
      </Box>

      {/* 24h metric sparklines */}
      {p.series && (
        <Box sx={{ mb: 3 }}>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
            24h time series
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 1.5 }}>
            <MetricMini title="CPU %" series={p.series.cpu} color={C.azBlue} latest={p.cpu24hPeak?.max ?? null} fmtLatest={(v) => v == null ? '—' : `${v.toFixed(1)}%`} latestLabel="peak" C={C} />
            <MetricMini title="Memory %" series={p.series.memory} color={C.amber} latest={p.memory24hPeak?.max ?? null} fmtLatest={(v) => v == null ? '—' : `${v.toFixed(1)}%`} latestLabel="peak" C={C} />
            <MetricMini title="HTTP queue" series={p.series.httpQueue} color={C.red} latest={p.httpQueue24h?.max ?? null} fmtLatest={(v) => v == null ? '—' : `${Math.round(v)}`} latestLabel="peak" C={C} />
            <MetricMini title="Disk queue" series={p.series.diskQueue} color={C.green} latest={p.diskQueue24h?.max ?? null} fmtLatest={(v) => v == null ? '—' : `${Math.round(v)}`} latestLabel="peak" C={C} />
            <MetricMini title="Bytes received" series={p.series.bytesReceived} color={C.blue} latest={p.bytesIn24h?.latest ?? null} fmtLatest={(v) => v == null ? '—' : fmtBytes(v)} latestLabel="recent" C={C} />
            <MetricMini title="Bytes sent" series={p.series.bytesSent} color={C.rust} latest={p.bytesOut24h?.latest ?? null} fmtLatest={(v) => v == null ? '—' : fmtBytes(v)} latestLabel="recent" C={C} />
          </Box>
        </Box>
      )}

      {/* Sites on this plan */}
      {sites.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
            Sites on this plan ({sites.length})
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1 }}>
            {sites.map(s => {
              const webApp = findWebApp(s.name)
              return (
                <Box
                  key={s.name}
                  onClick={webApp ? () => onOpenWebApp(webApp) : undefined}
                  sx={{
                    bgcolor: C.surface, borderRadius: '8px', p: 1.5,
                    cursor: webApp ? 'pointer' : 'default',
                    transition: 'background-color 0.15s',
                    '&:hover': webApp ? { bgcolor: C.azGlow } : undefined,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                    <Box sx={{
                      width: 7, height: 7, borderRadius: '50%',
                      bgcolor: stateColor(s.state || '', C),
                      boxShadow: s.state === 'Running' ? `0 0 8px ${C.green}` : 'none',
                    }} />
                    <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: C.ink, fontFamily: MONO, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                      {s.name.replace(/^app-/, '').replace(/-prod-[a-z0-9]+$/, '')}
                    </Typography>
                  </Box>
                  {s.linuxFxVersion && (
                    <Typography sx={{ fontSize: '0.66rem', color: C.muted, fontFamily: MONO }}>
                      {s.linuxFxVersion.replace(/^DOCKER\|/, '').split('/').pop()}
                    </Typography>
                  )}
                  {s.defaultHostName && (
                    <Typography noWrap sx={{ fontSize: '0.66rem', color: C.muted, fontFamily: MONO, mt: 0.25 }}>
                      {s.defaultHostName}
                    </Typography>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      )}

      {/* Memory upgrade nudge (existing) */}
      {memAvg >= 85 && (
        <Box sx={{ mt: 1.5, p: 1.25, bgcolor: `${C.amber}22`, borderRadius: '8px', display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarnIcon sx={{ fontSize: 18, color: C.amber }} />
          <Typography sx={{ fontSize: '0.78rem', color: C.ink }}>
            Memory above 85% sustained — consider upgrading. <code>--sku B2</code> cheapest path, <code>--sku P0V3</code> for dedicated CPU.
          </Typography>
        </Box>
      )}

      {/* Tags */}
      {p.tags && Object.keys(p.tags).length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em', mb: 1 }}>
            Tags
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {Object.entries(p.tags).map(([k, v]) => (
              <Chip key={k} label={`${k}: ${v}`} size="small" sx={{ height: 20, fontSize: '0.66rem', bgcolor: C.surface, color: C.muted, fontFamily: MONO }} />
            ))}
          </Box>
        </Box>
      )}
    </FloatingCard>
  )
}

function MetricMini({ title, series, color, latest, fmtLatest, latestLabel, C }: {
  title: string;
  series: SeriesPoint[];
  color: string;
  latest: number | null;
  fmtLatest: (v: number | null) => string;
  latestLabel: string;
  C: ReturnType<typeof useC>;
}) {
  const data = useMemo(() => series.map(p => ({ t: new Date(p.t).getTime(), v: p.v ?? 0 })), [series])
  return (
    <Box sx={{ bgcolor: C.surface, borderRadius: CARD_RADIUS, p: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography sx={{ fontSize: '0.7rem', fontWeight: 600, color: C.muted }}>{title}</Typography>
        <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, color, fontFamily: MONO }}>
          {fmtLatest(latest)} <Typography component="span" sx={{ fontSize: '0.62rem', color: C.muted }}>{latestLabel}</Typography>
        </Typography>
      </Box>
      <ResponsiveContainer width="100%" height={60}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`mini-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.5} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} fill={`url(#mini-${title})`} strokeWidth={1.6} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  )
}

// ── Build log viewer ─────────────────────────────────────────────────────
// Renders an ACR run log with three affordances the user asked for:
//   1. "Open full log" — opens the SAS-signed blob URL in a new tab (no 60KB
//      tail cap; useful when the error is buried deep in a long log).
//   2. "Copy log" — drops the tail to clipboard for pasting into chat/issue.
//   3. Auto-scroll-to-bottom for failed runs since the failing step is
//      almost always at the end of the log.
// Error / FAIL / fatal lines are tinted red so they jump out when skimming.
// ── Daily spend chart with per-service overlay ────────────────────────────
// Bar = daily total. Lines = top 5 services' daily contributions. Lets the
// user spot which service drove a spike on a particular day at a glance.
function DailySpendChart({ cost, C }: { cost: CostData; C: ReturnType<typeof useC> }) {
  // Pick the top 5 services by total spend across the window. Anything
  // beyond that clutters the chart without adding signal.
  const TOP_N = 5
  const topServices = useMemo(
    () => (cost.services || []).slice(0, TOP_N).map(s => s.service),
    [cost.services],
  )

  // Pivot dailyByService (long form) into wide rows keyed by date so recharts
  // can render multiple Lines from one dataset. Empty values default to 0 so
  // a service that didn't bill on a given day still draws a line back to 0.
  const data = useMemo(() => {
    type CostRow = { date: string; total: number } & Record<string, number>
    const byDate: Record<string, CostRow> = {}
    for (const d of cost.daily) {
      const row = { date: d.date, total: d.cost } as CostRow
      for (const svc of topServices) row[svc] = 0
      byDate[d.date] = row
    }
    for (const row of (cost.dailyByService || [])) {
      const r = byDate[row.date]
      if (r && topServices.includes(row.service)) r[row.service] = row.cost
    }
    return Object.values(byDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => ({ ...r, date: r.date.slice(5) }))
  }, [cost.daily, cost.dailyByService, topServices])

  // Consistent line colours — cycle through the warm/cool palette so each
  // service holds the same colour across re-renders.
  const palette = [C.azBlue, C.rust, C.amber, C.green, C.red, C.blue]

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 11 }} />
        <YAxis tick={{ fill: C.muted, fontSize: 11 }} tickFormatter={(v: number) => `$${Math.round(v)}`} />
        <ChartTooltip
          contentStyle={{ background: C.paper, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: '0.78rem' }}
          formatter={(v, name) => [fmtMoney(Number(v), cost.currency), name === 'total' ? 'Daily total' : name]}
          labelStyle={{ color: C.muted, fontSize: '0.72rem' }}
        />
        <Legend
          wrapperStyle={{ fontSize: '0.7rem', paddingTop: 4 }}
          formatter={(v: string) => v === 'total' ? 'Daily total' : v}
        />
        <Bar dataKey="total" fill={C.azBlue} fillOpacity={0.55} radius={[4, 4, 0, 0]} />
        {topServices.map((svc, i) => (
          <Line
            key={svc}
            type="monotone"
            dataKey={svc}
            stroke={palette[i % palette.length]}
            strokeWidth={1.8}
            dot={false}
            activeDot={{ r: 3 }}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function BuildLogViewer({ rg, reg, runId, logTail, logAvailable, isFailed, C }: {
  rg: string;
  reg: string;
  runId: string;
  logTail: string;
  logAvailable: boolean;
  isFailed: boolean;
  C: ReturnType<typeof useC>;
}) {
  const boxRef = useRef<HTMLPreElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [fullLog, setFullLog] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<string | null>(null)

  // The full log is fetched on demand through the authenticated proxy, so the
  // SAS URL never reaches the browser. Once loaded it replaces the inline tail.
  const displayText = fullLog ?? logTail

  const loadFullLog = useCallback(async (): Promise<string | null> => {
    if (fullLog !== null) return fullLog
    setLogLoading(true); setLogError(null)
    try {
      const res = await apiFetch(`/api/azure/acr/${rg}/${reg}/runs/${runId}/log`)
      if (!res.ok) {
        let message = `Could not load the full log (${res.status})`
        try {
          const body = await res.json() as { error?: { message?: string } | string; message?: string }
          const detail = typeof body.error === 'object' ? body.error?.message
            : typeof body.error === 'string' ? body.error : body.message
          if (detail) message = detail
        } catch { /* keep the status-based message */ }
        setLogError(message)
        return null
      }
      const body = await res.json() as { log: string; truncated?: boolean }
      setFullLog(body.log)
      setTruncated(Boolean(body.truncated))
      return body.log
    } catch {
      setLogError('Could not load the full log.')
      return null
    } finally {
      setLogLoading(false)
    }
  }, [fullLog, rg, reg, runId])

  // Auto-scroll to the bottom on mount for failed runs, and again when the full
  // log arrives. Succeeded runs we leave at the top — usually read from the start.
  useEffect(() => {
    if (isFailed && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [isFailed, displayText])

  // Copy pulls the complete (bounded) log through the proxy first, so the
  // clipboard gets more than the inline tail when a full log is available.
  const copy = async () => {
    const text = logAvailable ? ((await loadFullLog()) ?? displayText) : displayText
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard may be denied — ignore */ }
  }

  // Quick error-line detector. Matches the case-insensitive patterns ACR
  // builds (and the Docker daemon they wrap) actually emit on failure.
  const isErrorLine = (line: string) => /\b(error|fatal|failed|fail:|panic)\b/i.test(line)
  const lines = displayText.split('\n')
  const sizeLabel = fullLog !== null
    ? (truncated ? `(${fullLog.length.toLocaleString()} chars · truncated)` : `(${fullLog.length.toLocaleString()} chars)`)
    : (logTail.length >= 60000 ? '(tail · last 60 KB)' : `(${logTail.length.toLocaleString()} bytes)`)

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography sx={{ fontSize: '0.62rem', fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Build log {sizeLabel}
          </Typography>
          {isFailed && (
            <Chip label="failed" size="small" sx={{ height: 16, fontSize: '0.6rem', bgcolor: `${C.red}22`, color: C.red }} />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Button
            size="small"
            onClick={copy}
            disabled={!displayText && !logAvailable}
            sx={{ fontSize: '0.7rem', textTransform: 'none', color: C.azBlue, minWidth: 0, px: 1.25 }}
          >
            {copied ? 'Copied ✓' : 'Copy log'}
          </Button>
          {logAvailable && fullLog === null && (
            <Button
              size="small"
              onClick={loadFullLog}
              disabled={logLoading}
              startIcon={logLoading ? <CircularProgress size={12} sx={{ color: C.azBlue }} /> : undefined}
              sx={{ fontSize: '0.7rem', textTransform: 'none', color: C.azBlue, minWidth: 0, px: 1.25 }}
            >
              {logLoading ? 'Loading…' : 'View full log'}
            </Button>
          )}
        </Box>
      </Box>
      <Box
        component="pre"
        ref={boxRef}
        sx={{
          bgcolor: C.surface, color: C.ink, fontSize: '0.72rem', fontFamily: MONO,
          p: 1.5, borderRadius: '8px',
          maxHeight: isFailed ? 480 : 320, overflowY: 'auto', overflowX: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          border: `1px solid ${isFailed ? C.red : C.border}`,
          m: 0,
        }}
      >
        {lines.map((line, i) => (
          <Box
            key={i}
            component="span"
            sx={{
              display: 'block',
              color: isErrorLine(line) ? C.red : 'inherit',
              fontWeight: isErrorLine(line) ? 600 : 400,
            }}
          >
            {line || ' '}
          </Box>
        ))}
      </Box>
      {logError && (
        <Typography sx={{ fontSize: '0.62rem', color: C.red, mt: 0.75 }}>
          {logError}
        </Typography>
      )}
      {truncated && (
        <Typography sx={{ fontSize: '0.62rem', color: C.muted, mt: 0.75 }}>
          Log truncated at the 2 MB proxy limit.
        </Typography>
      )}
    </Box>
  )
}
