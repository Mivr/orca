import { describe, expect, it } from 'vitest'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'

// Fork-only: upstream dropped agent-launch-typed-line-shell.test.ts; these cover the sandbox paths.
describe('typed launch lines under the docker sandbox', () => {
  it('names the sandbox inner shell on Linux when sandbox routing is active', () => {
    if (process.platform === 'linux') {
      expect(
        nameLocalTypedLineShell({
          isRemote: false,
          platform: 'linux',
          envShell: '/bin/zsh',
          env: { ORCA_SANDBOX_AGENTS: '1' }
        })
      ).toBe('bash')
    }
  })

  it('returns false on a local Linux host when sandbox routing wraps the PTY in docker exec', () => {
    expect(
      launchHostProvesAgentInFront({
        isRemote: false,
        launchPlatform: 'linux',
        hostPlatform: 'linux',
        env: { ORCA_SANDBOX_AGENTS: '1' }
      })
    ).toBe(false)
  })

  it('still proves the agent in front on a local Linux host without sandbox routing', () => {
    expect(
      launchHostProvesAgentInFront({
        isRemote: false,
        launchPlatform: 'linux',
        hostPlatform: 'linux',
        env: {}
      })
    ).toBe(true)
  })
})
