import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SUPPORTED_ARCHES = new Set(['x64', 'arm64'])

export function resolveMacBuildArch({
  hostArch = process.arch,
  requestedArch = process.env.ORCA_MAC_BUILD_ARCH,
  nativeOnly = process.env.ORCA_MAC_NATIVE_ARCH === '1'
} = {}) {
  const arch = requestedArch || (nativeOnly ? hostArch : null)
  if (arch && !SUPPORTED_ARCHES.has(arch)) {
    throw new Error(
      `Unsupported macOS build architecture: ${arch}. Use ORCA_MAC_BUILD_ARCH=x64|arm64.`
    )
  }
  return arch
}

export function buildMacElectronBuilderArgs(arch) {
  const args = [
    'exec',
    'electron-builder',
    '--config',
    'config/electron-builder.config.cjs',
    '--mac'
  ]
  if (arch) {
    args.push(`--${arch}`)
  }
  return args
}

export function createLocalBuildVersion(baseVersion, timestamp, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Local build timestamp is invalid.')
  }
  const sanitizedCommit = commit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12)
  if (!sanitizedCommit) {
    throw new Error('Git commit identity is empty.')
  }
  const suffix = `local.${timestamp}.${sanitizedCommit}`
  return baseVersion.includes('-') ? `${baseVersion}.${suffix}` : `${baseVersion}-${suffix}`
}

export function getLocalBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  return {
    commit,
    version: createLocalBuildVersion(packageJson.version, Date.now(), commit)
  }
}

export function runLocalMacBuild({
  arch = resolveMacBuildArch(),
  environment = process.env,
  execFile = execFileSync,
  platform = process.platform,
  identity = getLocalBuildIdentity()
} = {}) {
  console.log(`[build:mac] local update version ${identity.version}`)
  if (arch) {
    console.log(`[build:mac] native-arch electron-builder target ${arch}`)
  }
  execFile(platform === 'win32' ? 'pnpm.cmd' : 'pnpm', buildMacElectronBuilderArgs(arch), {
    env: {
      ...environment,
      ORCA_BUILD_COMMIT: identity.commit,
      ORCA_LOCAL_BUILD_VERSION: identity.version
    },
    stdio: 'inherit'
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  runLocalMacBuild()
}
