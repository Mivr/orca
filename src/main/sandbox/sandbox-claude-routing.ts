/**
 * Claude account routing capability for sandbox containers (orcad-side).
 *
 * A container can honor a managed account's CLAUDE_CONFIG_DIR only if it was
 * created with the `claude-profiles` root mounted same-path. That fact is
 * recorded as a docker label at create; this module answers "does this
 * container carry it" (cached per container: mounts never change for a
 * container's life) and stamps the spawn env accordingly. Split from
 * sandbox-manager for the file-size lint cap.
 */
import {
  SANDBOX_CLAUDE_PROFILES_DIR_ENV,
  SANDBOX_CLAUDE_PROFILES_LABEL,
  hasInjectedClaudeConfigDir
} from './sandbox-config'
import { resolveSandboxClaudeProfilesDir } from './sandbox-hook-mounts'

type DockerResult = { code: number | null; stdout: string; stderr: string }
export type ClaudeRoutingDocker = (args: readonly string[]) => Promise<DockerResult>

/** Container name → label value ('' = container lacks the capability). */
const labelByContainer = new Map<string, string>()
/** Containers already warned about missing routing (one warning each). */
const warnedContainers = new Set<string>()

export function resetClaudeRoutingStateForTest(): void {
  labelByContainer.clear()
  warnedContainers.clear()
}

/** Drop everything remembered about a container (it was removed). */
export function forgetClaudeRoutingState(name: string): void {
  labelByContainer.delete(name)
  warnedContainers.delete(name)
}

/**
 * The profiles root when the resolved auth-mount list really mounts it, so the
 * label never claims a mount that was opted out or skipped.
 */
export function mountedClaudeProfilesDir(authMounts: readonly string[]): string | undefined {
  const root = resolveSandboxClaudeProfilesDir()
  return authMounts.some((mount) => mount.endsWith(`:${root}:rw`)) ? root : undefined
}

/** Remember what a freshly created container was labelled with. */
export function noteCreatedClaudeProfilesLabel(name: string, root: string | undefined): void {
  labelByContainer.set(name, root ?? '')
}

async function readLabel(name: string, docker: ClaudeRoutingDocker): Promise<string | null> {
  const cached = labelByContainer.get(name)
  if (cached !== undefined) {
    return cached
  }
  const result = await docker([
    'inspect',
    '--format',
    `{{index .Config.Labels "${SANDBOX_CLAUDE_PROFILES_LABEL}"}}`,
    name
  ]).catch(() => null)
  if (!result || result.code !== 0) {
    // Unknown, not "absent": do not cache so a transient failure can recover.
    return null
  }
  const raw = result.stdout.trim()
  const value = raw === '<no value>' ? '' : raw
  labelByContainer.set(name, value)
  return value
}

/**
 * Env stamp for a spawn into `name`: the profiles root when the container
 * carries the capability for the current root. Otherwise empty, plus one
 * warning per container when an Orca-injected account dir would be ignored.
 */
export async function claudeRoutingStamp(args: {
  name: string
  env: Record<string, string> | undefined
  docker: ClaudeRoutingDocker
}): Promise<Record<string, string>> {
  const root = resolveSandboxClaudeProfilesDir()
  if ((await readLabel(args.name, args.docker)) === root) {
    return { [SANDBOX_CLAUDE_PROFILES_DIR_ENV]: root }
  }
  if (hasInjectedClaudeConfigDir(args.env) && !warnedContainers.has(args.name)) {
    warnedContainers.add(args.name)
    // Names the container only: no env values are logged.
    console.warn(
      `[sandbox] ${args.name} predates Claude account routing; this launch uses the ` +
        `system default Claude login. Remove the container to pick up routing.`
    )
  }
  return {}
}
