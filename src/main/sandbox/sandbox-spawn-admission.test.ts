import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitSandboxSpawn, isSandboxSpawnCandidate } from './sandbox-spawn-admission'
import {
  resetSandboxManagerForTest,
  setSandboxDockerRunner,
  SANDBOX_SLOTS_FULL
} from './sandbox-manager'
import { SANDBOX_CONTAINER_ENV } from './sandbox-config'

let runs = 0
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-admission-'))
  process.env.ORCA_SANDBOX_AGENTS = '1'
  resetSandboxManagerForTest()
  runs = 0
  setSandboxDockerRunner(async ({ args }) => {
    if (args[0] === 'ps') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'run') {
      runs += 1
      return { code: 0, stdout: 'id\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
})

afterEach(() => {
  delete process.env.ORCA_SANDBOX_AGENTS
  setSandboxDockerRunner(null)
  resetSandboxManagerForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('isSandboxSpawnCandidate', () => {
  it('rejects plain shells, reattaches, and non-absolute cwds', () => {
    const cwd = join(dir, 'wt')
    mkdirSync(cwd, { recursive: true })
    expect(isSandboxSpawnCandidate({ worktreeId: 'w', cwd })).toBe(false)
    expect(
      isSandboxSpawnCandidate({ worktreeId: 'w', cwd, launchAgent: 'codex', attachOnly: true })
    ).toBe(false)
    expect(
      isSandboxSpawnCandidate({
        worktreeId: 'w',
        cwd,
        launchAgent: 'codex',
        sessionId: 's',
        isNewSession: false
      })
    ).toBe(false)
    expect(
      isSandboxSpawnCandidate({ worktreeId: 'w', cwd: 'relative', launchAgent: 'codex' })
    ).toBe(false)
  })

  it('accepts agent launches by intent or recognized command', () => {
    const cwd = join(dir, 'wt')
    expect(isSandboxSpawnCandidate({ worktreeId: 'w', cwd, launchAgent: 'codex' })).toBe(true)
    expect(isSandboxSpawnCandidate({ worktreeId: 'w', cwd, command: 'codex --yolo' })).toBe(true)
  })
})

describe('admitSandboxSpawn', () => {
  it('stamps the sandbox container into the spawn env', async () => {
    const cwd = join(dir, 'wt')
    mkdirSync(cwd, { recursive: true })
    const stamp = await admitSandboxSpawn({ worktreeId: 'w', cwd, launchAgent: 'codex' })
    expect(stamp?.[SANDBOX_CONTAINER_ENV]).toMatch(/^orca-sandbox-/)
    expect(runs).toBe(1)
  })

  it('returns null for host spawns without admitting', async () => {
    const cwd = join(dir, 'wt')
    expect(await admitSandboxSpawn({ worktreeId: 'w', cwd })).toBeNull()
    expect(runs).toBe(0)
  })

  it('throws sandbox_slots_full past the cap', async () => {
    delete process.env.ORCA_SANDBOX_AGENTS
    process.env.ORCA_SANDBOX_AGENTS = '1'
    setSandboxDockerRunner(async ({ args }) => {
      if (args[0] === 'ps') {
        return {
          code: 0,
          stdout: Array.from({ length: 10 }, (_, i) => `c${i}`).join('\n'),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const cwd = join(dir, 'wt')
    await expect(admitSandboxSpawn({ worktreeId: 'w', cwd, launchAgent: 'codex' })).rejects.toThrow(
      SANDBOX_SLOTS_FULL
    )
  })
})
