#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  decideLocalMacClientGitAction,
  decideLocalMacClientRebuild,
  processCommandLinesHaveRunningLocalAgents,
  workingTreeHasTrackedChanges,
  worktreePsHasRunningLocalAgents
} from './local-mac-client-update-decision.mjs'

export const UPSTREAM_REMOTE = 'upstream'
export const UPSTREAM_URL = 'https://github.com/stablyai/orca.git'
export const UPSTREAM_REF = 'refs/heads/main'
export const FORK_INTEGRATION_BRANCH = 'main'
export const LOCAL_CLIENT_APP_NAME = 'Orca Local.app'
export const LOCAL_BUILD_IDENTITY_FILE = 'orca-local-build.json'

const repoRoot = resolve(import.meta.dirname, '../..')

export function defaultLocalMacClientInstallPath(home = homedir()) {
  return join(home, 'Applications', LOCAL_CLIENT_APP_NAME)
}

export function packagedMacAppCandidates(distDir) {
  return [
    join(distDir, 'mac', 'Orca.app'),
    join(distDir, 'mac-arm64', 'Orca.app'),
    join(distDir, 'mac-x64', 'Orca.app')
  ]
}

export function resolvePackagedMacAppPath(distDir, exists = existsSync) {
  return packagedMacAppCandidates(distDir).find((candidate) => exists(candidate)) ?? null
}

export function readInstalledLocalClientIdentity(
  appPath,
  readFile = readFileSync,
  exists = existsSync
) {
  const identityPath = join(appPath, 'Contents', 'Resources', LOCAL_BUILD_IDENTITY_FILE)
  if (!exists(identityPath)) {
    return null
  }
  return JSON.parse(readFile(identityPath, 'utf8'))
}

export function parseUpdaterArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    skipBuild: argv.includes('--skip-build'),
    skipPush: argv.includes('--skip-push'),
    skipFetch: argv.includes('--skip-fetch')
  }
}

function git(args, { allowFail = false, ...opts } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    }).trim()
  } catch (error) {
    if (allowFail) {
      return null
    }
    const stderr = error.stderr?.toString().trim()
    throw new Error(stderr ? `git ${args.join(' ')}: ${stderr}` : error.message)
  }
}

function gitOk(args) {
  try {
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return true
  } catch {
    return false
  }
}

export function collectLocalMacClientGitFacts({
  porcelain,
  headSha,
  upstreamSha,
  upstreamIsAncestorOfHead,
  headIsAncestorOfUpstream,
  localOnlyCommits,
  agentsRunning = false
}) {
  return {
    dirty: workingTreeHasTrackedChanges(porcelain),
    agentsRunning,
    headSha,
    upstreamSha,
    upstreamIsAncestorOfHead,
    headIsAncestorOfUpstream,
    localOnlyCommits
  }
}

function ensureUpstreamRemote() {
  const remotes = git(['remote'])
  if (!remotes.split('\n').includes(UPSTREAM_REMOTE)) {
    git(['remote', 'add', UPSTREAM_REMOTE, UPSTREAM_URL])
    return
  }
  const url = git(['remote', 'get-url', UPSTREAM_REMOTE])
  if (url !== UPSTREAM_URL) {
    console.warn(`[local-mac-client] ${UPSTREAM_REMOTE} is ${url}; expected ${UPSTREAM_URL}`)
  }
}

function collectFactsFromGit({ fetch }) {
  if (fetch) {
    ensureUpstreamRemote()
    git(['fetch', UPSTREAM_REMOTE, 'main'])
    git(['fetch', 'origin', 'main'], { allowFail: true })
  }
  const porcelain = git(['status', '--porcelain'])
  const headSha = git(['rev-parse', 'HEAD'])
  const upstreamSha = git(['rev-parse', `${UPSTREAM_REMOTE}/main`])
  const localOnly = git(['rev-list', '--reverse', `${upstreamSha}..${headSha}`])
  return collectLocalMacClientGitFacts({
    porcelain,
    headSha,
    upstreamSha,
    upstreamIsAncestorOfHead: gitOk(['merge-base', '--is-ancestor', upstreamSha, headSha]),
    headIsAncestorOfUpstream: gitOk(['merge-base', '--is-ancestor', headSha, upstreamSha]),
    localOnlyCommits: localOnly ? localOnly.split('\n').filter(Boolean) : [],
    agentsRunning: collectRunningLocalAgents()
  })
}

