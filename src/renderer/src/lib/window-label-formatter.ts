import { formatResetDuration } from '../../../shared/rate-limit-reset-format'

/**
 * Returns a short human-readable label for a usage window duration.
 *
 * Why: 10080 minutes (7 days) is hard-coded as "wk" for backward
 * compatibility with the original StatusBar implementation.
 */
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 10080) {
    return 'wk'
  }
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes < 60) {
    return `${windowMinutes}m`
  }
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}

/**
 * Status-bar chip label for a rate-limit window.
 *
 * Why: the popup already shows remaining time via formatResetCountdown
 * ("Resets in 2h 33m"). The chip used fixed windowMinutes labels ("5h"),
 * so the same Codex session looked out of sync (#8378). Prefer remaining
 * duration when resetsAt is known; fall back to the fixed window size only
 * when no reset timestamp is available.
 */
export function formatRateLimitWindowChipLabel(
  window: { windowMinutes: number; resetsAt: number | null },
  now: number = Date.now()
): string {
  if (window.resetsAt != null) {
    return formatResetDuration(window.resetsAt - now)
  }
  return formatWindowLabel(window.windowMinutes)
}

/**
 * Shortens rate-limit bucket names for compact status-bar and roster presentation.
 *
 * Why: Full bucket names like "Cursor Models", "Other Models", or "Grok Bot"
 * consume too much horizontal space in the bottom bar alongside the provider icon.
 * Mapping:
 * - "Cursor Models" -> "Internal"
 * - "Other Models"  -> "External"
 * - "Grok Bot"      -> "bot"
 */
export function formatStatusBarBucketName(name: string, provider?: string): string {
  const norm = name.trim().toLowerCase()
  if (
    provider === 'cursor' ||
    norm.startsWith('cursor') ||
    norm === 'other models' ||
    norm === 'grok bot' ||
    norm === 'other model'
  ) {
    if (norm === 'cursor models' || norm === 'cursor model') return 'Internal'
    if (norm === 'other models' || norm === 'other model') return 'External'
    if (norm === 'grok bot' || norm === 'grok') return 'bot'
    if (provider === 'cursor' && name.startsWith('Cursor ')) return name.slice(7)
  }
  if (norm === 'cursor models') return 'Internal'
  if (norm === 'other models') return 'External'
  if (norm === 'grok bot') return 'bot'
  return name
}

