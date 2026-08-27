import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'

const DESKTOP_TOKEN_KEY = 'cursorAuth/accessToken'
const DESKTOP_EMAIL_KEY = 'cursorAuth/cachedEmail'
const DESKTOP_MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const DESKTOP_SUBSCRIPTION_KEY = 'cursorAuth/stripeSubscriptionStatus'
const SQLITE_OPEN_TIMEOUT_MS = 250

export type CursorAuthSource = 'desktop' | 'cli'

export type CursorAuthSession = {
  accessToken: string
  subject: string
  source: CursorAuthSource
  email: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

export type CursorAuthReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; session: CursorAuthSession }

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) {
    return xdg
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
  }
  return join(homedir(), '.config')
}

export function getCursorDesktopStateDbPath(): string {
  return join(configHome(), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

export function getCursorCliAuthPath(): string {
  const override = process.env.CURSOR_CLI_CONFIG?.trim()
  if (override) {
    return join(override, 'auth.json')
  }
  return join(configHome(), 'cursor', 'auth.json')
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) {
    return null
  }
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = '='.repeat((4 - (padded.length % 4)) % 4)
    const json = Buffer.from(padded + pad, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function jwtSubject(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : null
}

// Cookie shape the dashboard usage-summary endpoint authenticates.
export function cursorUsageSummaryCookie(token: string): string | null {
  const sub = jwtSubject(token)
  if (!sub) {
    return null
  }
  return `WorkosCursorSessionToken=${encodeURIComponent(sub)}%3A%3A${token}`
}

function valueAsString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8').trim()
    return text.length > 0 ? text : null
  }
  return null
}

type DesktopProfile = {
  accessToken: string | null
  email: string | null
  membershipType: string | null
  subscriptionStatus: string | null
}

function emptyProfile(): DesktopProfile {
  return { accessToken: null, email: null, membershipType: null, subscriptionStatus: null }
}

function readDesktopProfile(dbPath: string): DesktopProfile {
  // Why: Cursor's state.vscdb is often multi-GB. Never copy it; open read-only
  // in place and fall back to the CLI token if the desktop DB is busy.
  if (!existsSync(dbPath)) {
    return emptyProfile()
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: SQLITE_OPEN_TIMEOUT_MS
    })
    const rows = db
      .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?, ?)')
      .all(
        DESKTOP_TOKEN_KEY,
        DESKTOP_EMAIL_KEY,
        DESKTOP_MEMBERSHIP_KEY,
        DESKTOP_SUBSCRIPTION_KEY
      ) as { key?: unknown; value?: unknown }[]
    const byKey = new Map<string, string>()
    for (const row of rows) {
      if (typeof row.key !== 'string') {
        continue
      }
      const value = valueAsString(row.value)
      if (value) {
        byKey.set(row.key, value)
      }
    }
    return {
      accessToken: byKey.get(DESKTOP_TOKEN_KEY) ?? null,
      email: byKey.get(DESKTOP_EMAIL_KEY) ?? null,
      membershipType: byKey.get(DESKTOP_MEMBERSHIP_KEY) ?? null,
      subscriptionStatus: byKey.get(DESKTOP_SUBSCRIPTION_KEY) ?? null
    }
  } catch {
    return emptyProfile()
  } finally {
    db?.close()
  }
}

function readCliAccessToken(authPath: string): string | null {
  if (!existsSync(authPath)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const token = (parsed as { accessToken?: unknown }).accessToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

function sessionFromToken(
  token: string,
  source: CursorAuthSource,
  profile: Pick<DesktopProfile, 'email' | 'membershipType' | 'subscriptionStatus'>
): CursorAuthSession | null {
  const subject = jwtSubject(token)
  if (!subject) {
    return null
  }
  return {
    accessToken: token,
    subject,
    source,
    email: profile.email,
    membershipType: profile.membershipType,
    subscriptionStatus: profile.subscriptionStatus
  }
}

export function readCursorAuthSession(): CursorAuthReadResult {
  try {
    const profile = readDesktopProfile(getCursorDesktopStateDbPath())
    const desktop = profile.accessToken
      ? sessionFromToken(profile.accessToken, 'desktop', profile)
      : null
    if (desktop) {
      return { status: 'ok', session: desktop }
    }

    const cliToken = readCliAccessToken(getCursorCliAuthPath())
    const cli = cliToken
      ? sessionFromToken(cliToken, 'cli', {
          email: null,
          membershipType: null,
          subscriptionStatus: null
        })
      : null
    if (cli) {
      return { status: 'ok', session: cli }
    }

    return { status: 'missing' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to read Cursor sign-in'
    return { status: 'error', error: message }
  }
}
