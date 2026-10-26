/**
 * Sandbox admission for fresh agent spawns (orcad-side).
 *
 * Called from the daemon client's spawn path — which runs in the orcad
 * process on headless hosts — before the createOrAttach request is issued.
 * Admits (or reuses) the worktree's sandbox and stamps the target container
 * into the spawn env; the host daemon only sees the stamped request and
 * rewrites the shell into `docker exec`. Rejections throw
 * `sandbox_slots_full` so UI/CLI can show retry guidance.
 */
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { splitWorktreeId } from '../../shared/worktree/id'
import { isSandboxRoutingEnabled } from './sandbox-config'
import { stampSandboxSpawnEnv } from './sandbox-manager'

export type SandboxSpawnCandidate = {
  worktreeId?: string
  cwd?: string
  command?: string
  launchAgent?: unknown
  attachOnly?: boolean
  isNewSession?: boolean
  sessionId?: string
  env?: Record<string, string>
}

export function isSandboxSpawnCandidate(opts: SandboxSpawnCandidate): boolean {
  if (!isSandboxRoutingEnabled()) {
    return false
  }
  if (!opts.worktreeId || !opts.cwd || !opts.cwd.startsWith('/')) {
    return false
  }
  // Reattaches ride the PTY that already routes; only fresh spawns admit.
  if (opts.attachOnly === true) {
    return false
  }
  if (opts.sessionId !== undefined && opts.isNewSession !== true) {
    return false
  }
  // Only agent launches sandbox — plain shells stay on the host.
  if (opts.launchAgent !== undefined) {
    return true
  }
  return recognizeAgentProcessFromCommandLine(opts.command)?.agent !== undefined
}

/** Admits the sandbox and returns the env stamp, or null when not sandboxed. */
export async function admitSandboxSpawn(
  opts: SandboxSpawnCandidate
): Promise<Record<string, string> | null> {
  if (!isSandboxSpawnCandidate(opts)) {
    return null
  }
  const worktreeId = opts.worktreeId as string
  // Why from the id and not the spawn cwd: the cwd can be a subdirectory —
  // the bind must cover the whole worktree root, which the id carries.
  const worktreePath = splitWorktreeId(worktreeId)?.worktreePath || (opts.cwd as string)
  return stampSandboxSpawnEnv({
    worktreeId,
    worktreePath,
    ...(opts.env ? { env: opts.env } : {})
  })
}
