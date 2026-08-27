import { describe, expect, it } from 'vitest'
import { diagnoseConnection } from './connection-diagnostics-analysis'
import type { ConnectionLogEntry } from '../transport/types'

function event(message: string, detail?: string): ConnectionLogEntry {
  return { id: message, ts: 1, level: 'error', message, detail }
}

describe('diagnoseConnection', () => {
  it('reports the current healthy path instead of a historical failure', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'connected',
        activePath: 'relay',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'Connection is healthy via Relay.',
      nextStep: 'No action needed.'
    })
  })

  it('distinguishes an invalid Relay credential from a transient outage', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        pendingPath: 'relay',
        entries: [event('Relay: relay dial failed', 'relay director resolve failed (401)')]
      })
    ).toEqual({
      likelyCause: 'Relay rejected the saved resume credential.',
      nextStep: 'Try a direct connection; if Relay keeps returning 401, pair this device again.'
    })
  })

  it('identifies the direct Tailscale timeout while Relay recovery is pending', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://100.88.90.25:6768',
        state: 'reconnecting',
        activePath: 'tailscale',
        pendingPath: 'relay',
        entries: [event('WebSocket connect timeout')]
      })
    ).toEqual({
      likelyCause: 'The saved Tailscale endpoint did not answer before the connection timeout.',
      nextStep: 'Relay recovery is in progress; keep Orca open while it retries.'
    })
  })

  it('identifies an authenticated Relay liveness failure', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Relay health check failed'),
            code: 'liveness-timeout',
            path: 'relay'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'Relay stopped answering authenticated health checks.',
      nextStep: 'Orca closed the stale session and started recovery.'
    })
  })

  it('separates an active Relay close from a failed Relay dial', () => {
    expect(
      diagnoseConnection({
        endpoint: 'ws://192.168.1.2:6768',
        state: 'reconnecting',
        activePath: 'relay',
        entries: [
          {
            ...event('Relay: active relay session failed', 'RelayOuterError: close code 4408'),
            code: 'relay-session-failed',
            path: 'relay'
          }
        ]
      })
    ).toEqual({
      likelyCause: 'The active Relay session closed unexpectedly.',
      nextStep: 'Orca started Relay recovery; the event history includes the cell close reason.'
    })
  })
})
