import type { ConnectionDiagnosticCode, ConnectionLogLevel, ConnectionLogSink } from './types'

export type RelayRecoveryLog = (
  message: string,
  detail?: string,
  evidence?: { level?: ConnectionLogLevel; code?: ConnectionDiagnosticCode }
) => void

// Why: relay recovery failed silently in production for weeks; every decision
// must reach logcat and the in-app connection log.
export function createRelayRecoveryLog(
  now: () => number,
  onLog?: ConnectionLogSink
): RelayRecoveryLog {
  let sequence = 0
  return (message, detail, evidence) => {
    console.log(`[relay] ${message}`, detail ?? '')
    onLog?.({
      id: `relay-${++sequence}`,
      ts: now(),
      level: evidence?.level ?? 'info',
      path: 'relay',
      ...(evidence?.code ? { code: evidence.code } : {}),
      message: `Relay: ${message}`,
      ...(detail ? { detail } : {})
    })
  }
}
