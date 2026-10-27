import {
  isFinalAutomationRunStatus,
  type AutomationRun,
  type AutomationRunStatus
} from '../../shared/automations/history/automation-run'
import { automationRunRecency } from '../../shared/automations/history/automation-session-reuse'
import { isSandboxRoutingEnabled } from '../sandbox/sandbox-config'
import { sandboxRunGraceMs } from './sandbox-run-retention'

export const RUN_TERMINAL_GRACE_MS = 10 * 60_000
export const RUN_TERMINALS_KEPT_PER_AUTOMATION = 3

export type RetentionSweepPolicy = {
  keep: number
  graceMs: number
  sandboxMode: boolean
}

export type RunTerminalRetentionDeps = {
  listRuns: () => readonly AutomationRun[]
  /** Used, viewed, or unknown-use terminals belong to the user and must stay open. */
  terminalClientUse: (run: AutomationRun) => 'used' | 'unused' | 'unknown'
  /** True only while the pane holds this run's PTY. */
  runTerminalAlive: (run: AutomationRun) => boolean
  /** Require fresh proof that only an idle shell remains in the PTY. */
  shellAloneAtPrompt: (run: AutomationRun) => Promise<boolean>
  /** Close only this run's pane and PTY; preserve user-created splits. */
  closeRunTerminal: (run: AutomationRun) => Promise<boolean>
  runOwnsWorkspace: (run: AutomationRun) => boolean
  /** Preserve the resumable tab; return false if another terminal is live or sleep fails. */
  sleepRunWorkspace: (run: AutomationRun) => Promise<boolean>
  /** Clear terminal references while preserving status, error and output. */
  forgetRunTerminal: (run: AutomationRun) => Promise<void>
  /** Stop and remove the sandbox container once the run's terminal is closed/slept. */
  releaseRunSandbox?: (run: AutomationRun) => Promise<void>
  /** Prune older sleeping automationCreated worktrees past the per-automation cap. */
  pruneAutomationWorktrees?: (
    automationId: string,
    runs: readonly AutomationRun[]
  ) => Promise<void>
  /** Serialize retention with dispatch to protect reused panes. */
  inAutomationLane: <T>(automationId: string, operation: () => Promise<T>) => Promise<T>
  policy?: () => RetentionSweepPolicy
  now?: () => number
}

const STARTING: ReadonlySet<AutomationRunStatus> = new Set(['pending', 'dispatching'])

export type RunTerminalRetention = {
  sweep: () => Promise<void>
  /** Release terminals before an update, bypassing grace and newest-run retention. */
  drain: () => Promise<number>
  /** Fork: start a final run's sandbox grace at its completion, not at the next sweep. */
  noteRunFinished: (runId: string, finishedAt?: number) => void
}

