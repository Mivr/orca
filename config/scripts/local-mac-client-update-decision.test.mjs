import { describe, expect, it } from 'vitest'
import {
  decideLocalMacClientGitAction,
  decideLocalMacClientRebuild,
  installedClientMatchesHead,
  workingTreeHasTrackedChanges
} from './local-mac-client-update-decision.mjs'

const upstream = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const localPatch = 'cccccccccccccccccccccccccccccccccccccccc'

describe('workingTreeHasTrackedChanges', () => {
  it('ignores untracked and ignored paths', () => {
    expect(workingTreeHasTrackedChanges('?? .metadata_cache/\n!! dist/\n')).toBe(false)
  })

  it('treats modified, staged, and unmerged tracked files as dirty', () => {
    expect(workingTreeHasTrackedChanges(' M src/main/index.ts\n')).toBe(true)
    expect(workingTreeHasTrackedChanges('M  package.json\n')).toBe(true)
    expect(workingTreeHasTrackedChanges('UU config/scripts/local-mac-client-update.mjs\n')).toBe(
      true
    )
  })
})

describe('decideLocalMacClientGitAction', () => {
  it('refuses to rebase a dirty working tree', () => {
    expect(
      decideLocalMacClientGitAction({
        dirty: true,
        headSha: head,
        upstreamSha: upstream,
        upstreamIsAncestorOfHead: false,
        headIsAncestorOfUpstream: false,
        localOnlyCommits: [localPatch]
      })
    ).toMatchObject({ action: 'skip-dirty', localOnlyCommits: [localPatch] })
  })

  it('skips when HEAD is already upstream main', () => {
    expect(
      decideLocalMacClientGitAction({
        dirty: false,
        headSha: upstream,
        upstreamSha: upstream,
        upstreamIsAncestorOfHead: true,
        headIsAncestorOfUpstream: true,
        localOnlyCommits: []
      })
    ).toEqual({
      action: 'skip-current',
      reason: 'HEAD is already upstream main',
      localOnlyCommits: []
    })
  })

  it('skips rebase when already based on latest upstream and keeps local-only commits', () => {
    expect(
      decideLocalMacClientGitAction({
        dirty: false,
        headSha: localPatch,
        upstreamSha: upstream,
        upstreamIsAncestorOfHead: true,
        headIsAncestorOfUpstream: false,
        localOnlyCommits: [localPatch]
      })
    ).toEqual({
      action: 'skip-current',
      reason: 'already based on latest upstream; keeping local-only commits',
      localOnlyCommits: [localPatch]
    })
  })

  it('fast-forwards when the branch has no unique commits and upstream moved', () => {
    expect(
      decideLocalMacClientGitAction({
        dirty: false,
        headSha: head,
        upstreamSha: upstream,
        upstreamIsAncestorOfHead: false,
        headIsAncestorOfUpstream: true,
        localOnlyCommits: []
      })
    ).toMatchObject({ action: 'fast-forward', localOnlyCommits: [] })
  })

  it('rebases onto upstream when histories diverged and preserves local-only commits', () => {
    expect(
      decideLocalMacClientGitAction({
        dirty: false,
        headSha: localPatch,
        upstreamSha: upstream,
        upstreamIsAncestorOfHead: false,
        headIsAncestorOfUpstream: false,
        localOnlyCommits: [localPatch]
      })
    ).toEqual({
      action: 'rebase',
      reason: 'upstream moved; rebase local-only commits onto upstream main',
      localOnlyCommits: [localPatch]
    })
  })
})

describe('decideLocalMacClientRebuild', () => {
  it('skips rebuild when already at upstream with no new patches and install matches HEAD', () => {
    expect(
      decideLocalMacClientRebuild({
        gitAction: 'skip-current',
        headSha: localPatch,
        installedCommit: localPatch.slice(0, 12)
      })
    ).toMatchObject({ action: 'skip' })
  })

  it('rebuilds when the tree is current but the installed client is missing or stale', () => {
    expect(
      decideLocalMacClientRebuild({
        gitAction: 'skip-current',
        headSha: localPatch,
        installedCommit: null
      })
    ).toMatchObject({ action: 'rebuild' })
    expect(
      decideLocalMacClientRebuild({
        gitAction: 'skip-current',
        headSha: localPatch,
        installedCommit: 'dddddddddddd'
      })
    ).toMatchObject({ action: 'rebuild' })
  })

  it('rebuilds after fast-forward or rebase and never rebuilds a dirty tree', () => {
    expect(
      decideLocalMacClientRebuild({ gitAction: 'fast-forward', headSha: upstream })
    ).toMatchObject({ action: 'rebuild' })
    expect(
      decideLocalMacClientRebuild({
        gitAction: 'rebase',
        headSha: localPatch,
        installedCommit: head.slice(0, 12)
      })
    ).toMatchObject({ action: 'rebuild' })
    expect(decideLocalMacClientRebuild({ gitAction: 'skip-dirty', headSha: head })).toMatchObject({
      action: 'skip'
    })
  })
})

describe('installedClientMatchesHead', () => {
  it('matches a short packaged commit against the full HEAD SHA', () => {
    expect(installedClientMatchesHead({ commit: localPatch.slice(0, 12) }, localPatch)).toBe(true)
    expect(installedClientMatchesHead({ commit: localPatch }, localPatch.slice(0, 12))).toBe(true)
    expect(installedClientMatchesHead({ commit: 'deadbeef' }, localPatch)).toBe(false)
    expect(installedClientMatchesHead(null, localPatch)).toBe(false)
  })
})
