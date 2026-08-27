import { describe, expect, it } from 'vitest'

import { decodeAccountsSnapshot } from './accounts-snapshot'

function makeSnapshot(): unknown {
  return {
    extensionField: { retained: true },
    claude: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: [
        {
          id: 'codex-host',
          email: 'host@example.com',
          managedHomeRuntime: 'host',
          wslDistro: null,
          updatedAt: 100,
          extensionField: 'account-extra'
        }
      ],
      activeAccountId: 'codex-host',
      activeAccountIdsByRuntime: {
        host: 'codex-host',
        wsl: { Ubuntu: 'codex-wsl' }
      }
    },
    rateLimits: {
      extensionField: 'limits-extra',
      claude: null,
      grok: {
        provider: 'grok',
        session: null,
        weekly: null,
        rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null },
        updatedAt: 100,
        error: null,
        status: 'unavailable'
      },
      cursor: {
        provider: 'cursor',
        session: null,
        weekly: null,
        buckets: [],
        updatedAt: 100,
        error: null,
        status: 'unavailable'
      },
      codex: {
        provider: 'codex',
        session: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: 200,
          resetDescription: 'soon'
        },
        weekly: null,
        rateLimitResetCredits: {
          availableCount: 1,
          totalEarnedCount: 2,
          nextExpiresAt: 300,
          credits: [{ status: 'available', expiresAt: 300, grantedAt: 50 }]
        },
        updatedAt: 100,
        error: null,
        status: 'ok',
        extensionField: 'provider-extra'
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [
        {
          accountId: 'codex-inactive',
          rateLimits: null,
          updatedAt: 99,
          isFetching: false
        }
      ]
    }
  }
}

function setPath(root: unknown, path: string[], value: unknown): void {
  let current: unknown = root
  for (const segment of path.slice(0, -1)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Invalid fixture path: ${path.join('.')}`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Invalid fixture path: ${path.join('.')}`)
  }
  const record = current as Record<string, unknown>
  record[path.at(-1)!] = value
}

describe('decodeAccountsSnapshot', () => {
  it('validates nested account/rate-limit state and preserves forward-compatible fields', () => {
    const snapshot = decodeAccountsSnapshot(makeSnapshot())

    expect(snapshot.extensionField).toEqual({ retained: true })
    expect(snapshot.codex.accounts[0]?.extensionField).toBe('account-extra')
    expect(snapshot.rateLimits.extensionField).toBe('limits-extra')
    expect(snapshot.rateLimits.codex?.extensionField).toBe('provider-extra')
  })

  it('defaults missing runtime targets for older host-only snapshots', () => {
    const raw = makeSnapshot() as {
      rateLimits: {
        claudeTarget?: unknown
        codexTarget?: unknown
        grok?: unknown
        cursor?: unknown
      }
    }
    delete raw.rateLimits.claudeTarget
    delete raw.rateLimits.codexTarget
    delete raw.rateLimits.grok
    delete raw.rateLimits.cursor

    const snapshot = decodeAccountsSnapshot(raw)

    expect(snapshot.rateLimits.claudeTarget).toEqual({ runtime: 'host', wslDistro: null })
    expect(snapshot.rateLimits.codexTarget).toEqual({ runtime: 'host', wslDistro: null })
    expect(snapshot.rateLimits.grok).toBeUndefined()
    expect(snapshot.rateLimits.cursor).toBeUndefined()
  })

  it('decodes Cursor buckets, email, Stripe status, and Grok reset credits as first-class fields', () => {
    const raw = makeSnapshot() as {
      rateLimits: Record<string, unknown>
    }
    raw.rateLimits.cursor = {
      provider: 'cursor',
      session: null,
      weekly: null,
      buckets: [
        {
          name: 'Cursor Models',
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: Date.parse('2026-08-27T20:01:49Z'),
          resetDescription: 'Aug 27'
        },
        {
          name: 'Other Models',
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: Date.parse('2026-08-27T20:01:49Z'),
          resetDescription: 'Aug 27'
        },
        {
          name: 'Grok Bot',
          usedPercent: 0,
          windowMinutes: 10_080,
          resetsAt: Date.parse('2026-08-31T15:44:42.913Z'),
          resetDescription: 'Aug 31'
        }
      ],
      planType: 'ultra',
      usageMetadata: {
        accountEmail: 'dev@example.com',
        subscriptionStatus: 'active',
        authProvenance: 'dev@example.com · ultra · active'
      },
      updatedAt: 100,
      error: null,
      status: 'ok'
    }
    raw.rateLimits.grok = {
      provider: 'grok',
      session: null,
      weekly: {
        usedPercent: 13,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-09-03T12:58:43Z'),
        resetDescription: 'Thu'
      },
      rateLimitResetCredits: {
        availableCount: 1,
        nextExpiresAt: Date.parse('2026-09-12T18:49:00Z')
      },
      usageMetadata: { authProvenance: 'dev@example.com (SuperGrok Heavy)' },
      updatedAt: 100,
      error: null,
      status: 'ok'
    }

    const snapshot = decodeAccountsSnapshot(raw)

    expect(snapshot.rateLimits.cursor?.buckets?.map((bucket) => bucket.name)).toEqual([
      'Cursor Models',
      'Other Models',
      'Grok Bot'
    ])
    expect(snapshot.rateLimits.cursor?.usageMetadata?.accountEmail).toBe('dev@example.com')
    expect(snapshot.rateLimits.cursor?.usageMetadata?.subscriptionStatus).toBe('active')
    expect(snapshot.rateLimits.cursor?.planType).toBe('ultra')
    expect(snapshot.rateLimits.grok?.rateLimitResetCredits).toEqual({
      availableCount: 1,
      nextExpiresAt: Date.parse('2026-09-12T18:49:00Z')
    })
    expect(snapshot.rateLimits.grok?.weekly?.usedPercent).toBe(13)
  })

  it.each([
    ['account arrays', ['codex', 'accounts'], {}],
    ['active account IDs', ['codex', 'activeAccountId'], 42],
    ['runtime selections', ['codex', 'activeAccountIdsByRuntime', 'wsl'], []],
    ['targets', ['rateLimits', 'codexTarget', 'runtime'], 'remote'],
    ['provider identity', ['rateLimits', 'codex', 'provider'], 'claude'],
    ['inactive account arrays', ['rateLimits', 'inactiveCodexAccounts'], {}],
    ['window percentages', ['rateLimits', 'codex', 'session', 'usedPercent'], 101],
    ['credit counts', ['rateLimits', 'codex', 'rateLimitResetCredits', 'availableCount'], -1],
    [
      'credit status',
      ['rateLimits', 'codex', 'rateLimitResetCredits', 'credits'],
      [{ status: '', expiresAt: 300, grantedAt: 50 }]
    ],
    ['credit expiry', ['rateLimits', 'codex', 'rateLimitResetCredits', 'nextExpiresAt'], 'soon'],
    ['Grok provider identity', ['rateLimits', 'grok', 'provider'], 'codex'],
    ['Cursor provider identity', ['rateLimits', 'cursor', 'provider'], 'grok']
  ] satisfies Array<[string, string[], unknown]>)('rejects malformed %s', (_name, path, value) => {
    const snapshot = makeSnapshot()
    setPath(snapshot, path, value)

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })

  it('rejects a host target that smuggles a WSL distro', () => {
    const snapshot = makeSnapshot()
    setPath(snapshot, ['rateLimits', 'codexTarget', 'wslDistro'], 'Ubuntu')

    expect(() => decodeAccountsSnapshot(snapshot)).toThrow('Invalid accounts snapshot from host')
  })
})
