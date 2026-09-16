import { describe, expect, it, vi } from 'vitest'
import {
  buildMacElectronBuilderArgs,
  createLocalBuildVersion,
  getLocalBuildIdentity,
  pickLocalBuildBaseVersion,
  resolveMacBuildArch,
  runLocalMacBuild
} from './build-mac-local.mjs'

describe('createLocalBuildVersion', () => {
  it('creates unique valid prerelease versions without changing the release base', () => {
    expect(createLocalBuildVersion('1.4.159-rc.0', 123456, 'abc123')).toBe(
      '1.4.159-rc.0.local.123456.abc123'
    )
    expect(createLocalBuildVersion('1.4.159', 123456, 'abc123')).toBe('1.4.159-local.123456.abc123')
  })

  it('sanitizes commit identifiers', () => {
    expect(createLocalBuildVersion('1.0.0', 1, 'abc/def')).toBe('1.0.0-local.1.abcdef')
  })
})

describe('pickLocalBuildBaseVersion', () => {
  it('uses a newer GitHub release when package.json on main still lags', () => {
    expect(pickLocalBuildBaseVersion('1.4.197', 'v1.4.204')).toBe('1.4.204')
    expect(pickLocalBuildBaseVersion('1.4.197', '1.4.204')).toBe('1.4.204')
  })

  it('keeps package.json when it is already newer or the release is missing', () => {
    expect(pickLocalBuildBaseVersion('1.4.210', '1.4.204')).toBe('1.4.210')
    expect(pickLocalBuildBaseVersion('1.4.197', null)).toBe('1.4.197')
    expect(pickLocalBuildBaseVersion('1.4.204', '1.4.204')).toBe('1.4.204')
  })
})

describe('getLocalBuildIdentity', () => {
  it('stamps the local label from the newer advertised release', () => {
    expect(
      getLocalBuildIdentity({
        packageVersion: '1.4.197',
        advertisedReleaseVersion: 'v1.4.204',
        timestamp: 9,
        commit: 'cce2636b2862'
      })
    ).toEqual({
      commit: 'cce2636b2862',
      version: '1.4.204-local.9.cce2636b2862'
    })
  })
})

describe('native-arch local Mac packaging', () => {
  it('keeps dual-arch electron-builder args unless native-only is requested', () => {
    expect(resolveMacBuildArch({ hostArch: 'arm64', nativeOnly: false })).toBeNull()
    expect(buildMacElectronBuilderArgs(null)).toEqual([
      'exec',
      'electron-builder',
      '--config',
      'config/electron-builder.config.cjs',
      '--mac'
    ])
  })

  it('passes the host architecture when ORCA_MAC_NATIVE_ARCH is set', () => {
    expect(resolveMacBuildArch({ hostArch: 'arm64', nativeOnly: true })).toBe('arm64')
    expect(resolveMacBuildArch({ hostArch: 'x64', nativeOnly: true })).toBe('x64')
    expect(buildMacElectronBuilderArgs('arm64')).toEqual([
      'exec',
      'electron-builder',
      '--config',
      'config/electron-builder.config.cjs',
      '--mac',
      '--arm64'
    ])
  })

  it('rejects unsupported architectures', () => {
    expect(() => resolveMacBuildArch({ hostArch: 'ia32', nativeOnly: true })).toThrow(
      'Unsupported macOS build architecture'
    )
  })

  it('stamps the local version and forwards native-arch args to electron-builder', () => {
    const execFile = vi.fn()
    runLocalMacBuild({
      arch: 'arm64',
      environment: { PATH: '/bin' },
      execFile,
      platform: 'darwin',
      identity: { commit: 'abc123def456', version: '1.4.197-local.1.abc123def456' }
    })
    expect(execFile).toHaveBeenCalledWith(
      'pnpm',
      buildMacElectronBuilderArgs('arm64'),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_BUILD_COMMIT: 'abc123def456',
          ORCA_LOCAL_BUILD_VERSION: '1.4.197-local.1.abc123def456'
        }),
        stdio: 'inherit'
      })
    )
  })
})
