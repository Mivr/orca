/**
 * Phase-1 docker-sandboxed worktree agents — shared constants.
 *
 * Decision (b): central orcad + host daemon, `docker exec` transport. The host
 * daemon keeps owning every PTY; only the spawn arguments are rewritten.
 * This module is pure (no docker calls) so both the orcad-side manager and the
 * daemon-side spawn rewrite can share it without pulling in a process runner.
 */

/** Max concurrent sandboxed agents. Admission rejects past this — never queues. */
export const MAX_SANDBOX_SLOTS = 10

/** Surfaced when admission refuses a spawn past the cap. */
export const SANDBOX_SLOTS_FULL = 'sandbox_slots_full'

/** Docker label namespace for sandbox containers. */
export const SANDBOX_LABEL_PREFIX = 'orca.sandbox'
export const SANDBOX_WORKTREE_LABEL = 'orca.sandbox.worktree'
export const SANDBOX_MANAGED_LABEL = 'orca.sandbox.managed'

/** Sandbox container image (phase 1 pinned tag — has buck2 + agent CLIs). */
export const SANDBOX_IMAGE = process.env.ORCA_SANDBOX_IMAGE ?? 'orca-dev:4'

/** Host DRI devices passed to `docker create --device` for GPU passthrough. */
export const SANDBOX_DRI_DEVICES_ENV = 'ORCA_SANDBOX_DRI_DEVICES'
const SANDBOX_DEFAULT_DRI_DEVICES = ['/dev/dri/renderD128']

/** Supplementary groups for DRI access, passed as `docker create --group-add`. */
export const SANDBOX_GPU_GROUPS_ENV = 'ORCA_SANDBOX_GPU_GROUPS'
const SANDBOX_DEFAULT_GPU_GROUPS = ['44', '991']

function parseCsvEnv(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * Render node only, not the primary node: headless WebGL/compute needs just
 * the render node, while cardN (modesetting) widens to display control.
 * Override with e.g. `/dev/dri/card1,/dev/dri/renderD128`; empty opts out.
 */
export function sandboxDriDevices(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseCsvEnv(env[SANDBOX_DRI_DEVICES_ENV]) ?? [...SANDBOX_DEFAULT_DRI_DEVICES]
}

/** Numeric gids (video=44, render=991 on the host) — no container name lookup. */
export function sandboxGpuGroups(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseCsvEnv(env[SANDBOX_GPU_GROUPS_ENV]) ?? [...SANDBOX_DEFAULT_GPU_GROUPS]
}

/** Per-sandbox limits: 40GB / 20 threads worst case at 10x on the 64GB host. */
export const SANDBOX_MEMORY = '4g'
export const SANDBOX_CPUS = '2.0'

/** Marker env: orcad stamps the target container, the daemon rewrites the spawn. */
export const SANDBOX_CONTAINER_ENV = 'ORCA_SANDBOX_NAME'
export const SANDBOX_WORKTREE_ENV = 'ORCA_SANDBOX_WORKTREE'

/** Container HOME stamped at create (`-e HOME=...` in the manager). */
export const SANDBOX_HOME = '/var/tmp'

/** Master switch — desktop and unpaired hosts never route unless this is set. */
export const SANDBOX_ROUTING_ENV = 'ORCA_SANDBOX_AGENTS'

/**
 * Explicit container-path → host-source bind overrides, `;`-separated
 * `/container/path=/host/source` pairs. Needed when orcad itself runs
 * containerized with volumes (e.g. ORCA_SANDBOX_BIND_MAP="/src=/work/docker/volumes/orca-src/_data"):
 * a volume's host source is invisible from inside, so auto-detection cannot
 * find it. Unset on bare-metal hosts, where container path == host path.
 */
export const SANDBOX_BIND_MAP_ENV = 'ORCA_SANDBOX_BIND_MAP'

export function sandboxBindMap(env: NodeJS.ProcessEnv = process.env): HostMount[] {
  const raw = env[SANDBOX_BIND_MAP_ENV]
  if (!raw) {
    return []
  }
  const mounts: HostMount[] = []
  for (const pair of raw.split(';')) {
    const equals = pair.indexOf('=')
    if (equals <= 0) {
      continue
    }
    const mountpoint = pair.slice(0, equals).trim()
    const source = pair.slice(equals + 1).trim()
    if (mountpoint && source) {
      mounts.push({ mountpoint, source })
    }
  }
  return mounts
}

export type HostMount = { mountpoint: string; source: string }

export function isSandboxRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SANDBOX_ROUTING_ENV] === '1' && process.platform === 'linux'
}

/**
 * Container name for a worktree. Worktree ids are `${repoId}::${path`-shaped,
 * so they hash into a docker-safe `orca-sandbox-<12hex>` name; the worktree id
 * itself rides the `orca.sandbox.worktree` label for reconciliation.
 */
