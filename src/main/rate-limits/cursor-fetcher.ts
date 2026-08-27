import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import {
  cursorUsageSummaryCookie,
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'

export const CURSOR_MODELS_BUCKET = 'Cursor Models'
export const CURSOR_OTHER_BUCKET = 'Other Models'
export const CURSOR_GROK_BOT_BUCKET = 'Grok Bot'

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const SAND_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const API_TIMEOUT_MS = 10_000

type CursorUsageSummary = {
  billingCycleStart?: unknown
  billingCycleEnd?: unknown
  membershipType?: unknown
  individualUsage?: {
    plan?: {
      autoPercentUsed?: unknown
      apiPercentUsed?: unknown
      onDemandPercentUsed?: unknown
    }
    onDemand?: {
      enabled?: unknown
      used?: unknown
      limit?: unknown
    }
  }
}

type CursorSandUsage = {
  usagePercent?: unknown
  currentPeriodStart?: unknown
  nextResetTimestampUtc?: unknown
  grokPlanLabel?: unknown
  hasNonZeroIncludedLimit?: unknown
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata,
  extras: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {}),
    ...extras
  }
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    if (/^\d+$/.test(value.trim())) {
      return parseTimestampMs(Number(value))
    }
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

function windowMinutesBetween(startMs: number | null, endMs: number | null): number {
  if (startMs === null || endMs === null || endMs <= startMs) {
    return 1
  }
  return Math.max(1, Math.round((endMs - startMs) / 60_000))
}

