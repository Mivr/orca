import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  cursorUsageSummaryCookie,
  getCursorDesktopStateDbPath,
  jwtSubject,
  readCursorAuthSession
} from './cursor-auth'

function mintJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

describe('cursor-auth', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds the dashboard cookie from the JWT subject', () => {
    const token = mintJwt('auth0|user-1')
    expect(jwtSubject(token)).toBe('auth0|user-1')
    expect(cursorUsageSummaryCookie(token)).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent('auth0|user-1')}%3A%3A${token}`
    )
  })

  it('reads a desktop vscdb token without copying the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-auth-'))
    dirs.push(dir)
    const dbPath = join(dir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(join(dir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    const token = mintJwt('auth0|desktop')
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    insert.run('cursorAuth/accessToken', token)
    insert.run('cursorAuth/cachedEmail', 'dev@example.com')
    insert.run('cursorAuth/stripeMembershipType', 'ultra')
    insert.run('cursorAuth/stripeSubscriptionStatus', 'active')
    db.close()

    const previousConfig = process.env.XDG_CONFIG_HOME
    const previousCli = process.env.CURSOR_CLI_CONFIG
    process.env.XDG_CONFIG_HOME = dir
    process.env.CURSOR_CLI_CONFIG = join(dir, 'no-cli')
    try {
      expect(getCursorDesktopStateDbPath()).toBe(dbPath)
      expect(readCursorAuthSession()).toEqual({
        status: 'ok',
        session: {
          accessToken: token,
          subject: 'auth0|desktop',
          source: 'desktop',
          email: 'dev@example.com',
          membershipType: 'ultra',
          subscriptionStatus: 'active'
        }
      })
    } finally {
      if (previousConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfig
      }
      if (previousCli === undefined) {
        delete process.env.CURSOR_CLI_CONFIG
      } else {
        process.env.CURSOR_CLI_CONFIG = previousCli
      }
    }
  })

  it('returns missing when neither desktop nor CLI auth exists in the temp override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-missing-'))
    dirs.push(dir)
    const previousConfig = process.env.XDG_CONFIG_HOME
    const previousCli = process.env.CURSOR_CLI_CONFIG
    process.env.XDG_CONFIG_HOME = dir
    delete process.env.CURSOR_CLI_CONFIG
    try {
      expect(readCursorAuthSession().status).toBe('missing')
    } finally {
      if (previousConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfig
      }
      if (previousCli === undefined) {
        delete process.env.CURSOR_CLI_CONFIG
      } else {
        process.env.CURSOR_CLI_CONFIG = previousCli
      }
    }
  })

  it('falls back to CLI auth.json when the desktop DB is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-cli-'))
    dirs.push(dir)
    const token = mintJwt('auth0|cli')
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ accessToken: token }))
    const previousConfig = process.env.XDG_CONFIG_HOME
    const previousCli = process.env.CURSOR_CLI_CONFIG
    process.env.XDG_CONFIG_HOME = join(dir, 'no-desktop')
    process.env.CURSOR_CLI_CONFIG = dir
    try {
      const result = readCursorAuthSession()
      expect(result).toEqual({
        status: 'ok',
        session: {
          accessToken: token,
          subject: 'auth0|cli',
          source: 'cli',
          email: null,
          membershipType: null,
          subscriptionStatus: null
        }
      })
    } finally {
      if (previousConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousConfig
      }
      if (previousCli === undefined) {
        delete process.env.CURSOR_CLI_CONFIG
      } else {
        process.env.CURSOR_CLI_CONFIG = previousCli
      }
    }
  })
})
