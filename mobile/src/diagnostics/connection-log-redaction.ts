import type { ConnectionLogEntry } from '../transport/types'

const SECRET_ASSIGNMENT =
  /\b(resumeToken|deviceToken|authorization|credential|token|publicKeyB64)(\s*[:=]\s*)(?:Bearer\s+)?([^\s;,]+)/gi
const SECRET_QUERY = /([?&](?:token|credential|resumeToken|deviceToken)=)[^&#\s]+/gi
const URL_USERINFO = /(wss?:\/\/)[^/@\s]+@/gi

export function redactConnectionLogText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, (_match, label: string, separator: string) => {
      return `${label}${separator}[redacted]`
    })
    .replace(SECRET_QUERY, '$1[redacted]')
    .replace(URL_USERINFO, '$1[redacted]@')
}

export function redactConnectionLogEntry(entry: ConnectionLogEntry): ConnectionLogEntry {
  return {
    ...entry,
    message: redactConnectionLogText(entry.message),
    ...(entry.detail ? { detail: redactConnectionLogText(entry.detail) } : {})
  }
}
