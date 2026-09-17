import { describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

function mockSubprocess(pid: number): SubprocessHandle & { write: ReturnType<typeof vi.fn> } {
  return {
    pid,
    getForegroundProcess: vi.fn(() => 'agy'),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: () => {},
    dispose: vi.fn()
  } as unknown as SubprocessHandle & { write: ReturnType<typeof vi.fn> }
}

type ReadinessEvent = { event: string; details: Record<string, unknown> }

// Why this test: cutover7 restarted orca-live and the daemon reattached the sandbox PTY as a fresh
// session (session-created pid:57, startup-command-delivery written:false/hasCommand:false) while
// the agent (agy) ran untouched in its container. A reattach that re-injects the launch command
// double-starts the agent and wedges it on a conversation lock — so the reattach path must never
// write startup bytes, never disturb the surviving process, and never touch pairing state.
describe('TerminalHost restart reattach never injects', () => {
  it('reattaches the same session id with zero injected bytes and a writable PTY', async () => {
    const sessionId = 'repo::/work/cutover7-agy@@8dad5a1d'
    const agentPid = 14

    const preRestartSub = mockSubprocess(agentPid)
    const preRestartEvents: ReadinessEvent[] = []
    const preRestartHost = new TerminalHost({
      spawnSubprocess: () => preRestartSub,
      reportReadinessEvent: (event, details) => preRestartEvents.push({ event, details })
    })
    const launched = await preRestartHost.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      command: 'agy',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(launched.pid).toBe(agentPid)
    expect(preRestartSub.write).toHaveBeenCalled()
    const injectedBeforeRestart = (preRestartSub.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .join('').length
    expect(injectedBeforeRestart).toBeGreaterThan(0)

    // Daemon restart: a fresh host re-creates the same session id against the SURVIVING agent
    // process (same container-side pid). The reattach carries no startup command.
    const reattachSub = mockSubprocess(agentPid)
    const reattachEvents: ReadinessEvent[] = []
    const restartedHost = new TerminalHost({
      spawnSubprocess: () => reattachSub,
      reportReadinessEvent: (event, details) => reattachEvents.push({ event, details })
    })
    const reattached = await restartedHost.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    // Same agent process still parented under the reattached session.
    expect(reattached.pid).toBe(agentPid)
    expect(reattached.isNew).toBe(true)
    // Zero bytes injected: the clean reattach pattern from the cutover7 daemon log.
    expect(reattachSub.write).not.toHaveBeenCalled()
    expect(
      reattachEvents.find((entry) => entry.event === 'startup-command-delivery')?.details
    ).toMatchObject({ written: false, hasCommand: false, sessionId })
    // The surviving pre-restart process handle is never signaled or reaped by the reattach.
    expect(preRestartSub.kill).not.toHaveBeenCalled()
    expect(preRestartSub.forceKill).not.toHaveBeenCalled()
    expect(preRestartSub.signal).not.toHaveBeenCalled()
    // The reattached PTY is writable for live agent flow.
    restartedHost.write(sessionId, 'status\n')
    expect(reattachSub.write).toHaveBeenCalledTimes(1)
    expect(reattachSub.write).toHaveBeenCalledWith('status\n')
    // Session inventory still names the reattached session (client handles resolve).
    expect(restartedHost.listSessions().map((session) => session.sessionId)).toContain(sessionId)
  })

  it('never logs startup command text on the reattach path', async () => {
    const sessionId = 'repo::/work/secret@@8dad5a1d'
    const events: ReadinessEvent[] = []
    const host = new TerminalHost({
      spawnSubprocess: () => mockSubprocess(7),
      reportReadinessEvent: (event, details) => events.push({ event, details })
    })
    await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(JSON.stringify(events)).not.toContain('hunter2')
  })
})
