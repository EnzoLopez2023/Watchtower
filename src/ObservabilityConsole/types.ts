export type AgentName = 'unifi' | 'ups' | 'shutdown' | 'synology' | 'sonarr'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ConsoleMode = 'explore' | 'analytics'
export type LogView = 'table' | 'stream' | 'raw'
export type SortOrder = 'newest' | 'oldest'
export type TimePreset = '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'

export interface TimeRange {
  from: number
  to: number
  preset: TimePreset
}

export interface LogEntry {
  id: number
  agent: AgentName
  ts: number
  level: LogLevel
  message: string
  received_at: number
  ingestion_delay_ms: number
}

export interface LogCursor {
  ts: number
  id: number
}

export interface SourceFreshness {
  agent: AgentName
  total: number
  newestEventAt: number
  newestReceivedAt: number
}

export interface LogResponse {
  ok: true
  lines: LogEntry[]
  total: number
  matchingTotal: number
  nextCursor: LogCursor | null
  order: SortOrder
  sources: SourceFreshness[]
  retention: {
    maxAgeDays: number
    maxRowsPerAgent: number
  }
}

export interface SummaryMetrics {
  total: number
  errors: number
  errorRate: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  clockSkewCount: number
}

export interface AnalyticsSummary extends SummaryMetrics {
  previous: SummaryMetrics | null
  volumeChange: number | null
  errorRateChange: number | null
}

export interface VolumePoint {
  ts: number
  debug: number
  info: number
  warn: number
  error: number
  total: number
}

export interface LevelCount {
  level: LogLevel
  count: number
}

export interface SourceCount {
  agent: AgentName
  total: number
  errors: number
  avgLatencyMs: number | null
}

export interface LatencyPoint {
  ts: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  count: number
}

export type InsightTone = 'info' | 'warning' | 'critical' | 'positive'

export interface Insight {
  id: string
  tone: InsightTone
  title: string
  detail: string
  filter?: {
    agent?: AgentName
    level?: LogLevel
    query?: string
  }
}

export interface AnalyticsResponse {
  ok: true
  window: {
    from: number
    to: number
    bucketMs: number
    previousFrom: number
    previousTo: number
  }
  summary: AnalyticsSummary
  volume: VolumePoint[]
  levels: LevelCount[]
  sources: SourceCount[]
  latency: LatencyPoint[]
  insights: Insight[]
  retention: {
    maxAgeDays: number
    maxRowsPerAgent: number
  }
}

export interface ExplorerFilters {
  agents: AgentName[]
  levels: LogLevel[]
  query: string
  order: SortOrder
}

export type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>
