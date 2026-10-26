/** Docker-sandbox deployment duties that orcad runs during startup. */
import type { TerminalReattachReport } from '../../shared/runtime-client-events'

const SANDBOX_SPOOL_POLL_MS = 5_000

/**
 * Why polled and not event-driven: bridge-networked sandbox hooks cannot POST to loopback, so the
 * mounted spool dir is the only signal. The drain consumes what it replays, so overlapping ticks
 * are safe. Sandbox-gated: no containers, no polling. Returns the stop function.
 */
export async function startSandboxHookSpoolPoll(server: {
  drainSandboxHookSpool(): Promise<number>
}): Promise<() => void> {
  const { isSandboxRoutingEnabled } = await import('../sandbox/sandbox-config')
  if (!isSandboxRoutingEnabled()) {
    return () => {}
  }
  // Why a gate: the drain is async now, and a slow tick must not overlap the next one.
  let draining = false
  const poll = setInterval(() => {
    if (draining) {
      return
    }
    draining = true
    server
      .drainSandboxHookSpool()
      .catch(() => {
        // Best effort: a failed poll retries on the next tick.
      })
      .finally(() => {
        draining = false
      })
  }, SANDBOX_SPOOL_POLL_MS)
  return () => clearInterval(poll)
}

/**
 * Diffs the durable handle map against live PTYs and publishes the restart report paired clients
 * read. Best-effort: a failed inventory must never fail the boot it was meant to observe.
 */
export async function logTerminalReattachReport(runtime: {
  publishTerminalReattachReport(): Promise<TerminalReattachReport | null>
}): Promise<void> {
  try {
    const report = await runtime.publishTerminalReattachReport()
    if (report) {
      console.error(
        `[orcad] restart reattach: ${report.reattached.length} reattached, ` +
          `${report.remapped.length} remapped, ${report.failed.length} failed`
      )
    }
  } catch (error) {
    console.error('[orcad] restart reattach report unavailable:', error)
  }
}
