import {
  isFinalAutomationRunStatus,
  type AutomationRun,
  type AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { isSandboxRoutingEnabled } from '../sandbox/sandbox-config'
import { isSandboxWorktreeShellAlone, removeSandboxForWorktree } from '../sandbox/sandbox-manager'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'

export const SANDBOX_RUN_GRACE_MS_ENV = 'ORCA_SANDBOX_RUN_GRACE_MS'
export const DEFAULT_SANDBOX_RUN_GRACE_MS = 2 * 60_000
export const SANDBOX_AUTOMATION_WORKTREES_KEPT_ENV = 'ORCA_SANDBOX_AUTOMATION_WORKTREES_KEPT'
export const DEFAULT_SANDBOX_AUTOMATION_WORKTREES_KEPT = 3

const SNAPSHOT_TAIL_LIMIT = 2_000

export function sandboxRunGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SANDBOX_RUN_GRACE_MS_ENV]?.trim()
  if (!raw) {
    return DEFAULT_SANDBOX_RUN_GRACE_MS
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SANDBOX_RUN_GRACE_MS
}

export function sandboxAutomationWorktreesKept(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SANDBOX_AUTOMATION_WORKTREES_KEPT_ENV]?.trim()
  if (!raw) {
    return DEFAULT_SANDBOX_AUTOMATION_WORKTREES_KEPT
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SANDBOX_AUTOMATION_WORKTREES_KEPT
}

export function sandboxSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!isSandboxRoutingEnabled(env)) {
    return 60_000
  }
  const grace = sandboxRunGraceMs(env)
  return Math.min(60_000, Math.max(5_000, Math.floor(grace / 4)))
}

export type SandboxRetentionRuntimeLike = {
  readTerminal?: (handle: string, opts?: { limit?: number }) => Promise<{ tail: string[] }>
  listTerminals?: (
    selector?: string,
    limit?: number,
    options?: { requireFreshPtyLiveness?: boolean }
  ) => Promise<{ terminals: unknown[] }>
  removeManagedWorktree?: (
    selector: string,
    options?: { force?: boolean; waitForBackgroundRemoval?: boolean }
  ) => Promise<unknown>
}

export type SandboxRetentionStoreLike = {
  getAllWorktreeMeta?: () => Record<string, WorktreeMeta>
}

export async function captureMissingRunOutputSnapshot(
  runtime: SandboxRetentionRuntimeLike,
  handle: string | null,
  run: AutomationRun
): Promise<AutomationRunOutputSnapshot | undefined> {
  if (run.outputSnapshot !== null || !handle || typeof runtime.readTerminal !== 'function') {
    return undefined
  }
  try {
    const read = await runtime.readTerminal(handle, { limit: SNAPSHOT_TAIL_LIMIT })
    const buffer = createHeadlessAutomationOutputSnapshotBuffer()
    buffer.append(read.tail.join('\n'))
    return buffer.snapshot() ?? undefined
  } catch {
    return undefined
  }
}

export async function hasNoLiveWorktreeTerminals(
  runtime: SandboxRetentionRuntimeLike,
  worktreeId: string
): Promise<boolean> {
  if (typeof runtime.listTerminals !== 'function') {
    return true
  }
  try {
    const listed = await runtime.listTerminals(`id:${worktreeId}`, 1, {
      requireFreshPtyLiveness: true
    })
    return listed.terminals.length === 0
  } catch {
    return true
  }
}

export async function releaseSandboxIfWorktreeIdle(
  runtime: SandboxRetentionRuntimeLike,
  worktreeId: string | null
): Promise<void> {
  if (!worktreeId || !isSandboxRoutingEnabled()) {
    return
  }
  if (await hasNoLiveWorktreeTerminals(runtime, worktreeId)) {
    await removeSandboxForWorktree(worktreeId)
  }
}

export async function confirmRunShellAloneWithSandbox(
  confirmHostShellAlone: () => Promise<boolean>,
  workspaceId: string | null
): Promise<boolean> {
  if (await confirmHostShellAlone()) {
    return true
  }
  if (workspaceId && isSandboxRoutingEnabled()) {
    return isSandboxWorktreeShellAlone(workspaceId)
  }
  return false
}

export async function pruneSandboxAutomationWorktrees(args: {
  automationId: string
  runs: readonly AutomationRun[]
  store: SandboxRetentionStoreLike
  runtime: SandboxRetentionRuntimeLike
  runTerminalAlive: (run: AutomationRun) => boolean
  keepWorktrees?: number
}): Promise<void> {
  if (!isSandboxRoutingEnabled() || typeof args.store.getAllWorktreeMeta !== 'function') {
    return
  }
  const keepWorktrees = args.keepWorktrees ?? sandboxAutomationWorktreesKept()
  const runsById = new Map(args.runs.map((run) => [run.id, run]))
  const allMeta = args.store.getAllWorktreeMeta()
  const owned: { worktreeId: string; createdAt: number; run: AutomationRun | undefined }[] = []
  for (const [worktreeId, meta] of Object.entries(allMeta)) {
    const prov = meta?.automationProvenance
    if (prov?.kind !== 'created-by-automation' || prov.automationId !== args.automationId) {
      continue
    }
    const run = runsById.get(prov.automationRunId)
    const createdAt = prov.createdAt || (run ? automationRunRecency(run) : 0)
    owned.push({ worktreeId, createdAt, run })
  }
  owned.sort((a, b) => b.createdAt - a.createdAt)
  for (let index = 0; index < owned.length; index += 1) {
    const entry = owned[index]
    const { run, worktreeId } = entry
    if (run && (!isFinalAutomationRunStatus(run.status) || run.terminalPtyId !== null || args.runTerminalAlive(run))) {
      continue
    }
    if (!(await hasNoLiveWorktreeTerminals(args.runtime, worktreeId))) {
      continue
    }
    await removeSandboxForWorktree(worktreeId)
    if (index >= keepWorktrees && typeof args.runtime.removeManagedWorktree === 'function') {
      await args.runtime
        .removeManagedWorktree(`id:${worktreeId}`, {
          force: true,
          waitForBackgroundRemoval: true
        })
        .catch((error) => {
          console.error('[automations] could not prune old automation worktree:', error)
        })
    }
  }
}
