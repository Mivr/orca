import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_FRONTIER_5H_BUCKET,
  ANTIGRAVITY_FRONTIER_7D_BUCKET,
  ANTIGRAVITY_GEMINI_5H_BUCKET,
  ANTIGRAVITY_GEMINI_7D_BUCKET,
  fetchAntigravityRateLimits,
  mapFleetOverrideToBuckets,
  mapLiveQuotaSummaryToBuckets,
  type LiveQuotaSummaryResponse
} from './antigravity-fetcher'

describe('antigravity-fetcher', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('mapFleetOverrideToBuckets', () => {
    it('maps all 4 Google AI Ultra windows from remaining percentages', () => {
      const { buckets, session, weekly, planTier } = mapFleetOverrideToBuckets({
        gemini_7d: { remaining_percent: 98.53, resets_at: 1788879157 },
        gemini_5h: { remaining_percent: 100.0, resets_at: null },
        frontier_7d: { remaining_percent: 85.0, resets_at: 1788879157 },
        frontier_5h: { remaining_percent: 90.0, resets_at: null },
        source: 'google-ultra'
      })

      expect(planTier).toBe('Google AI Ultra')
      expect(buckets).toHaveLength(4)

      const g7d = buckets.find((b) => b.name === ANTIGRAVITY_GEMINI_7D_BUCKET)
      expect(g7d?.usedPercent).toBeCloseTo(1.47, 2)
      expect(g7d?.resetsAt).toBe(1788879157000)

      const g5h = buckets.find((b) => b.name === ANTIGRAVITY_GEMINI_5H_BUCKET)
      expect(g5h?.usedPercent).toBe(0)
      expect(g5h?.resetsAt).toBeNull()

      const f7d = buckets.find((b) => b.name === ANTIGRAVITY_FRONTIER_7D_BUCKET)
      expect(f7d?.usedPercent).toBe(15)

      const f5h = buckets.find((b) => b.name === ANTIGRAVITY_FRONTIER_5H_BUCKET)
      expect(f5h?.usedPercent).toBe(10)

      expect(weekly?.usedPercent).toBeCloseTo(1.47, 2)
      expect(session?.usedPercent).toBe(0)
    })

    it('handles direct used_percent and flat reset timestamps', () => {
      const { buckets } = mapFleetOverrideToBuckets({
        gemini_7d: { used_percent: 42.5, reset_at: 1788879157000 },
        source: 'google-override'
      })

      expect(buckets).toHaveLength(1)
      expect(buckets[0]?.name).toBe(ANTIGRAVITY_GEMINI_7D_BUCKET)
      expect(buckets[0]?.usedPercent).toBe(42.5)
      expect(buckets[0]?.resetsAt).toBe(1788879157000)
    })
  })

  describe('mapLiveQuotaSummaryToBuckets', () => {
    it('maps live Google quota summary into 4 Option A buckets', () => {
      const summary: LiveQuotaSummaryResponse = {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-10T22:34:50Z',
                remainingFraction: 0.558
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-09T22:12:59Z',
                remainingFraction: 0.849
              }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                resetTime: '2026-09-14T12:31:30Z',
                remainingFraction: 0.909
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                resetTime: '2026-09-09T22:13:48Z',
                remainingFraction: 1.0
              }
            ]
          }
        ]
      }

      const { buckets, session, weekly } = mapLiveQuotaSummaryToBuckets(summary)
      expect(buckets).toHaveLength(4)

      const g7d = buckets.find((b) => b.name === '7d')
      expect(g7d?.usedPercent).toBeCloseTo(44.2, 1)
      expect(g7d?.resetsAt).toBe(Date.parse('2026-09-10T22:34:50Z'))

      const g5h = buckets.find((b) => b.name === '5h')
      expect(g5h?.usedPercent).toBeCloseTo(15.1, 1)
      expect(g5h?.resetsAt).toBe(Date.parse('2026-09-09T22:12:59Z'))

      const f7d = buckets.find((b) => b.name === 'Other 7d')
      expect(f7d?.usedPercent).toBeCloseTo(9.1, 1)
      expect(f7d?.resetsAt).toBe(Date.parse('2026-09-14T12:31:30Z'))

      const f5h = buckets.find((b) => b.name === 'Other 5h')
      expect(f5h?.usedPercent).toBe(0)
      expect(f5h?.resetsAt).toBe(Date.parse('2026-09-09T22:13:48Z'))

      expect(weekly?.usedPercent).toBeCloseTo(44.2, 1)
      expect(session?.usedPercent).toBeCloseTo(15.1, 1)
    })
  })

  describe('fetchAntigravityRateLimits', () => {
    it('returns unavailable when auth session is missing', async () => {
      const limits = await fetchAntigravityRateLimits(() => ({ status: 'missing' }))
      expect(limits.status).toBe('unavailable')
      expect(limits.provider).toBe('antigravity')
      expect(limits.error).toContain('not connected')
    })

    it('returns error when auth session encounters an error', async () => {
      const limits = await fetchAntigravityRateLimits(() => ({
        status: 'error',
        error: 'Keyring unreadable'
      }))
      expect(limits.status).toBe('error')
      expect(limits.error).toBe('Keyring unreadable')
    })

    it('fetches live rate limits from Google quota summary API', async () => {
      const mockQuotaSummary = vi.fn().mockResolvedValue({
        status: 'ok',
        data: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  window: 'weekly',
                  remainingFraction: 0.558,
                  resetTime: '2026-09-10T22:34:50Z'
                },
                {
                  bucketId: 'gemini-5h',
                  window: '5h',
                  remainingFraction: 0.849,
                  resetTime: '2026-09-09T22:12:59Z'
                }
              ]
            }
          ]
        }
      })
      const mockEmail = vi.fn().mockResolvedValue('mihail@example.com')

      const limits = await fetchAntigravityRateLimits({
        authReadResult: {
          status: 'ok',
          session: {
            accessToken: 'ya29.live-token',
            email: null,
            planTier: 'Google AI Ultra',
            source: 'keyring',
            authMethod: 'consumer'
          }
        },
        fetchQuotaSummary: mockQuotaSummary,
        fetchEmail: mockEmail
      })

      expect(limits.status).toBe('ok')
      expect(limits.provider).toBe('antigravity')
      expect(limits.usageMetadata?.accountEmail).toBe('mihail@example.com')
      expect(limits.usageMetadata?.credentialSource).toBe('keyring')
      expect(limits.buckets).toHaveLength(2)
      expect(limits.buckets![0]?.name).toBe('7d')
      expect(limits.buckets![1]?.name).toBe('5h')
      expect(mockQuotaSummary).toHaveBeenCalledWith('ya29.live-token', undefined)
    })

    it('refreshes token on 401 unauthorized and retries', async () => {
      let callCount = 0
      const mockQuotaSummary = vi.fn().mockImplementation(async (_token: string) => {
        callCount++
        if (callCount === 1) {
          return { status: 'unauthorized' }
        }
        return {
          status: 'ok',
          data: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  {
                    bucketId: 'gemini-weekly',
                    window: 'weekly',
                    remainingFraction: 0.6,
                    resetTime: '2026-09-10T22:34:50Z'
                  }
                ]
              }
            ]
          }
        }
      })
      const mockRefreshToken = vi.fn().mockResolvedValue('ya29.refreshed-token')

      const limits = await fetchAntigravityRateLimits({
        authReadResult: {
          status: 'ok',
          session: {
            accessToken: 'ya29.old-token',
            refreshToken: '1//refresh-secret',
            email: 'mihail@example.com',
            planTier: 'Google AI Ultra',
            source: 'keyring',
            authMethod: 'consumer'
          }
        },
        fetchQuotaSummary: mockQuotaSummary,
        refreshToken: mockRefreshToken
      })

      expect(limits.status).toBe('ok')
      expect(mockRefreshToken).toHaveBeenCalledWith('1//refresh-secret', undefined)
      expect(mockQuotaSummary).toHaveBeenCalledTimes(2)
      expect(mockQuotaSummary).toHaveBeenNthCalledWith(2, 'ya29.refreshed-token', undefined)
    })

    it('falls back to fleet override if live fetch fails and override is present', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-ag-fetcher-fallback-'))
      dirs.push(dir)
      const overridePath = join(dir, 'google-usage-override.json')
      writeFileSync(
        overridePath,
        JSON.stringify({
          gemini_7d: { remaining_percent: 98.53, resets_at: 1788879157 },
          source: 'google-ultra'
        })
      )

      const mockQuotaSummary = vi.fn().mockResolvedValue({
        status: 'error',
        error: 'Network timeout'
      })

      const limits = await fetchAntigravityRateLimits({
        authReadResult: {
          status: 'ok',
          session: {
            accessToken: 'ya29.failing-token',
            email: 'user@example.com',
            planTier: 'Google AI Ultra',
            source: 'keyring',
            authMethod: 'consumer',
            overridePath
          }
        },
        fetchQuotaSummary: mockQuotaSummary
      })

      expect(limits.status).toBe('ok')
      expect(limits.usageMetadata?.credentialSource).toBe('fleet-override')
      expect(limits.buckets).toHaveLength(1)
      expect(limits.buckets![0]?.name).toBe('7d')
    })
  })
})
