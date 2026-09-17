/**
 * Create-time secret transport for sandbox containers.
 *
 * Split from sandbox-manager under the 300-line lint cap. Secrets cross at
 * create via a host-owned 0600 env file, never baked or logged. Per-spawn
 * hook coords do NOT ride here (see pickSandboxHookSpawnEnv): a container is
 * shared per worktree while panes differ, so those cross per spawn via
 * `docker exec -e`.
 */
import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickSandboxEnv } from './sandbox-config'

/** Secrets cross at create via a host-owned 0600 env file, never baked or logged. */
export function writeSandboxEnvFile(env: Record<string, string> | undefined): string | null {
  const picked = pickSandboxEnv(env ?? {})
  const entries = Object.entries(picked)
  if (entries.length === 0) {
    return null
  }
  const path = join(tmpdir(), `orca-sandbox-env-${process.pid}-${Date.now()}`)
  writeFileSync(path, `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {
    mode: 0o600
  })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort: writeFileSync mode already applied on creation.
  }
  return path
}

export function cleanupSandboxEnvFile(envFileArg: string): void {
  if (!envFileArg.startsWith(`${tmpdir()}/orca-sandbox-env-`)) {
    return
  }
  try {
    if (existsSync(envFileArg)) {
      unlinkSync(envFileArg)
    }
  } catch {
    // Best effort.
  }
}
