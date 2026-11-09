import { createAutomationOutputSnapshotBuffer } from './automation-launch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations/history/automation-run'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automations/history/automation-run-failure-copy'
import {
  agentStartDeadlineMs,
  formatTerminalTailError,
  hasPostDispatchAgentStatus,
  judgeHeldRunTurn,
  judgeIdleRun,
  captureRunAgentTurn,
  judgeRunExit,
  type AutomationRunAgentEvidence,
  type JudgedRun,
  type IdleRunVerdict
} from './automation-run-agent-evidence'
import { readProvenTerminalExit } from '../runtime/terminal/wait/terminal-wait-results'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

const AGENT_EVIDENCE_POLL_INTERVAL_MS = 1_000
const AGENT_START_POLL_INTERVAL_MS = 250
/** Stay below the runtime's 2s fallback to avoid starting a foreground-process poll. */
const AGENT_START_PROBE_TIMEOUT_MS = 250
/** Allow prompt submission delays and SSH startup before declaring the agent unstarted. */
const AGENT_START_DEADLINE_MS = 2 * 60 * 1000
/** How long the agent's own `done` must stand before it settles a run whose screen never reads
 *  idle (a lost stream or an unknown idle screen, #34064); past any blocked verdict a screen gives. */
const HELD_DONE_SETTLE_MS = 30_000
/** Bound re-arming per observation; startup reconciliation can attach again. */
const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000

export type AutomationRunTerminalHost = {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
  /** False only once no window graph can hold the run's terminal; a reloading graph still can. */
  canOpenRunTerminals(): boolean
}

async function readTail(runtime: AutomationRunTerminalHost, handle: string): Promise<string[]> {
  try {
    return (await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })).tail
  } catch {
    return []
  }
}

function snapshotOf(tail: readonly string[]): AutomationRunOutputSnapshot | null {
  const snapshotBuffer = createAutomationOutputSnapshotBuffer()
  snapshotBuffer.append(tail.join('\n'))
  return snapshotBuffer.snapshot()
}

/** A finished run keeps what the agent answered; the screen is the fallback for agents without hooks. */
function completedSnapshot(
  tail: readonly string[],
  judged: JudgedRun | null
): AutomationRunOutputSnapshot | null {
  const reply = judged?.turn()?.reply ?? null
  const snapshot = snapshotOf(reply ? [reply.text] : tail)
  return snapshot && reply?.truncated ? { ...snapshot, truncated: true } : snapshot
}

/** Fork: proof the run's agent process started, with a deadline for runs that never start one. */
type AgentStartWatch = {
  refreshAgentSeen: () => Promise<boolean>
  isAgentSeen: () => boolean
  startDeadlineAt: number
  startDeadlineMs: number
}

async function judgeIdleTail(
  tail: readonly string[],
  judged: JudgedRun,
  runStartedAt: number,
  agentStarted: boolean
): Promise<AutomationRunCompletionObservation | null> {
  const verdict: IdleRunVerdict = judged.turn()?.interrupted
    ? { kind: 'failed', ...automationRunFailure('agentInterrupted') }
    : judgeIdleRun(judged.evidence, judged.run, tail, runStartedAt, Date.now(), agentStarted)
  return verdict.kind === 'wait' ? null : observationOf(verdict, tail, judged)
}

function observationOf(
  verdict: Exclude<IdleRunVerdict, { kind: 'wait' }>,
  tail: readonly string[],
  judged: JudgedRun | null
): AutomationRunCompletionObservation {
  if (verdict.kind === 'completed') {
    return {
      status: 'completed',
      outputSnapshot: completedSnapshot(tail, judged),
      error: null
    }
  }
  const { kind: _kind, ...failure } = verdict
  return { status: 'dispatch_failed', outputSnapshot: snapshotOf(tail), ...failure }
}

