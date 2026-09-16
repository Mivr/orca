import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FORK_INTEGRATION_BRANCH,
  buildForkMainPushArgs,
  collectLocalMacClientGitFacts,
  parseUpdaterArgs,
  packagedMacAppCandidates,
  resolvePackagedMacAppPath,
  runLocalMacClientUpdate
} from './local-mac-client-update.mjs'

const upstream = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const localPatch = 'cccccccccccccccccccccccccccccccccccccccc'

function facts(overrides) {
  return collectLocalMacClientGitFacts({
    porcelain: '',
    headSha: localPatch,
    upstreamSha: upstream,
    upstreamIsAncestorOfHead: false,
    headIsAncestorOfUpstream: false,
    localOnlyCommits: [localPatch],
    ...overrides
  })
}

describe('parseUpdaterArgs', () => {
  it('recognizes dry-run and skip flags', () => {
    expect(parseUpdaterArgs(['--dry-run', '--skip-build', '--skip-push', '--skip-fetch'])).toEqual({
      dryRun: true,
      skipBuild: true,
      skipPush: true,
      skipFetch: true
    })
  })
})

describe('resolvePackagedMacAppPath', () => {
  it('prefers dist/mac then arch-specific electron-builder outputs', () => {
    const distDir = '/repo/dist'
    expect(packagedMacAppCandidates(distDir)).toEqual([
      '/repo/dist/mac/Orca.app',
      '/repo/dist/mac-arm64/Orca.app',
      '/repo/dist/mac-x64/Orca.app'
    ])
    expect(resolvePackagedMacAppPath(distDir, (path) => path.endsWith('mac-arm64/Orca.app'))).toBe(
      '/repo/dist/mac-arm64/Orca.app'
    )
    expect(resolvePackagedMacAppPath(distDir, () => false)).toBeNull()
  })
})

describe('runLocalMacClientUpdate', () => {
  it('is the package script used by the local Mac client updater', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')
    )
    expect(packageJson.scripts['update:local-mac-client']).toBe(
      'node config/scripts/local-mac-client-update.mjs'
    )
    expect(packageJson.scripts['install:local-mac-client-scheduler']).toBe(
      'node config/scripts/install-local-mac-client-scheduler.mjs'
    )
  })

  it('refuses to rebase or reinstall while local agents are running', () => {
    const rebuild = vi.fn()
    const result = runLocalMacClientUpdate({
      argv: [],
      collectFacts: () => facts({ agentsRunning: true }),
      applyGit: vi.fn(),
      rebuild,
      push: vi.fn(),
      log: () => {}
    })
    expect(result.gitDecision.action).toBe('skip-agents-running')
    expect(result.rebuildDecision.action).toBe('skip')
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('refuses to rebase or rebuild a dirty tree', () => {
    const applyGit = vi.fn()
    const rebuild = vi.fn()
    const push = vi.fn()
    const result = runLocalMacClientUpdate({
      argv: [],
      collectFacts: () => facts({ porcelain: ' M package.json' }),
      applyGit,
      rebuild,
      push,
      log: () => {}
    })
    expect(result.gitDecision.action).toBe('skip-dirty')
    expect(result.rebuildDecision.action).toBe('skip')
    expect(applyGit).toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('skips rebuild when already at upstream with no new patches and install matches HEAD', () => {
    const rebuild = vi.fn()
    const result = runLocalMacClientUpdate({
      argv: ['--dry-run'],
      collectFacts: () =>
        facts({
          porcelain: '?? .metadata_cache/',
          headSha: localPatch,
          upstreamIsAncestorOfHead: true,
          headIsAncestorOfUpstream: false
        }),
      applyGit: vi.fn(),
      rebuild,
      push: vi.fn(),
      readInstalled: () => ({ commit: localPatch.slice(0, 12) }),
      log: () => {}
    })
    expect(result.gitDecision.action).toBe('skip-current')
    expect(result.gitDecision.localOnlyCommits).toEqual([localPatch])
    expect(result.rebuildDecision.action).toBe('skip')
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('rebases diverged history, keeps local-only commits, and rebuilds', () => {
    const applyGit = vi.fn()
    const rebuild = vi.fn()
    const push = vi.fn()
    const logs = []
    const result = runLocalMacClientUpdate({
      argv: [],
      collectFacts: () => facts({}),
      applyGit,
      rebuild,
      push,
      readHeadSha: () => localPatch,
      readInstalled: () => null,
      log: (line) => logs.push(line)
    })
    expect(result.gitDecision.action).toBe('rebase')
    expect(result.gitDecision.localOnlyCommits).toEqual([localPatch])
    expect(result.rebuildDecision.action).toBe('rebuild')
    expect(applyGit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rebase', localOnlyCommits: [localPatch] }),
      expect.objectContaining({ dryRun: false })
    )
    expect(rebuild).toHaveBeenCalled()
    expect(logs.some((line) => line.includes(`upstream ${upstream}`))).toBe(true)
  })

  it('publishes the rebased tip to fork main and never force-pushes upstream over patches', () => {
    expect(FORK_INTEGRATION_BRANCH).toBe('main')
    expect(buildForkMainPushArgs('rebase')).toEqual([
      'push',
      '--force-with-lease',
      'origin',
      'HEAD:refs/heads/main'
    ])
    expect(buildForkMainPushArgs('fast-forward')).toEqual([
      'push',
      'origin',
      'HEAD:refs/heads/main'
    ])
    expect(buildForkMainPushArgs('skip-current')).toEqual([
      'push',
      'origin',
      'HEAD:refs/heads/main'
    ])
    expect(buildForkMainPushArgs('skip-dirty')).toBeNull()
    expect(buildForkMainPushArgs('skip-agents-running')).toBeNull()
  })

  it('fast-forwards when there are no unique commits and still fetches on dry-run', () => {
    const collectFacts = vi.fn(() =>
      facts({
        headSha: head,
        localOnlyCommits: [],
        upstreamIsAncestorOfHead: false,
        headIsAncestorOfUpstream: true
      })
    )
    const result = runLocalMacClientUpdate({
      argv: ['--dry-run'],
      collectFacts,
      applyGit: vi.fn(),
      rebuild: vi.fn(),
      push: vi.fn(),
      log: () => {}
    })
    expect(collectFacts).toHaveBeenCalledWith({ fetch: true })
    expect(result.gitDecision.action).toBe('fast-forward')
  })
})
