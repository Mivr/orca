import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import {
  discoverActivePtyId as discoverActivePtyIdImpl,
  waitForActivePaneHookDescriptor as waitForActivePaneHookDescriptorImpl
} from './terminal-active-pane'
import {
  closeActiveTerminalPane as closeActiveTerminalPaneImpl,
  countVisibleTerminalPanes as countVisibleTerminalPanesImpl,
  execInTerminal as execInTerminalImpl,
  focusLastTerminalPane as focusLastTerminalPaneImpl,
  moveTerminalPaneByLeafId as moveTerminalPaneByLeafIdImpl,
  readTerminalPaneDomLeafOrder as readTerminalPaneDomLeafOrderImpl,
  sendToTerminal as sendToTerminalImpl,
  splitActiveTerminalPane as splitActiveTerminalPaneImpl,
  waitForActiveTerminalManager as waitForActiveTerminalManagerImpl,
  waitForPaneCount as waitForPaneCountImpl,
  waitForTerminalOutput as waitForTerminalOutputImpl
} from './terminal-pane-operations'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type PaneIdentitySnapshot = {
  tabId: string
  activeLeafId: string | null
  panes: {
    numericPaneId: number
    leafId: string
    stablePaneId: string
    datasetLeafId: string | null
    ptyId: string | null
  }[]
  ptyIdsByLeafId: Record<string, string>
}

export type ActivePaneHookDescriptor = {
  paneKey: string
  worktreeId: string
}

// Why: typing-latency specs must type into xterm's helper textarea, not the
// page body — keyboard.type only reaches the PTY when that textarea has focus.
export async function focusActiveTerminalInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('No active terminal pane to focus')
    }
    state?.setActiveTab(tabId)
    state?.setActiveTabType('terminal')
    pane.terminal.focus()
    const textarea = pane.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!textarea) {
      throw new Error('Active terminal has no xterm helper textarea')
    }
    textarea.focus()
  })
}

// Why: worktree restoration can render the terminal surface before the legacy
// global activeTabId settles. Prefer the active worktree's saved terminal tab
// pointer, then fall back to the first terminal tab.
async function resolveActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return null
    }
    const state = store.getState()
    const wId = state.activeWorktreeId
    if (!wId) {
      return null
    }
    const tabs = state.tabsByWorktree[wId] ?? []
    if (tabs.length === 0) {
      return null
    }
    const pref =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[wId] ?? null)
    if (pref && tabs.some((t) => t.id === pref)) {
      return pref
    }
    return tabs[0]?.id ?? null
  })
}

// Why: reads the buffer through the SerializeAddon that the PaneManager
// already loads for every terminal pane (exposed via VITE_EXPOSE_STORE).
export async function getTerminalContent(page: Page, charLimit = 4000): Promise<string> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return ''
  }
  return page.evaluate(
    ({ tabId, charLimit }) => {
      const paneManagers = window.__paneManagers
      if (!paneManagers) {
        return ''
      }

      const manager = paneManagers.get(tabId)
      if (!manager) {
        return ''
      }

      const activePane = manager.getActivePane?.()
      if (!activePane) {
        const panes = manager.getPanes?.() ?? []
        if (panes.length === 0) {
          return ''
        }
        const text = panes[0].serializeAddon?.serialize?.() ?? ''
        return text.slice(-charLimit)
      }

      const text = activePane.serializeAddon?.serialize?.() ?? ''
      return text.slice(-charLimit)
    },
    { tabId, charLimit }
  )
}

export async function waitForActivePanePtyId(page: Page, timeoutMs = 15_000): Promise<string> {
  let resolvedPtyId: string | null = null
  await expect
    .poll(
      async () => {
        const tabId = await resolveActiveTabId(page)
        if (!tabId) {
          return null
        }

        resolvedPtyId = await page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return activePane?.container?.dataset?.ptyId ?? null
        }, tabId)
        return resolvedPtyId
      },
      {
        timeout: timeoutMs,
        message: 'Active terminal pane did not receive a PTY binding'
      }
    )
    .not.toBeNull()

  if (!resolvedPtyId) {
    throw new Error('waitForActivePanePtyId: active pane has no PTY binding')
  }
  return resolvedPtyId
}

