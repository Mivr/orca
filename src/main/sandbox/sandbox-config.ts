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
 * Inner shell for `docker exec`. The host-resolved absolute shell path (e.g.
 * /bin/zsh) is meaningless inside the pinned image, so only shells the image
 * is known to carry resolve by name; anything else falls back to bash.
 */
const SANDBOX_KNOWN_SHELLS = new Set(['bash', 'sh', 'dash'])

export function sandboxInnerShell(hostShellPath: string): string {
  const base = hostShellPath.split('/').pop() ?? hostShellPath
  return SANDBOX_KNOWN_SHELLS.has(base) ? base : 'bash'
}
