import { AsyncLocalStorage } from 'node:async_hooks'
import {
  isSandboxRoutingEnabled,
  sandboxAutomationMaxSlots,
  sandboxContainerName
} from './sandbox-config'

export type SandboxAutomationReservation = {
  materialized: boolean
}

export type SandboxSlotsDriver = {
  listContainers: () => Promise<string[]>
  refreshListedNames: (names: string[]) => void
  hasLiveWorktreeContainer: (worktreeId: string, containerName: string) => boolean
  resolveWorktreeContainerName: (worktreeId: string) => string
  runDockerTop: (
    containerName: string
  ) => Promise<{ code: number | null; stdout: string; stderr: string } | null>
}

const automationReservationStorage = new AsyncLocalStorage<SandboxAutomationReservation>()
const pendingReservations = new Set<SandboxAutomationReservation>()
let admissionQueue: Promise<void> = Promise.resolve()
let driver: SandboxSlotsDriver | null = null

export function registerSandboxSlotsDriver(next: SandboxSlotsDriver): void {
  driver = next
}

export function withSandboxAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = admissionQueue.then(operation, operation)
  admissionQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export function currentAutomationReservation(): SandboxAutomationReservation | undefined {
  return automationReservationStorage.getStore()
}

export function createAutomationReservation(): SandboxAutomationReservation {
  const reservation: SandboxAutomationReservation = { materialized: false }
  pendingReservations.add(reservation)
  return reservation
}

export function markAutomationReservationMaterialized(
  reservation: SandboxAutomationReservation | undefined
): void {
  if (!reservation) {
    return
  }
  reservation.materialized = true
  pendingReservations.delete(reservation)
}

export function releaseAutomationReservation(reservation: SandboxAutomationReservation): void {
  pendingReservations.delete(reservation)
}

export function countPendingAutomationReservations(exclude?: SandboxAutomationReservation): number {
  let count = 0
  for (const reservation of pendingReservations) {
    if (reservation !== exclude && !reservation.materialized) {
      count += 1
    }
  }
  return count
}

export function resetSandboxSlotsForTest(): void {
  pendingReservations.clear()
  admissionQueue = Promise.resolve()
}

/**
 * Reserve an automation sandbox slot before creating any worktree, enforcing
 * `limit - reserve` so interactive sessions always retain reserved capacity.
 */
export async function tryWithAutomationSandboxSlot<T>(
  args: { existingWorktreeId?: string },
  operation: () => Promise<T>
): Promise<{ allowed: true; value: T } | { allowed: false }> {
  if (!isSandboxRoutingEnabled() || !driver) {
    return { allowed: true, value: await operation() }
  }
  const activeDriver = driver
  const reservation = await withSandboxAdmissionLock(async () => {
    const names = await activeDriver.listContainers()
    activeDriver.refreshListedNames(names)
    if (args.existingWorktreeId) {
      const existingName = sandboxContainerName(args.existingWorktreeId)
      if (
        names.includes(existingName) ||
        activeDriver.hasLiveWorktreeContainer(args.existingWorktreeId, existingName)
      ) {
        return createAutomationReservation()
      }
    }
    const occupied = names.length + countPendingAutomationReservations()
    if (occupied >= sandboxAutomationMaxSlots()) {
      return null
    }
    return createAutomationReservation()
  })
  if (!reservation) {
    return { allowed: false }
  }
  try {
    return {
      allowed: true,
      value: await automationReservationStorage.run(reservation, operation)
    }
  } finally {
    releaseAutomationReservation(reservation)
  }
}

export async function isSandboxWorktreeShellAlone(worktreeId: string): Promise<boolean> {
  if (!isSandboxRoutingEnabled() || !driver) {
    return false
  }
  const top = await driver.runDockerTop(driver.resolveWorktreeContainerName(worktreeId))
  return Boolean(top && top.code === 0 && execDescendantsShowShellAlone(top.stdout))
}

export async function isSandboxWorktreeAgentRunning(
  worktreeId: string,
  commands: readonly string[]
): Promise<boolean> {
  if (!isSandboxRoutingEnabled() || !driver) {
    return false
  }
  const top = await driver.runDockerTop(driver.resolveWorktreeContainerName(worktreeId))
  return Boolean(top && top.code === 0 && execDescendantsMatchAgent(top.stdout, commands))
}

type DockerTopProcess = {
  pid: number
  ppid: number
  comm: string
  args: string
}

export function parseDockerTopExecDescendants(stdout: string): {
  hasExecShell: boolean
  execChildren: { comm: string; args: string }[]
} {
  const rows: DockerTopProcess[] = []
  const lines = stdout.split('\n')
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim()
    if (!trimmed) {
      continue
    }
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(trimmed)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      comm: match[3],
      args: match[4] ?? ''
    })
  }
  const pids = new Set(rows.map((row) => row.pid))
  const execRootPids = new Set<number>()
  for (const row of rows) {
    if (!pids.has(row.ppid) && row.comm !== 'tini' && !row.args.startsWith('sleep infinity')) {
      execRootPids.add(row.pid)
    }
  }
  const descendants = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (
        !descendants.has(row.pid) &&
        !execRootPids.has(row.pid) &&
        (execRootPids.has(row.ppid) || descendants.has(row.ppid))
      ) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return {
    hasExecShell: execRootPids.size > 0,
    execChildren: rows
      .filter((row) => descendants.has(row.pid))
      .map((row) => ({ comm: row.comm, args: row.args }))
  }
}

const SCRIPT_INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3'])

function commandBaseName(raw: string): string {
  const token =
    raw
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .split(/\s+/)[0] ?? ''
  return (token.split('/').pop() ?? token).toLowerCase()
}

function procExecutableNames(proc: { comm: string; args: string }): string[] {
  const names = [proc.comm.toLowerCase()]
  const tokens = proc.args.trim().split(/\s+/).filter(Boolean)
  if (tokens[0]) {
    const first = commandBaseName(tokens[0])
    names.push(first)
    if (SCRIPT_INTERPRETERS.has(first)) {
      const scriptArg = tokens.slice(1).find((token) => !token.startsWith('-'))
      if (scriptArg) {
        names.push(commandBaseName(scriptArg))
      }
    }
  }
  return names
}

export function execDescendantsShowShellAlone(stdout: string): boolean {
  const parsed = parseDockerTopExecDescendants(stdout)
  return parsed.hasExecShell && parsed.execChildren.length === 0
}

export function execDescendantsMatchAgent(stdout: string, commands: readonly string[]): boolean {
  const wanted = new Set(commands.map(commandBaseName).filter(Boolean))
  if (wanted.size === 0) {
    return false
  }
  return parseDockerTopExecDescendants(stdout).execChildren.some((proc) => {
    if (/\bopencode\s+serve\b/.test(proc.args)) {
      return false
    }
    return procExecutableNames(proc).some((name) => wanted.has(name))
  })
}