export async function readPaneIdentitySnapshot(page: Page): Promise<PaneIdentitySnapshot | null> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return null
  }

  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const store = window.__store
    if (!manager || !store) {
      return null
    }

    const activePane = manager.getActivePane?.() ?? null
    return {
      tabId,
      activeLeafId: activePane?.leafId ?? null,
      panes: manager.getPanes().map((pane) => ({
        numericPaneId: pane.id,
        leafId: pane.leafId,
        stablePaneId: pane.stablePaneId,
        datasetLeafId: pane.container.dataset.leafId ?? null,
        ptyId: pane.container.dataset.ptyId ?? null
      })),
      ptyIdsByLeafId: store.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
    }
  }, tabId)
}

export async function waitForPaneIdentitySnapshot(
  page: Page,
  paneCount: number
): Promise<PaneIdentitySnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPaneIdentitySnapshot(page)
        return Boolean(
          snapshot &&
          snapshot.panes.length === paneCount &&
          snapshot.panes.every(
            (pane) =>
              UUID_RE.test(pane.leafId) &&
              pane.stablePaneId === pane.leafId &&
              pane.datasetLeafId === pane.leafId &&
              pane.ptyId !== null &&
              snapshot.ptyIdsByLeafId[pane.leafId] === pane.ptyId
          )
        )
      },
      {
        timeout: 15_000,
        message: 'Split terminal panes did not settle with UUID leaf-keyed PTY bindings'
      }
    )
    .toBe(true)

  const snapshot = await readPaneIdentitySnapshot(page)
  if (!snapshot) {
    throw new Error('Pane identity snapshot disappeared after settling')
  }
  return snapshot
}

export function waitForActivePaneHookDescriptor(
  page: Page,
  timeoutMs = 15_000
): Promise<ActivePaneHookDescriptor> {
  return waitForActivePaneHookDescriptorImpl(page, timeoutMs)
}

export function discoverActivePtyId(page: Page): Promise<string> {
  return discoverActivePtyIdImpl(page)
}

export function readTerminalPaneDomLeafOrder(page: Page): Promise<string[]> {
  return readTerminalPaneDomLeafOrderImpl(page)
}

export function moveTerminalPaneByLeafId(
  page: Page,
  sourceLeafId: string,
  targetLeafId: string,
  zone: 'top' | 'bottom' | 'left' | 'right'
): Promise<void> {
  return moveTerminalPaneByLeafIdImpl(page, sourceLeafId, targetLeafId, zone)
}

export function sendToTerminal(page: Page, ptyId: string, text: string): Promise<void> {
  return sendToTerminalImpl(page, ptyId, text)
}

export function execInTerminal(page: Page, ptyId: string, command: string): Promise<void> {
  return execInTerminalImpl(page, ptyId, command)
}

export function waitForActiveTerminalManager(page: Page, timeoutMs = 30_000): Promise<void> {
  return waitForActiveTerminalManagerImpl(page, timeoutMs)
}

export function splitActiveTerminalPane(
  page: Page,
  direction: 'vertical' | 'horizontal'
): Promise<void> {
  return splitActiveTerminalPaneImpl(page, direction)
}

export function closeActiveTerminalPane(page: Page): Promise<void> {
  return closeActiveTerminalPaneImpl(page)
}

export function focusLastTerminalPane(page: Page): Promise<void> {
  return focusLastTerminalPaneImpl(page)
}

export function countVisibleTerminalPanes(page: Page): Promise<number> {
  return countVisibleTerminalPanesImpl(page)
}

export function waitForTerminalOutput(
  page: Page,
  expected: string,
  timeoutMs = 10_000,
  charLimit = 4000
): Promise<void> {
  return waitForTerminalOutputImpl(page, expected, timeoutMs, charLimit)
}

export function waitForPaneCount(
  page: Page,
  expectedCount: number,
  timeoutMs = 10_000
): Promise<void> {
  return waitForPaneCountImpl(page, expectedCount, timeoutMs)
}