export function formatCursorResetDescription(ms: number | null): string | null {
  if (ms === null) {
    return null
  }
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  // Why: Cursor's spending UI prints the API calendar day ("Aug 27"), not a
  // weekday/time that collapses to "today" and hides which pool is which.
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function bucket(
  name: string,
  usedPercent: number,
  startMs: number | null,
  endMs: number | null
): RateLimitBucket {
  return {
    name,
    usedPercent: clampPercent(usedPercent),
    windowMinutes: windowMinutesBetween(startMs, endMs),
    resetsAt: endMs,
    resetDescription: formatCursorResetDescription(endMs)
  }
}

export function mapCursorUsageSummary(data: CursorUsageSummary): {
  buckets: RateLimitBucket[]
  planType: string | null
} {
  const plan = data.individualUsage?.plan
  const cycleStart = parseTimestampMs(data.billingCycleStart)
  const cycleEnd = parseTimestampMs(data.billingCycleEnd)
  const buckets: RateLimitBucket[] = []
  const autoPercent = parseFiniteNumber(plan?.autoPercentUsed)
  if (autoPercent !== null) {
    buckets.push(bucket(CURSOR_MODELS_BUCKET, autoPercent, cycleStart, cycleEnd))
  }
  const apiPercent = parseFiniteNumber(plan?.apiPercentUsed)
  if (apiPercent !== null) {
    buckets.push(bucket(CURSOR_OTHER_BUCKET, apiPercent, cycleStart, cycleEnd))
  }

  const onDemand = data.individualUsage?.onDemand
  if (onDemand?.enabled === true) {
    const used = parseFiniteNumber(onDemand.used)
    const limit = parseFiniteNumber(onDemand.limit)
    if (used !== null && limit !== null && limit > 0) {
      buckets.push(bucket('On-demand', (used / limit) * 100, cycleStart, cycleEnd))
    }
  }

  const membership = data.membershipType
  return {
    buckets,
    planType: typeof membership === 'string' && membership.trim() ? membership.trim() : null
  }
}

export function mapCursorSandUsage(data: CursorSandUsage): RateLimitBucket | null {
  if (data.hasNonZeroIncludedLimit === false) {
    return null
  }
  const usedPercent = parseFiniteNumber(data.usagePercent)
  if (usedPercent === null) {
    return null
  }
  const startMs = parseTimestampMs(data.currentPeriodStart)
  const endMs = parseTimestampMs(data.nextResetTimestampUtc)
  return bucket(CURSOR_GROK_BOT_BUCKET, usedPercent, startMs, endMs)
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init: { method?: string; body?: string; signal?: AbortSignal } = {}
): Promise<{ status: number; data: unknown }> {
  const requestSignal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    signal: requestSignal
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

function provenance(session: CursorAuthSession, planType: string | null): string {
  const parts: string[] = []
  if (session.email) {
    parts.push(session.email)
  } else {
    parts.push(session.source === 'cli' ? 'Cursor CLI' : 'Cursor account')
  }
  if (planType) {
    parts.push(planType)
  }
  if (session.subscriptionStatus) {
    parts.push(session.subscriptionStatus)
  }
  return parts.join(' · ')
}

function cursorUsageMetadata(
  session: CursorAuthSession,
  planType: string | null,
  extras: Partial<UsageRateLimitMetadata> = {}
): UsageRateLimitMetadata {
  return {
    source: session.source === 'cli' ? 'cli' : 'oauth',
    credentialSource: session.source,
    authProvenance: provenance(session, planType),
    ...(session.email ? { accountEmail: session.email } : {}),
    ...(session.subscriptionStatus ? { subscriptionStatus: session.subscriptionStatus } : {}),
    ...extras
  }
}

export async function fetchCursorRateLimits(options?: {
  signal?: AbortSignal
  authReadResult?: CursorAuthReadResult
}): Promise<ProviderRateLimits> {
  const readResult = options?.authReadResult ?? readCursorAuthSession()
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Cursor — sign in with Cursor or cursor-agent')
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error)
  }
  const session = readResult.session
  const cookie = cursorUsageSummaryCookie(session.accessToken)
  if (!cookie) {
    return result('error', 'Cursor sign-in is missing a usable account id')
  }

  try {
    const summaryResponse = await fetchJson(
      USAGE_SUMMARY_URL,
      { Cookie: cookie, Accept: 'application/json' },
      { signal: options?.signal }
    )
    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      return result(
        'error',
        `Cursor usage request unauthorized (HTTP ${summaryResponse.status}) — sign in with Cursor or cursor-agent on the computer running Orca`,
        cursorUsageMetadata(session, session.membershipType, {
          failureKind: 'delegated-refresh-required'
        })
      )
    }
    if (summaryResponse.status < 200 || summaryResponse.status >= 300) {
      return result(
        'error',
        `Cursor usage request failed (HTTP ${summaryResponse.status})`,
        cursorUsageMetadata(session, session.membershipType, { failureKind: 'server' })
      )
    }

    const mapped = mapCursorUsageSummary(
      typeof summaryResponse.data === 'object' && summaryResponse.data !== null
        ? (summaryResponse.data as CursorUsageSummary)
        : {}
    )
    const planType = session.membershipType ?? mapped.planType
    const buckets = [...mapped.buckets]

    try {
      const sandResponse = await fetchJson(
        SAND_USAGE_URL,
        {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        { method: 'POST', body: '{}', signal: options?.signal }
      )
      if (sandResponse.status >= 200 && sandResponse.status < 300) {
        const grokBot = mapCursorSandUsage(
          typeof sandResponse.data === 'object' && sandResponse.data !== null
            ? (sandResponse.data as CursorSandUsage)
            : {}
        )
        if (grokBot) {
          buckets.push(grokBot)
        }
      }
    } catch {
      // Why: Grok Bot is a separate dashboard RPC; a failure must not hide the two billing pools.
    }

    if (buckets.length === 0) {
      return result(
        'unavailable',
        'Cursor usage response did not include quota windows',
        cursorUsageMetadata(session, planType, { failureKind: 'usage-unavailable' })
      )
    }

    return result('ok', null, cursorUsageMetadata(session, planType), {
      buckets,
      planType
    })
  } catch (err) {
    return result(
      'error',
      err instanceof Error ? err.message : 'Cursor usage request failed',
      cursorUsageMetadata(session, session.membershipType, { failureKind: 'network' })
    )
  }
}
