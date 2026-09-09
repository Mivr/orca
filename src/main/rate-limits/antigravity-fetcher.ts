import { existsSync, readFileSync } from 'node:fs'
import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import {
  readAntigravityAuthSession,
  type AntigravityAuthReadResult
} from './antigravity-auth'

export const ANTIGRAVITY_GEMINI_7D_BUCKET = '7d'
export const ANTIGRAVITY_GEMINI_5H_BUCKET = '5h'
export const ANTIGRAVITY_FRONTIER_7D_BUCKET = 'Other 7d'
export const ANTIGRAVITY_FRONTIER_5H_BUCKET = 'Other 5h'

export const RETRIEVE_USER_QUOTA_SUMMARY_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const GOOGLE_CLIENT_SECRET = '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'

const API_TIMEOUT_MS = 5_000
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const FIVE_HOUR_WINDOW_MINUTES = 300
const SEVEN_DAY_WINDOW_MINUTES = 10_080

export type FleetGoogleWindow = {
  used_percent?: number
  remaining_percent?: number
  resets_at?: number | null
  reset_at?: number | null
}

export type FleetGoogleOverride = {
  gemini_7d?: FleetGoogleWindow
  gemini_5h?: FleetGoogleWindow
  frontier_7d?: FleetGoogleWindow
  frontier_5h?: FleetGoogleWindow
  source?: string
  force?: boolean
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000
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

export function formatAntigravityResetDescription(ms: number | null): string | null {
  if (ms === null) {
    return null
  }
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function createBucket(
  name: string,
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null
): RateLimitBucket {
  return {
    name,
    usedPercent: clampPercent(usedPercent),
    windowMinutes,
    resetsAt,
    resetDescription: formatAntigravityResetDescription(resetsAt)
  }
}

function parseWindowUsedPercent(win?: FleetGoogleWindow): number | null {
  if (!win || typeof win !== 'object') {
    return null
  }
  if (typeof win.used_percent === 'number' && Number.isFinite(win.used_percent)) {
    return win.used_percent
  }
  if (typeof win.remaining_percent === 'number' && Number.isFinite(win.remaining_percent)) {
    return 100 - win.remaining_percent
  }
  return null
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata,
  extras: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {}),
    ...extras
  }
}

export function mapFleetOverrideToBuckets(override: FleetGoogleOverride): {
  buckets: RateLimitBucket[]
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  planTier: string
} {
  const buckets: RateLimitBucket[] = []

  const g7dUsed = parseWindowUsedPercent(override.gemini_7d)
  const g7dReset = parseTimestampMs(override.gemini_7d?.resets_at ?? override.gemini_7d?.reset_at)
  let weeklyWindow: RateLimitWindow | null = null
  if (g7dUsed !== null) {
    const b = createBucket(ANTIGRAVITY_GEMINI_7D_BUCKET, g7dUsed, SEVEN_DAY_WINDOW_MINUTES, g7dReset)
    buckets.push(b)
    weeklyWindow = {
      usedPercent: b.usedPercent,
      windowMinutes: b.windowMinutes ?? SEVEN_DAY_WINDOW_MINUTES,
      resetsAt: b.resetsAt,
      resetDescription: b.resetDescription
    }
  }

  const g5hUsed = parseWindowUsedPercent(override.gemini_5h)
  const g5hReset = parseTimestampMs(override.gemini_5h?.resets_at ?? override.gemini_5h?.reset_at)
  let sessionWindow: RateLimitWindow | null = null
  if (g5hUsed !== null) {
    const b = createBucket(ANTIGRAVITY_GEMINI_5H_BUCKET, g5hUsed, FIVE_HOUR_WINDOW_MINUTES, g5hReset)
    buckets.push(b)
    sessionWindow = {
      usedPercent: b.usedPercent,
      windowMinutes: b.windowMinutes ?? FIVE_HOUR_WINDOW_MINUTES,
      resetsAt: b.resetsAt,
      resetDescription: b.resetDescription
    }
  }

  const f7dUsed = parseWindowUsedPercent(override.frontier_7d)
  const f7dReset = parseTimestampMs(override.frontier_7d?.resets_at ?? override.frontier_7d?.reset_at)
  if (f7dUsed !== null) {
    buckets.push(createBucket(ANTIGRAVITY_FRONTIER_7D_BUCKET, f7dUsed, SEVEN_DAY_WINDOW_MINUTES, f7dReset))
  }

  const f5hUsed = parseWindowUsedPercent(override.frontier_5h)
  const f5hReset = parseTimestampMs(override.frontier_5h?.resets_at ?? override.frontier_5h?.reset_at)
  if (f5hUsed !== null) {
    buckets.push(createBucket(ANTIGRAVITY_FRONTIER_5H_BUCKET, f5hUsed, FIVE_HOUR_WINDOW_MINUTES, f5hReset))
  }

  const planTier = override.source === 'google-ultra' ? 'Google AI Ultra' : 'Google AI Pro'

  return { buckets, session: sessionWindow, weekly: weeklyWindow, planTier }
}

