/**
 * Daemon-side sandbox transport rewrite (phase 1).
 *
 * Pure argument layer only: when the merged spawn env carries the orcad-stamped
 * sandbox container, the PTY child becomes `docker exec -it` into that container
 * instead of the host shell. PTY ownership, pairing, RPC, and endpoint handling
 * are untouched — node-pty still spawns and owns the master; only the child's
 * argv changes. Secrets cross via explicit `-e` allowlist flags.
 *
 * Why `-it` and not `-i`: agent TUIs (codex, claude) refuse a non-terminal
 * stdin outright, so `-i` can only ever run headless commands. The nested
 * container pty sizes itself from the host pty at exec time; later resizes
 * and exotic signal paths are phase-1 best-effort (§5 — fallback is (c)).
 */
import {
  SANDBOX_CONTAINER_ENV,
  pickSandboxEnv,
  pickSandboxHookSpawnEnv,
  sandboxInnerShell
} from '../../sandbox/sandbox-config'

export type SandboxExecRewrite = {
  shellPath: string
  shellArgs: string[]
}

export function buildSandboxExecRewrite(args: {
  containerName: string
  hostShellPath: string
  hostShellArgs: string[]
  cwd: string
  env: Record<string, string>
}): SandboxExecRewrite {
  const innerShell = sandboxInnerShell(args.hostShellPath)
  // Why two lists: the static allowlist is create-time secrets, while the
  // hook plane is per-spawn routing (pane keys differ per pane in one
  // container). Without these the in-sandbox hooks see no ORCA_PANE_KEY and
  // even the spool fallback stays silent (`[ -n ... ] || return 0`).
  const execEnv = { ...pickSandboxEnv(args.env), ...pickSandboxHookSpawnEnv(args.env) }
  const envFlags: string[] = []
  for (const [key, value] of Object.entries(execEnv)) {
    envFlags.push('-e', `${key}=${value}`)
  }
  return {
    shellPath: 'docker',
    shellArgs: [
      'exec',
      '-it',
      ...envFlags,
      '-w',
      args.cwd,
      args.containerName,
      innerShell,
      ...args.hostShellArgs
    ]
  }
}

/** Reads the orcad stamp from the merged daemon spawn env; null means host spawn. */
export function rewritePtySpawnForSandbox(args: {
  env: Record<string, string>
  shellPath: string
  shellArgs: string[]
  cwd: string
}): SandboxExecRewrite | null {
  const containerName = args.env[SANDBOX_CONTAINER_ENV]
  if (!containerName || process.platform !== 'linux') {
    return null
  }
  return buildSandboxExecRewrite({
    containerName,
    hostShellPath: args.shellPath,
    hostShellArgs: args.shellArgs,
    cwd: args.cwd,
    env: args.env
  })
}
