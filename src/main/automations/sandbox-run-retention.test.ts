import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AutomationRun,
  AutomationRunStatus
} from '../../shared/automations/history/automation-run'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  ensureSandboxForWorktree,
  getSandboxState,
  resetSandboxManagerForTest,
  sandboxContainerName,
  setSandboxDockerRunner
} from '../sandbox/sandbox-manager'
import { launchAutomationTerminalAgent } from './automation-terminal-launch'
import { AutomationDispatchRefusedError } from './automation-launch-runner'
import { createRuntimeAutomationService } from './runtime-automation-service'
import { DEFAULT_SANDBOX_RUN_GRACE_MS } from './sandbox-run-retention'

vi.mock('./service', () => ({
  AutomationService: class {
    // Upstream builds run-terminal retention inside the service from this factory option.
    runTerminalRetention: unknown
    constructor(
      _store: unknown,
      opts: { runTerminalRetention?: (owner: unknown) => unknown } = {}
    ) {
      this.runTerminalRetention = opts.runTerminalRetention?.(this) ?? null
    }
    start = vi.fn()
    stop = vi.fn()
    markDispatchResult = vi.fn(async () => ({}))
    runInAutomationLane = <T>(_automationId: string, operation: () => Promise<T>): Promise<T> =>
      operation()
  }
}))

let dir: string
let containers: Map<string, string>
let dockerCalls: (readonly string[])[]

