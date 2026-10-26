import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeTerminalListResult, RuntimeWorktreePsResult } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { sandboxContainerName } from '../../main/sandbox/sandbox-config'

export const SESSION_SNAPSHOT_VERSION = 1

export type SessionSnapshotRow = {
  worktreeId: string
  worktreePath: string
  handle: string
  ptyId: string | null
  incarnationId: string | null
  sandbox: 'running' | 'absent'
  container: string | null
  processId: number | null
}

export type SessionSnapshotFile = {
  version: number
  takenAt: number
  rows: SessionSnapshotRow[]
}

export type SessionVerifyStatus =
  | 'ok'
  | 'reattached'
  | 'remapped'
  | 'container-changed'
  | 'missing'
  | 'new'

export type SessionVerifyRow = {
  status: SessionVerifyStatus
  worktreeId: string
  handle: string
  resolvedHandle?: string
  ptyId: string | null
  detail: string
}

export type SessionVerifyResult = {
  takenAt: number
  checkedAt: number
  rows: SessionVerifyRow[]
  summary: { ok: number; reattached: number; remapped: number; missing: number; extra: number }
}

export function buildSessionSnapshot(
  terminals: RuntimeTerminalListResult,
  ps: RuntimeWorktreePsResult
): SessionSnapshotFile {
  const sandboxByWorktree = new Map(
    ps.worktrees.map((worktree) => [worktree.worktreeId, worktree.sandbox ?? 'absent'])
  )
  const rows = terminals.terminals.map((terminal) => {
    const sandbox = sandboxByWorktree.get(terminal.worktreeId) ?? 'absent'
    return {
      worktreeId: terminal.worktreeId,
      worktreePath: terminal.worktreePath,
      handle: terminal.handle,
      ptyId: terminal.ptyId,
      incarnationId: terminal.incarnationId ?? null,
      sandbox,
      container:
        sandbox === 'running' && terminal.ptyId ? sandboxContainerName(terminal.worktreeId) : null,
      processId: terminal.processId ?? null
    } satisfies SessionSnapshotRow
  })
  return { version: SESSION_SNAPSHOT_VERSION, takenAt: Date.now(), rows }
}

function rowKey(row: { ptyId: string | null; handle: string }): string {
  return row.ptyId ?? `handle:${row.handle}`
}

export function diffSessionSnapshot(
  snapshot: SessionSnapshotFile,
  live: SessionSnapshotFile
): SessionVerifyResult {
  const liveByKey = new Map(live.rows.map((row) => [rowKey(row), row]))
  const rows: SessionVerifyRow[] = []
  const summary = { ok: 0, reattached: 0, remapped: 0, missing: 0, extra: 0 }
  for (const expected of snapshot.rows) {
    const key = rowKey(expected)
    const actual = liveByKey.get(key)
    liveByKey.delete(key)
    if (!actual) {
      summary.missing += 1
      rows.push({
        status: 'missing',
        worktreeId: expected.worktreeId,
        handle: expected.handle,
        ptyId: expected.ptyId,
        detail: `session gone after restart (container ${expected.container ?? 'none'})`
      })
      continue
    }
    if (actual.handle !== expected.handle) {
      summary.remapped += 1
      rows.push({
        status: 'remapped',
        worktreeId: expected.worktreeId,
        handle: expected.handle,
        resolvedHandle: actual.handle,
        ptyId: expected.ptyId,
        detail: `handle ${expected.handle} is now ${actual.handle} — update the client`
      })
      continue
    }
    if (
      actual.incarnationId !== expected.incarnationId ||
      actual.processId !== expected.processId
    ) {
      summary.reattached += 1
      rows.push({
        status: 'reattached',
        worktreeId: expected.worktreeId,
        handle: expected.handle,
        ptyId: expected.ptyId,
        detail: `same handle, new incarnation/pid (pid ${expected.processId ?? '?'} → ${actual.processId ?? '?'}) — agent flow uninterrupted`
      })
      continue
    }
    if (actual.container !== expected.container) {
      rows.push({
        status: 'container-changed',
        worktreeId: expected.worktreeId,
        handle: expected.handle,
        ptyId: expected.ptyId,
        detail: `container ${expected.container ?? 'none'} → ${actual.container ?? 'none'}`
      })
      continue
    }
    summary.ok += 1
    rows.push({
      status: 'ok',
      worktreeId: expected.worktreeId,
      handle: expected.handle,
      ptyId: expected.ptyId,
      detail: 'unchanged'
    })
  }
  for (const extra of liveByKey.values()) {
    summary.extra += 1
    rows.push({
      status: 'new',
      worktreeId: extra.worktreeId,
      handle: extra.handle,
      ptyId: extra.ptyId,
      detail: 'appeared after the snapshot'
    })
  }
  return {
    takenAt: snapshot.takenAt,
    checkedAt: live.takenAt,
    rows,
    summary
  }
}

