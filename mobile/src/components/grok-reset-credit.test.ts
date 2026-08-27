import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getGrokResetCreditOutcomeCopy,
  getGrokResetCreditSummary,
  requestGrokResetCredit,
  resetGrokResetCreditRequestsForTests
} from './grok-reset-credit'
import type { ProviderRateLimits } from './accounts-snapshot'

function makeLimits(availableCount: number, nextExpiresAt: number | null): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: {
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: nextExpiresAt,
      resetDescription: null
    },
    rateLimitResetCredits: { availableCount, nextExpiresAt },
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

const SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    grok: makeLimits(0, null),
    cursor: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

afterEach(() => {
  resetGrokResetCreditRequestsForTests()
})

describe('getGrokResetCreditSummary', () => {
  it('hides empty inventories and labels a remaining SuperGrok token', () => {
    const now = Date.parse('2026-08-27T12:00:00Z')
    expect(getGrokResetCreditSummary(null, now)).toBeNull()
    expect(getGrokResetCreditSummary(makeLimits(0, now + 60_000), now)).toBeNull()
    expect(getGrokResetCreditSummary(makeLimits(1, now + 2 * 60 * 60_000), now)).toEqual({
      availableCount: 1,
      availabilityLabel: '1 reset available',
      expiryLabel: 'Expires in 2h'
    })
  })
})

describe('getGrokResetCreditOutcomeCopy', () => {
  it('maps Codex-shaped host outcomes', () => {
    expect(getGrokResetCreditOutcomeCopy('reset').title).toBe('Rate limits reset')
    expect(getGrokResetCreditOutcomeCopy('noCredit').title).toBe('No reset available')
    expect(getGrokResetCreditOutcomeCopy('nothingToReset').title).toBe('Nothing to reset')
    expect(getGrokResetCreditOutcomeCopy('alreadyRedeemed').title).toBe('Reset already applied')
  })
})

describe('requestGrokResetCredit', () => {
  it('sends the phone-owned attempt key and does not include a real token id', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { outcome: 'noCredit', snapshot: SNAPSHOT }
    })

    const result = await requestGrokResetCredit(
      { sendRequest },
      { hostId: 'host-1', createIdempotencyKey: () => '22222222-2222-4222-8222-222222222222' }
    )

    expect(result.outcome).toBe('noCredit')
    expect(sendRequest).toHaveBeenCalledWith(
      'accounts.consumeGrokResetCredit',
      { idempotencyKey: '22222222-2222-4222-8222-222222222222' },
      { timeoutMs: 90_000 }
    )
    const params = sendRequest.mock.calls[0]?.[1] as Record<string, unknown>
    expect(JSON.stringify(params)).not.toMatch(/restok_/)
  })

  it('maps alreadyRedeemed without a live grok.com token id', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { outcome: 'alreadyRedeemed', snapshot: SNAPSHOT }
    })
    await expect(
      requestGrokResetCredit(
        { sendRequest },
        { hostId: 'host-1', createIdempotencyKey: () => '33333333-3333-4333-8333-333333333333' }
      )
    ).resolves.toMatchObject({ outcome: 'alreadyRedeemed' })
  })
})
