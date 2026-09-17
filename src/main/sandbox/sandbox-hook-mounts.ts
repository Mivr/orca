/**
 * Cutover7 hook-plane mounts for sandbox containers.
 *
 * Split from sandbox-bind-mounts/sandbox-manager: the 300-line lint cap
 * forbids growing those files, and the hook plane (scripts, endpoint, spool,
 * codex home, opencode overlays) is one domain concept. This module stays
 * orcad-side (it computes orcad-visible host paths); the daemon only sees
 * the rendered `src:dst:mode` strings and the exec-time env passthrough.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { resolveUserDataPath } from '../orcad/orcad-app-paths'
import { SANDBOX_AUTH_MOUNT_KEYS, SANDBOX_HOME, type SandboxAuthMountKey } from './sandbox-config'

export type SandboxHookMountSpec = {
  key: SandboxAuthMountKey
  hostPath: string
  containerPath: string
  kind: 'dir' | 'file'
  mode: 'ro' | 'rw'
}

/**
 * Orcad-owned hook-plane dirs, computed once per admission by the manager
 * (which owns the userData/codex-home helpers). Omitted → hook mounts are
 * skipped (fail closed).
 */
export type SandboxHookMountDirs = {
  /** Host `~/.orca/agent-hooks` (managed hook scripts, host-preinstalled). */
  scriptsDir: string
  /** Host `~/.gemini/config` (agy hooks.json, host-preinstalled). */
  geminiConfigDir: string
  /** Orcad hook endpoint dir (endpoint.env; `:ro` so renames stay fresh). */
  endpointDir: string
  /** Orcad hook spool dir (bridge-network delivery; ensured to exist). */
  spoolDir: string
  /** Managed codex home (`.../codex-runtime-home/home`; ensured to exist). */
  codexRuntimeHome: string
  /** Opencode overlay root (ensured to exist). */
  opencodeOverlaysDir: string
}

/** Every hook-mount key, so an invariant test can pin the full set. */
export const SANDBOX_HOOK_MOUNT_KEYS: readonly SandboxAuthMountKey[] =
  SANDBOX_AUTH_MOUNT_KEYS.filter(
    (key) =>
      key === 'hook-scripts-abs' ||
      key === 'hook-scripts-home' ||
      key === 'gemini-config' ||
      key === 'hook-endpoint' ||
      key === 'hook-spool' ||
      key === 'codex-runtime-home' ||
      key === 'opencode-overlays'
  )

/**
 * Orcad-owned hook-plane dirs for sandbox mounts. Orcad-owned dirs (spool,
 * opencode overlays) are ensured here: mounts freeze at container create
 * while spawns arrive later, so gating on existence would drop the delivery
 * path for later spawns in a container admitted by an earlier one. All are
 * orcad-userData state (never secrets, never logged).
 */
export function resolveSandboxHookMountDirs(
  orcadHome: string = process.env.HOME ?? '/home/mihail',
  userDataPath: string = resolveUserDataPath(),
  // Why the getter default, not a join: it mkdirs the managed home itself,
  // so the mount gate sees it even before any codex spawn ran on this host.
  codexRuntimeHome: string = getOrcaManagedCodexHomePath()
): SandboxHookMountDirs {
  const endpointDir = join(userDataPath, 'agent-hooks')
  const spoolDir = join(endpointDir, 'spool')
  const opencodeOverlaysDir = join(userDataPath, 'opencode-config-overlays')
  for (const dir of [spoolDir, opencodeOverlaysDir]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      // Best effort: the existence gate below skips what cannot be made.
    }
  }
  return {
    scriptsDir: join(orcadHome, '.orca', 'agent-hooks'),
    geminiConfigDir: join(orcadHome, '.gemini', 'config'),
    endpointDir,
    spoolDir,
    codexRuntimeHome,
    opencodeOverlaysDir
  }
}

/**
 * Hook-plane mount specs. Per-CLI coverage: claude/codex/cursor/grok hook
 * configs already live inside their `:rw` login mounts, so they need no new
 * mount — only agy (`~/.gemini/config`, outside the antigravity-cli login
 * mount) does. Managed hook COMMANDS are absolute host paths
 * (`/home/mihail/.orca/agent-hooks/*.sh`), hence the same-path scripts mount;
 * the /var/tmp twin covers $HOME-relative callers (remote-install shape).
 */
export function sandboxHookMountSpecs(hookDirs: SandboxHookMountDirs): SandboxHookMountSpec[] {
  return [
    // Hook scripts, same-path: without this the in-sandbox guard (`[ -f ]`)
    // fails and the hook degrades to a silent no-op. `:ro` — host `hooks on`
    // owns content, sandbox only executes (same trust as `:ro` git-hooks).
    {
      key: 'hook-scripts-abs',
      hostPath: hookDirs.scriptsDir,
      containerPath: hookDirs.scriptsDir,
      kind: 'dir',
      mode: 'ro'
    },
    // Hook scripts, $HOME twin: remote-install-shaped commands resolve under
    // the sandbox HOME (/var/tmp). Same source, `:ro`.
    {
      key: 'hook-scripts-home',
      hostPath: hookDirs.scriptsDir,
      containerPath: `${SANDBOX_HOME}/.orca/agent-hooks`,
      kind: 'dir',
      mode: 'ro'
    },
    // agy hook config: the only six-CLI hook config outside the login
    // mounts. `:ro` — host-preinstalled, never rewritten by the CLI.
    {
      key: 'gemini-config',
      hostPath: hookDirs.geminiConfigDir,
      containerPath: `${SANDBOX_HOME}/.gemini/config`,
      kind: 'dir',
      mode: 'ro'
    },
    // Hook endpoint dir: hooks source endpoint.env for port/token. `:ro`
    // dir mount so an orcad restart (rename-write) stays fresh — a file
    // mount would pin the stale inode.
    {
      key: 'hook-endpoint',
      hostPath: hookDirs.endpointDir,
      containerPath: hookDirs.endpointDir,
      kind: 'dir',
      mode: 'ro'
    },
    // Hook spool: the bridge-network delivery path (sandbox 127.0.0.1 ≠
    // orcad, so POSTs fail and hooks spool). `:rw` — hook writers append;
    // orcad drains. Nested under the `:ro` endpoint mount; inner wins.
    {
      key: 'hook-spool',
      hostPath: hookDirs.spoolDir,
      containerPath: hookDirs.spoolDir,
      kind: 'dir',
      mode: 'rw'
    },
    // Managed codex home (hooks.json + mirrored sessions/state): `:rw`,
    // same refresh-in-place reasoning as `~/.codex`. Same-path so any
    // CODEX_HOME value keeps working.
    {
      key: 'codex-runtime-home',
      hostPath: hookDirs.codexRuntimeHome,
      containerPath: hookDirs.codexRuntimeHome,
      kind: 'dir',
      mode: 'rw'
    },
    // Opencode config overlays (per-pty plugin dirs): `:rw` same-path so
    // OPENCODE_CONFIG_DIR values resolve verbatim in the sandbox.
    {
      key: 'opencode-overlays',
      hostPath: hookDirs.opencodeOverlaysDir,
      containerPath: hookDirs.opencodeOverlaysDir,
      kind: 'dir',
      mode: 'rw'
    }
  ]
}
