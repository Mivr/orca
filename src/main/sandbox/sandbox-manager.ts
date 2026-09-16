/**
 * Orcad-side sandbox manager (phase 1).
 *
 * Owns admission (cap-10, reject `sandbox_slots_full`, never queue), container
 * lifecycle tied to worktrees (labels carry the worktree id), and orphan
 * reaping on orcad start. The daemon never calls this — it only sees the
 * stamped spawn env and rewrites the shell into `docker exec`.
 */
import { existsSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { resetBindMountsForTest, resolveSandboxMounts, type HostMount } from './sandbox-bind-mounts'
import {
  MAX_SANDBOX_SLOTS,
  SANDBOX_CONTAINER_ENV,
  SANDBOX_CPUS,
  SANDBOX_IMAGE,
  SANDBOX_MANAGED_LABEL,
  SANDBOX_MEMORY,
  SANDBOX_SLOTS_FULL,
  SANDBOX_WORKTREE_ENV,
  SANDBOX_WORKTREE_LABEL,
  isSandboxRoutingEnabled,
  pickSandboxEnv,
  sandboxContainerName,
  sandboxDriDevices,
  sandboxGpuGroups
} from './sandbox-config'

export { SANDBOX_SLOTS_FULL }
export { sandboxContainerName }
export type { HostMount }

export class SandboxSlotsFullError extends Error {
  readonly code = SANDBOX_SLOTS_FULL
  constructor(worktreeId: string) {
    super(`${SANDBOX_SLOTS_FULL}: ${worktreeId}`)
  }
}

export type SandboxDockerRunner = (args: {
  program: string
  args: readonly string[]
  input?: string
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

let dockerRunner: SandboxDockerRunner = async ({ program, args, input }) => {
  const result = await runProcess({
    program,
    args,
    ...(input !== undefined ? { input } : {}),
    timeoutMs: 30_000
  })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** Tests inject a fake docker; production always shells out to the CLI. */
export function setSandboxDockerRunner(runner: SandboxDockerRunner | null): void {
  if (runner) {
    dockerRunner = runner
  }
}

function docker(
  args: readonly string[],
  input?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return dockerRunner({ program: 'docker', args, ...(input !== undefined ? { input } : {}) })
}

/** Live sandboxed-agent refcount this process admitted (labels reconcile restarts). */
const liveSandboxByWorktree = new Map<string, string>()
/** Last admission rejection per worktree, surfaced as `sandboxReason` in worktree ps. */
const lastRejectionAtByWorktree = new Map<string, number>()
const REJECTION_VISIBLE_MS = 5 * 60_000
/** Cached `docker ps` listing so worktree ps polling does not fork per request. */
let listedAtMs = 0
let listedNames: string[] = []
const LIST_TTL_MS = 10_000

export function resetSandboxManagerForTest(): void {
  liveSandboxByWorktree.clear()
  lastRejectionAtByWorktree.clear()
  listedAtMs = 0
  listedNames = []
  resetBindMountsForTest()
}

export function noteSandboxRejectionForTest(worktreeId: string, atMs: number): void {
  lastRejectionAtByWorktree.set(worktreeId, atMs)
}

export { resolveSandboxMounts }

async function listSandboxContainers(): Promise<string[]> {
  const result = await docker([
    'ps',
    '--filter',
    `label=${SANDBOX_MANAGED_LABEL}=1`,
    '--format',
    '{{.Names}}'
  ])
  if (result.code !== 0) {
    return []
  }
  return result.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
}

async function cachedSandboxNames(): Promise<string[]> {
  const now = Date.now()
  if (now - listedAtMs < LIST_TTL_MS) {
    return listedNames
  }
  listedNames = await listSandboxContainers()
  listedAtMs = now
  return listedNames
}

function refreshListedNames(names: string[]): void {
  listedNames = names
  listedAtMs = Date.now()
}

/**
 * Admit a sandboxed agent for a worktree: reuse the live container or create
 * one (cap-10 enforced across all labeled containers, so restarts reconcile).
 * Throws SandboxSlotsFullError past the cap.
 */
export async function ensureSandboxForWorktree(args: {
  worktreeId: string
  worktreePath: string
  env?: Record<string, string>
}): Promise<string> {
  const name = sandboxContainerName(args.worktreeId)
  const names = await cachedSandboxNames()
  if (names.includes(name) || liveSandboxByWorktree.get(args.worktreeId) === name) {
    liveSandboxByWorktree.set(args.worktreeId, name)
    return name
  }
  if (names.length >= MAX_SANDBOX_SLOTS) {
    lastRejectionAtByWorktree.set(args.worktreeId, Date.now())
    throw new SandboxSlotsFullError(args.worktreeId)
  }
  const { mounts } = await resolveSandboxMounts(args.worktreePath, dockerRunner)
  const envFile = writeSandboxEnvFile(args.env)
  const runArgs = [
    'run',
    '-d',
    '--name',
    name,
    '--user',
    '1000:1000',
    `--memory=${SANDBOX_MEMORY}`,
    `--cpus=${SANDBOX_CPUS}`,
    // GPU passthrough: host AMD render node + video/render gids so Chromium
    // uses radeonsi instead of SwiftShader. Env-overridable, empty opts out.
    ...sandboxDriDevices().flatMap((device) => ['--device', device]),
    ...sandboxGpuGroups().flatMap((group) => ['--group-add', group]),
    // Why /var/tmp: the image default HOME (/root) is unreadable as uid 1000,
    // no host home may leak in (§2 deny), and agent CLIs refuse a temporary
    // HOME (/tmp) for helper binaries. Container-private writable layer;
    // phase 2 owns a per-sandbox home volume.
    '-e',
    'HOME=/var/tmp',
    '--label',
    `${SANDBOX_MANAGED_LABEL}=1`,
    '--label',
    `${SANDBOX_WORKTREE_LABEL}=${args.worktreeId}`,
    ...mounts.flatMap((mount) => ['-v', mount]),
    '-w',
    args.worktreePath,
    ...(envFile ? ['--env-file', envFile] : []),
    SANDBOX_IMAGE,
    'sleep',
    'infinity'
  ]
  try {
    const created = await docker(runArgs)
    if (created.code !== 0) {
      throw new Error(`sandbox_create_failed: ${created.stderr.trim().slice(0, 300)}`)
    }
  } finally {
    if (envFile) {
      cleanupSandboxEnvFile(envFile)
    }
  }
  liveSandboxByWorktree.set(args.worktreeId, name)
  refreshListedNames([...names, name])
  return name
}

/** Secrets cross at create via a host-owned 0600 env file, never baked or logged. */
function writeSandboxEnvFile(env: Record<string, string> | undefined): string | null {
  const picked = pickSandboxEnv(env ?? {})
  const entries = Object.entries(picked)
  if (entries.length === 0) {
    return null
  }
  const path = join(tmpdir(), `orca-sandbox-env-${process.pid}-${Date.now()}`)
  writeFileSync(path, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {
    mode: 0o600
  })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort: writeFileSync mode already applied on creation.
  }
  return path
}

/** Stop+remove on worktree archive. Best-effort: a missing container is success. */
export async function removeSandboxForWorktree(worktreeId: string): Promise<void> {
  if (!isSandboxRoutingEnabled()) {
    return
  }
  const name = liveSandboxByWorktree.get(worktreeId) ?? sandboxContainerName(worktreeId)
  liveSandboxByWorktree.delete(worktreeId)
  lastRejectionAtByWorktree.delete(worktreeId)
  await docker(['rm', '-f', name]).catch(() => {})
  listedNames = listedNames.filter((listed) => listed !== name)
}

export async function getSandboxState(worktreeId: string): Promise<'running' | 'absent'> {
  if (!isSandboxRoutingEnabled()) {
    return 'absent'
  }
  const name = liveSandboxByWorktree.get(worktreeId) ?? sandboxContainerName(worktreeId)
  const names = await cachedSandboxNames().catch(() => [] as string[])
  return names.includes(name) ? 'running' : 'absent'
}

/** worktree ps view: sandbox column state plus the rejection reason when fresh. */
export async function describeSandboxesForWorktrees(
  worktreeIds: string[]
): Promise<Map<string, { sandbox: 'running' | 'absent'; sandboxReason?: 'sandbox_slots_full' }>> {
  const described = new Map<
    string,
    { sandbox: 'running' | 'absent'; sandboxReason?: 'sandbox_slots_full' }
  >()
  if (!isSandboxRoutingEnabled()) {
    for (const id of worktreeIds) {
      described.set(id, { sandbox: 'absent' })
    }
    return described
  }
  const names = await cachedSandboxNames().catch(() => [] as string[])
  const now = Date.now()
  for (const id of worktreeIds) {
    const name = liveSandboxByWorktree.get(id) ?? sandboxContainerName(id)
    const sandbox = names.includes(name) ? 'running' : 'absent'
    const rejectedAt = lastRejectionAtByWorktree.get(id)
    described.set(
      id,
      rejectedAt !== undefined && now - rejectedAt < REJECTION_VISIBLE_MS
        ? { sandbox, sandboxReason: 'sandbox_slots_full' }
        : { sandbox }
    )
  }
  return described
}

/**
 * Orphan reaper — runs on orcad start only. Removes labeled containers whose
 * worktree no longer exists. Daemon restarts never reap (daemon owns PTYs,
 * not sandboxes).
 */
export async function reapOrphanSandboxes(existingWorktreeIds: Set<string>): Promise<string[]> {
  if (!isSandboxRoutingEnabled()) {
    return []
  }
  const result = await docker([
    'ps',
    '-a',
    '--filter',
    `label=${SANDBOX_MANAGED_LABEL}=1`,
    '--format',
    `{{.Names}}\t{{.Label "${SANDBOX_WORKTREE_LABEL}"}}`
  ]).catch(() => null)
  if (!result || result.code !== 0) {
    return []
  }
  const reaped: string[] = []
  const live: string[] = []
  for (const line of result.stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const name = line.slice(0, tab).trim()
    const worktreeId = line.slice(tab + 1).trim()
    if (!name) {
      continue
    }
    if (worktreeId && existingWorktreeIds.has(worktreeId)) {
      live.push(name)
      if (worktreeId) {
        liveSandboxByWorktree.set(worktreeId, name)
      }
      continue
    }
    await docker(['rm', '-f', name]).catch(() => {})
    reaped.push(name)
  }
  refreshListedNames(live)
  return reaped
}

/** Stamp a fresh agent spawn with its sandbox target (admitting it first). */
export async function stampSandboxSpawnEnv(args: {
  worktreeId: string
  worktreePath: string
  env?: Record<string, string>
}): Promise<Record<string, string>> {
  const name = await ensureSandboxForWorktree({
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    ...(args.env ? { env: args.env } : {})
  })
  return {
    [SANDBOX_CONTAINER_ENV]: name,
    [SANDBOX_WORKTREE_ENV]: args.worktreeId
  }
}

export function cleanupSandboxEnvFile(envFileArg: string): void {
  if (!envFileArg.startsWith(`${tmpdir()}/orca-sandbox-env-`)) {
    return
  }
  try {
    if (existsSync(envFileArg)) {
      unlinkSync(envFileArg)
    }
  } catch {
    // Best effort.
  }
}
