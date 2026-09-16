import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveHostBindSource,
  resolveHostBindSourceAsync,
  resolveSandboxMounts
} from './sandbox-bind-mounts'

let dir: string
let savedHostname: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-bind-mounts-'))
  savedHostname = process.env.HOSTNAME
})

afterEach(() => {
  if (savedHostname === undefined) {
    delete process.env.HOSTNAME
  } else {
    process.env.HOSTNAME = savedHostname
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveSandboxMounts', () => {
  it('binds only the worktree when no gitdir pointer exists', async () => {
    const { mounts, gitDir } = await resolveSandboxMounts(join(dir, 'missing'), async () => ({
      code: 1,
      stdout: '',
      stderr: ''
    }))
    expect(mounts).toHaveLength(1)
    expect(gitDir).toBeNull()
  })
})

describe('resolveHostBindSource', () => {
  const mounts = [
    { mountpoint: '/home/mihail', source: '/home/mihail' },
    { mountpoint: '/src', source: '/work/docker/volumes/orca-src/_data' }
  ]
  it('maps volume paths to their host source, keeping the destination', () => {
    expect(resolveHostBindSource('/src/simple-business/.git', mounts)).toBe(
      '/work/docker/volumes/orca-src/_data/simple-business/.git'
    )
  })
  it('leaves ordinary host paths alone', () => {
    expect(resolveHostBindSource('/home/mihail/orca/workspaces/x', mounts)).toBe(
      '/home/mihail/orca/workspaces/x'
    )
    expect(resolveHostBindSource('/tmp/y', mounts)).toBe('/tmp/y')
  })
  it('prefers daemon-reported self mounts over /proc device entries', async () => {
    process.env.HOSTNAME = 'aa1abb0cd21b19a1cd0e2903a2b49cf0ab5e1ca945e45c9d4983c06c6f5fda86'
    const inspectRunner = async ({ args }: { args: readonly string[] }) => {
      if (args[0] === 'inspect') {
        return {
          code: 0,
          stdout: JSON.stringify([
            { Destination: '/src', Source: '/work/docker/volumes/orca-src/_data' },
            { Destination: '/home/mihail', Source: '/home/mihail' }
          ]),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    expect(await resolveHostBindSourceAsync('/src/simple-business/.git', inspectRunner)).toBe(
      '/work/docker/volumes/orca-src/_data/simple-business/.git'
    )
  })
  it('honors the explicit bind map for containerized orcad', async () => {
    process.env.ORCA_SANDBOX_BIND_MAP = '/src=/work/docker/volumes/orca-src/_data'
    try {
      const neverInspect = async () => {
        throw new Error('must not inspect when the map covers the path')
      }
      expect(await resolveHostBindSourceAsync('/src/simple-business/.git', neverInspect)).toBe(
        '/work/docker/volumes/orca-src/_data/simple-business/.git'
      )
    } finally {
      delete process.env.ORCA_SANDBOX_BIND_MAP
    }
  })
})
