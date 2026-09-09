import { useAppStore } from '../../store'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import {
  isAntigravityStatusBarAvailable,
  isCursorStatusBarAvailable
} from './status-bar-provider-visibility'

/** Filters CLI toggles by detection, Cursor by credential or usage state, and Antigravity by auth or detection. */
export function useAvailableStatusBarToggles<T extends { id: StatusBarItem }>(
  toggles: readonly T[]
): T[] {
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const cursor = useAppStore((s) => s.rateLimits.cursor)
  const cursorAuthConfigured = useAppStore((s) => s.rateLimits.cursorAuthConfigured)
  const antigravity = useAppStore((s) => s.rateLimits.antigravity)
  const antigravityAuthConfigured = useAppStore((s) => s.rateLimits.antigravityAuthConfigured)
  return toggles.filter((toggle) => {
    if (toggle.id === 'cursor') {
      return isCursorStatusBarAvailable(cursor, cursorAuthConfigured)
    }
    if (toggle.id === 'antigravity') {
      return (
        antigravityAuthConfigured ||
        isAntigravityStatusBarAvailable(antigravity, antigravityAuthConfigured) ||
        isStatusBarItemAvailable(toggle.id, detectedAgentIds)
      )
    }
    return isStatusBarItemAvailable(toggle.id, detectedAgentIds)
  })
}
