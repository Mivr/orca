import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-fetcher'
import { readAntigravityAuthSession } from './antigravity-auth'
import {
  errorProvider,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn(),
  consumeGrokRateLimitResetCredit: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('./cursor-fetcher', () => ({
  fetchCursorRateLimits: vi.fn()
}))

vi.mock('./cursor-auth', () => ({
  readCursorAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('./antigravity-fetcher', () => ({
  fetchAntigravityRateLimits: vi.fn()
}))

vi.mock('./antigravity-auth', () => ({
  readAntigravityAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

function antigravitySnapshot(
  status: ProviderRateLimits['status'] = 'ok',
  error: string | null = null
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: {
      usedPercent: 20,
      windowMinutes: 300,
      resetsAt: 1_800_000_000_000,
      resetDescription: '2:00 PM'
    },
    weekly: {
      usedPercent: 45,
      windowMinutes: 10080,
      resetsAt: 1_800_500_000_000,
      resetDescription: 'Fri'
    },
    buckets: [
      {
        name: 'Gemini 5h',
        usedPercent: 20,
        windowMinutes: 300,
        resetsAt: 1_800_000_000_000,
        resetDescription: '2:00 PM'
      },
      {
        name: 'Gemini 7d',
        usedPercent: 45,
        windowMinutes: 10080,
        resetsAt: 1_800_500_000_000,
        resetDescription: 'Fri'
      },
      {
        name: 'Frontier 5h',
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: 1_800_000_000_000,
        resetDescription: '2:00 PM'
      },
      {
        name: 'Frontier 7d',
        usedPercent: 30,
        windowMinutes: 10080,
        resetsAt: 1_800_500_000_000,
        resetDescription: 'Fri'
      }
    ],
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'oauth',
      credentialSource: 'fleet-override',
      accountEmail: 'mihail.vratchanski@gmail.com',
      subscriptionStatus: 'Google AI Ultra'
    }
  }
}

describe('RateLimitService Antigravity usage', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
  })

  it('fetches Antigravity rate limits independently from Gemini', async () => {
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(
      errorProvider('gemini', 'Gemini project ID not found')
    )
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(antigravitySnapshot('ok'))
    vi.mocked(readAntigravityAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        source: 'keyring',
        email: 'mihail.vratchanski@gmail.com',
        accessToken: 'ya29.test',
        planTier: 'Google AI Ultra',
        authMethod: 'consumer'
      }
    })

    const service = new RateLimitService()
    await service.refresh()

    const state = service.getState()
    expect(state.antigravityAuthConfigured).toBe(true)
    expect(state.antigravity?.status).toBe('ok')
    expect(state.antigravity?.provider).toBe('antigravity')
    expect(state.antigravity?.buckets).toHaveLength(4)
    expect(state.antigravity?.usageMetadata?.accountEmail).toBe('mihail.vratchanski@gmail.com')

    // Gemini error remains localized to Gemini
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('Gemini project ID not found')
  })

  it('handles isolated refreshAntigravity call without running other providers', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(antigravitySnapshot('ok'))
    vi.mocked(readAntigravityAuthSession).mockReturnValue({
      status: 'ok',
      session: {
        source: 'keyring',
        email: 'mihail.vratchanski@gmail.com',
        planTier: 'Google AI Ultra',
        authMethod: 'consumer'
      }
    })

    const service = new RateLimitService()
    vi.mocked(fetchClaudeRateLimits).mockClear()
    vi.mocked(fetchGeminiRateLimits).mockClear()
    vi.mocked(fetchAntigravityRateLimits).mockClear()

    await service.refreshAntigravity()

    expect(fetchAntigravityRateLimits).toHaveBeenCalled()
    expect(fetchGeminiRateLimits).not.toHaveBeenCalled()
    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
  })

  it('applies stale policy when Antigravity refresh fails after a previous success', async () => {
    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce(antigravitySnapshot('ok'))
    const service = new RateLimitService()
    await service.refresh()

    expect(service.getState().antigravity?.status).toBe('ok')

    vi.mocked(fetchAntigravityRateLimits).mockResolvedValueOnce({
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Network timeout',
      status: 'error'
    })
    await service.refreshAntigravity()

    const state = service.getState()
    expect(state.antigravity?.status).toBe('error')
    expect(state.antigravity?.error).toBe('Network timeout')
    // Retains previous buckets during transient failure
    expect(state.antigravity?.buckets).toHaveLength(4)
  })
})
