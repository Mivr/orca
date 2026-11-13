import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SANDBOX_HOOK_MOUNT_KEYS,
  resolveSandboxClaudeProfilesDir,
  resolveSandboxHookMountDirs,
  sandboxHookMountSpecs
} from './sandbox-hook-mounts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-hook-mounts-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sandbox-hook-mounts', () => {
  it('pins the full hook-mount key set', () => {
    expect([...SANDBOX_HOOK_MOUNT_KEYS]).toEqual([
      'hook-scripts-abs',
      'hook-scripts-home',
      'gemini-config',
      'hook-endpoint',
      'hook-spool',
      'codex-runtime-home',
      'opencode-overlays',
      'opencode-shared',
      'launch-staging',
      'claude-profiles',
      'claude-home-abs'
    ])
  })

  it('ensures orcad-owned dirs and maps the rest from explicit roots', () => {
    const home = join(dir, 'fakehome')
    const userData = join(dir, 'userdata')
    const codexHome = join(dir, 'codexhome')
    const resolved = resolveSandboxHookMountDirs(home, userData, codexHome)
    expect(resolved).toEqual({
      scriptsDir: join(home, '.orca', 'agent-hooks'),
      geminiConfigDir: join(home, '.gemini', 'config'),
      endpointDir: join(userData, 'agent-hooks'),
      spoolDir: join(userData, 'agent-hooks', 'spool'),
      codexRuntimeHome: codexHome,
      opencodeOverlaysDir: join(userData, 'opencode-config-overlays'),
      opencodeSharedDir: join(userData, 'opencode-hooks', 'shared'),
      launchStagingDir: join(userData, 'launch-staging'),
      claudeProfilesDir: join(userData, 'claude-profiles'),
      claudeHomeDir: join(home, '.claude')
    })
    // Ensured even with no prior spawn: the mount gate must see them.
    expect(existsSync(join(userData, 'agent-hooks', 'spool'))).toBe(true)
    expect(statSync(join(userData, 'agent-hooks', 'spool')).isDirectory()).toBe(true)
    expect(existsSync(join(userData, 'opencode-config-overlays'))).toBe(true)
    expect(existsSync(join(userData, 'opencode-hooks', 'shared'))).toBe(true)
    expect(existsSync(join(userData, 'opencode-hooks', 'shared', 'plugins'))).toBe(true)
    // Profiles root exists at create time (0700) so accounts added later resolve.
    expect(statSync(join(userData, 'claude-profiles')).isDirectory()).toBe(true)
    expect(statSync(join(userData, 'claude-profiles')).mode & 0o777).toBe(0o700)
  })

  it('mounts the profiles root and the default home same-path :rw', () => {
    const home = join(dir, 'h')
    const userData = join(dir, 'u')
    const hookDirs = resolveSandboxHookMountDirs(home, userData, join(dir, 'c'))
    expect(resolveSandboxClaudeProfilesDir(userData)).toBe(join(userData, 'claude-profiles'))
    const byKey = new Map(sandboxHookMountSpecs(hookDirs).map((spec) => [spec.key, spec]))
    expect(byKey.get('claude-profiles')).toEqual({
      key: 'claude-profiles',
      hostPath: join(userData, 'claude-profiles'),
      containerPath: join(userData, 'claude-profiles'),
      kind: 'dir',
      mode: 'rw'
    })
    expect(byKey.get('claude-home-abs')).toEqual({
      key: 'claude-home-abs',
      hostPath: join(home, '.claude'),
      containerPath: join(home, '.claude'),
      kind: 'dir',
      mode: 'rw'
    })
    // Without the optional dirs the specs are omitted (fail closed).
    const bare = sandboxHookMountSpecs({ ...hookDirs, claudeProfilesDir: undefined, claudeHomeDir: undefined })
    expect(bare.map((spec) => spec.key)).not.toContain('claude-profiles')
    expect(bare.map((spec) => spec.key)).not.toContain('claude-home-abs')
  })

  it('renders scripts :ro twice, endpoint :ro, spool/homes :rw', () => {
    const hookDirs = resolveSandboxHookMountDirs(join(dir, 'h'), join(dir, 'u'), join(dir, 'c'))
    const modes = new Map(sandboxHookMountSpecs(hookDirs).map((spec) => [spec.key, spec.mode]))
    expect(modes.get('hook-scripts-abs')).toBe('ro')
    expect(modes.get('hook-scripts-home')).toBe('ro')
    expect(modes.get('gemini-config')).toBe('ro')
    expect(modes.get('hook-endpoint')).toBe('ro')
    expect(modes.get('hook-spool')).toBe('rw')
    expect(modes.get('codex-runtime-home')).toBe('rw')
    expect(modes.get('opencode-overlays')).toBe('rw')
    expect(modes.get('opencode-shared')).toBe('rw')
    expect(modes.get('launch-staging')).toBe('rw')
    const byKey = new Map(sandboxHookMountSpecs(hookDirs).map((spec) => [spec.key, spec]))
    // Absolute command paths resolve same-path; $HOME callers land in /var/tmp.
    expect(byKey.get('hook-scripts-abs')?.containerPath).toBe(hookDirs.scriptsDir)
    expect(byKey.get('hook-scripts-home')?.containerPath).toBe('/var/tmp/.orca/agent-hooks')
    expect(byKey.get('opencode-shared')?.containerPath).toBe(hookDirs.opencodeSharedDir)
    expect(byKey.get('launch-staging')?.containerPath).toBe(hookDirs.launchStagingDir)
  })
})
