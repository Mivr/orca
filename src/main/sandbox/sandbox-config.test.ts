import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SANDBOX_SLOTS,
  SANDBOX_IMAGE,
  SANDBOX_SLOTS_FULL,
  isSandboxRoutingEnabled,
  pickSandboxEnv,
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
})
