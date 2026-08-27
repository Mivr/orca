import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from '../transport/types'
import { ConnectionLog } from './ConnectionLog'

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

const entries: ConnectionLogEntry[] = [
  { id: 'event-1', ts: 1, level: 'info', message: 'Opening WebSocket' }
]

describe('ConnectionLog', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function renderLog(fillAvailableHeight = false): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(ConnectionLog, { entries, fillAvailableHeight }))
    })
    return renderer as unknown as ReactTestRenderer
  }

  it('keeps the compact height in pairing flows', () => {
    const instance = renderLog()
    const containerStyles = instance.root.findAllByType('View')[0]!.props.style

    expect(containerStyles).toContainEqual({ maxHeight: 240 })
  })

  it('fills the available diagnostics viewport', () => {
    const instance = renderLog(true)
    const containerStyles = instance.root.findAllByType('View')[0]!.props.style
    const scroll = instance.root.findByType('ScrollView')

    expect(containerStyles).toContainEqual({ flex: 1 })
    expect(scroll.props.style).toEqual({ flex: 1 })
  })
})
