import { existsSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { getDaemonLogFilePath } from '../observability/logs-directory'
import { DaemonClient } from './client'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

export function getDaemonRuntimeDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'daemon')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDaemonHistoryDir(): string {
  const dir = join(getAppEnvironment().getPath('userData'), 'terminal-history')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDaemonEntryPath(): string {
  const appPath = getAppEnvironment().getAppPath()
  const basePath = appPath.includes('app.asar')
    ? appPath.replace('app.asar', 'app.asar.unpacked')
    : appPath
  const directEntryPath = join(basePath, 'daemon-entry.js')
  return existsSync(directEntryPath)
    ? directEntryPath
    : join(basePath, 'out', 'main', 'daemon-entry.js')
}

export function resolvePackagedDarwinAppVersion(): string | null {
  const environment = getAppEnvironment()
  return process.platform === 'darwin' && environment.isPackaged() ? environment.getVersion() : null
}

export function daemonLogArgs(): string[] {
  const disabled = (process.env.ORCA_DIAGNOSTICS_DISABLED ?? '').trim().toLowerCase()
  return disabled === '1' || disabled === 'true' ? [] : ['--log-file', getDaemonLogFilePath()]
}

export function probeDaemonSocket(socketPath: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  if (process.platform !== 'win32' && !existsSync(socketPath)) {
    resolve(false)
    return promise
  }
  const socket = connect({ path: socketPath })
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (alive: boolean, destroy = false): void => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    socket.removeListener('connect', onConnect)
    socket.removeListener('error', onError)
    if (destroy) {
      socket.destroy()
    }
    resolve(alive)
  }
  const onConnect = (): void => finish(true, true)
  const onError = (): void => finish(false)
  timer = setTimeout(() => finish(false, true), 1000)
  socket.on('connect', onConnect)
  socket.on('error', onError)
  return promise
}

export async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await client.ensureConnected()
    const result = await client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}
