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
  // Why stubbed: admission ensures orcad-owned hook dirs (spool, overlays)
  // and the managed codex home — without stubs those mkdirs land in the real
  // HOME instead of the fixture dir.
  vi.stubEnv('ORCA_USER_DATA', join(dir, 'userdata'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(dir, 'config-orca'))
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
    expect(args).toContain('--memory=8g')
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
    expect(args).toContain('--add-host')
    const addHosts = args.flatMap((arg, i) => (arg === '--add-host' ? [args[i + 1]] : []))
    expect(addHosts).toContain('host.docker.internal:host-gateway')
  })

  it('honors extra hosts env overrides and empty opt-out', async () => {
    const { mkdirSync } = await import('node:fs')
    vi.stubEnv('ORCA_SANDBOX_EXTRA_HOSTS', 'custom.internal:10.0.0.1')
    const overridePath = join(dir, 'wt-hosts-override')
    mkdirSync(overridePath, { recursive: true })
    await ensureSandboxForWorktree({
      worktreeId: 'repo::/wt-hosts-override',
      worktreePath: overridePath
    })
    const overrideArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(overrideArgs).toContain('custom.internal:10.0.0.1')

    vi.stubEnv('ORCA_SANDBOX_EXTRA_HOSTS', '')
    calls = []
    const optOutPath = join(dir, 'wt-hosts-optout')
    mkdirSync(optOutPath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-hosts-optout', worktreePath: optOutPath })
    const optOutArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(optOutArgs).not.toContain('--add-host')
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

  it('stamps the hardware-GL AGENT_BROWSER_ARGS default into new sandboxes', async () => {
    const { mkdirSync } = await import('node:fs')
    const glPath = join(dir, 'wt-gpu-gl')
    mkdirSync(glPath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-gpu-gl', worktreePath: glPath })
    const args = calls.find((call) => call.args[0] === 'run')?.args ?? []
    const envIndex = args.indexOf(
      'AGENT_BROWSER_ARGS=--use-gl=angle,--use-angle=gl-egl,--ignore-gpu-blocklist,--disable-gpu-sandbox'
    )
    expect(envIndex).toBeGreaterThan(-1)
    expect(args[envIndex - 1]).toBe('-e')
  })

  it('honors the browser-GPU env override and empty opt-out', async () => {
    const { mkdirSync } = await import('node:fs')
    vi.stubEnv('ORCA_SANDBOX_BROWSER_GPU_ARGS', '--use-gl=swiftshader')
    const overridePath = join(dir, 'wt-gpu-gl-override')
    mkdirSync(overridePath, { recursive: true })
    await ensureSandboxForWorktree({
      worktreeId: 'repo::/wt-gpu-gl-override',
      worktreePath: overridePath
    })
    const overrideArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(overrideArgs).toContain('AGENT_BROWSER_ARGS=--use-gl=swiftshader')

    vi.stubEnv('ORCA_SANDBOX_BROWSER_GPU_ARGS', '')
    calls = []
    const optOutPath = join(dir, 'wt-gpu-gl-optout')
    mkdirSync(optOutPath, { recursive: true })
    await ensureSandboxForWorktree({
      worktreeId: 'repo::/wt-gpu-gl-optout',
      worktreePath: optOutPath
    })
    const optOutArgs = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(optOutArgs.some((arg) => arg.startsWith('AGENT_BROWSER_ARGS='))).toBe(false)
  })

  it('stamps :ro git-auth mounts from the host home, never the whole home', async () => {
    const { mkdirSync } = await import('node:fs')
    const fakeHome = join(dir, 'fakehome')
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
    mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true })
    vi.stubEnv('HOME', fakeHome)
    const worktreePath = join(dir, 'wt-auth')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-auth', worktreePath })
    const args = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(args).toContain(`${fakeHome}/.ssh:/var/tmp/.ssh:ro`)
    expect(args).toContain(`${fakeHome}/.config/gh:/var/tmp/.config/gh:ro`)
    expect(args).not.toContain(`${fakeHome}:${fakeHome}`)
    expect(args).not.toContain('/home/mihail:/home/mihail')
  })

  it('stamps CLI logins :rw so refresh writes back, skipping absent sources', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const fakeHome = join(dir, 'fakehome-cli')
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
    writeFileSync(join(fakeHome, '.claude.json'), '{}')
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    mkdirSync(join(fakeHome, '.codex'), { recursive: true })
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true })
    mkdirSync(join(fakeHome, '.grok'), { recursive: true })
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(fakeHome, '.config', 'gcloud'), { recursive: true })
    mkdirSync(join(fakeHome, '.local', 'share', 'opencode'), { recursive: true })
    vi.stubEnv('HOME', fakeHome)
    const worktreePath = join(dir, 'wt-auth-cli')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-auth-cli', worktreePath })
    const args = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(args).toContain(`${fakeHome}/.claude.json:/var/tmp/.claude.json:rw`)
    expect(args).toContain(`${fakeHome}/.claude:/var/tmp/.claude:rw`)
    expect(args).toContain(`${fakeHome}/.codex:/var/tmp/.codex:rw`)
    expect(args).toContain(`${fakeHome}/.cursor:/var/tmp/.cursor:rw`)
    expect(args).toContain(`${fakeHome}/.grok:/var/tmp/.grok:rw`)
    expect(args).toContain(
      `${fakeHome}/.gemini/antigravity-cli:/var/tmp/.gemini/antigravity-cli:rw`
    )
    expect(args).toContain(`${fakeHome}/.config/gcloud:/var/tmp/.config/gcloud:rw`)
    expect(args).toContain(`${fakeHome}/.local/share/opencode:/var/tmp/.local/share/opencode:rw`)
    // gh absent here → skipped, never shadowed with an empty dir.
    expect(args.some((arg) => typeof arg === 'string' && arg.includes('/.config/gh'))).toBe(false)
  })

  it('stamps hook-plane mounts: scripts :ro, spool :rw, codex home + overlays :rw', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const fakeHome = join(dir, 'fakehome-hooks')
    mkdirSync(join(fakeHome, '.orca', 'agent-hooks'), { recursive: true })
    writeFileSync(join(fakeHome, '.orca', 'agent-hooks', 'agy-hook.sh'), '#!/bin/sh\n')
    mkdirSync(join(fakeHome, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(fakeHome, '.gemini', 'config', 'hooks.json'), '{}')
    vi.stubEnv('HOME', fakeHome)
    const worktreePath = join(dir, 'wt-hooks')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-hooks', worktreePath })
    const args = calls.find((call) => call.args[0] === 'run')?.args ?? []
    const scriptsDir = join(fakeHome, '.orca', 'agent-hooks')
    expect(args).toContain(`${scriptsDir}:${scriptsDir}:ro`)
    expect(args).toContain(`${scriptsDir}:/var/tmp/.orca/agent-hooks:ro`)
    expect(args).toContain(`${join(fakeHome, '.gemini', 'config')}:/var/tmp/.gemini/config:ro`)
    // Orcad-owned dirs are ensured at admission even with no prior spawn.
    const spoolDir = join(dir, 'userdata', 'agent-hooks', 'spool')
    const overlaysDir = join(dir, 'userdata', 'opencode-config-overlays')
    expect(args).toContain(`${spoolDir}:${spoolDir}:rw`)
    expect(args).toContain(`${overlaysDir}:${overlaysDir}:rw`)
    const codexHome = join(dir, 'config-orca', 'codex-runtime-home', 'home')
    expect(args).toContain(`${codexHome}:${codexHome}:rw`)
  })

  it('opts out of git-auth mounts via ORCA_SANDBOX_AUTH_MOUNTS=', async () => {
    const { mkdirSync } = await import('node:fs')
    const fakeHome = join(dir, 'fakehome-optout')
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true })
    mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true })
    mkdirSync(join(fakeHome, '.codex'), { recursive: true })
    vi.stubEnv('HOME', fakeHome)
    vi.stubEnv('ORCA_SANDBOX_AUTH_MOUNTS', '')
    const worktreePath = join(dir, 'wt-auth-optout')
    mkdirSync(worktreePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: 'repo::/wt-auth-optout', worktreePath })
    const args = calls.find((call) => call.args[0] === 'run')?.args ?? []
    expect(args.some((arg) => typeof arg === 'string' && arg.endsWith(':ro'))).toBe(false)
    expect(args.some((arg) => typeof arg === 'string' && arg.endsWith(':rw'))).toBe(false)
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
