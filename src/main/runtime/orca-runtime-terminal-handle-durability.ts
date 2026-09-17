import { OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory } from './orca-runtime-refresh-pty-worktree-records-with-controller-inventory'
import type {
  TerminalHandleRemapReason,
  TerminalReattachReport
} from './terminal-handle-persistence'

export class OrcaRuntimeWithTerminalHandleDurability extends OrcaRuntimeWithRefreshPtyWorktreeRecordsWithControllerInventory {
  setTerminalHandlePersistenceDir(dir: string): void {
    this.terminalHandleStore.setPersistenceDir(dir)
  }

  getTerminalHandlePersistenceEnabled(): boolean {
    return this.terminalHandleStore.persistenceEnabled
  }

  protected resolveStableTerminalHandle(ptyId: string): string | null {
    return this.terminalHandleStore.getStableHandle(ptyId)
  }

  protected noteStableTerminalHandle(
    ptyId: string,
    handle: string,
    incarnationId: string | null = null,
    worktreeId: string | null = null,
    reason: TerminalHandleRemapReason = 'handle-replaced'
  ): void {
    this.terminalHandleStore.noteMapping(ptyId, handle, incarnationId, worktreeId, reason)
  }

  getTerminalReattachNotice(): TerminalReattachReport | null {
    return this.terminalHandleStore.getLastReport()
  }

  async publishTerminalReattachReport(): Promise<TerminalReattachReport | null> {
    if (!this.terminalHandleStore.persistenceEnabled) {
      return null
    }
    const knownPtyIds = this.terminalHandleStore.knownPtyIds()
    if (knownPtyIds.length === 0) {
      return null
    }
    const remappedSinceBoot = this.terminalHandleStore.recentRemaps(200)
    let livePtyIds: Set<string> | null = null
    try {
      const resolvedWorktrees = await this.listResolvedWorktrees()
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        resolvedWorktrees,
        null
      )
      livePtyIds = inventory ? new Set(inventory.allLivePtyIds) : null
    } catch {
      livePtyIds = null
    }
    const reattached: TerminalReattachReport['reattached'] = []
    const failed: TerminalReattachReport['failed'] = []
    for (const ptyId of knownPtyIds) {
      const stable = this.terminalHandleStore.getStableEntry(ptyId)
      if (!stable) {
        continue
      }
      const live = this.ptysById.get(ptyId)
      const inventoryLive = livePtyIds === null ? live?.connected !== false : livePtyIds.has(ptyId)
      if (live && inventoryLive) {
        reattached.push({
          ptyId,
          handle: stable.handle,
          incarnationChanged:
            live.incarnationId !== null && stable.incarnationId !== live.incarnationId,
          worktreeId: live.worktreeId ?? stable.worktreeId
        })
      } else {
        failed.push({
          ptyId,
          handle: stable.handle,
          reason: live ? 'not-connected' : 'absent-from-inventory'
        })
      }
    }
    if (livePtyIds) {
      this.terminalHandleStore.pruneExcept(livePtyIds)
    }
    if (reattached.length === 0 && remappedSinceBoot.length === 0 && failed.length === 0) {
      return null
    }
    const report: TerminalReattachReport = {
      at: Date.now(),
      reattached,
      remapped: remappedSinceBoot,
      failed
    }
    this.terminalHandleStore.setLastReport(report)
    this.emitClientEvent({ type: 'terminalReattachNotice', report })
    return report
  }
}