/** Rejudge unchanged idle output: an idle shell may never emit another idle edge. */
async function settleIdlePane(
  runtime: AutomationRunTerminalHost,
  handle: string,
  judged: JudgedRun,
  start: AgentStartWatch,
  runStartedAt: number,
  signal: AbortSignal,
  deadlineAt: number
): Promise<AutomationRunCompletionObservation | null> {
  const idleTail = (await readTail(runtime, handle)).join('\n')
  while (
    Date.now() < (start.isAgentSeen() ? deadlineAt : Math.min(deadlineAt, start.startDeadlineAt))
  ) {
    const tail = await readTail(runtime, handle)
    if (tail.join('\n') !== idleTail) {
      return null
    }
    const agentStarted = await start.refreshAgentSeen()
    const observation = await judgeIdleTail(tail, judged, runStartedAt, agentStarted)
    if (observation) {
      return observation
    }
    await sleep(AGENT_EVIDENCE_POLL_INTERVAL_MS, signal)
  }
  return null
}

function isTerminalWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout'
}

function isGraphUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === 'runtime_unavailable'
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('request_aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Reuse runtime idle detection across sticky status, pane titles and ready shell prompts. */
async function isTuiIdleSatisfiedNow(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const wait = await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: AGENT_START_PROBE_TIMEOUT_MS,
      signal
    })
    return wait.satisfied
  } catch (error) {
    if (isTerminalWaitTimeout(error)) {
      return false
    }
    throw error
  }
}

async function waitForAgentStart(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal,
  deadlineAt: number
): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    await sleep(AGENT_START_POLL_INTERVAL_MS, signal)
    if (!(await isTuiIdleSatisfiedNow(runtime, handle, signal))) {
      return true
    }
  }
  return false
}

export const AGENT_HOOKS_REVIEW_BLOCKED_ERROR = AUTOMATION_RUN_FAILURE_COPY.hooksReviewBlocked

function describeBlockedAgent(blockedReason: string): AutomationRunFailure {
  return blockedReason === 'agent-hooks-review-prompt'
    ? automationRunFailure('hooksReviewBlocked')
    : { error: `Automation agent is blocked: ${blockedReason}.` }
}

async function readTerminalSnapshot(
  runtime: AutomationRunTerminalHost,
  handle: string
): Promise<AutomationRunOutputSnapshot | null> {
  const snapshotBuffer = createAutomationOutputSnapshotBuffer()
  try {
    const read = await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })
    snapshotBuffer.append(read.tail.join('\n'))
  } catch {
    // A terminal may exit after the wait succeeds; snapshot failure must not change its outcome.
  }
  return snapshotBuffer.snapshot()
}

async function buildObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  wait: { satisfied: boolean; blockedReason?: string }
): Promise<AutomationRunCompletionObservation> {
  const outputSnapshot = await readTerminalSnapshot(runtime, handle)
  if (wait.satisfied) {
    return { status: 'completed', outputSnapshot, error: null }
  }
  return {
    status: 'dispatch_failed',
    outputSnapshot,
    ...(wait.blockedReason
      ? describeBlockedAgent(wait.blockedReason)
      : automationRunFailure('agentNoCompletion'))
  }
}

async function buildUnobservedObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  failure: AutomationRunFailure,
  useTerminalTail = false
): Promise<AutomationRunCompletionObservation> {
  const tail = await readTail(runtime, handle)
  // Why: an agent that never started usually printed why (missing binary, auth prompt); the
  // terminal's last lines are the actionable error. The coded copy only stands in when it is empty.
  const tailError = useTerminalTail ? formatTerminalTailError(tail, '') : ''
  return {
    status: 'dispatch_failed',
    outputSnapshot: snapshotOf(tail),
    ...(tailError ? { error: tailError } : failure)
  }
}