export type LiveQuotaBucket = {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction?: number
}

export type LiveQuotaGroup = {
  buckets?: LiveQuotaBucket[]
  displayName?: string
  description?: string
}

export type LiveQuotaSummaryResponse = {
  groups?: LiveQuotaGroup[]
  description?: string
}

export function mapLiveQuotaSummaryToBuckets(summary: LiveQuotaSummaryResponse): {
  buckets: RateLimitBucket[]
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const buckets: RateLimitBucket[] = []
  let sessionWindow: RateLimitWindow | null = null
  let weeklyWindow: RateLimitWindow | null = null

  const allBuckets: { bucket: LiveQuotaBucket; groupName: string }[] = []
  for (const group of summary.groups ?? []) {
    const groupName = group.displayName ?? ''
    for (const b of group.buckets ?? []) {
      allBuckets.push({ bucket: b, groupName })
    }
  }

  // 1. Gemini Weekly ('7d')
  const g7d = allBuckets.find(
    ({ bucket, groupName }) =>
      bucket.bucketId === 'gemini-weekly' ||
      (groupName.toLowerCase().includes('gemini') && bucket.window === 'weekly')
  )
  if (g7d) {
    const usedPercent =
      typeof g7d.bucket.remainingFraction === 'number' && Number.isFinite(g7d.bucket.remainingFraction)
        ? (1 - g7d.bucket.remainingFraction) * 100
        : 0
    const resetsAt = parseTimestampMs(g7d.bucket.resetTime)
    const b = createBucket(ANTIGRAVITY_GEMINI_7D_BUCKET, usedPercent, SEVEN_DAY_WINDOW_MINUTES, resetsAt)
    buckets.push(b)
    weeklyWindow = {
      usedPercent: b.usedPercent,
      windowMinutes: SEVEN_DAY_WINDOW_MINUTES,
      resetsAt: b.resetsAt,
      resetDescription: b.resetDescription
    }
  }

  // 2. Gemini 5h ('5h')
  const g5h = allBuckets.find(
    ({ bucket, groupName }) =>
      bucket.bucketId === 'gemini-5h' ||
      (groupName.toLowerCase().includes('gemini') && bucket.window === '5h')
  )
  if (g5h) {
    const usedPercent =
      typeof g5h.bucket.remainingFraction === 'number' && Number.isFinite(g5h.bucket.remainingFraction)
        ? (1 - g5h.bucket.remainingFraction) * 100
        : 0
    const resetsAt = parseTimestampMs(g5h.bucket.resetTime)
    const b = createBucket(ANTIGRAVITY_GEMINI_5H_BUCKET, usedPercent, FIVE_HOUR_WINDOW_MINUTES, resetsAt)
    buckets.push(b)
    sessionWindow = {
      usedPercent: b.usedPercent,
      windowMinutes: FIVE_HOUR_WINDOW_MINUTES,
      resetsAt: b.resetsAt,
      resetDescription: b.resetDescription
    }
  }

  // 3. Other Weekly ('Other 7d')
  const f7d = allBuckets.find(
    ({ bucket, groupName }) =>
      bucket.bucketId === '3p-weekly' ||
      ((groupName.toLowerCase().includes('claude') ||
        groupName.toLowerCase().includes('gpt') ||
        groupName.toLowerCase().includes('3p')) &&
        bucket.window === 'weekly')
  )
  if (f7d) {
    const usedPercent =
      typeof f7d.bucket.remainingFraction === 'number' && Number.isFinite(f7d.bucket.remainingFraction)
        ? (1 - f7d.bucket.remainingFraction) * 100
        : 0
    const resetsAt = parseTimestampMs(f7d.bucket.resetTime)
    buckets.push(createBucket(ANTIGRAVITY_FRONTIER_7D_BUCKET, usedPercent, SEVEN_DAY_WINDOW_MINUTES, resetsAt))
  }

  // 4. Other 5h ('Other 5h')
  const f5h = allBuckets.find(
    ({ bucket, groupName }) =>
      bucket.bucketId === '3p-5h' ||
      ((groupName.toLowerCase().includes('claude') ||
        groupName.toLowerCase().includes('gpt') ||
        groupName.toLowerCase().includes('3p')) &&
        bucket.window === '5h')
  )
  if (f5h) {
    const usedPercent =
      typeof f5h.bucket.remainingFraction === 'number' && Number.isFinite(f5h.bucket.remainingFraction)
        ? (1 - f5h.bucket.remainingFraction) * 100
        : 0
    const resetsAt = parseTimestampMs(f5h.bucket.resetTime)
    buckets.push(createBucket(ANTIGRAVITY_FRONTIER_5H_BUCKET, usedPercent, FIVE_HOUR_WINDOW_MINUTES, resetsAt))
  }

  return { buckets, session: sessionWindow, weekly: weeklyWindow }
}

