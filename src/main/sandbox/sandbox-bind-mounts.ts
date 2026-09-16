/**
 * Same-path bind-mount resolution for sandbox containers.
 *
 * Binds the worktree dir rw at the identical path plus the main-repo .git dir
 * (shared object store) rw. Everything else is denied by omission. When orcad
 * itself runs containerized, container paths map to host bind sources via the
 * explicit ORCA_SANDBOX_BIND_MAP, the daemon-reported self mounts, then
 * /proc/mounts — so the sibling sandbox gets a working host source while its
 * destination stays same-path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandboxBindMap, type HostMount } from './sandbox-config'

export type { HostMount }

/** Minimal docker access: self-inspect for the daemon-reported mount map. */
export type BindMountDockerRunner = (args: {
  program: string
  args: readonly string[]
}) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** Destination→source map of this container's own mounts (host view), cached. */
let selfMounts: HostMount[] | null = null

async function readSelfMounts(runDocker: BindMountDockerRunner): Promise<HostMount[]> {
  if (selfMounts) {
    return selfMounts
  }
  try {
    // Why the hex guard: with host networking the container inherits the host
    // hostname (`workstation`), which is not inspectable — only a real id is.
    const hostname =
      typeof process.env.HOSTNAME === 'string' && /^[0-9a-f]{12,64}$/.test(process.env.HOSTNAME)
        ? process.env.HOSTNAME
        : null
    if (!hostname) {
      return []
    }
    const inspected = await runDocker({
      program: 'docker',
      args: ['inspect', '--format', '{{json .Mounts}}', hostname]
    })
    if (inspected.code !== 0) {
      return []
    }
    const mounts = JSON.parse(inspected.stdout) as { Destination?: string; Source?: string }[]
    selfMounts = mounts
      .filter((mount) => mount.Destination && mount.Source)
      .map((mount) => ({
        mountpoint: mount.Destination as string,
        source: mount.Source as string
      }))
    return selfMounts
  } catch {
    return []
  }
}

export function resetBindMountsForTest(): void {
  selfMounts = null
}

/** Sync variant over /proc/mounts (device sources excluded); identity fallback. */
export function resolveHostBindSource(
  containerPath: string,
  mounts: HostMount[] = readProcMounts()
): string {
  return mapThroughMounts(containerPath, mounts) ?? containerPath
}

/** Async variant: explicit map, then daemon-reported self mounts, then /proc. */
export async function resolveHostBindSourceAsync(
  containerPath: string,
  runDocker: BindMountDockerRunner
): Promise<string> {
  const configured = mapThroughMounts(containerPath, sandboxBindMap())
  if (configured) {
    return configured
  }
  const self = await readSelfMounts(runDocker).catch(() => [] as HostMount[])
  return mapThroughMounts(containerPath, self) ?? resolveHostBindSource(containerPath)
}

function mapThroughMounts(containerPath: string, mounts: HostMount[]): string | null {
  let best: HostMount | null = null
  for (const mount of mounts) {
    if (
      mount.mountpoint !== '/' &&
      (containerPath === mount.mountpoint || containerPath.startsWith(`${mount.mountpoint}/`)) &&
      (!best || mount.mountpoint.length > best.mountpoint.length)
    ) {
      best = mount
    }
  }
  if (!best) {
    return null
  }
  return `${best.source}${containerPath.slice(best.mountpoint.length)}`
}

function readProcMounts(): HostMount[] {
  try {
    const lines = readFileSync('/proc/mounts', 'utf8').split('\n')
    const mounts: HostMount[] = []
    for (const line of lines) {
      const parts = line.split(' ')
      if (parts.length < 3) {
        continue
      }
      const [source, mountpoint, fstype] = parts as [string, string, string]
      // Why only real path-backed mounts: device nodes (/dev/*), overlay,
      // and pseudo filesystems are not host bind sources (a volume mount can
      // surface its block device here), and mapping through them corrupts paths.
      if (!source?.startsWith('/') || source.startsWith('/dev/') || fstype === 'overlay') {
        continue
      }
      mounts.push({ mountpoint: unescapeMountPath(mountpoint as string), source })
    }
    return mounts
  } catch {
    return []
  }
}

function unescapeMountPath(path: string): string {
  return path.replace(/\\040/g, ' ').replace(/\\134/g, '\\')
}

export async function resolveSandboxMounts(
  worktreePath: string,
  runDocker: BindMountDockerRunner
): Promise<{ mounts: string[]; gitDir: string | null }> {
  const mounts = [`${await resolveHostBindSourceAsync(worktreePath, runDocker)}:${worktreePath}`]
  const gitDir = resolveWorktreeGitDir(worktreePath)
  // Why the whole .git and not just the worktrees/<name> pointer: commits
  // write objects into the shared store, so the pointer alone breaks git.
  const mainGitDir = gitDir ? mainRepoGitDir(gitDir) : null
  if (mainGitDir && mainGitDir !== worktreePath) {
    mounts.push(`${await resolveHostBindSourceAsync(mainGitDir, runDocker)}:${mainGitDir}`)
  }
  return { mounts, gitDir: mainGitDir }
}

function resolveWorktreeGitDir(worktreePath: string): string | null {
  try {
    const dotGit = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/.exec(dotGit)
    if (match?.[1]) {
      return match[1].trim()
    }
    return null
  } catch {
    return null
  }
}

function mainRepoGitDir(gitDir: string): string {
  const marker = '/.git/worktrees/'
  const index = gitDir.indexOf(marker)
  return index !== -1 ? gitDir.slice(0, index + '/.git'.length) : gitDir
}