function formatSessionSnapshot(snapshot: SessionSnapshotFile): string {
  const lines = snapshot.rows.map(
    (row) =>
      `${row.worktreeId} handle=${row.handle} pty=${row.ptyId ?? 'none'} ` +
      `container=${row.container ?? 'none'} pid=${row.processId ?? '?'}`
  )
  return [`snapshot: ${snapshot.rows.length} session rows`, ...lines].join('\n')
}

function formatSessionVerify(result: SessionVerifyResult): string {
  const lines = result.rows.map(
    (row) =>
      `[${row.status}] ${row.worktreeId} handle=${row.handle}${row.resolvedHandle ? ` now=${row.resolvedHandle}` : ''} — ${row.detail}`
  )
  const summary = `verify: ok=${result.summary.ok} reattached=${result.summary.reattached} remapped=${result.summary.remapped} missing=${result.summary.missing} new=${result.summary.extra}`
  return [...lines, summary].join('\n')
}

function parseSnapshotFile(path: string): SessionSnapshotFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Cannot read snapshot file ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== SESSION_SNAPSHOT_VERSION ||
    !Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Not a sessions snapshot (version ${SESSION_SNAPSHOT_VERSION}): ${path}`
    )
  }
  return parsed as SessionSnapshotFile
}

async function collectLiveSnapshot(
  client: Parameters<CommandHandler>[0]['client']
): Promise<SessionSnapshotFile> {
  // Why read-only: snapshot/verify are pre/post restart witnesses. They call list endpoints
  // only — never create, kill, or reap — so running them cannot disturb agent flow.
  const terminals = await client.call<RuntimeTerminalListResult>('terminal.list', {
    limit: 500
  })
  const ps = await client.call<RuntimeWorktreePsResult>('worktree.ps', {})
  return buildSessionSnapshot(terminals.result, ps.result)
}

export const SESSION_HANDLERS: Record<string, CommandHandler> = {
  'sessions snapshot': async ({ flags, client, json }) => {
    const snapshot = await collectLiveSnapshot(client)
    const file = getOptionalStringFlag(flags, 'file')
    if (file) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    }
    printResult(localSuccess(file ? { file, ...snapshot } : snapshot), json, (value) =>
      'file' in value && typeof value.file === 'string'
        ? `snapshot: ${value.rows.length} rows → ${value.file}`
        : formatSessionSnapshot(value)
    )
  },
  'sessions verify': async ({ flags, client, json }) => {
    const file = getRequiredStringFlag(flags, 'file')
    const expected = parseSnapshotFile(file)
    const live = await collectLiveSnapshot(client)
    const result = diffSessionSnapshot(expected, live)
    printResult(localSuccess(result), json, formatSessionVerify)
    if (result.summary.missing > 0) {
      throw new RuntimeClientError(
        'sessions_verify_mismatch',
        `${result.summary.missing} session(s) from ${file} are missing after the restart`
      )
    }
  }
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}