export function createRunTerminalRetention(deps: RunTerminalRetentionDeps): RunTerminalRetention {
  const now = deps.now ?? Date.now
  const resolvePolicy =
    deps.policy ??
    ((): RetentionSweepPolicy => {
      const sandboxMode = isSandboxRoutingEnabled()
      return {
        keep: sandboxMode ? 0 : RUN_TERMINALS_KEPT_PER_AUTOMATION,
        graceMs: sandboxMode ? sandboxRunGraceMs() : RUN_TERMINAL_GRACE_MS,
        sandboxMode
      }
    })
  // Grace starts when the terminal enters its current phase (resetting on transition to final).
  const firstSeenAt = new Map<string, number>()
  const seenFinal = new Map<string, boolean>()
  let sweeping: Promise<void> | null = null

  const noteSeen = (run: AutomationRun): void => {
    const isFinal = isFinalAutomationRunStatus(run.status)
    if (!firstSeenAt.has(run.id) || (isFinal && seenFinal.get(run.id) === false)) {
      firstSeenAt.set(run.id, now())
    }
    seenFinal.set(run.id, isFinal)
  }

  const forget = async (run: AutomationRun): Promise<void> => {
    await deps.forgetRunTerminal(run)
    firstSeenAt.delete(run.id)
    seenFinal.delete(run.id)
  }

  const pastGrace = (run: AutomationRun, graceMs: number): boolean =>
    now() - (firstSeenAt.get(run.id) ?? now()) >= graceMs

  const mayClose = async (run: AutomationRun, policy: RetentionSweepPolicy): Promise<boolean> => {
    if (!pastGrace(run, policy.graceMs)) {
      return false
    }
    if (deps.terminalClientUse(run) !== 'unused') {
      return false
    }
    if (policy.sandboxMode && isFinalAutomationRunStatus(run.status)) {
      return true
    }
    return run.status === 'completed' || (await deps.shellAloneAtPrompt(run))
  }

  const sweepAutomation = async (
    automationId: string,
    policy: RetentionSweepPolicy
  ): Promise<number> => {
    let releasedCount = 0
    let kept = 0
    const ownedPaneKeys = new Set<string>()
    const allAutomationRuns = deps
      .listRuns()
      .filter((run) => run.automationId === automationId)
    const runs = allAutomationRuns
      .filter(
        (run): run is PanedRun =>
          Boolean(run.terminalPaneKey) &&
          // Slept panes must remain resumable after their PTY is released.
          Boolean(run.terminalPtyId) &&
          !STARTING.has(run.status)
      )
      .toSorted((a, b) => automationRunRecency(b) - automationRunRecency(a))
    for (const run of runs) {
      noteSeen(run)
      try {
        if (!deps.runTerminalAlive(run)) {
          if (isFinalAutomationRunStatus(run.status)) {
            if (policy.sandboxMode && !pastGrace(run, policy.graceMs)) {
              continue
            }
            await deps.releaseRunSandbox?.(run)
            await forget(run)
          }
          continue
        }
        // The newest run controls a reused pane; older runs retain their links until it closes.
        if (ownedPaneKeys.has(run.terminalPaneKey)) {
          continue
        }
        ownedPaneKeys.add(run.terminalPaneKey)
        if (kept < policy.keep) {
          kept += 1
          continue
        }
        if (!(await mayClose(run, policy))) {
          continue
        }
        // Closing a completed run's own workspace would lose its resumable session.
        if (run.status === 'completed' && deps.runOwnsWorkspace(run)) {
          if (await deps.sleepRunWorkspace(run)) {
            await deps.releaseRunSandbox?.(run)
            firstSeenAt.delete(run.id)
            seenFinal.delete(run.id)
            releasedCount += 1
          }
          continue
        }
        if (await deps.closeRunTerminal(run)) {
          releasedCount += 1
        }
        await forget(run)
        await deps.releaseRunSandbox?.(run)
      } catch (error) {
        console.error('[automations] could not close a run terminal:', error)
      }
    }
    if (policy.sandboxMode) {
      await deps.pruneAutomationWorktrees?.(automationId, allAutomationRuns)
    }
    return releasedCount
  }

  const sweepOnce = async (policy: RetentionSweepPolicy): Promise<number> => {
    let releasedCount = 0
    for (const automationId of new Set(deps.listRuns().map((run) => run.automationId))) {
      releasedCount += await deps.inAutomationLane(automationId, () =>
        sweepAutomation(automationId, policy)
      )
    }
    return releasedCount
  }

  const sweep = (): Promise<void> => {
    sweeping ??= sweepOnce(resolvePolicy())
      .then(() => {})
      .finally(() => {
        sweeping = null
      })
    return sweeping
  }

  const drain = async (): Promise<number> => {
    // Avoid closing a terminal twice during an active sweep.
    await sweeping?.catch(() => {})
    return sweepOnce({ keep: 0, graceMs: 0, sandboxMode: resolvePolicy().sandboxMode })
  }

  return {
    sweep,
    drain,
    noteRunFinished: (runId: string, finishedAt?: number) => {
      if (seenFinal.get(runId) !== true) {
        firstSeenAt.set(runId, finishedAt ?? now())
        seenFinal.set(runId, true)
      }
    }
  }
}

type PanedRun = AutomationRun & { terminalPaneKey: string }
