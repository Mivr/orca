/** Orphan sandbox reaping on orcad start (daemon restarts never reap). */
import { isSandboxRoutingEnabled } from '../sandbox/sandbox-config'
import { reapOrphanSandboxes } from '../sandbox/sandbox-manager'

export async function reapSandboxOrphansOnStart(
  listWorktreeIds: () => readonly string[]
): Promise<void> {
  if (!isSandboxRoutingEnabled()) {
    return
  }
  // Why degrade to empty and not throw: a store that cannot list must never
  // fail the boot, and an empty set only means "reap nothing this start".
  let worktreeIds: readonly string[] = []
  try {
    worktreeIds = listWorktreeIds()
  } catch {
    worktreeIds = []
  }
  const reaped = await reapOrphanSandboxes(new Set(worktreeIds)).catch(() => [] as string[])
  if (reaped.length > 0) {
    console.error(`[orcad] reaped orphan sandboxes: ${reaped.join(', ')}`)
  }
}
