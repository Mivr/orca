import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsScreen from '../app/h/[hostId]/accounts'

const dependencies = vi.hoisted(() => ({
  alert: vi.fn(),
  back: vi.fn(),
  loadHosts: vi.fn(),
  randomUUID: vi.fn(),
  grokResetRequest: vi.fn(),
  statusCapabilities: vi.fn(),
  subscriptionListeners: [] as Array<(payload: unknown) => void>
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: dependencies.alert },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Image: 'Image'
}))

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    },
    useLocalSearchParams: () => ({ hostId: 'host-1' }),
    useRouter: () => ({ back: dependencies.back })
  }
})

vi.mock('expo-crypto', () => ({ randomUUID: dependencies.randomUUID }))

vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronLeft: 'ChevronLeft',
  RefreshCw: 'RefreshCw',
  RotateCcw: 'RotateCcw',
  User: 'User',
  Terminal: 'Terminal'
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Path: 'Path',
  Defs: 'Defs',
  G: 'G',
  LinearGradient: 'LinearGradient',
  Stop: 'Stop'
}))

vi.mock('./transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))

vi.mock('./transport/client-context', () => {
  const client = {
    sendRequest: async (method: string, params?: unknown) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { capabilities: dependencies.statusCapabilities() },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'accounts.consumeGrokResetCredit') {
        return dependencies.grokResetRequest(params)
      }
      if (method === 'accounts.list') {
        return { id: 'list', ok: true, result: HOST_SNAPSHOT }
      }
      throw new Error(`Unexpected request: ${method}`)
    },
    subscribe: (_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      dependencies.subscriptionListeners.push(onData)
      onData({ type: 'ready', snapshot: HOST_SNAPSHOT })
      return vi.fn()
    }
  }
  return {
    useHostClient: () => ({ client, state: 'connected' })
  }
})

vi.mock('./components/AgentIcons', () => ({
  ClaudeIcon: 'ClaudeIcon',
  OpenAIIcon: 'OpenAIIcon'
}))

vi.mock('./components/MobileAgentIcon', () => ({
  MobileAgentIcon: 'MobileAgentIcon'
}))

const HOST_SNAPSHOT = {
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: null,
    codex: null,
    grok: {
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
    },
    cursor: {
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
        subscriptionStatus: 'active'
      },
      updatedAt: 100,
      error: null,
      status: 'ok'
    },
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

const AFTER_GROK_RESET = {
  ...HOST_SNAPSHOT,
  rateLimits: {
    ...HOST_SNAPSHOT.rateLimits,
    grok: {
      ...HOST_SNAPSHOT.rateLimits.grok,
      weekly: { ...HOST_SNAPSHOT.rateLimits.grok.weekly, usedPercent: 0 },
      rateLimitResetCredits: { availableCount: 0, nextExpiresAt: null }
    }
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join('')
  }
  if (typeof node !== 'object') {
    return ''
  }
  const record = node as { children?: unknown; props?: { children?: unknown } }
  if (Array.isArray(record.children) && record.children.length > 0) {
    return record.children.map((child) => collectText(child)).join('')
  }
  return collectText(record.props?.children)
}

async function renderAccountsRoute(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(AccountsScreen))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  if (!renderer) {
    throw new Error('Accounts screen did not render')
  }
  return renderer
}

function grokResetButtons(renderer: ReactTestRenderer) {
  return renderer.root
    .findAllByType('Pressable')
    .filter((node) => node.props.accessibilityLabel === 'Use Grok rate-limit reset')
}

describe('accounts route Grok/Cursor extras', () => {
  beforeEach(() => {
    dependencies.alert.mockReset()
    dependencies.loadHosts.mockReset().mockResolvedValue([
      {
        id: 'host-1',
        name: 'Desk',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'public-key',
        lastConnected: 1
      }
    ])
    dependencies.randomUUID.mockReset().mockReturnValue('22222222-2222-4222-8222-222222222222')
    dependencies.statusCapabilities
      .mockReset()
      .mockReturnValue(['accounts.codex-reset-credit.v1', 'accounts.grok-reset-credit.v1'])
    dependencies.grokResetRequest.mockReset().mockImplementation((params) => ({
      id: 'grok-reset',
      ok: true,
      result: { outcome: 'reset', snapshot: AFTER_GROK_RESET },
      params
    }))
    dependencies.subscriptionListeners.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders Cursor buckets, email, Stripe status, and Grok reset inventory', async () => {
    const renderer = await renderAccountsRoute()
    const text = collectText(renderer.root)

    expect(text).toContain('Cursor Models')
    expect(text).toContain('Other Models')
    expect(text).toContain('Grok Bot')
    expect(text).toContain('dev@example.com')
    expect(text).toContain('ultra · active')
    expect(text).toContain('1 reset available')
    expect(text).toContain('dev@example.com (SuperGrok Heavy)')
    expect(grokResetButtons(renderer)).toHaveLength(1)
    act(() => renderer.unmount())
  })

  it('hides the Grok redeem control when the host does not advertise the capability', async () => {
    dependencies.statusCapabilities.mockReturnValue(['accounts.codex-reset-credit.v1'])
    const renderer = await renderAccountsRoute()
    await act(async () => {
      await Promise.resolve()
    })

    expect(grokResetButtons(renderer)).toHaveLength(0)
    expect(collectText(renderer.root)).toContain('Cursor Models')
    act(() => renderer.unmount())
  })

  it('redeems through accounts.consumeGrokResetCredit without a live token id', async () => {
    const renderer = await renderAccountsRoute()
    const button = grokResetButtons(renderer)[0]
    await act(async () => button?.props.onPress())
    const confirm = dependencies.alert.mock.calls.find(
      (call) => call[0] === 'Use a rate-limit reset?'
    )
    expect(confirm).toBeDefined()
    const useReset = (confirm?.[2] as Array<{ text: string; onPress?: () => void }>).find(
      (action) => action.text === 'Use reset'
    )
    await act(async () => {
      useReset?.onPress?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.grokResetRequest).toHaveBeenCalledWith({
      idempotencyKey: '22222222-2222-4222-8222-222222222222'
    })
    expect(JSON.stringify(dependencies.grokResetRequest.mock.calls)).not.toMatch(/restok_/)
    expect(dependencies.alert).toHaveBeenCalledWith(
      'Rate limits reset',
      'Grok usage has been refreshed.'
    )
    act(() => renderer.unmount())
  })

  it('surfaces dummy-token alreadyRedeemed without calling grok.com', async () => {
    dependencies.grokResetRequest.mockImplementation(() => ({
      id: 'grok-reset',
      ok: true,
      result: { outcome: 'alreadyRedeemed', snapshot: HOST_SNAPSHOT }
    }))
    const renderer = await renderAccountsRoute()
    const button = grokResetButtons(renderer)[0]
    await act(async () => button?.props.onPress())
    const confirm = dependencies.alert.mock.calls.find(
      (call) => call[0] === 'Use a rate-limit reset?'
    )
    const useReset = (confirm?.[2] as Array<{ text: string; onPress?: () => void }>).find(
      (action) => action.text === 'Use reset'
    )
    await act(async () => {
      useReset?.onPress?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(dependencies.alert).toHaveBeenCalledWith(
      'Reset already applied',
      'Grok usage has been refreshed.'
    )
    act(() => renderer.unmount())
  })
})
