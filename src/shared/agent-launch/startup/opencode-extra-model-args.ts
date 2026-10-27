import { findOptionOccurrence } from '../../command-option-occurrence'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

const OPENCODE_MODEL_ALIASES = ['-m', '--model'] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stripModelOptionTokens(tokens: readonly string[]): {
  remaining: string[]
  model: string | null
} {
  const remaining = [...tokens]
  let model: string | null = null
  while (true) {
    const occurrence = findOptionOccurrence(remaining, OPENCODE_MODEL_ALIASES, true)
    if (!occurrence) {
      break
    }
    if (occurrence.value?.trim()) {
      model = occurrence.value.trim()
    }
    remaining.splice(occurrence.index, occurrence.consumed)
  }
  return { remaining, model }
}

export function mergeOpenCodeConfigContentModel(
  existingContent: string | undefined,
  model: string
): string {
  let base: Record<string, unknown> = {}
  if (existingContent?.trim()) {
    try {
      const parsed: unknown = JSON.parse(existingContent)
      if (isPlainRecord(parsed)) {
        base = parsed
      }
    } catch {
      // Replace malformed user JSON rather than failing launch; valid objects merge cleanly.
    }
  }
  const existingAgents = isPlainRecord(base.agents) ? base.agents : {}
  const existingBuild = isPlainRecord(existingAgents.build) ? existingAgents.build : {}
  return JSON.stringify({
    ...base,
    model,
    agents: {
      ...existingAgents,
      build: {
        ...existingBuild,
        model
      }
    }
  })
}

function hasServerModeFlag(tokens: readonly string[]): boolean {
  return (
    findOptionOccurrence(tokens, ['--standalone', '--server'], true) !== null ||
    tokens.includes('--standalone')
  )
}

/**
 * OpenCode 2's TUI has no `--model` flag and attaches to `opencode serve --service`
 * by default, ignoring per-process config env. Translate `-m` / `--model` into
 * `--standalone` plus `OPENCODE_CONFIG_CONTENT` so per-automation models apply cleanly.
 */
export function applyOpenCodeExtraModelArgs(input: {
  agentArgs: string | null
  agentEnv: Record<string, string>
  shell: AgentStartupShell
}): {
  agentArgs: string | null
  agentEnv: Record<string, string>
} {
  if (!input.agentArgs?.trim()) {
    return { agentArgs: input.agentArgs, agentEnv: input.agentEnv }
  }
  const tokenized = tokenizeStartupCommand(input.agentArgs, input.shell)
  if (!tokenized.ok) {
    return { agentArgs: input.agentArgs, agentEnv: input.agentEnv }
  }
  const { remaining, model } = stripModelOptionTokens(tokenized.tokens)
  if (!model) {
    return { agentArgs: input.agentArgs, agentEnv: input.agentEnv }
  }
  const nextTokens = hasServerModeFlag(remaining) ? remaining : ['--standalone', ...remaining]
  return {
    agentArgs: nextTokens.map((token) => quoteStartupArg(token, input.shell)).join(' '),
    agentEnv: {
      ...input.agentEnv,
      OPENCODE_CONFIG_CONTENT: mergeOpenCodeConfigContentModel(
        input.agentEnv.OPENCODE_CONFIG_CONTENT,
        model
      )
    }
  }
}
