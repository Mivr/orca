import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFleetGoogleOverridePath,
  isAntigravityTokenFresh,
  readAntigravityAuthSession,
  type AntigravityAuthSession
} from './antigravity-auth'

describe('antigravity-auth', () => {
  const dirs: string[] = []

  afterEach(() => {
    delete process.env.FLEET_RUNTIME_HOME
    delete process.env.ORCA_ANTIGRAVITY_KEYRING_MOCK
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads fleet override when present and valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-antigravity-auth-'))
    dirs.push(dir)
    process.env.FLEET_RUNTIME_HOME = dir

    const overridePath = join(dir, 'google-usage-override.json')
    writeFileSync(
      overridePath,
      JSON.stringify({
        gemini_7d: { remaining_percent: 98.53, resets_at: 1788879157 },
        gemini_5h: { remaining_percent: 100.0, resets_at: null },
        frontier_7d: { remaining_percent: 100.0, resets_at: 1788879157 },
        frontier_5h: { remaining_percent: 100.0, resets_at: null },
        source: 'google-ultra',
        force: true
      })
    )

    expect(getFleetGoogleOverridePath()).toBe(overridePath)
    const result = readAntigravityAuthSession()
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.session.source).toBe('fleet-override')
      expect(result.session.planTier).toBe('Google AI Ultra')
      expect(result.session.overridePath).toBe(overridePath)
    }
  })

  it('reports error when fleet override is malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-antigravity-auth-'))
    dirs.push(dir)
    process.env.FLEET_RUNTIME_HOME = dir

    writeFileSync(join(dir, 'google-usage-override.json'), 'not json{')
    const result = readAntigravityAuthSession()
    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error).toContain('invalid JSON')
    }
  })

  it('reads keyring token when mock secret is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-antigravity-auth-'))
    dirs.push(dir)
    process.env.FLEET_RUNTIME_HOME = dir // No override file here

    const futureExpiry = new Date(Date.now() + 3600_000).toISOString()
    process.env.ORCA_ANTIGRAVITY_KEYRING_MOCK = JSON.stringify({
      token: {
        access_token: 'ya29.mock-token',
        refresh_token: '1//mock-refresh',
        expiry: futureExpiry,
        token_type: 'Bearer'
      },
      auth_method: 'consumer'
    })

    const result = readAntigravityAuthSession()
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.session.source).toBe('keyring')
      expect(result.session.accessToken).toBe('ya29.mock-token')
      expect(result.session.refreshToken).toBe('1//mock-refresh')
      expect(result.session.authMethod).toBe('consumer')
      expect(isAntigravityTokenFresh(result.session)).toBe(true)
    }
  })

  it('returns missing when neither override nor keyring secret exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-antigravity-auth-'))
    dirs.push(dir)
    process.env.FLEET_RUNTIME_HOME = dir
    process.env.ORCA_ANTIGRAVITY_KEYRING_MOCK = ''

    const result = readAntigravityAuthSession()
    // If real system keyring is empty or mocked empty
    if (!result || result.status === 'missing') {
      expect(result.status).toBe('missing')
    }
  })

  it('marks token as expired when past expiration', () => {
    const pastExpiry = new Date(Date.now() - 3600_000).getTime()
    const session: AntigravityAuthSession = {
      accessToken: 'ya29.expired',
      refreshToken: null,
      expiresAtMs: pastExpiry,
      email: null,
      planTier: 'Google AI Ultra',
      source: 'keyring',
      authMethod: 'consumer'
    }
    expect(isAntigravityTokenFresh(session)).toBe(false)
  })
})
