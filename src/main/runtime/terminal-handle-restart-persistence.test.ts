import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

const PTY_ID = 'repo::/worktree@@deadbeef'
const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-terminal'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-restart-resilience-'))
}

function makeRuntime(dir: string | null = null): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  if (dir) {
    runtime.setTerminalHandlePersistenceDir(dir)
  }
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => true),
    getForegroundProcess: async () => null
  })
  return runtime
}

function register(
  runtime: OrcaRuntimeService,
  incarnationId: string,
  terminalHandle?: string
): void {
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId,
    ...(terminalHandle ? { terminalHandle } : {})
  })
}

describe('restart-resilient terminal handles', () => {
  it('replays the same handle for the same pty across a runtime restart', () => {
    const dir = tempDir()
    const before = makeRuntime(dir)
    const handle = before.preAllocateHandleForPty(PTY_ID)
    register(before, 'incarnation-1')

    // New process, same persistence dir: the orcad-restart case.
    const after = makeRuntime(dir)
    expect(after.preAllocateHandleForPty(PTY_ID)).toBe(handle)
    register(after, 'incarnation-2', handle)
    const [listed] = (after as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId
    expect(listed).toEqual([PTY_ID, handle])
  })

  it('preserves the exported handle when a new incarnation reattaches the same pty', async () => {
    const dir = tempDir()
    const runtime = makeRuntime(dir)
    const stable = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')
    await expect(runtime.readTerminal(stable)).resolves.toMatchObject({ status: 'running' })

    // Daemon restart: same ptyId, new incarnation, same exported ORCA_TERMINAL_HANDLE.
    register(runtime, 'incarnation-new', stable)
    await expect(runtime.readTerminal(stable)).resolves.toMatchObject({
      handle: stable,
      status: 'running'
    })
  })

  it('records an old→new remap when the handle genuinely changes', () => {
    const dir = tempDir()
    const runtime = makeRuntime(dir)
    const stale = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-old')

    register(runtime, 'incarnation-new')
    const internals = runtime as unknown as {
      terminalHandleStore: { resolveRemappedHandle(handle: string): string | null }
    }
    const replacement = runtime.preAllocateHandleForPty(PTY_ID)
    expect(replacement).not.toBe(stale)
    expect(internals.terminalHandleStore.resolveRemappedHandle(stale)).toBe(replacement)
  })

  it('publishes a reattach report naming reattached and failed sessions', async () => {
    const dir = tempDir()
    const runtime = makeRuntime(dir)
    const stable = runtime.preAllocateHandleForPty(PTY_ID)
    register(runtime, 'incarnation-1')
    const internals = runtime as unknown as {
      terminalHandleStore: {
        noteMapping(
          ptyId: string,
          handle: string,
          incarnation: string | null,
          worktree: string | null
        ): void
      }
      clientEvents: { on(listener: (event: RuntimeClientEvent) => void): () => void }
    }
    internals.terminalHandleStore.noteMapping('pty-gone', 'term_gone', 'inc-9', 'wt-gone')

    const events: RuntimeClientEvent[] = []
    internals.clientEvents.on((event) => {
      events.push(event)
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: PTY_ID,
          incarnationId: 'incarnation-1',
          cwd: '/worktree',
          title: 'shell',
          worktreeId: WORKTREE_ID,
          terminalHandle: stable
        }
      ]
    })

    const report = await runtime.publishTerminalReattachReport()
    expect(report).not.toBeNull()
    expect(report?.reattached).toMatchObject([{ ptyId: PTY_ID, handle: stable }])
    expect(report?.failed).toMatchObject([{ ptyId: 'pty-gone', reason: 'absent-from-inventory' }])
    const notice = events.find((event) => event.type === 'terminalReattachNotice')
    expect(notice).toMatchObject({ type: 'terminalReattachNotice', report })
    // Late subscribers read the same report off terminal.list.
    expect(runtime.getTerminalReattachNotice()).toEqual(report)
  })

  it('publishes nothing on a fresh boot with no durable handles', async () => {
    const runtime = makeRuntime(tempDir())
    await expect(runtime.publishTerminalReattachReport()).resolves.toBeNull()
  })

  it('does not require persistence for ordinary handle issuance', () => {
    const runtime = makeRuntime()
    expect(runtime.getTerminalHandlePersistenceEnabled()).toBe(false)
    const handle = runtime.preAllocateHandleForPty(PTY_ID)
    expect(handle.startsWith('term_')).toBe(true)
  })
})
