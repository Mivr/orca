import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'
import { formatEndpoint } from './host-reachability'
import { diagnoseConnection } from './connection-diagnostics-analysis'
import { redactConnectionLogEntry, redactConnectionLogText } from './connection-log-redaction'

// Why: one shareable text blob answering everything we historically had to
// ask reporters one message at a time (endpoint type, state, attempt count,
// last-connected, versions, and the reconnect lifecycle log).
export function buildConnectionDiagnosticsReport(args: {
  hostName: string
  endpoint: string
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  platform: string
  appVersion: string
  entries: readonly ConnectionLogEntry[]
  activePath?: MobileConnectionDiagnosticPath
  pendingPath?: MobileConnectionDiagnosticPath | null
  nowMs?: number
}): string {
  const now = args.nowMs ?? Date.now()
  const entries = args.entries.map(redactConnectionLogEntry)
  const diagnosis = diagnoseConnection({
    endpoint: args.endpoint,
    state: args.state,
    activePath: args.activePath,
    pendingPath: args.pendingPath,
    entries
  })
  const lines: string[] = []
  lines.push('Orca Mobile connection diagnostics')
  lines.push(`Generated: ${new Date(now).toISOString()}`)
  lines.push(`App: Orca Mobile ${args.appVersion} · ${args.platform}`)
  lines.push(`Host: ${redactConnectionLogText(args.hostName)}`)
  lines.push(
    `Endpoint: ${formatEndpoint(args.endpoint)}${isTailscaleEndpoint(args.endpoint) ? ' (Tailscale)' : ''}`
  )
  lines.push(`State: ${args.state} (reconnect attempts: ${args.reconnectAttempts})`)
  if (args.activePath) {
    lines.push(
      `Path: active=${args.activePath}${args.pendingPath ? `; recovery=${args.pendingPath}` : ''}`
    )
  }
  lines.push(
    args.lastConnectedAt == null
      ? 'Last connected: never this session'
      : `Last connected: ${new Date(args.lastConnectedAt).toISOString()} (${formatAgo(now - args.lastConnectedAt)} ago)`
  )
  lines.push('')
  lines.push(`Likely cause: ${diagnosis.likelyCause}`)
  lines.push(`Next step: ${diagnosis.nextStep}`)
  lines.push('')
  if (entries.length === 0) {
    lines.push('No connection events recorded.')
  } else {
    lines.push(`Recent connection history (${entries.length} events, oldest first):`)
    for (const entry of entries) {
      const detail = entry.detail ? ` — ${entry.detail}` : ''
      const evidence = [entry.code, entry.path].filter(Boolean).join(' · ')
      lines.push(
        `${new Date(entry.ts).toISOString()} [${entry.level}]${evidence ? ` [${evidence}]` : ''} ${entry.message}${detail}`
      )
    }
  }
  return lines.join('\n')
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
