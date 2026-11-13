import {
  AGENT_BROWSER_ARGS_ENV,
  joinAgentBrowserArgs,
  sandboxBrowserGpuArgs
} from '../browser/agent-browser-gpu-flags'
import {
  SANDBOX_CLAUDE_PROFILES_LABEL,
  SANDBOX_CPUS,
  SANDBOX_HOME,
  SANDBOX_IMAGE,
  SANDBOX_MANAGED_LABEL,
  SANDBOX_WORKTREE_LABEL,
  sandboxDriDevices,
  sandboxExtraHosts,
  sandboxGpuGroups,
  sandboxMemory
} from './sandbox-config'

export function buildSandboxDockerRunArgs(input: {
  name: string
  worktreeId: string
  worktreePath: string
  mounts: readonly string[]
  authMounts: readonly string[]
  envFile: string | null
  /** Absolute `claude-profiles` mount root; present only when that mount is included. */
  claudeProfilesDir?: string
}): string[] {
  // Why stamped, not baked: hosts without DRI opt out via
  // ORCA_SANDBOX_BROWSER_GPU_ARGS='' and every agent-browser launch inside
  // inherits the default without per-command flags.
  const browserGpuArgs = joinAgentBrowserArgs(sandboxBrowserGpuArgs())
  return [
    'run',
    '-d',
    '--name',
    input.name,
    '--user',
    '1000:1000',
    `--memory=${sandboxMemory()}`,
    `--cpus=${SANDBOX_CPUS}`,
    // GPU passthrough: host AMD render node + video/render gids so Chromium
    // uses radeonsi instead of SwiftShader. Env-overridable, empty opts out.
    ...sandboxDriDevices().flatMap((device) => ['--device', device]),
    ...sandboxGpuGroups().flatMap((group) => ['--group-add', group]),
    ...sandboxExtraHosts().flatMap((host) => ['--add-host', host]),
    // Why /var/tmp: the image default HOME (/root) is unreadable as uid 1000,
    // no host home may leak in (§2 deny), and agent CLIs refuse a temporary
    // HOME (/tmp) for helper binaries. Container-private writable layer;
    // phase 2 owns a per-sandbox home volume.
    '-e',
    `HOME=${SANDBOX_HOME}`,
    // Hardware-GL default for in-sandbox agent-browser launches.
    ...(browserGpuArgs ? ['-e', `${AGENT_BROWSER_ARGS_ENV}=${browserGpuArgs}`] : []),
    '--label',
    `${SANDBOX_MANAGED_LABEL}=1`,
    '--label',
    `${SANDBOX_WORKTREE_LABEL}=${input.worktreeId}`,
    ...(input.claudeProfilesDir
      ? ['--label', `${SANDBOX_CLAUDE_PROFILES_LABEL}=${input.claudeProfilesDir}`]
      : []),
    ...input.mounts.flatMap((mount) => ['-v', mount]),
    ...input.authMounts.flatMap((mount) => ['-v', mount]),
    '-w',
    input.worktreePath,
    ...(input.envFile ? ['--env-file', input.envFile] : []),
    SANDBOX_IMAGE,
    'sleep',
    'infinity'
  ]
}
