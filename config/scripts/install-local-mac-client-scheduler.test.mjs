import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_UPDATER_INTERVAL_SECONDS,
  LOCAL_MAC_CLIENT_UPDATER_LABEL,
  installLocalMacClientScheduler,
  renderLocalMacClientUpdaterPlist
} from './install-local-mac-client-scheduler.mjs'

describe('renderLocalMacClientUpdaterPlist', () => {
  it('renders a launchd job that runs the shipped updater on an interval', () => {
    const plist = renderLocalMacClientUpdaterPlist({
      nodePath: '/opt/node24/bin/node',
      scriptPath: '/repo/config/scripts/local-mac-client-update.mjs',
      repoRoot: '/repo',
      pathEnv: '/opt/node24/bin:/usr/bin',
      logPath: '/tmp/orca-local-mac-client-updater.log'
    })
    expect(plist).toContain(`<string>${LOCAL_MAC_CLIENT_UPDATER_LABEL}</string>`)
    expect(plist).toContain('<string>/opt/node24/bin/node</string>')
    expect(plist).toContain('<string>/repo/config/scripts/local-mac-client-update.mjs</string>')
    expect(plist).toContain('<string>/repo</string>')
    expect(plist).toContain(`<integer>${DEFAULT_UPDATER_INTERVAL_SECONDS}</integer>`)
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist.includes('&amp;')).toBe(false)
  })

  it('escapes XML special characters in paths', () => {
    const plist = renderLocalMacClientUpdaterPlist({
      nodePath: '/opt/node/bin/node',
      scriptPath: '/repo/a&b.mjs',
      repoRoot: '/repo/<orca>',
      pathEnv: '/bin',
      logPath: '/tmp/log'
    })
    expect(plist).toContain('/repo/a&amp;b.mjs')
    expect(plist).toContain('/repo/&lt;orca&gt;')
  })
})

describe('installLocalMacClientScheduler', () => {
  it('writes the plist and bootstraps the shipped launchd label', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-local-mac-scheduler-'))
    const execFile = vi.fn()
    const result = installLocalMacClientScheduler({
      home,
      nodePath: '/opt/node24/bin/node',
      repoRoot: '/repo',
      pathEnv: '/opt/node24/bin:/usr/bin',
      uid: 501,
      execFile
    })
    const written = readFileSync(result.plistPath, 'utf8')
    expect(written).toContain(LOCAL_MAC_CLIENT_UPDATER_LABEL)
    expect(written).toContain('/repo/config/scripts/local-mac-client-update.mjs')
    expect(execFile).toHaveBeenCalledWith(
      'launchctl',
      ['bootstrap', 'gui/501', result.plistPath],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(execFile).toHaveBeenCalledWith(
      'launchctl',
      ['enable', `gui/501/${LOCAL_MAC_CLIENT_UPDATER_LABEL}`],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })
})
