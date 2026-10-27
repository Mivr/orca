import { basename } from 'node:path'
import { isSandboxRoutingEnabled, sandboxInnerShell } from '../sandbox/sandbox-config'

/** Match local spawn shell precedence: request → default setting → SHELL.
 * Remote relays and Windows shell families cannot be named by this POSIX lookup. */
export function nameLocalTypedLineShell(args: {
  isRemote: boolean
  shellOverride?: string
  defaultShellSetting?: string
  platform?: NodeJS.Platform
  envShell?: string
  env?: NodeJS.ProcessEnv
}): string | undefined {
  const effectivePlatform = args.platform ?? process.platform
  if (args.isRemote || effectivePlatform === 'win32') {
    return undefined
  }
  const shellPath =
    args.shellOverride?.trim() ||
    args.defaultShellSetting?.trim() ||
    (args.envShell ?? process.env.SHELL) ||
    '/bin/zsh'
  if (effectivePlatform === 'linux' && isSandboxRoutingEnabled(args.env ?? process.env)) {
    return sandboxInnerShell(shellPath)
  }
  return basename(shellPath).toLowerCase()
}

/** Foreground proof depends on the execution host: local WSL still uses Windows PTY machinery; SSH uses its host platform. */
export function launchHostProvesAgentInFront(args: {
  isRemote: boolean
  launchPlatform: NodeJS.Platform
  hostPlatform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): boolean {
  const effectiveHost = args.hostPlatform ?? process.platform
  // Host PTY foreground reads see `docker exec`, not the container agent; keep prompts on the startup line/script.
  if (!args.isRemote && effectiveHost === 'linux' && (args.env ?? process.env).ORCA_SANDBOX_AGENTS === '1') {
    return false
  }
  return args.isRemote ? args.launchPlatform !== 'win32' : effectiveHost !== 'win32'
}
