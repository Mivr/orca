import {
  stageStartupCommand,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../../shared/startup-command-staging'
import type { Session } from '../sessions/session'
import type { SubprocessHandle } from '../sessions/session-subprocess-handle'

export function stageSessionStartupCommand(args: {
  command: string
  sessionId: string
  subprocess: SubprocessHandle
  orcaBuiltLine: boolean
  session: Session
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
}): StartupCommandStaging {
  const staging = stageStartupCommand({
    command: args.command,
    shellPath: args.subprocess.stagingShellPath ?? args.subprocess.shellPath,
    ...(args.subprocess.stagingDirectory ? { directory: args.subprocess.stagingDirectory } : {}),
    orcaBuiltLine: args.orcaBuiltLine
  })
  const notice = startupStagingFailureNotice(staging)
  if (notice) {
    console.error('[daemon] startup-command-stage-failed', {
      sessionId: args.sessionId,
      reason: staging.failure
    })
    args.session.startupIngress.accept(notice)
    try {
      args.reportReadinessEvent?.('startup-command-stage-failed', {
        sessionId: args.sessionId,
        reason: staging.failure
      })
    } catch {
      // Diagnostics must never turn a live PTY into a failed create.
    }
  }
  return staging
}
