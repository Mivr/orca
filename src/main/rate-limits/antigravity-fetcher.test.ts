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
  mapFleetOverrideToBuckets
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

    it('fetches rate limits from fleet override file and enriches with email', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-ag-fetcher-'))
      dirs.push(dir)
      const overridePath = join(dir, 'google-usage-override.json')
      writeFileSync(
        overridePath,
        JSON.stringify({
          gemini_7d: { remaining_percent: 98.53, resets_at: 1788879157 },
          gemini_5h: { remaining_percent: 100.0, resets_at: null },
          source: 'google-ultra'
        })
      )

      const mockFetchEmail = vi.fn().mockResolvedValue('user@example.com')
      const limits = await fetchAntigravityRateLimits(
        () => ({
          status: 'ok',
          session: {
            accessToken: 'ya29.test',
            email: null,
            planTier: 'Google AI Ultra',
            source: 'fleet-override',
            authMethod: 'consumer',
            overridePath
          }
        }),
        mockFetchEmail
      )

      expect(limits.status).toBe('ok')
      expect(limits.provider).toBe('antigravity')
      expect(limits.planType).toBe('Google AI Ultra')
      expect(limits.usageMetadata?.accountEmail).toBe('user@example.com')
      expect(limits.usageMetadata?.subscriptionStatus).toBe('Google AI Ultra')
      expect(limits.buckets).toHaveLength(2)
      expect(mockFetchEmail).toHaveBeenCalledWith('ya29.test')
    })

    it('returns ok with empty buckets when signed in via keyring without override', async () => {
      const limits = await fetchAntigravityRateLimits(
        () => ({
          status: 'ok',
          session: {
            accessToken: 'ya29.keyring-only',
            email: 'dev@gmail.com',
            planTier: 'Google AI Ultra',
            source: 'keyring',
            authMethod: 'consumer'
          }
        }),
        async () => null
      )

      expect(limits.status).toBe('ok')
      expect(limits.usageMetadata?.accountEmail).toBe('dev@gmail.com')
      expect(limits.usageMetadata?.credentialSource).toBe('keyring')
      expect(limits.buckets).toEqual([])
    })
  })
})
