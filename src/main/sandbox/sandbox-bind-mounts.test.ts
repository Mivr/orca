import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveHostBindSource,
  resolveHostBindSourceAsync,
  resolveSandboxAuthMounts,
  resolveSandboxMounts,
  sandboxAuthMountSpecs
} from './sandbox-bind-mounts'

let dir: string
let savedHostname: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-bind-mounts-'))
  savedHostname = process.env.HOSTNAME
})

afterEach(() => {
  if (savedHostname === undefined) {
    delete process.env.HOSTNAME
  } else {
    process.env.HOSTNAME = savedHostname
  }
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('resolveSandboxMounts', () => {
  it('binds only the worktree when no gitdir pointer exists', async () => {
    const { mounts, gitDir } = await resolveSandboxMounts(join(dir, 'missing'), async () => ({
      code: 1,
      stdout: '',
      stderr: ''
    }))
    expect(mounts).toHaveLength(1)
    expect(gitDir).toBeNull()
  })
})

describe('resolveHostBindSource', () => {
  const mounts = [
    { mountpoint: '/home/mihail', source: '/home/mihail' },
    { mountpoint: '/src', source: '/work/docker/volumes/orca-src/_data' }
  ]
  it('maps volume paths to their host source, keeping the destination', () => {
    expect(resolveHostBindSource('/src/simple-business/.git', mounts)).toBe(
      '/work/docker/volumes/orca-src/_data/simple-business/.git'
    )
  })
  it('leaves ordinary host paths alone', () => {
    expect(resolveHostBindSource('/home/mihail/orca/workspaces/x', mounts)).toBe(
      '/home/mihail/orca/workspaces/x'
    )
    expect(resolveHostBindSource('/tmp/y', mounts)).toBe('/tmp/y')
  })
  it('prefers daemon-reported self mounts over /proc device entries', async () => {
    process.env.HOSTNAME = 'aa1abb0cd21b19a1cd0e2903a2b49cf0ab5e1ca945e45c9d4983c06c6f5fda86'
    const inspectRunner = async ({ args }: { args: readonly string[] }) => {
      if (args[0] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([
            { Destination: '/src', Source: '/work/docker/volumes/orca-src/_data' },
            { Destination: '/home/mihail', Source: '/home/mihail' }
          ]),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    expect(await resolveHostBindSourceAsync('/src/simple-business/.git', inspectRunner)).toBe(
      '/work/docker/volumes/orca-src/_data/simple-business/.git'
    )
  })
  it('honors the explicit bind map for containerized orcad', async () => {
    process.env.ORCA_SANDBOX_BIND_MAP = '/src=/work/docker/volumes/orca-src/_data'
    try {
      const neverInspect = async () => {
        throw new Error('must not inspect when the map covers the path')
      }
      expect(await resolveHostBindSourceAsync('/src/simple-business/.git', neverInspect)).toBe(
        '/work/docker/volumes/orca-src/_data/simple-business/.git'
      )
    } finally {
      delete process.env.ORCA_SANDBOX_BIND_MAP
    }
  })
})

describe('resolveSandboxAuthMounts', () => {
  const noInspect = async () => ({ code: 0, stdout: '', stderr: '' })

  function fixtureHome(): string {
    const home = join(dir, 'fakehome')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(join(home, '.config', 'gh'), { recursive: true })
    return home
  }

  it('aims ssh/gh at the stamped HOME and hooks/cookies same-path, git-auth :ro', async () => {
    const specs = sandboxAuthMountSpecs('/home/mihail')
    expect(specs).toEqual([
      {
        key: 'ssh',
        hostPath: '/home/mihail/.ssh',
        containerPath: '/var/tmp/.ssh',
        kind: 'dir',
        mode: 'ro'
      },
      {
        key: 'gh',
        hostPath: '/home/mihail/.config/gh',
        containerPath: '/var/tmp/.config/gh',
        kind: 'dir',
        mode: 'ro'
      },
      {
        key: 'git-hooks',
        hostPath: '/home/mihail/.config/git-hooks',
        containerPath: '/home/mihail/.config/git-hooks',
        kind: 'dir',
        mode: 'ro'
      },
      {
        key: 'gitcookies',
        hostPath: '/home/mihail/.gitcookies',
        containerPath: '/home/mihail/.gitcookies',
        kind: 'file',
        mode: 'ro'
      },
      {
        key: 'claude-json',
        hostPath: '/home/mihail/.claude.json',
        containerPath: '/var/tmp/.claude.json',
        kind: 'file',
        mode: 'rw'
      },
      {
        key: 'claude',
        hostPath: '/home/mihail/.claude',
        containerPath: '/var/tmp/.claude',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'codex',
        hostPath: '/home/mihail/.codex',
        containerPath: '/var/tmp/.codex',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'cursor',
        hostPath: '/home/mihail/.cursor',
        containerPath: '/var/tmp/.cursor',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'grok',
        hostPath: '/home/mihail/.grok',
        containerPath: '/var/tmp/.grok',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'gemini-antigravity',
        hostPath: '/home/mihail/.gemini/antigravity-cli',
        containerPath: '/var/tmp/.gemini/antigravity-cli',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'gcloud',
        hostPath: '/home/mihail/.config/gcloud',
        containerPath: '/var/tmp/.config/gcloud',
        kind: 'dir',
        mode: 'rw'
      },
      {
        key: 'opencode',
        hostPath: '/home/mihail/.local/share/opencode',
        containerPath: '/var/tmp/.local/share/opencode',
        kind: 'dir',
        mode: 'rw'
      }
    ])
  })

  it('mounts present sources :ro and skips absent ones without shadowing', async () => {
    const home = fixtureHome()
    const mounts = await resolveSandboxAuthMounts(noInspect, { orcadHome: home })
    expect(mounts).toEqual([
      `${home}/.ssh:/var/tmp/.ssh:ro`,
      `${home}/.config/gh:/var/tmp/.config/gh:ro`
    ])
  })

  it('mounts CLI logins :rw so token refresh writes back to the host', async () => {
    const home = join(dir, 'clihome')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude.json'), '{}')
    mkdirSync(join(home, '.codex'), { recursive: true })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    mkdirSync(join(home, '.grok'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(home, '.config', 'gcloud'), { recursive: true })
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    const mounts = await resolveSandboxAuthMounts(noInspect, {
      orcadHome: home,
      env: {
        ORCA_SANDBOX_AUTH_MOUNTS:
          'claude-json,claude,codex,cursor,grok,gemini-antigravity,gcloud,opencode'
      }
    })
    expect(mounts).toEqual([
      `${home}/.claude.json:/var/tmp/.claude.json:rw`,
      `${home}/.claude:/var/tmp/.claude:rw`,
      `${home}/.codex:/var/tmp/.codex:rw`,
      `${home}/.cursor:/var/tmp/.cursor:rw`,
      `${home}/.grok:/var/tmp/.grok:rw`,
      `${home}/.gemini/antigravity-cli:/var/tmp/.gemini/antigravity-cli:rw`,
      `${home}/.config/gcloud:/var/tmp/.config/gcloud:rw`,
      `${home}/.local/share/opencode:/var/tmp/.local/share/opencode:rw`
    ])
  })

  it('skips a CLI login file of the wrong kind without shadowing', async () => {
    const home = join(dir, 'wrongkind')
    mkdirSync(join(home, '.claude.json'), { recursive: true })
    const mounts = await resolveSandboxAuthMounts(noInspect, {
      orcadHome: home,
      env: { ORCA_SANDBOX_AUTH_MOUNTS: 'claude-json' }
    })
    expect(mounts).toEqual([])
  })

  it('mounts hooks dir and cookies file once they exist on the host', async () => {
    const home = fixtureHome()
    mkdirSync(join(home, '.config', 'git-hooks'), { recursive: true })
    writeFileSync(join(home, '.gitcookies'), 'example.com\tTRUE\n')
    const mounts = await resolveSandboxAuthMounts(noInspect, { orcadHome: home })
    expect(mounts).toContain(`${home}/.config/git-hooks:/home/mihail/.config/git-hooks:ro`)
    expect(mounts).toContain(`${home}/.gitcookies:/home/mihail/.gitcookies:ro`)
  })

  it('respects the env subset and empty opt-out', async () => {
    const home = fixtureHome()
    // Why passed as opts.env, not stubbed: resolveSandboxAuthMounts reads the
    // override from the given env, keeping HOME stubbing out of the picture.
    expect(
      await resolveSandboxAuthMounts(noInspect, {
        orcadHome: home,
        env: { ORCA_SANDBOX_AUTH_MOUNTS: 'gh' }
      })
    ).toEqual([`${home}/.config/gh:/var/tmp/.config/gh:ro`])
    expect(
      await resolveSandboxAuthMounts(noInspect, {
        orcadHome: home,
        env: { ORCA_SANDBOX_AUTH_MOUNTS: '' }
      })
    ).toEqual([])
  })

  it('maps sources through the explicit bind map for containerized orcad', async () => {
    const home = fixtureHome()
    vi.stubEnv('ORCA_SANDBOX_BIND_MAP', `${home}=/host/home`)
    const mounts = await resolveSandboxAuthMounts(noInspect, { orcadHome: home })
    expect(mounts).toContain('/host/home/.ssh:/var/tmp/.ssh:ro')
  })

  it('mounts the hook plane: scripts :ro twice, agy config :ro, spool :rw, homes :rw', async () => {
    const home = join(dir, 'hookhome')
    const scriptsDir = join(home, '.orca', 'agent-hooks')
    const geminiConfigDir = join(home, '.gemini', 'config')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'claude-hook.sh'), '#!/bin/sh\n')
    mkdirSync(geminiConfigDir, { recursive: true })
    writeFileSync(join(geminiConfigDir, 'hooks.json'), '{}')
    const userData = join(dir, 'userdata')
    const endpointDir = join(userData, 'agent-hooks')
    const spoolDir = join(endpointDir, 'spool')
    const codexRuntimeHome = join(dir, 'codexhome')
    const opencodeOverlaysDir = join(userData, 'opencode-config-overlays')
    mkdirSync(endpointDir, { recursive: true })
    writeFileSync(join(endpointDir, 'endpoint.env'), 'ORCA_AGENT_HOOK_PORT=1\n')
    mkdirSync(spoolDir, { recursive: true })
    mkdirSync(codexRuntimeHome, { recursive: true })
    mkdirSync(opencodeOverlaysDir, { recursive: true })
    const mounts = await resolveSandboxAuthMounts(noInspect, {
      orcadHome: home,
      env: {
        ORCA_SANDBOX_AUTH_MOUNTS:
          'hook-scripts-abs,hook-scripts-home,gemini-config,hook-endpoint,hook-spool,codex-runtime-home,opencode-overlays'
      },
      hookDirs: {
        scriptsDir,
        geminiConfigDir,
        endpointDir,
        spoolDir,
        codexRuntimeHome,
        opencodeOverlaysDir
      }
    })
    expect(mounts).toEqual([
      `${scriptsDir}:${scriptsDir}:ro`,
      `${scriptsDir}:/var/tmp/.orca/agent-hooks:ro`,
      `${geminiConfigDir}:/var/tmp/.gemini/config:ro`,
      `${endpointDir}:${endpointDir}:ro`,
      `${spoolDir}:${spoolDir}:rw`,
      `${codexRuntimeHome}:${codexRuntimeHome}:rw`,
      `${opencodeOverlaysDir}:${opencodeOverlaysDir}:rw`
    ])
  })

  it('skips hook mounts without hookDirs and absent sources without shadowing', async () => {
    const home = fixtureHome()
    // No hookDirs → fail closed, only the login mounts from fixtureHome.
    const mounts = await resolveSandboxAuthMounts(noInspect, { orcadHome: home })
    expect(mounts).toEqual([
      `${home}/.ssh:/var/tmp/.ssh:ro`,
      `${home}/.config/gh:/var/tmp/.config/gh:ro`
    ])
    // hookDirs pointing at absent dirs → skipped.
    const missing = await resolveSandboxAuthMounts(noInspect, {
      orcadHome: home,
      env: { ORCA_SANDBOX_AUTH_MOUNTS: 'hook-scripts-abs,hook-spool' },
      hookDirs: {
        scriptsDir: join(dir, 'nope-scripts'),
        geminiConfigDir: join(dir, 'nope-gemini'),
        endpointDir: join(dir, 'nope-endpoint'),
        spoolDir: join(dir, 'nope-spool'),
        codexRuntimeHome: join(dir, 'nope-codex'),
        opencodeOverlaysDir: join(dir, 'nope-overlays')
      }
    })
    expect(missing).toEqual([])
  })
})
