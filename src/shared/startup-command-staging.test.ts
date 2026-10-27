import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STAGED_STARTUP_COMMAND_STALE_MS,
  discardStagedStartupCommand,
  stageStartupCommand,
  sweepStaleStagedStartupCommands
} from './startup-command-staging'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-staging-test-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function stage(command: string, shellPath = '/bin/zsh', platform: NodeJS.Platform = 'darwin') {
  return stageStartupCommand({ command, shellPath, platform, directory })
}

describe('stageStartupCommand', () => {
  it('writes a 0600 script whose body is exactly the command, and types a sourcing line', () => {
    const command = `claude '${'x'.repeat(600)}'`
    const staged = stage(`${command}\n`)
    expect(staged.delivery).toBe('staged')
    expect(staged.scriptPath).toBeDefined()
    const scriptPath = staged.scriptPath!
    expect(staged.command).toBe(`. '${scriptPath}'`)
    expect(statSync(scriptPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(scriptPath, 'utf8')).toBe(`command rm -f -- '${scriptPath}'\n${command}\n`)
  })

  it('types the full command and says so when the script cannot be written', () => {
    const command = 'a'.repeat(600)
    const staged = stageStartupCommand({
      command,
      shellPath: '/bin/bash',
      platform: 'linux',
      directory: join(directory, 'missing')
    })
    expect(staged.command).toBe(command)
    expect(staged.delivery).toBe('typed-after-stage-failed')
    expect(staged.failure).toMatch(/ENOENT/)
    expect(staged.scriptPath).toBeUndefined()
  })
})

describe('discardStagedStartupCommand', () => {
  it('removes a script the shell never sourced', () => {
    const staged = stage('a'.repeat(600))
    discardStagedStartupCommand(staged)
    expect(readdirSync(directory)).toEqual([])
  })
})

describe('sweepStaleStagedStartupCommands', () => {
  it('removes only staged scripts older than an hour', () => {
    const now = Date.now()
    const stale = join(directory, 'orca-launch-aaaa.sh')
    const fresh = join(directory, 'orca-launch-bbbb.sh')
    const unrelated = join(directory, 'something-else.sh')
    for (const path of [stale, fresh, unrelated]) {
      writeFileSync(path, '')
    }
    const staleSeconds = (now - STAGED_STARTUP_COMMAND_STALE_MS - 1000) / 1000
    utimesSync(stale, staleSeconds, staleSeconds)
    utimesSync(unrelated, staleSeconds, staleSeconds)
    sweepStaleStagedStartupCommands({ directory, now })
    expect(readdirSync(directory).sort()).toEqual(['orca-launch-bbbb.sh', 'something-else.sh'])
  })
})

describe('sandboxed inner-shell startup staging', () => {
  it('types a 300-byte line containing single quotes directly when given the inner bash shell', () => {
    const launchStaging = join(directory, 'launch-staging')
    const line = `claude --model haiku 'it's ${'a'.repeat(270)}'`
    expect(Buffer.byteLength(line)).toBeGreaterThanOrEqual(295)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512)
    const staged = stageStartupCommand({
      command: line,
      shellPath: 'bash',
      orcaBuiltLine: true,
      platform: 'linux',
      directory: launchStaging
    })
    expect(staged).toEqual({ command: line, delivery: 'typed' })
  })

  it('stages a 700-byte line into launch-staging and sources it with dot for inner bash', () => {
    const launchStaging = join(directory, 'launch-staging')
    mkdirSync(launchStaging, { mode: 0o700 })
    const line = `claude --model haiku '${'p'.repeat(700)}'`
    const staged = stageStartupCommand({
      command: line,
      shellPath: 'bash',
      orcaBuiltLine: true,
      platform: 'linux',
      directory: launchStaging
    })
    expect(staged.delivery).toBe('staged')
    expect(staged.scriptPath?.startsWith(`${launchStaging}/orca-launch-`)).toBe(true)
    expect(staged.command).toBe(`. '${staged.scriptPath}'`)
  })
})
