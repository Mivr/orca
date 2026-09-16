import { afterEach, describe, expect, it } from 'vitest'
import { reapSandboxOrphansOnStart } from './orcad-sandbox-reaper'
import { resetSandboxManagerForTest, setSandboxDockerRunner } from '../sandbox/sandbox-manager'

afterEach(() => {
  delete process.env.ORCA_SANDBOX_AGENTS
  setSandboxDockerRunner(null)
  resetSandboxManagerForTest()
})

describe('reapSandboxOrphansOnStart', () => {
  it('never touches the store when routing is disabled', async () => {
    await expect(
      reapSandboxOrphansOnStart(() => {
        throw new Error('store unavailable')
      })
    ).resolves.toBeUndefined()
  })

  it('degrades to an empty set when listing fails while enabled', async () => {
    process.env.ORCA_SANDBOX_AGENTS = '1'
    setSandboxDockerRunner(async () => ({ code: 0, stdout: '', stderr: '' }))
    await expect(
      reapSandboxOrphansOnStart(() => {
        throw new Error('store unavailable')
      })
    ).resolves.toBeUndefined()
  })
})
