#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const LOCAL_MAC_CLIENT_UPDATER_LABEL = 'com.mivr.orca.local-mac-client-updater'
export const DEFAULT_UPDATER_INTERVAL_SECONDS = 6 * 60 * 60

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function defaultUpdaterPlistPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${LOCAL_MAC_CLIENT_UPDATER_LABEL}.plist`)
}

export function defaultUpdaterLogPath(home = homedir()) {
  return join(home, 'Library', 'Logs', 'orca-local-mac-client-updater.log')
}

export function renderLocalMacClientUpdaterPlist({
  label = LOCAL_MAC_CLIENT_UPDATER_LABEL,
  nodePath,
  scriptPath,
  repoRoot,
  pathEnv,
  logPath,
  startIntervalSeconds = DEFAULT_UPDATER_INTERVAL_SECONDS
}) {
  if (!nodePath || !scriptPath || !repoRoot || !pathEnv || !logPath) {
    throw new Error('nodePath, scriptPath, repoRoot, pathEnv, and logPath are required')
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${startIntervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`
}

export function installLocalMacClientScheduler({
  home = homedir(),
  nodePath = process.execPath,
  repoRoot = resolve(import.meta.dirname, '../..'),
  pathEnv = process.env.PATH,
  uid = process.getuid?.() ?? 501,
  execFile = execFileSync,
  writeFile = writeFileSync,
  mkdir = mkdirSync
} = {}) {
  const scriptPath = resolve(repoRoot, 'config/scripts/local-mac-client-update.mjs')
  const plistPath = defaultUpdaterPlistPath(home)
  const logPath = defaultUpdaterLogPath(home)
  mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  mkdir(join(home, 'Library', 'Logs'), { recursive: true })
  writeFile(
    plistPath,
    renderLocalMacClientUpdaterPlist({
      nodePath,
      scriptPath,
      repoRoot,
      pathEnv,
      logPath
    }),
    'utf8'
  )
  const domain = `gui/${uid}`
  const target = `${domain}/${LOCAL_MAC_CLIENT_UPDATER_LABEL}`
  try {
    execFile('launchctl', ['bootout', target], { stdio: 'pipe' })
  } catch {
    // Not loaded yet.
  }
  execFile('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' })
  execFile('launchctl', ['enable', target], { stdio: 'inherit' })
  return { plistPath, logPath, label: LOCAL_MAC_CLIENT_UPDATER_LABEL }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const installed = installLocalMacClientScheduler()
  console.log(`[local-mac-client] installed ${installed.label} at ${installed.plistPath}`)
}
