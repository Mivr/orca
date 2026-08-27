import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_GROK_BOT_BUCKET,
  CURSOR_MODELS_BUCKET,
  CURSOR_OTHER_BUCKET,
  fetchCursorRateLimits,
  formatCursorResetDescription,
  mapCursorSandUsage,
  mapCursorUsageSummary
} from './cursor-fetcher'
import type { CursorAuthReadResult } from './cursor-auth'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

function mintJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

const signedIn: CursorAuthReadResult = {
  status: 'ok',
  session: {
    accessToken: mintJwt('auth0|user-1'),
    subject: 'auth0|user-1',
    source: 'desktop',
    email: 'dev@example.com',
    membershipType: 'ultra',
    subscriptionStatus: 'active'
  }
}

const SUMMARY = {
  billingCycleStart: '2026-07-27T20:01:49.000Z',
  billingCycleEnd: '2026-08-27T20:01:49.000Z',
  membershipType: 'ultra',
  individualUsage: {
    plan: {
      autoPercentUsed: 100,
      apiPercentUsed: 41.5
    },
    onDemand: { enabled: false, used: 0, limit: null }
  }
}

const SAND = {
  currentPeriodStart: '2026-08-26T17:22:03.913Z',
  nextResetTimestampUtc: '2026-08-31T15:44:42.913Z',
  usagePercent: 12,
  hasNonZeroIncludedLimit: true,
  grokPlanLabel: 'Grok Bot Plan'
}

describe('mapCursorUsageSummary', () => {
  it('maps both billing pools from percentages and never invents a dollar cap', () => {
    const mapped = mapCursorUsageSummary(SUMMARY)
    expect(mapped.planType).toBe('ultra')
    expect(mapped.buckets.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET
    ])
    expect(mapped.buckets[0]?.usedPercent).toBe(100)
    expect(mapped.buckets[1]?.usedPercent).toBe(41.5)
    expect(mapped.buckets[0]?.resetsAt).toBe(Date.parse(SUMMARY.billingCycleEnd))
    expect(mapped.buckets[0]?.resetDescription).toBe('Aug 27')
    expect(mapped.buckets[1]?.resetDescription).toBe('Aug 27')
    expect(mapped.buckets[0]?.windowMinutes).toBeGreaterThan(20_000)
  })

  it('omits a pool when its percent is absent instead of faking 0%', () => {
    const mapped = mapCursorUsageSummary({
      individualUsage: { plan: { autoPercentUsed: 12 } }
    })
    expect(mapped.buckets).toHaveLength(1)
    expect(mapped.buckets[0]?.name).toBe(CURSOR_MODELS_BUCKET)
  })
})

describe('mapCursorSandUsage', () => {
  it('maps the Grok Bot weekly window from dashboard sand usage', () => {
    const grokBot = mapCursorSandUsage(SAND)
    expect(grokBot?.name).toBe(CURSOR_GROK_BOT_BUCKET)
    expect(grokBot?.usedPercent).toBe(12)
    expect(grokBot?.resetsAt).toBe(Date.parse(SAND.nextResetTimestampUtc))
    expect(grokBot?.resetDescription).toBe('Aug 31')
  })

  it('prints Cursor spending-page calendar days in UTC', () => {
    expect(formatCursorResetDescription(Date.parse('2026-08-27T20:01:49.000Z'))).toBe('Aug 27')
    expect(formatCursorResetDescription(Date.parse('2026-08-31T15:44:42.913Z'))).toBe('Aug 31')
  })

  it('skips Grok Bot when the account has no included limit', () => {
    expect(mapCursorSandUsage({ ...SAND, hasNonZeroIncludedLimit: false })).toBeNull()
  })
})

describe('fetchCursorRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when not signed in', async () => {
    const result = await fetchCursorRateLimits({ authReadResult: { status: 'missing' } })
    expect(result.provider).toBe('cursor')
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toBeUndefined()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns named buckets only — no synthetic monthly or session window', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(SUMMARY))
      .mockResolvedValueOnce(jsonResponse(SAND))

    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('ok')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toBeUndefined()
    expect(result.planType).toBe('ultra')
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET,
      CURSOR_GROK_BOT_BUCKET
    ])
    expect(result.usageMetadata?.authProvenance).toContain('dev@example.com')
    expect(result.usageMetadata?.authProvenance).toContain('ultra')
    expect(result.usageMetadata?.authProvenance).toContain('active')
    expect(result.usageMetadata?.accountEmail).toBe('dev@example.com')
    expect(result.usageMetadata?.subscriptionStatus).toBe('active')
    expect(result.buckets?.[0]?.resetDescription).toBe('Aug 27')
    expect(result.buckets?.[2]?.resetDescription).toBe('Aug 31')
  })

  it('keeps billing pools when Grok Bot RPC fails', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(SUMMARY))
      .mockRejectedValueOnce(new Error('sand down'))

    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('ok')
    expect(result.buckets?.map((bucket) => bucket.name)).toEqual([
      CURSOR_MODELS_BUCKET,
      CURSOR_OTHER_BUCKET
    ])
  })

  it('treats a 200 without percents as unavailable, not 0%', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse({ membershipType: 'ultra', individualUsage: {} }))
      .mockResolvedValueOnce(jsonResponse({ usagePercent: undefined }))

    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('unavailable')
    expect(result.buckets).toBeUndefined()
  })

  it('maps 401 to a delegated refresh error without echoing the token', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401))
    const result = await fetchCursorRateLimits({ authReadResult: signedIn })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
    expect(result.error).not.toContain(signedIn.session.accessToken)
    expect(JSON.stringify(result)).not.toContain(signedIn.session.accessToken)
  })
})
