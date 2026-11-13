/**
 * Orcad-side sandbox manager (phase 1).
 *
 * Owns admission (cap-10, reject `sandbox_slots_full`, never queue), container
 * lifecycle tied to worktrees (labels carry the worktree id), and orphan
 * reaping on orcad start. The daemon never calls this — it only sees the
 * stamped spawn env and rewrites the shell into `docker exec`.
 */
import { runProcess } from '@orca/process-host'
import { cleanupSandboxEnvFile, writeSandboxEnvFile } from './sandbox-env-file'
import {
  claudeRoutingStamp,
  forgetClaudeRoutingState,
  mountedClaudeProfilesDir,
  noteCreatedClaudeProfilesLabel,
  resetClaudeRoutingStateForTest
} from './sandbox-claude-routing'
import { resolveSandboxHookMountDirs, resolveSandboxLaunchStagingDir } from './sandbox-hook-mounts'
import { buildSandboxDockerRunArgs } from './sandbox-run-args'
import {
  resetBindMountsForTest,
  resolveSandboxMounts,
  resolveSandboxAuthMounts,
  type HostMount
} from './sandbox-bind-mounts'
import {
  SANDBOX_CONTAINER_ENV,
  SANDBOX_LAUNCH_STAGING_ENV,
  SANDBOX_MANAGED_LABEL,
  SANDBOX_SLOTS_FULL,
  SANDBOX_WORKTREE_ENV,
  SANDBOX_WORKTREE_LABEL,
  isSandboxRoutingEnabled,
  sandboxAutomationMaxSlots,
  sandboxContainerName,
  sandboxMaxSlots
} from './sandbox-config'
import {
  countPendingAutomationReservations,
  currentAutomationReservation,
  isSandboxWorktreeAgentRunning,
  isSandboxWorktreeShellAlone,
  markAutomationReservationMaterialized,
  registerSandboxSlotsDriver,
  resetSandboxSlotsForTest,
  tryWithAutomationSandboxSlot,
  withSandboxAdmissionLock
} from './sandbox-slots'

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
  resetClaudeRoutingStateForTest()
  resetBindMountsForTest()
  resetSandboxSlotsForTest()
}

export function noteSandboxRejectionForTest(worktreeId: string, atMs: number): void {
  lastRejectionAtByWorktree.set(worktreeId, atMs)
}

export {
  isSandboxWorktreeAgentRunning,
  isSandboxWorktreeShellAlone,
  resolveSandboxMounts,
  tryWithAutomationSandboxSlot
}

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
  const reservation = currentAutomationReservation()
  return withSandboxAdmissionLock(() => ensureSandboxLocked(args, reservation))
}

async function ensureSandboxLocked(
  args: { worktreeId: string; worktreePath: string; env?: Record<string, string> },
  reservation: ReturnType<typeof currentAutomationReservation>
): Promise<string> {
  const name = sandboxContainerName(args.worktreeId)
  const names = reservation ? await listSandboxContainers() : await cachedSandboxNames()
  if (reservation) {
    refreshListedNames(names)
  }
  if (names.includes(name) || liveSandboxByWorktree.get(args.worktreeId) === name) {
    liveSandboxByWorktree.set(args.worktreeId, name)
    markAutomationReservationMaterialized(reservation)
    return name
  }
  const slotCap = reservation ? sandboxAutomationMaxSlots() : sandboxMaxSlots()
  const occupied = names.length + countPendingAutomationReservations(reservation)
  if (occupied >= slotCap) {
    lastRejectionAtByWorktree.set(args.worktreeId, Date.now())
    throw new SandboxSlotsFullError(args.worktreeId)
  }
  const { mounts } = await resolveSandboxMounts(args.worktreePath, dockerRunner)
  // Auth rides host-owned bind mounts (never baked or logged): static git
  // identity `:ro`, CLI logins `:rw` so token refresh writes back to the
  // host store and survives the session. Same trust as the `:rw` worktree +
  // main `.git` mounts below — no new boundary. Missing host sources are
  // skipped, never shadowed with empty dirs.
  // Cutover7: hook-plane mounts ride along (scripts `:ro`, spool `:rw`,
  // codex home + opencode overlays `:rw`). Per-spawn hook coords
  // (ORCA_AGENT_HOOK_*/ORCA_PANE_KEY/...) cannot ride the create-time env
  // file — a container is shared per worktree while panes differ — so they
  // cross per spawn via `docker exec -e` (see sandbox-exec-rewrite).
  const authMounts = await resolveSandboxAuthMounts(dockerRunner, {
    hookDirs: resolveSandboxHookMountDirs()
  })
  const envFile = writeSandboxEnvFile(args.env)
  // Capability label only when the final resolved list really mounts the root
  // (opt-out via ORCA_SANDBOX_AUTH_MOUNTS or a missing dir leaves it off).
  const claudeProfilesDir = mountedClaudeProfilesDir(authMounts)
  const runArgs = buildSandboxDockerRunArgs({
    name,
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    mounts,
    authMounts,
    envFile,
    ...(claudeProfilesDir ? { claudeProfilesDir } : {})
  })
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
  noteCreatedClaudeProfilesLabel(name, claudeProfilesDir)
  liveSandboxByWorktree.set(args.worktreeId, name)
  refreshListedNames([...names, name])
  markAutomationReservationMaterialized(reservation)
  return name
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
  forgetClaudeRoutingState(name)
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
    forgetClaudeRoutingState(name)
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
  const claudeStamp = await claudeRoutingStamp({ name, env: args.env, docker })
  return {
    [SANDBOX_CONTAINER_ENV]: name,
    [SANDBOX_WORKTREE_ENV]: args.worktreeId,
    [SANDBOX_LAUNCH_STAGING_ENV]: resolveSandboxLaunchStagingDir(),
    ...claudeStamp
  }
}

registerSandboxSlotsDriver({
  listContainers: listSandboxContainers,
  refreshListedNames,
  hasLiveWorktreeContainer: (worktreeId, containerName) =>
    liveSandboxByWorktree.get(worktreeId) === containerName,
  resolveWorktreeContainerName: (worktreeId) =>
    liveSandboxByWorktree.get(worktreeId) ?? sandboxContainerName(worktreeId),
  runDockerTop: (containerName) =>
    docker(['top', containerName, '-eo', 'pid,ppid,comm,args']).catch(() => null)
})
