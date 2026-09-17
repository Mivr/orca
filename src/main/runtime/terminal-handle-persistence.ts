import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  TerminalHandleRemap,
  TerminalReattachFailedRow,
  TerminalReattachReport,
  TerminalReattachRow
} from '../../shared/runtime-client-events'

export type {
  TerminalHandleRemap,
  TerminalReattachFailedRow,
  TerminalReattachReport,
  TerminalReattachRow
}

export const TERMINAL_HANDLE_STORE_FILENAME = 'orca-terminal-handles.json'
export const TERMINAL_HANDLE_STORE_VERSION = 1
const MAX_REMAP_ENTRIES = 200
const MAX_HANDLE_ENTRIES = 5000

export type StableTerminalHandleEntry = {
  handle: string
  incarnationId: string | null
  worktreeId: string | null
  updatedAt: number
}

export type TerminalHandleRemapReason =
  | 'incarnation-replaced'
  | 'controller-adopted'
  | 'preallocated'
  | 'handle-replaced'

export function isValidTerminalHandle(handle: string): boolean {
  return handle.startsWith('term_') && handle.length > 6 && handle.length < 128
}

type StoredFile = {
  version: number
  handles: Record<string, StableTerminalHandleEntry>
  remaps: TerminalHandleRemap[]
  lastReport: TerminalReattachReport | null
}

function sanitizeEntry(raw: unknown): StableTerminalHandleEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const entry = raw as Record<string, unknown>
  if (typeof entry.handle !== 'string' || !isValidTerminalHandle(entry.handle)) {
    return null
  }
  return {
    handle: entry.handle,
    incarnationId: typeof entry.incarnationId === 'string' ? entry.incarnationId : null,
    worktreeId: typeof entry.worktreeId === 'string' ? entry.worktreeId : null,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0
  }
}

function sanitizeRemap(raw: unknown): TerminalHandleRemap | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const entry = raw as Record<string, unknown>
  if (
    typeof entry.ptyId !== 'string' ||
    typeof entry.newHandle !== 'string' ||
    !isValidTerminalHandle(entry.newHandle)
  ) {
    return null
  }
  if (
    entry.oldHandle !== null &&
    (typeof entry.oldHandle !== 'string' || !isValidTerminalHandle(entry.oldHandle))
  ) {
    return null
  }
  return {
    ptyId: entry.ptyId,
    oldHandle: entry.oldHandle,
    newHandle: entry.newHandle,
    oldIncarnationId: typeof entry.oldIncarnationId === 'string' ? entry.oldIncarnationId : null,
    newIncarnationId: typeof entry.newIncarnationId === 'string' ? entry.newIncarnationId : null,
    at: typeof entry.at === 'number' ? entry.at : 0,
    reason:
      entry.reason === 'incarnation-replaced' ||
      entry.reason === 'controller-adopted' ||
      entry.reason === 'preallocated'
        ? entry.reason
        : 'handle-replaced'
  }
}

export function createTerminalHandleStore(): TerminalHandleStore {
  return new TerminalHandleStore()
}

export class TerminalHandleStore {
  private dir: string | null = null
  private handles = new Map<string, StableTerminalHandleEntry>()
  private remaps: TerminalHandleRemap[] = []
  private lastReport: TerminalReattachReport | null = null

  setPersistenceDir(dir: string): void {
    this.dir = dir
    this.load()
  }

  get persistenceEnabled(): boolean {
    return this.dir !== null
  }

  getStableHandle(ptyId: string): string | null {
    return this.handles.get(ptyId)?.handle ?? null
  }

  getStableEntry(ptyId: string): StableTerminalHandleEntry | null {
    return this.handles.get(ptyId) ?? null
  }

  knownPtyIds(): string[] {
    return [...this.handles.keys()]
  }

