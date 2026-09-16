/** Parse `git status --porcelain`: tracked changes block rebase; `??`/`!!` do not. */
export function workingTreeHasTrackedChanges(porcelainOutput) {
  return porcelainOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .some((line) => !line.startsWith('??') && !line.startsWith('!!'))
}

export function installedClientMatchesHead(installed, headSha) {
  const commit = installed?.commit
  if (!commit || !headSha) {
    return false
  }
  return headSha.startsWith(commit) || commit.startsWith(headSha)
}

export const RUNNING_LOCAL_AGENT_STATES = new Set(['working', 'blocked', 'waiting'])
export const LOCAL_AGENT_PROCESS_NAMES = new Set([
  'agy',
  'claude',
  'codex',
  'opencode',
  'gemini',
  'grok'
])

/** True when `orca worktree ps --json` reports a live local agent. */
export function worktreePsHasRunningLocalAgents(ps) {
  const worktrees = Array.isArray(ps?.worktrees) ? ps.worktrees : []
  return worktrees.some((worktree) => {
    if (worktree.status === 'working' || worktree.status === 'permission') {
      return true
    }
    const agents = Array.isArray(worktree.agents) ? worktree.agents : []
    return agents.some((agent) => RUNNING_LOCAL_AGENT_STATES.has(agent.state))
  })
}

/** True when a process table row is a known local agent CLI. */
export function processCommandLinesHaveRunningLocalAgents(commandLines) {
  return commandLines.some((line) => {
    const first = line.trim().split(/\s+/)[0] ?? ''
    const base = first.split(/[/\\]/).pop() ?? ''
    const name = base.replace(/\.exe$/i, '')
    return LOCAL_AGENT_PROCESS_NAMES.has(name)
  })
}

/**
 * Decide the git step from facts collected at the I/O edge.
 * Dirty trees never rebase. Already-based trees keep local-only commits.
 */
export function decideLocalMacClientGitAction(facts) {
  if (facts.dirty) {
    return {
      action: 'skip-dirty',
      reason: 'working tree is dirty; refusing to rebase',
      localOnlyCommits: facts.localOnlyCommits ?? []
    }
  }
  if (facts.agentsRunning) {
    return {
      action: 'skip-agents-running',
      reason: 'local agents are running; refusing to rebase or reinstall',
      localOnlyCommits: facts.localOnlyCommits ?? []
    }
  }
  if (!facts.upstreamSha || !facts.headSha) {
    throw new Error('upstream SHA and HEAD SHA are required')
  }
  const localOnlyCommits = facts.localOnlyCommits ?? []
  if (facts.headSha === facts.upstreamSha) {
    return {
      action: 'skip-current',
      reason: 'HEAD is already upstream main',
      localOnlyCommits
    }
  }
  if (facts.upstreamIsAncestorOfHead) {
    return {
      action: 'skip-current',
      reason: 'already based on latest upstream; keeping local-only commits',
      localOnlyCommits
    }
  }
  if (facts.headIsAncestorOfUpstream) {
    return {
      action: 'fast-forward',
      reason: 'no unique local commits; fast-forward to upstream main',
      localOnlyCommits
    }
  }
  return {
    action: 'rebase',
    reason: 'upstream moved; rebase local-only commits onto upstream main',
    localOnlyCommits
  }
}

/** Rebuild unless the tree is dirty or already current with a matching install. */
export function decideLocalMacClientRebuild({ gitAction, headSha, installedCommit }) {
  if (gitAction === 'skip-dirty') {
    return {
      action: 'skip',
      reason: 'working tree is dirty; refusing to rebase or rebuild'
    }
  }
  if (gitAction === 'skip-agents-running') {
    return {
      action: 'skip',
      reason: 'local agents are running; refusing to rebase or reinstall'
    }
  }
  if (
    gitAction === 'skip-current' &&
    installedClientMatchesHead({ commit: installedCommit }, headSha)
  ) {
    return {
      action: 'skip',
      reason: 'already at upstream with no new patches; installed client matches HEAD'
    }
  }
  if (gitAction === 'skip-current') {
    return {
      action: 'rebuild',
      reason: 'tree is current but installed client is missing or stale'
    }
  }
  return {
    action: 'rebuild',
    reason: 'git history changed; rebuild the local Mac client'
  }
}
