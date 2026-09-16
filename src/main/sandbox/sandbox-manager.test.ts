import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SANDBOX_SLOTS_FULL, sandboxContainerName } from './sandbox-config'
import {
  describeSandboxesForWorktrees,
  ensureSandboxForWorktree,
  getSandboxState,
  reapOrphanSandboxes,
  removeSandboxForWorktree,
  resetSandboxManagerForTest,
  setSandboxDockerRunner,
  SandboxSlotsFullError
} from './sandbox-manager'

type RecordedCall = { program: string; args: readonly string[] }

let calls: RecordedCall[]
let containers: Map<string, string>
let dir: string

function installFakeDocker(): void {
  calls = []
  containers = new Map()
  setSandboxDockerRunner(async ({ program, args }) => {
    calls.push({ program, args })
    if (args[0] === 'ps') {
      const long = args.includes('-a')
      void long
      const lines = [...containers.entries()].map(([name, worktreeId]) =>
        args.includes('{{.Names}}\t{{.Label "orca.sandbox.worktree"}}')
          ? `${name}\t${worktreeId}`
          : name
      )
      return { code: 0, stdout: lines.join('\n'), stderr: '' }
    }
    if (args[0] === 'run') {
      const nameIndex = args.indexOf('--name')
      const label = args.find(
        (arg) => typeof arg === 'string' && arg.startsWith('orca.sandbox.worktree=')
      )
      const name = nameIndex !== -1 ? String(args[nameIndex + 1]) : ''
      const worktreeId = label ? String(label).split('=').slice(1).join('=') : ''
      containers.set(name, worktreeId)
      return { code: 0, stdout: `${name}\n`, stderr: '' }
    }
    if (args[0] === 'rm') {
      containers.delete(String(args.at(-1)))
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-manager-'))
  process.env.ORCA_SANDBOX_AGENTS = '1'
  resetSandboxManagerForTest()
  installFakeDocker()
})

afterEach(() => {
  delete process.env.ORCA_SANDBOX_AGENTS
  setSandboxDockerRunner(null)
  resetSandboxManagerForTest()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('ensureSandboxForWorktree', () => {
  it('creates a labeled, limited container with same-path worktree + git mounts', async () => {
    const worktreePath = join(dir, 'wt')
    const repoRoot = join(dir, 'repo')
    const gitDir = join(repoRoot, '.git')
    const worktreeGitDir = join(gitDir, 'worktrees', 'wt')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(worktreeGitDir, { recursive: true })
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`)

    const name = await ensureSandboxForWorktree({
      worktreeId: 'repo::/wt',
      worktreePath,
      env: { ANTHROPIC_API_KEY: 'secret', HOME: '/home/mihail' }
    })
    expect(name).toBe(sandboxContainerName('repo::/wt'))

    const run = calls.find((call) => call.args[0] === 'run')
    expect(run).toBeDefined()
    const args = run?.args ?? []
    expect(args).toContain('--memory=4g')
    expect(args).toContain('--cpus=2.0')
    expect(args).toContain('1000:1000')
    expect(args).toContain('orca.sandbox.managed=1')
    expect(args).toContain('orca.sandbox.worktree=repo::/wt')
    expect(args).toContain(`${worktreePath}:${worktreePath}`)
    // Whole main .git (shared object store), not just the worktrees pointer.
    expect(args).toContain(`${gitDir}:${gitDir}`)
    expect(args).not.toContain(`${worktreeGitDir}:${worktreeGitDir}`)
    expect(args).not.toContain('/home/mihail:/home/mihail')
    // Ephemeral HOME: image /root is unreadable as uid 1000, host home denied.
    expect(args).toContain('HOME=/var/tmp')
    expect(args).toContain('sleep')
    const envFileIndex = args.indexOf('--env-file')
    expect(envFileIndex).toBeGreaterThan(-1)
  })

  it('passes DRI devices and GPU groups through to docker run', async () => {
    const worktreePath = join(dir, 'wt-gpu')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(worktreePath, { recursive: true })

    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-gpu', worktreePath })

    const run = calls.find((call) => call.args[0] === 'run')
    const args = run?.args ?? []
    const deviceIndex = args.indexOf('--device')
    expect(deviceIndex).toBeGreaterThan(-1)
    expect(args[deviceIndex + 1]).toBe('/dev/dri/renderD128')
    expect(args).toContain('--group-add')
    const groupAdds = args.flatMap((arg, i) => (arg === '--group-add' ? [args[i + 1]] : []))
    expect(groupAdds).toContain('44')
    expect(groupAdds).toContain('991')
  })

  it('honors GPU env overrides and empty opt-out', async () => {
    const { mkdirSync } = await import('node:fs')
    vi.stubEnv('ORCA_SANDBOX_DRI_DEVICES', '/dev/dri/card1,/dev/dri/renderD128')
    vi.stubEnv('ORCA_SANDBOX_GPU_GROUPS', 'video,render')
    const overridePath = join(dir, 'wt-gpu-override')
    mkdirSync(overridePath, { recursive: true })
    await ensureSandboxForWorktree({
      worktreeId: 'repo::/wt-gpu-override',
      worktreePath: overridePath
    })
    const overrideArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(overrideArgs).toContain('/dev/dri/card1')
    expect(overrideArgs).toContain('/dev/dri/renderD128')
    expect(overrideArgs).toContain('video')

    vi.stubEnv('ORCA_SANDBOX_DRI_DEVICES', '')
    vi.stubEnv('ORCA_SANDBOX_GPU_GROUPS', '')
    calls = []
    const optOutPath = join(dir, 'wt-gpu-optout')
    mkdirSync(optOutPath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-gpu-optout', worktreePath: optOutPath })
    const optOutArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(optOutArgs).not.toContain('--device')
    expect(optOutArgs).not.toContain('--group-add')
  })

  it('reuses the live container without a second docker run', async () => {
    const worktreePath = join(dir, 'wt2')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt2', worktreePath })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt2', worktreePath })
    expect(calls.filter((call) => call.args[0] === 'run')).toHaveLength(1)
  })

  it('rejects past ten slots with sandbox_slots_full and never queues', async () => {
    const { mkdirSync } = await import('node:fs')
    for (let i = 0; i < 10; i += 1) {
      const path = join(dir, `wt-${i}`)
      mkdirSync(path, { recursive: true })
      await ensureSandboxForWorktree({ worktreeId: `repo::/wt-${i}`, worktreePath: path })
    }
    // A fresh process view: drop the in-memory cache so the cap reads docker labels.
    resetSandboxManagerForTest()
    const overflow = join(dir, 'wt-overflow')
    mkdirSync(overflow, { recursive: true })
    await expect(
      ensureSandboxForWorktree({ worktreeId: 'repo::/overflow', worktreePath: overflow })
    ).rejects.toBeInstanceOf(SandboxSlotsFullError)
    await expect(
      ensureSandboxForWorktree({ worktreeId: 'repo::/overflow', worktreePath: overflow })
    ).rejects.toThrow(SANDBOX_SLOTS_FULL)
    expect(calls.filter((call) => call.args[0] === 'run')).toHaveLength(10)
  })
})

describe('removeSandboxForWorktree', () => {
  it('stop+removes the container', async () => {
    const worktreePath = join(dir, 'wt-rm')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(worktreePath, { recursive: true })
    const name = await ensureSandboxForWorktree({ worktreeId: 'repo::/rm', worktreePath })
    await removeSandboxForWorktree('repo::/rm')
    expect(calls.at(-1)?.args).toEqual(['rm', '-f', name])
    expect(await getSandboxState('repo::/rm')).toBe('absent')
  })
})

describe('describeSandboxesForWorktrees', () => {
  it('reports running plus the fresh rejection reason', async () => {
    const worktreePath = join(dir, 'wt-ps')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/ps', worktreePath })
    const described = await describeSandboxesForWorktrees(['repo::/ps', 'repo::/gone'])
    expect(described.get('repo::/ps')?.sandbox).toBe('running')
    expect(described.get('repo::/gone')?.sandbox).toBe('absent')
  })
})

describe('reapOrphanSandboxes', () => {
  it('removes labeled containers whose worktree is gone and keeps live ones', async () => {
    const { mkdirSync } = await import('node:fs')
    for (const id of ['repo::/keep', 'repo::/drop']) {
      const path = join(dir, id.replace('repo::/', ''))
      mkdirSync(path, { recursive: true })
      await ensureSandboxForWorktree({ worktreeId: id, worktreePath: path })
    }
    resetSandboxManagerForTest()
    const reaped = await reapOrphanSandboxes(new Set(['repo::/keep']))
    expect(reaped).toEqual([sandboxContainerName('repo::/drop')])
    expect(calls.at(-1)?.args).toEqual(['rm', '-f', sandboxContainerName('repo::/drop')])
    const described = await describeSandboxesForWorktrees(['repo::/keep', 'repo::/drop'])
    expect(described.get('repo::/keep')?.sandbox).toBe('running')
    expect(described.get('repo::/drop')?.sandbox).toBe('absent')
  })

  it('does nothing when routing is disabled', async () => {
    delete process.env.ORCA_SANDBOX_AGENTS
    expect(await reapOrphanSandboxes(new Set())).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
