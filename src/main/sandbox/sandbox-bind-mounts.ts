/**
 * Same-path bind-mount resolution for sandbox containers.
 *
 * Binds the worktree dir rw at the identical path plus the main-repo .git dir
 * (shared object store) rw. Everything else is denied by omission. When orcad
 * itself runs containerized, container paths map to host bind sources via the
 * explicit ORCA_SANDBOX_BIND_MAP, the daemon-reported self mounts, then
 * /proc/mounts — so the sibling sandbox gets a working host source while its
 * destination stays same-path.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SANDBOX_HOME,
  sandboxAuthMounts,
  sandboxBindMap,
  type HostMount,
  type SandboxAuthMountKey
} from './sandbox-config'
import { sandboxHookMountSpecs, type SandboxHookMountDirs } from './sandbox-hook-mounts'

export type { HostMount }

/** Minimal docker access: self-inspect for the daemon-reported mount map. */
export type BindMountDockerRunner = (args: {
  program: string
  args: readonly string[]
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** Destination→source map of this container's own mounts (host view), cached. */
let selfMounts: HostMount[] | null = null

async function readSelfMounts(runDocker: BindMountDockerRunner): Promise<HostMount[]> {
  if (selfMounts) {
    return selfMounts
  }
  try {
    // Why the hex guard: with host networking the container inherits the host
    // hostname (`workstation`), which is not inspectable — only a real id is.
    const hostname =
      typeof process.env.HOSTNAME === 'string' && /^[0-9a-f]{12,64}$/.test(process.env.HOSTNAME)
        ? process.env.HOSTNAME
        : null
    if (!hostname) {
      return []
    }
    const inspected = await runDocker({
      program: 'docker',
      args: ['inspect', '--format', '{{json .Mounts}}', hostname]
    })
    if (inspected.code !== 0) {
      return []
    }
    const mounts = JSON.parse(inspected.stdout) as { Destination?: string; Source?: string }[]
    selfMounts = mounts
      .filter((mount) => mount.Destination && mount.Source)
      .map((mount) => ({
        mountpoint: mount.Destination as string,
        source: mount.Source as string
      }))
    return selfMounts
  } catch {
    return []
  }
}

export function resetBindMountsForTest(): void {
  selfMounts = null
}

/** Sync variant over /proc/mounts (device sources excluded); identity fallback. */
export function resolveHostBindSource(
  containerPath: string,
  mounts: HostMount[] = readProcMounts()
): string {
  return mapThroughMounts(containerPath, mounts) ?? containerPath
}

/** Async variant: explicit map, then daemon-reported self mounts, then /proc. */
export async function resolveHostBindSourceAsync(
  containerPath: string,
  runDocker: BindMountDockerRunner
): Promise<string> {
  const configured = mapThroughMounts(containerPath, sandboxBindMap())
  if (configured) {
    return configured
  }
  const self = await readSelfMounts(runDocker).catch(() => [] as HostMount[])
  return mapThroughMounts(containerPath, self) ?? resolveHostBindSource(containerPath)
}

function mapThroughMounts(containerPath: string, mounts: HostMount[]): string | null {
  let best: HostMount | null = null
  for (const mount of mounts) {
    if (
      mount.mountpoint !== '/' &&
      (containerPath === mount.mountpoint || containerPath.startsWith(`${mount.mountpoint}/`)) &&
      (!best || mount.mountpoint.length > best.mountpoint.length)
    ) {
      best = mount
    }
  }
  if (!best) {
    return null
  }
  return `${best.source}${containerPath.slice(best.mountpoint.length)}`
}

function readProcMounts(): HostMount[] {
  try {
    const lines = readFileSync('/proc/mounts', 'utf8').split('\n')
    const mounts: HostMount[] = []
    for (const line of lines) {
      const parts = line.split(' ')
      if (parts.length < 3) {
        continue
      }
      const [source, mountpoint, fstype] = parts as [string, string, string]
      // Why only real path-backed mounts: device nodes (/dev/*), overlay,
      // and pseudo filesystems are not host bind sources (a volume mount can
      // surface its block device here), and mapping through them corrupts paths.
      if (!source?.startsWith('/') || source.startsWith('/dev/') || fstype === 'overlay') {
        continue
      }
      mounts.push({ mountpoint: unescapeMountPath(mountpoint as string), source })
    }
    return mounts
  } catch {
    return []
  }
}

function unescapeMountPath(path: string): string {
  return path.replace(/\\040/g, ' ').replace(/\\134/g, '\\')
}

export type SandboxAuthMountSpec = {
  key: SandboxAuthMountKey
  hostPath: string
  containerPath: string
  kind: 'dir' | 'file'
  // Why per-mount mode: static identity (ssh keys, gh token, hooks, cookies)
  // is host-rotated and never written from the sandbox, so `:ro` keeps the
  // sandbox from corrupting host git access. CLI logins refresh tokens in
  // place (`:rw`) — a `:ro` login mount would die on first refresh and the
  // login would not survive the session it was meant to persist.
  mode: 'ro' | 'rw'
}

/**
 * Orcad-owned hook-plane dirs (type re-export; impl in sandbox-hook-mounts).
 * Omitted → hook mounts are skipped (fail closed).
 */
export type { SandboxHookMountDirs } from './sandbox-hook-mounts'

/**
 * Git-auth + agent-CLI login mount specs. ssh/gh resolve HOME-relative by
 * tool convention (ssh ~/.ssh, gh $HOME/.config/gh), so their destinations
 * hang under the stamped SANDBOX_HOME — no GIT_SSH_COMMAND/GH_CONFIG_DIR
 * overrides and no key-name knowledge in code; host ssh semantics
 * (IdentityFile, IdentitiesOnly, known_hosts) survive byte-for-byte, which
 * is what keeps host-key verification working. git-hooks/.gitcookies are
 * absolute paths baked in the image /etc/gitconfig, so they mount same-path.
 * CLI logins all resolve under the stamped SANDBOX_HOME too: the manager
 * stamps only HOME (XDG_DATA_HOME is NOT in the env allowlist), so
 * ~/.local/share/opencode, ~/.config/gcloud, etc. land under /var/tmp with
 * zero per-tool env overrides. Destinations mirror the existing
 * /var/tmp/.ssh pattern (passwd home is /var/tmp via the image usermod —
 * the ssh-trap fix — so getpwuid and $HOME agree on every path below).
 *
 * Cutover7 hook plane (one row per CLI below): claude/codex/cursor/grok hook
 * configs already live inside their `:rw` login mounts, so they need no new
 * mount — only agy (`~/.gemini/config`, outside the antigravity-cli login
 * mount) does. Managed hook COMMANDS are absolute host paths
 * (`/home/mihail/.orca/agent-hooks/*.sh`), hence the same-path scripts mount;
 * the /var/tmp twin covers $HOME-relative callers (remote-install shape).
 */
export function sandboxAuthMountSpecs(
  orcadHome: string = process.env.HOME ?? '/home/mihail',
  hookDirs?: SandboxHookMountDirs
): SandboxAuthMountSpec[] {
  return [
    {
      key: 'ssh',
      hostPath: `${orcadHome}/.ssh`,
      containerPath: `${SANDBOX_HOME}/.ssh`,
      kind: 'dir',
      mode: 'ro'
    },
    {
      key: 'gh',
      hostPath: `${orcadHome}/.config/gh`,
      containerPath: `${SANDBOX_HOME}/.config/gh`,
      kind: 'dir',
      mode: 'ro'
    },
    {
      key: 'git-hooks',
      hostPath: `${orcadHome}/.config/git-hooks`,
      containerPath: '/home/mihail/.config/git-hooks',
      kind: 'dir',
      mode: 'ro'
    },
    {
      key: 'gitcookies',
      hostPath: `${orcadHome}/.gitcookies`,
      containerPath: '/home/mihail/.gitcookies',
      kind: 'file',
      mode: 'ro'
    },
    // claude: OAuth + subscription state; the CLI rewrites both on refresh.
    {
      key: 'claude-json',
      hostPath: `${orcadHome}/.claude.json`,
      containerPath: `${SANDBOX_HOME}/.claude.json`,
      kind: 'file',
      mode: 'rw'
    },
    {
      key: 'claude',
      hostPath: `${orcadHome}/.claude`,
      containerPath: `${SANDBOX_HOME}/.claude`,
      kind: 'dir',
      mode: 'rw'
    },
    // codex: auth.json + sessions/state; refresh writes back into the dir.
    {
      key: 'codex',
      hostPath: `${orcadHome}/.codex`,
      containerPath: `${SANDBOX_HOME}/.codex`,
      kind: 'dir',
      mode: 'rw'
    },
    // cursor: whole dir, best effort — a keyring-bound token (libsecret /
    // gnome-keyring) does NOT live in files, so a keyring login will NOT
    // persist via this mount; file-based state still carries over.
    {
      key: 'cursor',
      hostPath: `${orcadHome}/.cursor`,
      containerPath: `${SANDBOX_HOME}/.cursor`,
      kind: 'dir',
      mode: 'rw'
    },
    // grok: OAuth session (auth.json) + quota state; refresh writes back.
    {
      key: 'grok',
      hostPath: `${orcadHome}/.grok`,
      containerPath: `${SANDBOX_HOME}/.grok`,
      kind: 'dir',
      mode: 'rw'
    },
    // agy (antigravity): CLI state dir; pairs with gcloud below (ADC lives
    // in gcloud legacy_credentials). Both refresh in place.
    {
      key: 'gemini-antigravity',
      hostPath: `${orcadHome}/.gemini/antigravity-cli`,
      containerPath: `${SANDBOX_HOME}/.gemini/antigravity-cli`,
      kind: 'dir',
      mode: 'rw'
    },
    // gcloud: credentials.db / access_tokens.db are rewritten on token
    // refresh, which fails under `:ro` — `:rw` is what makes refresh work.
    {
      key: 'gcloud',
      hostPath: `${orcadHome}/.config/gcloud`,
      containerPath: `${SANDBOX_HOME}/.config/gcloud`,
      kind: 'dir',
      mode: 'rw'
    },
    // opencode: auth.json + live SQLite state (opencode.db*-wal). Same-file
    // bind mount keeps SQLite locking correct (one filesystem, fcntl locks
    // serialize host + sandbox writers), so `:rw` is safe; `:ro` would break
    // auth refresh AND crash the daemon's state writes. Trust is the
    // worktree's (already `:rw`): no new boundary.
    {
      key: 'opencode',
      hostPath: `${orcadHome}/.local/share/opencode`,
      containerPath: `${SANDBOX_HOME}/.local/share/opencode`,
      kind: 'dir',
      mode: 'rw'
    },
    // Hook plane lives in sandbox-hook-mounts (lint cap): scripts :ro x2,
    // agy config :ro, endpoint :ro, spool :rw, codex home + overlays :rw.
    ...(hookDirs ? sandboxHookMountSpecs(hookDirs) : [])
  ]
}

/**
 * Resolve enabled auth mounts to `src:dst:mode` entries. Missing or
 * wrong-kind host sources are skipped: docker would otherwise create an
 * empty dir over the mountpoint and silently shadow the real credential
 * (same reason auth-mounts/check-auth.sh pre-flights).
 */
export async function resolveSandboxAuthMounts(
  runDocker: BindMountDockerRunner,
  opts: { orcadHome?: string; env?: NodeJS.ProcessEnv; hookDirs?: SandboxHookMountDirs } = {}
): Promise<string[]> {
  const wanted = new Set(sandboxAuthMounts(opts.env ?? process.env))
  const mounts: string[] = []
  for (const spec of sandboxAuthMountSpecs(
    opts.orcadHome ?? process.env.HOME ?? '/home/mihail',
    opts.hookDirs
  )) {
    if (!wanted.has(spec.key)) {
      continue
    }
    // Gate on the orcad-visible path, mount the host-resolved source: under a
    // bind map the resolved source is invisible from inside orcad, while the
    // spec path is what orcad can actually stat.
    if (!authSourcePresent(spec.hostPath, spec.kind)) {
      continue
    }
    const source = await resolveHostBindSourceAsync(spec.hostPath, runDocker)
    mounts.push(`${source}:${spec.containerPath}:${spec.mode}`)
  }
  return mounts
}

function authSourcePresent(source: string, kind: 'dir' | 'file'): boolean {
  try {
    if (!existsSync(source)) {
      return false
    }
    const stat = statSync(source)
    return kind === 'dir' ? stat.isDirectory() : stat.isFile()
  } catch {
    return false
  }
}

export async function resolveSandboxMounts(
  worktreePath: string,
  runDocker: BindMountDockerRunner
): Promise<{ mounts: string[]; gitDir: string | null }> {
  const mounts = [`${await resolveHostBindSourceAsync(worktreePath, runDocker)}:${worktreePath}`]
  const gitDir = resolveWorktreeGitDir(worktreePath)
  // Why the whole .git and not just the worktrees/<name> pointer: commits
  // write objects into the shared store, so the pointer alone breaks git.
  const mainGitDir = gitDir ? mainRepoGitDir(gitDir) : null
  if (mainGitDir && mainGitDir !== worktreePath) {
    mounts.push(`${await resolveHostBindSourceAsync(mainGitDir, runDocker)}:${mainGitDir}`)
  }
  return { mounts, gitDir: mainGitDir }
}

function resolveWorktreeGitDir(worktreePath: string): string | null {
  try {
    const dotGit = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(dotGit)
    if (match?.[1]) {
      return match[1].trim()
    }
    return null
  } catch {
    return null
  }
}

function mainRepoGitDir(gitDir: string): string {
  const marker = '/.git/worktrees/'
  const index = gitDir.indexOf(marker)
  return index !== -1 ? gitDir.slice(0, index + '/.git'.length) : gitDir
}
