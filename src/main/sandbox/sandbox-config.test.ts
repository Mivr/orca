import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SANDBOX_SLOTS,
  SANDBOX_HOME,
  SANDBOX_IMAGE,
  SANDBOX_SLOTS_FULL,
  isSandboxRoutingEnabled,
  pickSandboxEnv,
  pickSandboxHookSpawnEnv,
  sandboxAuthMounts,
  sandboxBindMap,
  sandboxContainerName,
  sandboxDriDevices,
  sandboxGpuGroups,
  sandboxInnerShell
} from './sandbox-config'

describe('sandbox-config', () => {
  it('caps concurrent sandboxes at ten', () => {
    expect(MAX_SANDBOX_SLOTS).toBe(10)
    expect(SANDBOX_SLOTS_FULL).toBe('sandbox_slots_full')
  })

  it('mints stable docker-safe container names', () => {
    const first = sandboxContainerName('repo-1::/home/mihail/orca/workspaces/x')
    const second = sandboxContainerName('repo-1::/home/mihail/orca/workspaces/x')
    expect(first).toBe(second)
    expect(first).toMatch(/^orca-sandbox-[0-9a-f]+$/)
    expect(sandboxContainerName('repo-1::/other')).not.toBe(first)
  })

  it('routes only on linux with the explicit opt-in', () => {
    expect(isSandboxRoutingEnabled({ ...process.env, ORCA_SANDBOX_AGENTS: '1' })).toBe(
      process.platform === 'linux'
    )
    expect(isSandboxRoutingEnabled({ ...process.env, ORCA_SANDBOX_AGENTS: '0' })).toBe(false)
    expect(isSandboxRoutingEnabled({})).toBe(false)
  })

  it('passes only the explicit env allowlist into the sandbox', () => {
    const picked = pickSandboxEnv({
      TERM: 'xterm-256color',
      ANTHROPIC_API_KEY: 'secret',
      HOME: '/home/mihail',
      ORCA_USER_DATA: '/home/mihail/.orca-orcad-data',
      SSH_AUTH_SOCK: '/run/agent.sock',
      ORCA_SANDBOX_NAME: 'orca-sandbox-x'
    })
    expect(picked).toEqual({ TERM: 'xterm-256color', ANTHROPIC_API_KEY: 'secret' })
  })

  it('passes per-spawn hook coords into the sandbox, never stamps or secrets', () => {
    const picked = pickSandboxHookSpawnEnv({
      ORCA_AGENT_HOOK_PORT: '1234',
      ORCA_AGENT_HOOK_TOKEN: 'tok',
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1',
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      ORCA_AGENT_HOOK_ENDPOINT: '/home/mihail/.orca-orcad-data/agent-hooks/endpoint.env',
      ORCA_PANE_KEY: 'tab:leaf',
      ORCA_TAB_ID: 'tab',
      ORCA_WORKTREE_ID: 'repo::/wt',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch',
      CODEX_HOME: '/home/mihail/.config/orca/codex-runtime-home/home',
      ORCA_CODEX_HOME: '/home/mihail/.config/orca/codex-runtime-home/home',
      OPENCODE_CONFIG_DIR: '/home/mihail/.orca-orcad-data/opencode-config-overlays/x',
      ORCA_OPENCODE_CONFIG_DIR: '/home/mihail/.orca-orcad-data/opencode-config-overlays/x',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: '/home/mihail/.config/opencode',
      GROK_HOME: '/home/mihail/.grok',
      HOME: '/home/mihail',
      SSH_AUTH_SOCK: '/run/agent.sock',
      ORCA_SANDBOX_NAME: 'orca-sandbox-x'
    })
    expect(picked.ORCA_PANE_KEY).toBe('tab:leaf')
    expect(picked.CODEX_HOME).toBe('/home/mihail/.config/orca/codex-runtime-home/home')
    expect(picked.OPENCODE_CONFIG_DIR).toContain('opencode-config-overlays')
    expect(picked).not.toHaveProperty('HOME')
    expect(picked).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(picked).not.toHaveProperty('ORCA_SANDBOX_NAME')
    expect(pickSandboxHookSpawnEnv({ TERM: 'xterm' })).toEqual({})
  })

  it('resolves the inner shell by image-known names, else bash', () => {
    expect(sandboxInnerShell('/bin/bash')).toBe('bash')
    expect(sandboxInnerShell('/bin/sh')).toBe('sh')
    expect(sandboxInnerShell('/bin/zsh')).toBe('bash')
    expect(sandboxInnerShell('/usr/bin/fish')).toBe('bash')
  })

  it('pins the sandbox image to orca-dev:4 unless overridden', async () => {
    vi.resetModules()
    delete process.env.ORCA_SANDBOX_IMAGE
    expect((await import('./sandbox-config')).SANDBOX_IMAGE).toBe('orca-dev:4')
    vi.resetModules()
    process.env.ORCA_SANDBOX_IMAGE = 'orca-dev:9-test'
    expect((await import('./sandbox-config')).SANDBOX_IMAGE).toBe('orca-dev:9-test')
    delete process.env.ORCA_SANDBOX_IMAGE
    vi.resetModules()
    expect(SANDBOX_IMAGE).toBe('orca-dev:4')
  })

  it('parses the explicit bind map for containerized orcad', () => {
    expect(
      sandboxBindMap({ ORCA_SANDBOX_BIND_MAP: '/src=/work/docker/volumes/orca-src/_data' })
    ).toEqual([{ mountpoint: '/src', source: '/work/docker/volumes/orca-src/_data' }])
    expect(sandboxBindMap({})).toEqual([])
    expect(sandboxBindMap({ ORCA_SANDBOX_BIND_MAP: 'bogus' })).toEqual([])
  })

  it('defaults GPU passthrough to the render node plus video/render gids', () => {
    expect(sandboxDriDevices({})).toEqual(['/dev/dri/renderD128'])
    expect(sandboxGpuGroups({})).toEqual(['44', '991'])
  })

  it('overrides GPU passthrough via env, empty opts out', () => {
    expect(
      sandboxDriDevices({ ORCA_SANDBOX_DRI_DEVICES: '/dev/dri/card1, /dev/dri/renderD128' })
    ).toEqual(['/dev/dri/card1', '/dev/dri/renderD128'])
    expect(sandboxDriDevices({ ORCA_SANDBOX_DRI_DEVICES: '' })).toEqual([])
    expect(sandboxGpuGroups({ ORCA_SANDBOX_GPU_GROUPS: 'video,render' })).toEqual([
      'video',
      'render'
    ])
    expect(sandboxGpuGroups({ ORCA_SANDBOX_GPU_GROUPS: '' })).toEqual([])
  })

  it('stamps container HOME for auth-mount destinations', () => {
    expect(SANDBOX_HOME).toBe('/var/tmp')
  })

  it('enables all auth mounts by default, subsets via env, empty opts out', () => {
    expect(sandboxAuthMounts({})).toEqual([
      'ssh',
      'gh',
      'git-hooks',
      'gitcookies',
      'claude-json',
      'claude',
      'codex',
      'cursor',
      'grok',
      'gemini-antigravity',
      'gcloud',
      'opencode',
      'hook-scripts-abs',
      'hook-scripts-home',
      'gemini-config',
      'hook-endpoint',
      'hook-spool',
      'codex-runtime-home',
      'opencode-overlays',
      'opencode-shared'
    ])
    expect(sandboxAuthMounts({ ORCA_SANDBOX_AUTH_MOUNTS: 'ssh,gh' })).toEqual(['ssh', 'gh'])
    expect(sandboxAuthMounts({ ORCA_SANDBOX_AUTH_MOUNTS: '' })).toEqual([])
    expect(sandboxAuthMounts({ ORCA_SANDBOX_AUTH_MOUNTS: 'ssh,bogus' })).toEqual(['ssh'])
    expect(sandboxAuthMounts({ ORCA_SANDBOX_AUTH_MOUNTS: 'codex,opencode' })).toEqual([
      'codex',
      'opencode'
    ])
  })
})