export function sandboxContainerName(worktreeId: string): string {
  let hash = 0
  for (let i = 0; i < worktreeId.length; i += 1) {
    hash = (hash * 31 + worktreeId.charCodeAt(i)) >>> 0
  }
  return `orca-sandbox-${hash.toString(16).padStart(8, '0')}`
}

/**
 * Explicit env allowlist for the sandbox (§6). Secrets ride `docker exec -e`
 * per spawn plus `--env-file` at create; everything else (pairing tokens,
 * SSH agent sockets, ORCA_USER_DATA paths) never crosses the boundary.
 * Never log values passed through this list.
 */
export const SANDBOX_ENV_ALLOWLIST = [
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'TZ',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'CODEX_API_KEY',
  'CLAUDE_CODE_API_KEY'
] as const

export function pickSandboxEnv(env: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = env[key]
    if (value !== undefined) {
      picked[key] = value
    }
  }
  return picked
}

/**
 * Per-spawn hook-plane coords for the sandbox (cutover7). The static allowlist
 * above cannot carry these: pane keys and the hook token differ per spawn while
 * a container is shared per worktree, so they ride `docker exec -e` per spawn
 * (see sandbox-exec-rewrite), never the create-time env file. Values are
 * routing coords, not host secrets: the hook token authenticates loopback POSTs
 * that cannot even route from the sandbox (bridge network), and the spool
 * fallback that does route needs no secret at all. Never log values.
 */
export const SANDBOX_HOOK_SPAWN_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_CONFIG_DIR',
  'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
  'GROK_HOME'
] as const

export function pickSandboxHookSpawnEnv(env: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of SANDBOX_HOOK_SPAWN_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined) {
      picked[key] = value
    }
  }
  return picked
}

/**
 * Git-auth + agent-CLI login allowlist for the sandbox (auth-mounts pattern).
 * `ssh`/`gh`/`git-hooks`/`gitcookies` = static identity, always `:ro`
 * (rotation happens on the host, then respawn — see GIT-AUTH.md).
 * The eight CLI-login keys (`claude-json`/`claude`/`codex`/`cursor`/`grok`/
 * `gemini-antigravity`/`gcloud`/`opencode`) mount `:rw`: CLIs refresh tokens
 * in place and the write must land back on the host store, otherwise the
 * login dies with the session. Trust is the worktree's: the sandbox already
 * holds the worktree + main `.git` `:rw`, so a `:rw` auth mount adds no new
 * boundary — host-owned files, never baked, never logged.
 * Override with e.g. `ORCA_SANDBOX_AUTH_MOUNTS=ssh,gh`; empty opts out.
 * Unknown keys are ignored. Missing host sources are skipped, never shadowed.
 */
export const SANDBOX_AUTH_MOUNT_KEYS = [
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
  // Cutover7 hook plane: host-preinstalled managed hook scripts (absolute
  // `/home/mihail/.orca/agent-hooks/*.sh` command paths need the same-path
  // mount; $HOME-relative callers need the /var/tmp twin), the agy hook
  // config (the only six-CLI hook config outside the login mounts), orcad's
  // hook endpoint dir (:ro, follows endpoint renames) + spool subdir (:rw,
  // the bridge-network delivery path), the managed codex home, and the
  // opencode overlay root. ro/rw per mount justified at the spec site.
  'hook-scripts-abs',
  'hook-scripts-home',
  'gemini-config',
  'hook-endpoint',
  'hook-spool',
  'codex-runtime-home',
  'opencode-overlays',
  'opencode-shared'
] as const
export type SandboxAuthMountKey = (typeof SANDBOX_AUTH_MOUNT_KEYS)[number]

export const SANDBOX_AUTH_MOUNTS_ENV = 'ORCA_SANDBOX_AUTH_MOUNTS'

export function sandboxAuthMounts(env: NodeJS.ProcessEnv = process.env): SandboxAuthMountKey[] {
  const wanted = parseCsvEnv(env[SANDBOX_AUTH_MOUNTS_ENV]) ?? [...SANDBOX_AUTH_MOUNT_KEYS]
  return SANDBOX_AUTH_MOUNT_KEYS.filter((key) => wanted.includes(key))
}

/**
 * Inner shell for `docker exec`. The host-resolved absolute shell path (e.g.
 * /bin/zsh) is meaningless inside the pinned image, so only shells the image
 * is known to carry resolve by name; anything else falls back to bash.
 */
const SANDBOX_KNOWN_SHELLS = new Set(['bash', 'sh', 'dash'])

export function sandboxInnerShell(hostShellPath: string): string {
  const base = hostShellPath.split('/').pop() ?? hostShellPath
  return SANDBOX_KNOWN_SHELLS.has(base) ? base : 'bash'
}
