import type { OrcaRuntimeWithBindPtyIncarnationHandle } from './terminal-handle-bindings'
import type { OrcaRuntimeWithInvalidateAllHandlesForPty } from '../lifecycle/pty-handle-invalidation'
import { randomUUID } from 'node:crypto'
import type { PtyIncarnationId } from '../../../../shared/terminal/pty/lifecycle/pty-incarnation'
import { forgetPtySurface } from '../surface/pty-recorded-surface-topology'
import { RuntimeMobileSessionTabSubscriptions } from '../../session-tabs/mobile-session-tab-subscriptions'
export abstract class RuntimePreallocatedTerminalHandles extends RuntimeMobileSessionTabSubscriptions {
  protected abstract deliverPendingMessagesForPty(ptyId: string): void

  protected abstract invalidatePtyIncarnationHandle(
    ...args: Parameters<OrcaRuntimeWithBindPtyIncarnationHandle['invalidatePtyIncarnationHandle']>
  ): ReturnType<OrcaRuntimeWithBindPtyIncarnationHandle['invalidatePtyIncarnationHandle']>

  protected abstract invalidateAllHandlesForPty(
    ...args: Parameters<OrcaRuntimeWithInvalidateAllHandlesForPty['invalidateAllHandlesForPty']>
  ): ReturnType<OrcaRuntimeWithInvalidateAllHandlesForPty['invalidateAllHandlesForPty']>

  protected abstract isTerminalHandleAdoptionBlocked(
    ...args: Parameters<
      OrcaRuntimeWithInvalidateAllHandlesForPty['isTerminalHandleAdoptionBlocked']
    >
  ): ReturnType<OrcaRuntimeWithInvalidateAllHandlesForPty['isTerminalHandleAdoptionBlocked']>

  protected abstract replaceSyntheticTerminalHandlesForRestoredPty(
    ...args: Parameters<
      OrcaRuntimeWithInvalidateAllHandlesForPty['replaceSyntheticTerminalHandlesForRestoredPty']
    >
  ): ReturnType<
    OrcaRuntimeWithInvalidateAllHandlesForPty['replaceSyntheticTerminalHandlesForRestoredPty']
  >

  // Allocate before spawn so ORCA_TERMINAL_HANDLE lets agents self-identify; lazy RPC allocation reuses it.
  preAllocateHandleForPty(ptyId: string): string {
    const existing = this.handleByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    // Why durable first: after an orcad restart the in-memory map is empty but the daemon-side
    // PTY (and its exported ORCA_TERMINAL_HANDLE) survived. Re-minting strands paired clients on
    // the old handle; replaying the persisted one keeps it working (RESTART-RESILIENCE.md).
    // Why the fence guard: a pending replacement proves THIS boot already retired the stored
    // handle's process. Replaying it would resurrect a fenced predecessor alias, so mint fresh.
    const stable = this.resolveStableTerminalHandle(ptyId)
    const fence = this.pendingPtyHandleReplacementFences.get(ptyId)
    const fenced =
      fence !== undefined &&
      stable !== null &&
      fence.incarnationId !== this.terminalHandleStore.getStableEntry(ptyId)?.incarnationId
    if (stable && !fenced) {
      this.setPtyHandle(ptyId, stable)
      return stable
    }
    const handle = this.createPreAllocatedTerminalHandle()
    this.setPtyHandle(ptyId, handle)
    this.noteStableTerminalHandle(
      ptyId,
      handle,
      this.ptysById.get(ptyId)?.incarnationId ?? null,
      null,
      'preallocated'
    )
    return handle
  }

  createPreAllocatedTerminalHandle(): string {
    return `term_${randomUUID()}`
  }

  protected rememberPtyHandleReplacementFence(
    ptyId: string,
    incarnationId: PtyIncarnationId,
    staleHandles: Iterable<string>,
    pendingRegistration: boolean
  ): void {
    const previous = this.pendingPtyHandleReplacementFences.get(ptyId)
    const merged = new Set(previous?.staleHandles)
    for (const handle of staleHandles) {
      merged.add(handle)
    }
    // Bound aliases in case a malformed provider emits an unbounded stream.
    while (merged.size > 16) {
      const oldest = merged.values().next().value
      if (typeof oldest !== 'string') {
        break
      }
      merged.delete(oldest)
    }
    this.pendingPtyHandleReplacementFences.set(ptyId, {
      incarnationId,
      staleHandles: merged,
      pendingRegistration
    })
  }

  registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    if (this.pendingPtyHandleReplacementFences.get(ptyId)?.staleHandles.has(handle)) {
      // The provider can replay the old env handle after announcing a new
      // incarnation. Never let that predecessor alias be reintroduced.
      return
    }
    const retained = this.handleByPtyIncarnation.get(ptyId)
    if (retained?.handle === handle) {
      this.terminalIdentity.removeIncarnation(ptyId)
    } else {
      this.invalidatePtyIncarnationHandle(ptyId)
    }
    this.setPtyHandle(ptyId, handle)
    const incarnation = this.ptysById.get(ptyId)?.incarnationId ?? null
    this.noteStableTerminalHandle(ptyId, handle, incarnation, null, 'controller-adopted')
    for (const leaf of this.getLeavesForPty(ptyId)) {
      this.adoptPreAllocatedHandle(leaf)
    }
  }

  protected setPtyHandle(ptyId: string, handle: string): void {
    if (this.handleByPtyId.get(ptyId) !== handle) {
      this.terminalIdentity.bindPty(ptyId, handle)
      this.wakeMailForNewPtyHandle(ptyId)
    }
  }

  /** Mail waits for a PTY's handle, so every new one is that PTY's delivery edge. */
  protected wakeMailForNewPtyHandle(ptyId: string): void {
    // Deferred so issuance inside a read (a terminal list) never types mid-read.
    queueMicrotask(() => this.deliverPendingMessagesForPty(ptyId))
  }

  protected adoptControllerTerminalHandle(
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options: { exactRestoredSurface?: boolean } = {}
  ): void {
    const trimmed = handle?.trim()
    if (!trimmed || !trimmed.startsWith('term_')) {
      return
    }
    const pty = this.ptysById.get(ptyId)
    const changedIncarnation = Boolean(
      incarnationId && pty?.incarnationId && incarnationId !== pty.incarnationId
    )
    if (changedIncarnation) {
      const priorHandle = this.handleByPtyId.get(ptyId)
      // Why the stable-handle exception: after an orcad/daemon restart the reattached PTY reports
      // a new incarnation but exports its ORIGINAL handle. The in-memory predecessor alias is gone
      // with the old process, so reusing the exported handle here is identity continuity, not alias
      // resurrection — and it is what keeps paired clients attached (RESTART-RESILIENCE.md).
      if (priorHandle === undefined && this.resolveStableTerminalHandle(ptyId) === trimmed) {
        this.registerPreAllocatedHandleForPty(ptyId, trimmed)
        return
      }
      this.invalidateAllHandlesForPty(ptyId)
      forgetPtySurface(this.terminalIdentity, pty!)
      // Reusing an exported handle would make stale client metadata name the replacement process.
      if (priorHandle === trimmed) {
        return
      }
    }
    if (this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)) {
      if (
        !options.exactRestoredSurface ||
        !this.replaceSyntheticTerminalHandlesForRestoredPty(ptyId, trimmed) ||
        this.isTerminalHandleAdoptionBlocked(ptyId, trimmed)
      ) {
        return
      }
    }
    // After runtime restart, surviving PTYs still carry their original exported handle.
    this.registerPreAllocatedHandleForPty(ptyId, trimmed)
  }
}
