// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshAntigravityRateLimits: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'antigravity-icon' })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: '',
      refreshAntigravityRateLimits: mocks.refreshAntigravityRateLimits,
      rateLimits: {
        antigravity: {
          provider: 'antigravity',
          status: 'ok',
          buckets: [
            { name: 'Gemini 7d', usedPercent: 12, windowMinutes: 10_080, resetsAt: 1000 },
            { name: 'Gemini 5h', windowMinutes: 300, usedPercent: 25, resetsAt: 500 }
          ],
          usageMetadata: { accountEmail: 'test@google.com', subscriptionStatus: 'Google AI Ultra' }
        },
        antigravityAuthConfigured: true
      }
    })
}))

import { AntigravityAccountsSection } from './AntigravityAccountsSection'

describe('AntigravityAccountsSection', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('renders account email, plan tier, and quota buckets', () => {
    render(<AntigravityAccountsSection />)
    expect(screen.getByText('test@google.com')).toBeInTheDocument()
    expect(screen.getByText(/Google AI Ultra/)).toBeInTheDocument()
    expect(screen.getByText('Gemini 7d')).toBeInTheDocument()
    expect(screen.getByText('Gemini 5h')).toBeInTheDocument()
  })
})
