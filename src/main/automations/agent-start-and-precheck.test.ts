import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type {
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations/history/automation-run'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automations/launch/automation-precheck'
import { execDescendantsMatchAgent } from '../sandbox/sandbox-slots'
import { DEFAULT_AGENT_START_DEADLINE_MS } from './automation-run-agent-evidence'
import { AutomationDispatchRefusedError, runAutomationLaunch } from './automation-launch-runner'
import { runAutomationPrecheck } from './precheck-runner'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const HANDLE = 'term-r3'
const PANE_KEY = 'tab-r3:1'

function makeHost(options: { idle: boolean; tail: string[] }): AutomationRunTerminalHost {
  return {
    getTerminalHandleForPaneKey: () => HANDLE,
    canOpenRunTerminals: () => true,
    readTerminal: async () => ({ tail: options.tail }),
    waitForTerminal: (_handle, waitOpts) => {
      if (options.idle) {
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('timeout'))
        }, waitOpts?.timeoutMs ?? 300_000)
        waitOpts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('request_aborted'))
        })
      })
    }
  }
}

describe('agent fast start failure & precheck output retention (R3 + R5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('matches both ELF agents and Node-wrapped agents (codex) in docker top while ignoring opencode serve', () => {
    const codexTop = [
      'PID PPID COMMAND COMMAND',
      '1 0 tini /usr/bin/tini -s -- sleep infinity',
      '50 1 opencode /usr/local/bin/opencode serve --service',
      '80 0 bash bash --rcfile /rc',
      '81 80 node node /usr/local/bin/codex --dangerously-bypass-approvals-and-sandbox'
    ].join('\n')
    expect(execDescendantsMatchAgent(codexTop, ['codex'])).toBe(true)
    expect(execDescendantsMatchAgent(codexTop, ['opencode'])).toBe(false)
    expect(execDescendantsMatchAgent(codexTop, ['claude'])).toBe(false)
  })

  it('fails immediately with last 20 terminal lines when an overridden agent binary does not exist', async () => {
    const lines = Array.from({ length: 25 }, (_, idx) => `line-${idx + 1}`)
    lines.push('bash: /nonexistent/missing-claude: No such file or directory')
    lines.push('ubuntu@sandbox:~$')
    const observer = createRuntimeAutomationRunTerminalObserver(
      makeHost({ idle: true, tail: lines }),
      {
        getAgentStatusRowsForPane: () => [],
        getAcceptedReply: () => undefined,
        subscribeStatusChanges: () => () => {},
        agentCommandsForRun: () => ['claude', '/nonexistent/missing-claude'],
        isAgentProcessRunning: async () => false
      }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal run fixture for observer.
    const run = {
      terminalPaneKey: PANE_KEY,
      startedAt: Date.now(),
      dispatchedAt: Date.now()
    } as AutomationRun
    const result = await observer.observeCompletion(HANDLE, {
      signal: new AbortController().signal,
      run
    })
    expect(result.status).toBe('dispatch_failed')
    expect(result.error).toContain('/nonexistent/missing-claude: No such file or directory')
    expect(result.error).toContain('line-8')
    expect(result.error).not.toContain('line-5\n')
  })

  it.each([true, false])(
    'fails at 120s (not 6h) with the last 20 terminal lines when expected agent never starts (idle=%s)',
    async (idle) => {
      const lines = Array.from({ length: 24 }, (_, idx) => `boot-${idx + 1}`)
      const observer = createRuntimeAutomationRunTerminalObserver(makeHost({ idle, tail: lines }), {
        getAgentStatusRowsForPane: () => [],
        getAcceptedReply: () => undefined,
        subscribeStatusChanges: () => () => {},
        agentCommandsForRun: () => ['claude'],
        isAgentProcessRunning: async () => false
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal run fixture for observer.
      const run = {
        terminalPaneKey: PANE_KEY,
        startedAt: Date.now(),
        dispatchedAt: Date.now()
      } as AutomationRun
      const settled = vi.fn()
      const promise = observer
        .observeCompletion(HANDLE, { signal: new AbortController().signal, run })
        .then(settled)

      await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_START_DEADLINE_MS - 1_000)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await promise
      expect(settled).toHaveBeenCalledOnce()
      const observation = settled.mock.calls[0]?.[0]
      expect(observation.status).toBe('dispatch_failed')
      const errorLines = String(observation.error).split('\n')
      expect(errorLines).toHaveLength(20)
      expect(errorLines[0]).toBe('boot-5')
      expect(errorLines[19]).toBe('boot-24')
    }
  )

  it('retains up to 4096 chars of stdout and stderr in precheckResult across skipped and failed dispatches', async () => {
    vi.useRealTimers()
    expect(MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS).toBe(4096)
    const precheck = await runAutomationPrecheck({
      precheck: {
        command:
          "python3 -c 'import sys; sys.stdout.write(chr(111)*4500); sys.stderr.write(chr(101)*4500); sys.exit(1)'",
        timeoutSeconds: 10
      },
      target: { type: 'local', cwd: process.cwd() }
    })
    expect(precheck.stdout).toHaveLength(4096)
    expect(precheck.stderr).toHaveLength(4096)
    expect(precheck.stdoutTruncated).toBe(true)
    expect(precheck.stderrTruncated).toBe(true)

    const passingPrecheck: AutomationPrecheckResult = {
      ...precheck,
      exitCode: 0,
      stdout: 'triage: 3 open issues need labels\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false
    }
    const updates: unknown[] = []
    await runAutomationLaunch({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal automation fixture.
      automation: {
        id: 'a1',
        workspaceId: null,
        precheck: { command: 'true', timeoutSeconds: 10 }
      } as Automation,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal run fixture.
      run: { id: 'run-refused', trigger: 'scheduled' } as AutomationRun,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused by refused dispatcher.
      target: { ok: true } as never,
      dispatcher: async () => {
        throw new AutomationDispatchRefusedError({ error: 'no free sandbox slot' })
      },
      // Upstream routes every dispatch-owned write through transition(); a refusal writes once.
      transition: (result) => {
        const payload = { runId: 'run-refused', ...result }
        updates.push(payload)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal test reads only the recorded payload.
        return { applied: true, run: Promise.resolve(payload as unknown as AutomationRun) }
      },
      runPrecheck: async () => passingPrecheck,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused in refusal test.
      markDispatchResult: async (res) => res as unknown as AutomationRun,
      watchRun: () => {}
    })
    expect(updates).toEqual([
      expect.objectContaining({
        runId: 'run-refused',
        status: 'skipped_unavailable',
        precheckResult: passingPrecheck,
        error: 'no free sandbox slot'
      })
    ])
  })
})
