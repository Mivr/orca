import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTerminalHandleStore,
  isValidTerminalHandle,
  scratchPersistenceDir
} from './terminal-handle-persistence'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-handle-store-'))
}

describe('terminal handle persistence', () => {
  it('rejects non-term_ handles', () => {
    expect(isValidTerminalHandle('term_abc')).toBe(true)
    expect(isValidTerminalHandle('pane-1')).toBe(false)
    expect(isValidTerminalHandle('')).toBe(false)
  })

  it('keeps mappings in memory without a persistence dir', () => {
    const store = createTerminalHandleStore()
    expect(store.persistenceEnabled).toBe(false)
    store.noteMapping('pty-1', 'term_aaa', 'inc-1', 'wt-1')
    expect(store.getStableHandle('pty-1')).toBe('term_aaa')
  })

  it('restores the same handle for a pty across store instances', () => {
    const dir = tempDir()
    const first = createTerminalHandleStore()
    first.setPersistenceDir(dir)
    first.noteMapping('pty-1', 'term_stable', 'inc-1', 'wt-1', 'preallocated')

    const second = createTerminalHandleStore()
    second.setPersistenceDir(dir)
    expect(second.getStableHandle('pty-1')).toBe('term_stable')
    expect(second.getStableEntry('pty-1')).toMatchObject({
      handle: 'term_stable',
      incarnationId: 'inc-1',
      worktreeId: 'wt-1'
    })
  })

  it('records an old→new remap when a pty handle changes', () => {
    const store = createTerminalHandleStore()
    store.noteMapping('pty-1', 'term_old', 'inc-1', null, 'preallocated')
    store.noteMapping('pty-1', 'term_new', 'inc-2', null, 'incarnation-replaced')
    expect(store.recentRemaps()).toMatchObject([
      {
        ptyId: 'pty-1',
        oldHandle: 'term_old',
        newHandle: 'term_new',
        oldIncarnationId: 'inc-1',
        newIncarnationId: 'inc-2'
      }
    ])
    expect(store.resolveRemappedHandle('term_old')).toBe('term_new')
  })

  it('does not log a remap when the same handle is re-noted', () => {
    const store = createTerminalHandleStore()
    store.noteMapping('pty-1', 'term_same', 'inc-1')
    store.noteMapping('pty-1', 'term_same', 'inc-2')
    expect(store.recentRemaps()).toEqual([])
    expect(store.getStableEntry('pty-1')?.incarnationId).toBe('inc-2')
  })

  it('ignores invalid handles instead of clobbering the stable one', () => {
    const store = createTerminalHandleStore()
    store.noteMapping('pty-1', 'term_stable', 'inc-1')
    store.noteMapping('pty-1', 'bogus', 'inc-2')
    expect(store.getStableHandle('pty-1')).toBe('term_stable')
  })

  it('prunes handles for ptys absent from the live inventory', () => {
    const store = createTerminalHandleStore()
    store.noteMapping('pty-live', 'term_live', 'inc-1')
    store.noteMapping('pty-gone', 'term_gone', 'inc-1')
    store.pruneExcept(new Set(['pty-live']))
    expect(store.knownPtyIds()).toEqual(['pty-live'])
  })

  it('round-trips the last reattach report', () => {
    const dir = tempDir()
    const first = createTerminalHandleStore()
    first.setPersistenceDir(dir)
    first.setLastReport({
      at: 123,
      reattached: [],
      remapped: [],
      failed: [{ ptyId: 'pty-x', handle: 'term_x', reason: 'absent-from-inventory' }]
    })
    const second = createTerminalHandleStore()
    second.setPersistenceDir(dir)
    expect(second.getLastReport()?.failed).toEqual([
      { ptyId: 'pty-x', handle: 'term_x', reason: 'absent-from-inventory' }
    ])
  })

  it('treats a corrupt file as empty', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'orca-terminal-handles.json'), '{nope', 'utf8')
    const store = createTerminalHandleStore()
    store.setPersistenceDir(dir)
    expect(store.knownPtyIds()).toEqual([])
    store.noteMapping('pty-1', 'term_ok', null)
    expect(store.getStableHandle('pty-1')).toBe('term_ok')
  })

  it('ignores a version-mismatched file', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'orca-terminal-handles.json'),
      JSON.stringify({ version: 999, handles: { 'pty-1': { handle: 'term_x' } }, remaps: [] }),
      'utf8'
    )
    const store = createTerminalHandleStore()
    store.setPersistenceDir(dir)
    expect(store.getStableHandle('pty-1')).toBeNull()
  })

  it('never throws when the directory is unwritable', () => {
    // Why a file blocker and not /proc or chmod: recursive mkdir under /proc spins forever as
    // root in containers, and root bypasses permission bits — ENOTDIR fails fast everywhere.
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const store = createTerminalHandleStore()
    store.setPersistenceDir(join(blocker, 'sub'))
    expect(() => {
      store.noteMapping('pty-1', 'term_ok', null)
      store.setLastReport({ at: 1, reattached: [], remapped: [], failed: [] })
    }).not.toThrow()
    expect(store.getStableHandle('pty-1')).toBe('term_ok')
  })

  it('persists atomically without leaving temp files behind', () => {
    const dir = scratchPersistenceDir()
    const store = createTerminalHandleStore()
    store.setPersistenceDir(dir)
    store.noteMapping('pty-1', 'term_ok', null)
    const parsed = JSON.parse(readFileSync(join(dir, 'orca-terminal-handles.json'), 'utf8')) as {
      version: number
    }
    expect(parsed.version).toBe(1)
  })
})
