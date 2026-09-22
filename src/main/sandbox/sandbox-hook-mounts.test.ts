import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SANDBOX_HOOK_MOUNT_KEYS,
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
      'opencode-shared'
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
      opencodeSharedDir: join(userData, 'opencode-hooks', 'shared')
    })
    // Ensured even with no prior spawn: the mount gate must see them.
    expect(existsSync(join(userData, 'agent-hooks', 'spool'))).toBe(true)
    expect(statSync(join(userData, 'agent-hooks', 'spool')).isDirectory()).toBe(true)
    expect(existsSync(join(userData, 'opencode-config-overlays'))).toBe(true)
    expect(existsSync(join(userData, 'opencode-hooks', 'shared'))).toBe(true)
    expect(existsSync(join(userData, 'opencode-hooks', 'shared', 'plugins'))).toBe(true)
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
    const byKey = new Map(sandboxHookMountSpecs(hookDirs).map((spec) => [spec.key, spec]))
    // Absolute command paths resolve same-path; $HOME callers land in /var/tmp.
    expect(byKey.get('hook-scripts-abs')?.containerPath).toBe(hookDirs.scriptsDir)
    expect(byKey.get('hook-scripts-home')?.containerPath).toBe('/var/tmp/.orca/agent-hooks')
    expect(byKey.get('opencode-shared')?.containerPath).toBe(hookDirs.opencodeSharedDir)
  })
})
