import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SESSION_HANDLERS,
  buildSessionSnapshot,
  diffSessionSnapshot,
  type SessionSnapshotFile
} from './sessions'
import { sandboxContainerName } from '../../main/sandbox/sandbox-config'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary,
  RuntimeWorktreePsResult
} from '../../shared/runtime-types'

const WORKTREE_ID = 'repo::/work/cutover7-agy'

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_66d57a08',
    ptyId: 'repo::/work/cutover7-agy@@8dad5a1d',
    incarnationId: 'inc-old',
    worktreeId: WORKTREE_ID,
    worktreePath: '/work/cutover7-agy',
    branch: 'main',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'agy',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    processId: 14,
    ...overrides
  }
}

function psEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktreeId: WORKTREE_ID,
    path: '/work/cutover7-agy',
    branch: 'main',
    sandbox: 'running',
    ...overrides
  }
}

function fakeClient(
  terminals: RuntimeTerminalListResult,
  ps: RuntimeWorktreePsResult
): {
  client: { call: ReturnType<typeof vi.fn> }
  calls: string[]
} {
  const calls: string[] = []
  const client = {
    call: vi.fn(async (method: string) => {
      calls.push(method)
      if (method === 'terminal.list') {
        return { result: terminals }
      }
      if (method === 'worktree.ps') {
        return { result: ps }
      }
      throw new Error(`unexpected rpc: ${method}`)
    })
  }
  return { client, calls }
}

const listResult = (terminals: RuntimeTerminalSummary[]): RuntimeTerminalListResult => ({
  terminals,
  totalCount: terminals.length,
  truncated: false
})
const psResult = (entries: Record<string, unknown>[]): RuntimeWorktreePsResult =>
  ({ worktrees: entries, totalCount: entries.length, truncated: false }) as RuntimeWorktreePsResult

describe('sessions snapshot', () => {
  it('joins terminal rows with sandbox containers', () => {
    const snapshot = buildSessionSnapshot(listResult([terminal()]), psResult([psEntry()]))
    expect(snapshot.rows).toEqual([
      {
        worktreeId: WORKTREE_ID,
        worktreePath: '/work/cutover7-agy',
        handle: 'term_66d57a08',
        ptyId: 'repo::/work/cutover7-agy@@8dad5a1d',
        incarnationId: 'inc-old',
        sandbox: 'running',
        container: sandboxContainerName(WORKTREE_ID),
        processId: 14
      }
    ])
  })

  it('leaves container null for non-sandboxed worktrees', () => {
    const snapshot = buildSessionSnapshot(
      listResult([terminal()]),
      psResult([psEntry({ sandbox: 'absent' })])
    )
    expect(snapshot.rows[0]?.container).toBeNull()
    expect(snapshot.rows[0]?.sandbox).toBe('absent')
  })

  it('writes the snapshot file and only calls read endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sessions-'))
    const file = join(dir, 'before.json')
    const { client, calls } = fakeClient(listResult([terminal()]), psResult([psEntry()]))
    const logged: string[] = []
    const originalLog = console.log
    console.log = (message: string): void => {
      logged.push(message)
    }
    try {
      await SESSION_HANDLERS['sessions snapshot']({
        flags: new Map([['file', file]]),
        client: client as never,
        cwd: '/tmp',
        json: false
      })
    } finally {
      console.log = originalLog
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SessionSnapshotFile
    expect(parsed.version).toBe(1)
    expect(parsed.rows).toHaveLength(1)
    // Read-only witness: no create/kill/reap RPC may fire during capture.
    expect(calls).toEqual(['terminal.list', 'worktree.ps'])
    expect(logged.join('\n')).toContain(file)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('sessions verify', () => {
  function snapshot(): SessionSnapshotFile {
    return {
      version: 1,
      takenAt: 1000,
      rows: [
        {
          worktreeId: WORKTREE_ID,
          worktreePath: '/work/cutover7-agy',
          handle: 'term_66d57a08',
          ptyId: 'repo::/work/cutover7-agy@@8dad5a1d',
          incarnationId: 'inc-old',
          sandbox: 'running',
          container: sandboxContainerName(WORKTREE_ID),
          processId: 14
        }
      ]
    }
  }

  it('reports ok for an unchanged row', () => {
    const live: SessionSnapshotFile = { version: 1, takenAt: 2000, rows: [...snapshot().rows] }
    const result = diffSessionSnapshot(snapshot(), live)
    expect(result.summary).toMatchObject({ ok: 1, missing: 0 })
    expect(result.rows[0]?.status).toBe('ok')
  })

  it('reports reattached for same handle with a new incarnation/pid', () => {
    const rows = snapshot().rows.map((row) => ({
      ...row,
      incarnationId: 'inc-new',
      processId: 57
    }))
    const result = diffSessionSnapshot(snapshot(), { version: 1, takenAt: 2000, rows })
    expect(result.rows[0]?.status).toBe('reattached')
    expect(result.summary.reattached).toBe(1)
  })

  it('reports remapped with the replacement handle', () => {
    const rows = snapshot().rows.map((row) => ({ ...row, handle: 'term_39f51a92' }))
    const result = diffSessionSnapshot(snapshot(), { version: 1, takenAt: 2000, rows })
    expect(result.rows[0]).toMatchObject({
      status: 'remapped',
      handle: 'term_66d57a08',
      resolvedHandle: 'term_39f51a92'
    })
  })

  it('reports missing rows and new rows', () => {
    const result = diffSessionSnapshot(snapshot(), { version: 1, takenAt: 2000, rows: [] })
    expect(result.rows[0]?.status).toBe('missing')
    expect(result.summary.missing).toBe(1)
  })

  it('fails the command when snapshot rows are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sessions-'))
    const file = join(dir, 'before.json')
    writeFileSync(file, JSON.stringify(snapshot()), 'utf8')
    const { client, calls } = fakeClient(listResult([]), psResult([]))
    const logged: string[] = []
    const originalLog = console.log
    console.log = (message: string): void => {
      logged.push(message)
    }
    let code: string | null = null
    try {
      await SESSION_HANDLERS['sessions verify']({
        flags: new Map([['file', file]]),
        client: client as never,
        cwd: '/tmp',
        json: false
      })
    } catch (error) {
      code = (error as { code?: string }).code ?? null
    } finally {
      console.log = originalLog
    }
    expect(code).toBe('sessions_verify_mismatch')
    expect(calls).toEqual(['terminal.list', 'worktree.ps'])
    expect(logged.join('\n')).toContain('[missing]')
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes verify when the session reattached under the same handle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sessions-'))
    const file = join(dir, 'before.json')
    writeFileSync(file, JSON.stringify(snapshot()), 'utf8')
    const { client } = fakeClient(
      listResult([terminal({ incarnationId: 'inc-new', processId: 57 })]),
      psResult([psEntry()])
    )
    const logged: string[] = []
    const originalLog = console.log
    console.log = (message: string): void => {
      logged.push(message)
    }
    try {
      await SESSION_HANDLERS['sessions verify']({
        flags: new Map([['file', file]]),
        client: client as never,
        cwd: '/tmp',
        json: false
      })
    } finally {
      console.log = originalLog
    }
    expect(logged.join('\n')).toContain('[reattached]')
    rmSync(dir, { recursive: true, force: true })
  })
})
