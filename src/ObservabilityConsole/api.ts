import type {
  AnalyticsResponse,
  AuthedFetch,
  ExplorerFilters,
  LogCursor,
  LogResponse,
  TimeRange,
} from './types'

function commonParams(range: TimeRange, filters: Pick<ExplorerFilters, 'agents' | 'query'>) {
  const params = new URLSearchParams({
    from: String(range.from),
    to: String(range.to),
  })
  if (filters.agents.length) params.set('agents', filters.agents.join(','))
  if (filters.query.trim()) params.set('q', filters.query.trim())
  return params
}

async function jsonOrError<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : `Observability request failed (HTTP ${response.status}).`,
    )
  }
  return body as T
}

export async function getLogs(
  authedFetch: AuthedFetch,
  range: TimeRange,
  filters: ExplorerFilters,
  cursor: LogCursor | null,
  signal?: AbortSignal,
) {
  const params = commonParams(range, filters)
  if (filters.levels.length) params.set('levels', filters.levels.join(','))
  params.set('order', filters.order)
  params.set('limit', '200')
  if (cursor) {
    params.set('cursorTs', String(cursor.ts))
    params.set('cursorId', String(cursor.id))
  }
  return jsonOrError<LogResponse>(
    await authedFetch(`/api/observability/logs?${params}`, { signal }),
  )
}

export async function getAnalytics(
  authedFetch: AuthedFetch,
  range: TimeRange,
  filters: Pick<ExplorerFilters, 'agents' | 'query'>,
  signal?: AbortSignal,
) {
  const params = commonParams(range, filters)
  return jsonOrError<AnalyticsResponse>(
    await authedFetch(`/api/observability/analytics?${params}`, { signal }),
  )
}
