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

export const ANTIGRAVITY_GEMINI_7D_BUCKET = 'Gemini 7d'
export const ANTIGRAVITY_GEMINI_5H_BUCKET = 'Gemini 5h'
export const ANTIGRAVITY_FRONTIER_7D_BUCKET = 'Frontier 7d'
export const ANTIGRAVITY_FRONTIER_5H_BUCKET = 'Frontier 5h'

export const RETRIEVE_USER_QUOTA_SUMMARY_URL =
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Why: the Google OAuth client credentials are machine-local secrets, not
// source. They resolve from the environment (same pattern as
// ORCA_ANTIGRAVITY_KEYRING_MOCK) so the refresh grant never embeds them in
// the repo or shipped bundles. Empty means "cannot refresh" — the caller
// then keeps the last known snapshot instead of failing the whole fetch.
function googleOAuthClientId(): string {
  return process.env.ORCA_GOOGLE_CLIENT_ID?.trim() ?? ''
}

function googleOAuthClientSecret(): string {
  return process.env.ORCA_GOOGLE_CLIENT_SECRET?.trim() ?? ''
}

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
      windowMinutes: b.windowMinutes,
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
      windowMinutes: b.windowMinutes,
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
}

export async function fetchAntigravityRateLimits(
  optionsOrReadAuth?: FetchAntigravityRateLimitsOptions | (() => AntigravityAuthReadResult),
  fetchEmailArg?: (token: string) => Promise<string | null>
): Promise<ProviderRateLimits> {
  let readAuth: () => AntigravityAuthReadResult = readAntigravityAuthSession
  let fetchEmail: (token: string, signal?: AbortSignal) => Promise<string | null> = fetchUserInfoEmail
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
  let accountEmail = session.email

  // If we have an access token and no email, attempt a quick userinfo fetch
  if (!accountEmail && session.accessToken) {
    accountEmail = signal
      ? await fetchEmail(session.accessToken, signal)
      : await fetchEmail(session.accessToken)
  }

  // Sourcing 1: Fleet override
  if (session.overridePath && existsSync(session.overridePath)) {
    try {
      const raw = readFileSync(session.overridePath, 'utf-8')
      const override = JSON.parse(raw) as FleetGoogleOverride
      const { buckets, session: sessionWin, weekly: weeklyWin, planTier } =
        mapFleetOverrideToBuckets(override)

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

  // Sourcing 2: Live keyring session without fleet override file
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
