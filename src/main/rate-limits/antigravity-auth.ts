import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type AntigravityAuthSource = 'fleet-override' | 'keyring' | 'cli'

export type AntigravityAuthSession = {
  accessToken?: string
  refreshToken?: string | null
  expiresAtMs?: number | null
  email: string | null
  planTier: string | null
  source: AntigravityAuthSource
  authMethod: string | null
  overridePath?: string | null
}

export type AntigravityAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: AntigravityAuthSession }

export function getFleetGoogleOverridePath(): string {
  const envRuntime = process.env.FLEET_RUNTIME_HOME?.trim()
  if (envRuntime) {
    return join(envRuntime, 'google-usage-override.json')
  }
  return join(homedir(), '.claude', 'fleet', 'google-usage-override.json')
}

type KeyringTokenPayload = {
  token?: {
    access_token?: string
    refresh_token?: string
    expiry?: string
    token_type?: string
  }
  auth_method?: string
}

function parseExpiresAtMs(iso: string | undefined): number | null {
  if (!iso) {
    return null
  }
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

const LINUX_SECRET_QUERY_SCRIPT = `
import json, sys
try:
    import secretstorage
    bus = secretstorage.dbus_init()
    col = secretstorage.get_default_collection(bus)
    for item in col.search_items({"service": "gemini", "username": "antigravity"}):
        sys.stdout.write(item.get_secret().decode())
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
`

export function readKeyringSecret(): string | null {
  if (process.env.ORCA_ANTIGRAVITY_KEYRING_MOCK !== undefined) {
    const customSecret = process.env.ORCA_ANTIGRAVITY_KEYRING_MOCK.trim()
    return customSecret.length > 0 ? customSecret : null
  }

  if (process.platform === 'linux') {
    try {
      const out = execFileSync('python3', ['-c', LINUX_SECRET_QUERY_SCRIPT], {
        encoding: 'utf-8',
        timeout: 2_000,
        windowsHide: true
      }).trim()
      return out.length > 0 ? out : null
    } catch {
      // Fallback: check secret-tool if available
      try {
        const out = execFileSync(
          'secret-tool',
          ['lookup', 'service', 'gemini', 'username', 'antigravity'],
          { encoding: 'utf-8', timeout: 2_000, windowsHide: true }
        ).trim()
        return out.length > 0 ? out : null
      } catch {
        return null
      }
    }
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        { encoding: 'utf-8', timeout: 2_000 }
      ).trim()
      return out.length > 0 ? out : null
    } catch {
      return null
    }
  }

  return null
}

export function isAntigravityTokenFresh(session: AntigravityAuthSession): boolean {
  if (!session.accessToken) {
    return false
  }
  if (!session.expiresAtMs) {
    return true
  }
  return session.expiresAtMs > Date.now() + 60_000
}

export function readAntigravityAuthSession(): AntigravityAuthReadResult {
  const overridePath = getFleetGoogleOverridePath()
  let hasFleetOverride = false
  let fleetPlanTier = 'Google AI Ultra'

  if (existsSync(overridePath)) {
    try {
      const content = JSON.parse(readFileSync(overridePath, 'utf-8')) as Record<string, unknown>
      if (
        content &&
        typeof content === 'object' &&
        ('gemini_7d' in content ||
          'gemini_5h' in content ||
          'frontier_7d' in content ||
          'source' in content)
      ) {
        hasFleetOverride = true
        if (content.source === 'google-ultra') {
          fleetPlanTier = 'Google AI Ultra'
        }
      }
    } catch {
      return { status: 'error', error: 'Antigravity fleet override file is invalid JSON' }
    }
  }

  // Check OS Keyring for live credentials
  let keyringSession: AntigravityAuthSession | null = null
  const rawSecret = readKeyringSecret()
  if (rawSecret) {
    try {
      const parsed = JSON.parse(rawSecret) as KeyringTokenPayload
      const token = parsed.token
      if (token && typeof token.access_token === 'string' && token.access_token.length > 0) {
        keyringSession = {
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          expiresAtMs: parseExpiresAtMs(token.expiry),
          email: null,
          planTier: 'Google AI Ultra',
          source: 'keyring',
          authMethod: parsed.auth_method ?? 'consumer'
        }
      }
    } catch {
      // Keyring secret not JSON or unparseable
    }
  }

  if (keyringSession) {
    return {
      status: 'ok',
      session: {
        ...keyringSession,
        overridePath: hasFleetOverride ? overridePath : null
      }
    }
  }

  if (hasFleetOverride) {
    return {
      status: 'ok',
      session: {
        accessToken: undefined,
        refreshToken: null,
        expiresAtMs: null,
        email: null,
        planTier: fleetPlanTier,
        source: 'fleet-override',
        authMethod: 'consumer',
        overridePath
      }
    }
  }

  return { status: 'missing' }
}