function makeSandboxRun(
  id: string,
  index: number,
  status: AutomationRunStatus = 'completed',
  outputSnapshot: AutomationRun['outputSnapshot'] = null
): AutomationRun {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies the fields retention inspects.
  return {
    id,
    automationId: 'rdf-triage',
    status,
    error: status === 'dispatch_failed' ? 'boom' : null,
    outputSnapshot,
    terminalSessionId: `tab-${id}`,
    terminalPaneKey: `tab-${id}:1`,
    terminalPtyId: `pty-${id}`,
    workspaceId: `repo::/wt/${id}`,
    dispatchedAt: index * 1000,
    startedAt: index * 1000,
    createdAt: index * 1000
  } as AutomationRun
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'sandbox-retention-'))
  vi.stubEnv('ORCA_SANDBOX_AGENTS', '1')
  vi.stubEnv('ORCA_USER_DATA', join(dir, 'userdata'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(dir, 'config-orca'))
  containers = new Map()
  dockerCalls = []
  resetSandboxManagerForTest()
  setSandboxDockerRunner(async ({ args }) => {
    dockerCalls.push(args)
    if (args[0] === 'ps') {
      return { code: 0, stdout: [...containers.keys()].join('\n'), stderr: '' }
    }
    if (args[0] === 'run') {
      const name = String(args[args.indexOf('--name') + 1] ?? '')
      containers.set(name, '1')
      return { code: 0, stdout: `${name}\n`, stderr: '' }
    }
    if (args[0] === 'top') {
      return {
        code: 0,
        stdout: 'PID PPID COMM ARGS\n1 0 tini tini -- sleep infinity\n42 0 bash bash\n',
        stderr: ''
      }
    }
    if (args[0] === 'rm') {
      containers.delete(String(args.at(-1) ?? ''))
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
})

afterEach(() => {
  vi.useRealTimers()
  setSandboxDockerRunner(null)
  resetSandboxManagerForTest()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('sandbox automation retention & slot reserve (R2 + R4)', () => {
  it('releases sandboxes for completed/failed/cancelled runs after 2m grace, captures outputSnapshot, keeps 0 live terminals, and prunes worktrees past 3', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const runs = [
      makeSandboxRun('r0', 0, 'completed'),
      makeSandboxRun('r1', 1, 'dispatch_failed'),
      makeSandboxRun('r2', 2, 'dispatched'),
      makeSandboxRun('r3', 3, 'completed'),
      makeSandboxRun('r4', 4, 'completed')
    ]
    const metaByWt: Record<string, Partial<WorktreeMeta>> = {}
    for (let i = 0; i < runs.length; i += 1) {
      const wtPath = join(dir, `wt-${i}`)
      mkdirSync(wtPath, { recursive: true })
      const wtId = runs[i].workspaceId!
      await ensureSandboxForWorktree({ worktreeId: wtId, worktreePath: wtPath })
      metaByWt[wtId] = {
        automationProvenance: {
          kind: 'created-by-automation',
          automationId: 'rdf-triage',
          automationNameSnapshot: 'rdf-triage',
          automationRunId: runs[i].id,
          automationRunTitleSnapshot: runs[i].id,
          createdAt: (i + 1) * 1000,
          executionTargetType: 'local',
          executionTargetId: 'local',
          projectId: 'p1'
        }
      }
    }
    // Interactive worktree must never be touched by retention.
    const interactiveId = 'repo::/wt/interactive'
    const interactivePath = join(dir, 'wt-interactive')
    mkdirSync(interactivePath, { recursive: true })
    await ensureSandboxForWorktree({ worktreeId: interactiveId, worktreePath: interactivePath })
    metaByWt[interactiveId] = {}

    const livePtys = new Set(runs.map((r) => r.terminalPtyId!))
    const removedWorktrees: string[] = []
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      getTerminalHandleForPaneKey: vi.fn((paneKey: string) => {
        const run = runs.find((entry) => entry.terminalPaneKey === paneKey)
        return run && run.terminalPtyId && livePtys.has(run.terminalPtyId)
          ? `handle:${paneKey}`
          : null
      }),
      getTerminalPtyIdForHandle: vi.fn((handle: string) => {
        const paneKey = handle.replace(/^handle:/, '')
        return runs.find((entry) => entry.terminalPaneKey === paneKey)?.terminalPtyId ?? null
      }),
      readTerminalClientUse: vi.fn(() => 'unused' as const),
      getWorkspaceSessionForWorktree: vi.fn(() => undefined),
      readTerminal: vi.fn(async (handle: string) => ({ tail: [`snapshot for ${handle}`] })),
      listTerminals: vi.fn(async (selector?: string) => {
        const wtId = selector?.replace(/^id:/, '')
        const active = runs.filter(
          (entry) =>
            entry.workspaceId === wtId &&
            entry.terminalPtyId !== null &&
            livePtys.has(entry.terminalPtyId)
        )
        return { terminals: active }
      }),
      closeTerminal: vi.fn(async (handle: string) => {
        const paneKey = handle.replace(/^handle:/, '')
        const run = runs.find((entry) => entry.terminalPaneKey === paneKey)
        if (run?.terminalPtyId) {
          livePtys.delete(run.terminalPtyId)
        }
      }),
      confirmTerminalShellAlone: vi.fn(async () => false),
      sleepTerminalsForWorktree: vi.fn(
        async (_selector: string, options: { soleLivePtyId?: string }) => {
          if (options.soleLivePtyId) {
            livePtys.delete(options.soleLivePtyId)
          }
          return {
            livePtyIds: options.soleLivePtyId ? [options.soleLivePtyId] : [],
            stoppedPtyIds: options.soleLivePtyId ? [options.soleLivePtyId] : []
          }
        }
      ),
      removeManagedWorktree: vi.fn(async (selector: string) => {
        const wtId = selector.replace(/^id:/, '')
        removedWorktrees.push(wtId)
        delete metaByWt[wtId]
        return {}
      })
    }
    const store = {
      listAutomationRuns: vi.fn(() => runs),
      listAutomations: () => [],
      getWorktreeMeta: vi.fn((wtId: string) => metaByWt[wtId]),
      getAllWorktreeMeta: vi.fn(() => metaByWt)
    }
    const service = createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test mock satisfies retention members.
      store: store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test mock satisfies retention members.
      runtime: runtime as never,
      allowRemoteHostScheduling: true
    })
    vi.mocked(service.markDispatchResult).mockImplementation(async (result) => {
      const target = runs.find((entry) => entry.id === result.runId)
      if (target) {
        target.status = result.status
        if (result.terminalPtyId !== undefined) {
          target.terminalPtyId = result.terminalPtyId
        }
        if (result.terminalPaneKey !== undefined) {
          target.terminalPaneKey = result.terminalPaneKey
        }
        if (result.outputSnapshot !== undefined) {
          target.outputSnapshot = result.outputSnapshot
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: return value is unused by retention.
      return (target ?? {}) as AutomationRun
    })

    service.start()
    expect(containers.size).toBe(6)

    await vi.advanceTimersByTimeAsync(DEFAULT_SANDBOX_RUN_GRACE_MS - 1_000)
    expect(containers.size).toBe(6)

    await vi.advanceTimersByTimeAsync(2_000)
    // All 4 already-final runs released immediately after 2m grace; r2 (dispatched with idle shell) releases on next 30s sweep.
    expect(containers.size).toBe(2)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(livePtys.size).toBe(0)
    expect(runs[2].status).toBe('dispatch_failed')
    expect([...containers.keys()]).toEqual([sandboxContainerName(interactiveId)])
    expect(await getSandboxState(interactiveId)).toBe('running')
    for (const run of runs) {
      expect(run.outputSnapshot?.content).toContain(`snapshot for handle:tab-${run.id}:1`)
    }
    expect(removedWorktrees.toSorted()).toEqual(['repo::/wt/r0', 'repo::/wt/r1'])
    service.stop()
  })

  it('refuses automation dispatch past limit - reserve before creating a worktree, while preserving 2 interactive slots', async () => {
    if (process.platform !== 'linux') {
      return
    }
    for (let i = 0; i < 8; i += 1) {
      const wtPath = join(dir, `occupied-${i}`)
      mkdirSync(wtPath, { recursive: true })
      await ensureSandboxForWorktree({ worktreeId: `repo::/occ-${i}`, worktreePath: wtPath })
    }
    expect(containers.size).toBe(8)

    const createManagedWorktree = vi.fn()
    const runtime = {
      requireStore: () => ({ getSettings: () => ({}) }),
      createManagedWorktree
    }
    await expect(
      launchAutomationTerminalAgent(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pre-worktree slot check runs before runtime methods.
        runtime as never,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal automation fixture.
          automation: {
            id: 'auto-slot',
            agentId: 'claude',
            prompt: 'hi',
            workspaceMode: 'new_per_run',
            workspaceId: null
          } as never,
          run: { id: 'run-9', title: 'Run 9', scheduledFor: 1, trigger: 'scheduled' },
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal target fixture.
          target: { ok: true, repo: { id: 'repo', path: '/repo', displayName: 'repo' } } as never,
          runs: []
        }
      )
    ).rejects.toThrow(AutomationDispatchRefusedError)
    expect(createManagedWorktree).not.toHaveBeenCalled()

    for (const slot of [9, 10]) {
      const wtPath = join(dir, `interactive-${slot}`)
      mkdirSync(wtPath, { recursive: true })
      await ensureSandboxForWorktree({
        worktreeId: `repo::/interactive-${slot}`,
        worktreePath: wtPath
      })
    }
    expect(containers.size).toBe(10)
  })
})