function collectRunningLocalAgents() {
  try {
    const output = execFileSync('orca', ['worktree', 'ps', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (worktreePsHasRunningLocalAgents(JSON.parse(output))) {
      return true
    }
  } catch {
    // Runtime may be down; fall through to process-table detection.
  }
  try {
    const output = execFileSync('ps', ['-axo', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return processCommandLinesHaveRunningLocalAgents(output.split('\n'))
  } catch {
    return false
  }
}

function applyGitAction(decision, { dryRun }) {
  if (dryRun || decision.action === 'skip-dirty' || decision.action === 'skip-current') {
    return
  }
  if (decision.action === 'fast-forward') {
    git(['merge', '--ff-only', `${UPSTREAM_REMOTE}/main`])
    return
  }
  if (decision.action === 'rebase') {
    git(['rebase', `${UPSTREAM_REMOTE}/main`])
  }
}

/** Push rebased HEAD to fork main. Never force-push upstream over local Mac patches. */
export function buildForkMainPushArgs(gitAction) {
  if (gitAction === 'skip-dirty' || gitAction === 'skip-agents-running') {
    return null
  }
  const refspec = `HEAD:refs/heads/${FORK_INTEGRATION_BRANCH}`
  if (gitAction === 'rebase') {
    return ['push', '--force-with-lease', 'origin', refspec]
  }
  if (gitAction === 'fast-forward' || gitAction === 'skip-current') {
    return ['push', 'origin', refspec]
  }
  return null
}

function pushIntegrationBranch({ dryRun, skipPush, gitAction }) {
  if (dryRun || skipPush) {
    return
  }
  const mainArgs = buildForkMainPushArgs(gitAction)
  if (mainArgs) {
    git(mainArgs)
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (
    branch &&
    branch !== FORK_INTEGRATION_BRANCH &&
    branch !== 'HEAD' &&
    (gitAction === 'fast-forward' || gitAction === 'rebase')
  ) {
    const args = ['push', 'origin', `HEAD:refs/heads/${branch}`]
    if (gitAction === 'rebase') {
      args.splice(1, 0, '--force-with-lease')
    }
    git(args)
  }
}

function rebuildAndInstall({ dryRun, skipBuild, installPath }) {
  if (dryRun || skipBuild) {
    return null
  }
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  execFileSync(pnpm, ['install', '--frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' })
  execFileSync(pnpm, ['build:mac'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ORCA_MAC_NATIVE_ARCH: '1' }
  })
  const packaged = resolvePackagedMacAppPath(join(repoRoot, 'dist'))
  if (!packaged) {
    throw new Error('Packaged Orca.app was not found under dist/')
  }
  mkdirSync(dirname(installPath), { recursive: true })
  execFileSync('ditto', [packaged, installPath], { stdio: 'inherit' })
  return packaged
}

export function runLocalMacClientUpdate({
  argv = process.argv.slice(2),
  collectFacts = collectFactsFromGit,
  applyGit = applyGitAction,
  push = pushIntegrationBranch,
  rebuild = rebuildAndInstall,
  readHeadSha = () => git(['rev-parse', 'HEAD']),
  readInstalled = readInstalledLocalClientIdentity,
  installPath = defaultLocalMacClientInstallPath(),
  log = console.log
} = {}) {
  const options = parseUpdaterArgs(argv)
  const facts = collectFacts({ fetch: !options.skipFetch })
  const gitDecision = decideLocalMacClientGitAction(facts)
  log(`[local-mac-client] upstream ${facts.upstreamSha}`)
  log(`[local-mac-client] HEAD ${facts.headSha}`)
  log(`[local-mac-client] git ${gitDecision.action}: ${gitDecision.reason}`)
  if (gitDecision.localOnlyCommits.length > 0) {
    log(`[local-mac-client] keeping ${gitDecision.localOnlyCommits.length} local-only commit(s)`)
  }
  applyGit(gitDecision, options)
  const headAfter =
    options.dryRun ||
    gitDecision.action === 'skip-dirty' ||
    gitDecision.action === 'skip-agents-running' ||
    gitDecision.action === 'skip-current'
      ? facts.headSha
      : readHeadSha()
  const installed = readInstalled(installPath)
  const rebuildDecision = decideLocalMacClientRebuild({
    gitAction: gitDecision.action,
    headSha: headAfter,
    installedCommit: installed?.commit
  })
  log(`[local-mac-client] rebuild ${rebuildDecision.action}: ${rebuildDecision.reason}`)
  if (rebuildDecision.action === 'rebuild') {
    rebuild({ ...options, installPath })
  }
  push({ ...options, gitAction: gitDecision.action, upstreamSha: facts.upstreamSha })
  return { facts, gitDecision, rebuildDecision, headAfter }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const result = runLocalMacClientUpdate()
    if (result.gitDecision.action === 'skip-dirty') {
      process.exitCode = 2
    }
  } catch (error) {
    console.error(`[local-mac-client] ${error.message}`)
    process.exitCode = 1
  }
}