export function createRuntimeAutomationRunTerminalObserver(
  runtime: AutomationRunTerminalHost,
  /** Agent evidence discounts prior-run idleness; without it, require a busy-to-idle transition. */
  evidence?: AutomationRunAgentEvidence
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal: (run) =>
      run.terminalPaneKey ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey) : null,
    observeCompletion: async (handle, { signal, run }) => {
      const startedAt = Date.now()
      const runStartedAt = run?.startedAt ?? run?.dispatchedAt ?? startedAt
      const judged =
        evidence && run?.terminalPaneKey ? captureRunAgentTurn(evidence, run, runStartedAt) : null
      const startDeadlineMs = agentStartDeadlineMs()
      const startDeadlineAt = startedAt + startDeadlineMs
      const hasProcessProbe = Boolean(evidence?.isAgentProcessRunning && run?.terminalPaneKey)
      let agentSeen = !hasProcessProbe
      const refreshAgentSeen = async (): Promise<boolean> => {
        if (agentSeen || !evidence || !run) {
          return true
        }
        if (hasPostDispatchAgentStatus(evidence, run, runStartedAt)) {
          agentSeen = true
          return true
        }
        if (await evidence.isAgentProcessRunning?.(run, handle).catch(() => false)) {
          agentSeen = true
          return true
        }
        return false
      }
      const start: AgentStartWatch = {
        refreshAgentSeen,
        isAgentSeen: () => agentSeen,
        startDeadlineAt,
        startDeadlineMs
      }
      if (!agentSeen) {
        await refreshAgentSeen()
      }
      const startPollTimer = !agentSeen
        ? setInterval(() => {
            if (agentSeen || signal.aborted || Date.now() >= startDeadlineAt) {
              clearInterval(startPollTimer!)
              return
            }
            void refreshAgentSeen()
          }, AGENT_EVIDENCE_POLL_INTERVAL_MS)
        : null
      startPollTimer?.unref?.()
      try {
        return await observeTerminalRun(
          runtime,
          handle,
          signal,
          judged,
          start,
          startedAt,
          runStartedAt
        )
      } finally {
        if (startPollTimer) {
          clearInterval(startPollTimer)
        }
        judged?.stop()
      }
    }
  }
}

async function observeTerminalRun(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal,
  judged: JudgedRun | null,
  start: AgentStartWatch,
  startedAt: number,
  runStartedAt: number
): Promise<AutomationRunCompletionObservation> {
  // Without agent evidence, require a busy edge to exclude a previous run's idle state.
  if (!judged && (await isTuiIdleSatisfiedNow(runtime, handle, signal))) {
    const started = await waitForAgentStart(
      runtime,
      handle,
      signal,
      startedAt + AGENT_START_DEADLINE_MS
    )
    if (!started) {
      return await buildUnobservedObservation(
        runtime,
        handle,
        automationRunFailure('agentNeverStarted')
      )
    }
  }
  const deadlineAt = startedAt + OBSERVE_DEADLINE_MS
  while (Date.now() < deadlineAt) {
    if (
      !start.isAgentSeen() &&
      Date.now() >= start.startDeadlineAt &&
      !(await start.refreshAgentSeen())
    ) {
      return await buildUnobservedObservation(
        runtime,
        handle,
        {
          error: `Automation agent did not start within ${Math.round(start.startDeadlineMs / 1000)}s of launch.`
        },
        true
      )
    }
    // Re-arm often enough to settle a held `done` (#34064) and to enforce the start deadline.
    const waitTimeouts = [
      ...(judged ? [HELD_DONE_SETTLE_MS] : []),
      ...(!start.isAgentSeen()
        ? [Math.max(AGENT_START_PROBE_TIMEOUT_MS, start.startDeadlineAt - Date.now())]
        : [])
    ]
    try {
      const wait = await runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        signal,
        ...(waitTimeouts.length > 0 ? { timeoutMs: Math.min(...waitTimeouts) } : {})
      })
      if (!judged || !wait.satisfied) {
        return await buildObservation(runtime, handle, wait)
      }
      const observation = await settleIdlePane(
        runtime,
        handle,
        judged,
        start,
        runStartedAt,
        signal,
        deadlineAt
      )
      if (observation) {
        return observation
      }
    } catch (error) {
      const exit = signal.aborted ? null : readProvenTerminalExit(error)
      if (exit) {
        return observationOf(judgeRunExit(exit, judged), await readTail(runtime, handle), judged)
      }
      // A window reload unpublishes the graph for a moment; the run's terminal survives it.
      if (!signal.aborted && isGraphUnavailable(error) && runtime.canOpenRunTerminals()) {
        await sleep(AGENT_EVIDENCE_POLL_INTERVAL_MS, signal)
        continue
      }
      // Individual wait timeouts do not prove the agent stopped working.
      if (signal.aborted || !isTerminalWaitTimeout(error)) {
        throw error
      }
      const held = judged
        ? judgeHeldRunTurn(
            judged.evidence,
            judged.run,
            runStartedAt,
            Date.now(),
            HELD_DONE_SETTLE_MS
          )
        : null
      if (held) {
        return observationOf(held, await readTail(runtime, handle), judged)
      }
    }
  }
  return await buildUnobservedObservation(runtime, handle, automationRunFailure('watchTimedOut'))
}
