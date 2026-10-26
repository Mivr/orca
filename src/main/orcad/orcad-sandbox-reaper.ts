/** Orphan sandbox reaping on orcad start (daemon restarts never reap). */
import { isSandboxRoutingEnabled } from '../sandbox/sandbox-config'
import { reapOrphanSandboxes } from '../sandbox/sandbox-manager'

export async function reapSandboxOrphansOnStart(
  listWorktreeIds: () => readonly string[]
): Promise<void> {
  if (!isSandboxRoutingEnabled()) {
    return
  }
  // Why a skip knob: an in-place cutover starts this orcad beside sandboxes a previous orcad
  // admitted, before anyone has confirmed this build reads worktree ids the same way.
  if (process.env.ORCA_SANDBOX_SKIP_START_REAP === '1') {
    console.error('[orcad] sandbox orphan reap skipped (ORCA_SANDBOX_SKIP_START_REAP=1)')
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