  noteMapping(
    ptyId: string,
    handle: string,
    incarnationId: string | null = null,
    worktreeId: string | null = null,
    reason: TerminalHandleRemapReason = 'handle-replaced'
  ): void {
    if (!isValidTerminalHandle(handle)) {
      return
    }
    const previous = this.handles.get(ptyId)
    if (previous?.handle === handle) {
      if (
        (incarnationId !== null && previous.incarnationId !== incarnationId) ||
        (worktreeId !== null && previous.worktreeId !== worktreeId)
      ) {
        this.handles.set(ptyId, {
          handle,
          incarnationId: incarnationId ?? previous.incarnationId,
          worktreeId: worktreeId ?? previous.worktreeId,
          updatedAt: Date.now()
        })
        this.save()
      }
      return
    }
    if (previous) {
      this.remaps.push({
        ptyId,
        oldHandle: previous.handle,
        newHandle: handle,
        oldIncarnationId: previous.incarnationId,
        newIncarnationId: incarnationId,
        at: Date.now(),
        reason
      })
      while (this.remaps.length > MAX_REMAP_ENTRIES) {
        this.remaps.shift()
      }
    }
    this.handles.set(ptyId, {
      handle,
      incarnationId,
      worktreeId,
      updatedAt: Date.now()
    })
    while (this.handles.size > MAX_HANDLE_ENTRIES) {
      const oldest = this.handles.keys().next().value as string | undefined
      if (oldest === undefined) {
        break
      }
      this.handles.delete(oldest)
    }
    this.save()
  }

  forgetPty(ptyId: string): void {
    if (this.handles.delete(ptyId)) {
      this.save()
    }
  }

  pruneExcept(livePtyIds: ReadonlySet<string> | readonly string[]): void {
    const live = new Set(livePtyIds)
    let changed = false
    for (const ptyId of this.handles.keys()) {
      if (!live.has(ptyId)) {
        this.handles.delete(ptyId)
        changed = true
      }
    }
    if (changed) {
      this.save()
    }
  }

  recentRemaps(limit = 50): TerminalHandleRemap[] {
    return this.remaps.slice(-Math.max(1, limit))
  }

  resolveRemappedHandle(oldHandle: string): string | null {
    for (let index = this.remaps.length - 1; index >= 0; index -= 1) {
      const remap = this.remaps[index]
      if (remap.oldHandle === oldHandle) {
        return remap.newHandle
      }
    }
    return null
  }

  setLastReport(report: TerminalReattachReport): void {
    this.lastReport = report
    this.save()
  }

  getLastReport(): TerminalReattachReport | null {
    return this.lastReport
  }

  snapshot(): {
    handles: Record<string, StableTerminalHandleEntry>
    remaps: TerminalHandleRemap[]
  } {
    return {
      handles: Object.fromEntries(this.handles),
      remaps: [...this.remaps]
    }
  }

  private filePath(): string | null {
    return this.dir ? join(this.dir, TERMINAL_HANDLE_STORE_FILENAME) : null
  }

  private load(): void {
    const path = this.filePath()
    if (!path) {
      return
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') {
        return
      }
      const file = raw as Partial<StoredFile>
      if (file.version !== TERMINAL_HANDLE_STORE_VERSION) {
        return
      }
      if (file.handles && typeof file.handles === 'object') {
        for (const [ptyId, entry] of Object.entries(file.handles)) {
          const clean = sanitizeEntry(entry)
          if (clean) {
            this.handles.set(ptyId, clean)
          }
        }
      }
      if (Array.isArray(file.remaps)) {
        for (const remap of file.remaps) {
          const clean = sanitizeRemap(remap)
          if (clean) {
            this.remaps.push(clean)
          }
        }
        this.remaps = this.remaps.slice(-MAX_REMAP_ENTRIES)
      }
      if (file.lastReport && typeof file.lastReport === 'object') {
        this.lastReport = file.lastReport as TerminalReattachReport
      }
    } catch {
      // Corrupt or missing file reads as empty; the live inventory rebuilds it.
    }
  }

  private save(): void {
    const path = this.filePath()
    if (!path) {
      return
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = join(
        dirname(path),
        `.${TERMINAL_HANDLE_STORE_FILENAME}.${process.pid}.${randomUUID()}.tmp`
      )
      const file: StoredFile = {
        version: TERMINAL_HANDLE_STORE_VERSION,
        handles: Object.fromEntries(this.handles),
        remaps: this.remaps,
        lastReport: this.lastReport
      }
      writeFileSync(tmp, JSON.stringify(file), 'utf8')
      renameSync(tmp, path)
    } catch {
      // Persistence is best-effort; the in-memory map still serves this boot.
    }
  }
}

export function scratchPersistenceDir(prefix = 'orca-terminal-handles-'): string {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
