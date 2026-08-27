import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { registerTerminalStreamViewSubscriber } from './terminal-stream-view-subscriber'

function createRuntime() {
  return {
    registerRawTerminalViewSubscriber: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn())
  } as unknown as OrcaRuntimeService
}

describe('registerTerminalStreamViewSubscriber', () => {
  it.each([
    ['legacy mobile', true, undefined, 'raw'],
    ['unready mobile', true, 0, 'raw'],
    ['ready mobile', true, 1, 'remote'],
    ['unidentified mobile', true, 1, 'raw'],
    ['legacy desktop', false, undefined, 'remote'],
    ['unready desktop', false, 0, 'raw']
  ] as const)('registers %s correctly', (_case, isMobile, queryReplyInput, expected) => {
    const runtime = createRuntime()
    const clientId = _case === 'unidentified mobile' ? undefined : 'client-1'

    registerTerminalStreamViewSubscriber({
      runtime,
      ptyId: 'pty-1',
      clientId,
      isMobile,
      queryReplyInput
    })

    expect(runtime.registerRawTerminalViewSubscriber).toHaveBeenCalledTimes(
      expected === 'raw' ? 1 : 0
    )
    expect(runtime.registerRemoteTerminalViewSubscriber).toHaveBeenCalledTimes(
      expected === 'remote' ? 1 : 0
    )
    if (expected === 'remote') {
      expect(runtime.registerRemoteTerminalViewSubscriber).toHaveBeenCalledWith(
        'pty-1',
        isMobile ? clientId : undefined
      )
    }
  })
})