export type LiveQuotaSummaryResult =
  | { status: 'ok'; data: LiveQuotaSummaryResponse }
  | { status: 'unauthorized' }
  | { status: 'error'; error: string }

export async function refreshGoogleAccessToken(
  refreshToken: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const params = new URLSearchParams()
    params.set('client_id', GOOGLE_CLIENT_ID)
    params.set('client_secret', GOOGLE_CLIENT_SECRET)
    params.set('refresh_token', refreshToken)
    params.set('grant_type', 'refresh_token')

    const res = await net.fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: signal ?? AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (!res.ok) {
      await res.text()
      return null
    }
    const data = (await res.json()) as { access_token?: unknown }
    return typeof data?.access_token === 'string' && data.access_token.length > 0
      ? data.access_token
      : null
  } catch {
    return null
  }
}

export async function fetchLiveQuotaSummary(
  accessToken: string,
  signal?: AbortSignal
): Promise<LiveQuotaSummaryResult> {
  try {
    const res = await net.fetch(RETRIEVE_USER_QUOTA_SUMMARY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.0.0'
      },
      body: '{}',
      signal: signal ?? AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      await res.text()
      return { status: 'unauthorized' }
    }
    if (!res.ok) {
      await res.text()
      return { status: 'error', error: `Quota summary fetch failed (${res.status})` }
    }
    const data = (await res.json()) as LiveQuotaSummaryResponse
    return { status: 'ok', data }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function fetchUserInfoEmail(
  accessToken: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const res = await net.fetch(USERINFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: signal ?? AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (!res.ok) {
      await res.text()
      return null
    }
    const data = (await res.json()) as { email?: unknown }
    return typeof data?.email === 'string' && data.email.length > 0 ? data.email : null
  } catch {
    return null
  }
}

export type FetchAntigravityRateLimitsOptions = {
  signal?: AbortSignal
  authReadResult?: AntigravityAuthReadResult
  readAuth?: () => AntigravityAuthReadResult
  fetchEmail?: (token: string, signal?: AbortSignal) => Promise<string | null>
  fetchQuotaSummary?: (token: string, signal?: AbortSignal) => Promise<LiveQuotaSummaryResult>
  refreshToken?: (refreshToken: string, signal?: AbortSignal) => Promise<string | null>
}

export async function fetchAntigravityRateLimits(
  optionsOrReadAuth?: FetchAntigravityRateLimitsOptions | (() => AntigravityAuthReadResult),
  fetchEmailArg?: (token: string) => Promise<string | null>
): Promise<ProviderRateLimits> {
  let readAuth: () => AntigravityAuthReadResult = readAntigravityAuthSession
  let fetchEmail: (token: string, signal?: AbortSignal) => Promise<string | null> = fetchUserInfoEmail
  let fetchQuotaSummaryFn: (token: string, signal?: AbortSignal) => Promise<LiveQuotaSummaryResult> =
    fetchLiveQuotaSummary
  let refreshTokenFn: (refreshToken: string, signal?: AbortSignal) => Promise<string | null> =
    refreshGoogleAccessToken
  let signal: AbortSignal | undefined

  if (typeof optionsOrReadAuth === 'function') {
    readAuth = optionsOrReadAuth
    if (fetchEmailArg) {
      fetchEmail = fetchEmailArg
    }
  } else if (optionsOrReadAuth) {
    if (optionsOrReadAuth.authReadResult) {
      const fixedResult = optionsOrReadAuth.authReadResult
      readAuth = () => fixedResult
    } else if (optionsOrReadAuth.readAuth) {
      readAuth = optionsOrReadAuth.readAuth
    }
    if (optionsOrReadAuth.fetchEmail) {
      fetchEmail = optionsOrReadAuth.fetchEmail
    }
    if (optionsOrReadAuth.fetchQuotaSummary) {
      fetchQuotaSummaryFn = optionsOrReadAuth.fetchQuotaSummary
    }
    if (optionsOrReadAuth.refreshToken) {
      refreshTokenFn = optionsOrReadAuth.refreshToken
    }
    signal = optionsOrReadAuth.signal
  }

  const auth = readAuth()

  if (auth.status === 'missing') {
    return result('unavailable', 'Antigravity account is not connected')
  }

  if (auth.status === 'error') {
    return result('error', auth.error)
  }

  const session = auth.session
  let accessToken = session.accessToken
  let accountEmail = session.email

  // If token is expired and refresh token is available, refresh proactively
  if (
    session.refreshToken &&
    (!accessToken || (session.expiresAtMs && session.expiresAtMs < Date.now() + 60_000))
  ) {
    const refreshed = await refreshTokenFn(session.refreshToken, signal)
    if (refreshed) {
      accessToken = refreshed
    }
  }

  // Sourcing 1: Live quota API
  let liveQuotaResult: LiveQuotaSummaryResult | null = null
  if (accessToken) {
    liveQuotaResult = await fetchQuotaSummaryFn(accessToken, signal)

    // If unauthorized, attempt token refresh and retry
    if (liveQuotaResult.status === 'unauthorized' && session.refreshToken) {
      const refreshed = await refreshTokenFn(session.refreshToken, signal)
      if (refreshed) {
        accessToken = refreshed
        liveQuotaResult = await fetchQuotaSummaryFn(accessToken, signal)
      }
    }

    if (liveQuotaResult.status === 'ok') {
      if (!accountEmail) {
        accountEmail = signal
          ? await fetchEmail(accessToken, signal)
          : await fetchEmail(accessToken)
      }
      const { buckets, session: sessionWin, weekly: weeklyWin } =
        mapLiveQuotaSummaryToBuckets(liveQuotaResult.data)
      const planTier = session.planTier || 'Google AI Ultra'
      return result(
        'ok',
        null,
        {
          source: 'oauth',
          credentialSource: session.source,
          accountEmail: accountEmail ?? undefined,
          subscriptionStatus: planTier
        },
        {
          planType: planTier,
          session: sessionWin,
          weekly: weeklyWin,
          buckets
        }
      )
    }
  }

  // Sourcing 2: Fleet override file fallback
  if (session.overridePath && existsSync(session.overridePath)) {
    try {
      const raw = readFileSync(session.overridePath, 'utf-8')
      const override = JSON.parse(raw) as FleetGoogleOverride
      const { buckets, session: sessionWin, weekly: weeklyWin, planTier } =
        mapFleetOverrideToBuckets(override)

      if (!accountEmail && accessToken) {
        accountEmail = signal
          ? await fetchEmail(accessToken, signal)
          : await fetchEmail(accessToken)
      }

      return result(
        'ok',
        null,
        {
          source: 'oauth',
          credentialSource: 'fleet-override',
          accountEmail: accountEmail ?? undefined,
          subscriptionStatus: planTier
        },
        {
          planType: planTier,
          session: sessionWin,
          weekly: weeklyWin,
          buckets
        }
      )
    } catch {
      return result('error', 'Failed to read Antigravity fleet override')
    }
  }

  if (liveQuotaResult) {
    if (liveQuotaResult.status === 'unauthorized') {
      return result('error', 'Google authentication expired')
    }
    if (liveQuotaResult.status === 'error') {
      return result('error', liveQuotaResult.error)
    }
  }

  if (session.accessToken) {
    const planTier = session.planTier || 'Google AI Ultra'
    return result(
      'ok',
      null,
      {
        source: 'oauth',
        credentialSource: 'keyring',
        accountEmail: accountEmail ?? undefined,
        subscriptionStatus: planTier
      },
      {
        planType: planTier,
        session: null,
        weekly: null,
        buckets: []
      }
    )
  }

  return result('unavailable', 'Antigravity quota data is not available')
}
