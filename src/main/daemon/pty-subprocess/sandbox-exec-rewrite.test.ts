import { describe, expect, it } from 'vitest'
import { buildSandboxExecRewrite, rewritePtySpawnForSandbox } from './sandbox-exec-rewrite'
import { SANDBOX_CONTAINER_ENV } from '../../sandbox/sandbox-config'

describe('sandbox-exec-rewrite', () => {
  it('rewrites the shell into docker exec with the same-path cwd', () => {
    const rewrite = buildSandboxExecRewrite({
      containerName: 'orca-sandbox-abc',
      hostShellPath: '/bin/bash',
      hostShellArgs: ['-l'],
      cwd: '/home/mihail/orca/workspaces/x',
      env: { TERM: 'xterm-256color' }
    })
    expect(rewrite.shellPath).toBe('docker')
    expect(rewrite.shellArgs).toEqual([
      'exec',
      '-it',
      '-e',
      'TERM=xterm-256color',
      '-w',
      '/home/mihail/orca/workspaces/x',
      'orca-sandbox-abc',
      'bash',
      '-l'
    ])
  })

  it('passes only the env allowlist and never the stamp or host secrets', () => {
    const rewrite = buildSandboxExecRewrite({
      containerName: 'orca-sandbox-abc',
      hostShellPath: '/bin/zsh',
      hostShellArgs: ['-l'],
      cwd: '/wt',
      env: {
        ANTHROPIC_API_KEY: 'secret',
        HOME: '/home/mihail',
        SSH_AUTH_SOCK: '/run/sock',
        [SANDBOX_CONTAINER_ENV]: 'orca-sandbox-abc'
      }
    })
    // zsh is not in the image: falls back to bash, keeping host args.
    expect(rewrite.shellArgs).toContain('bash')
    expect(rewrite.shellArgs).toContain('-e')
    expect(rewrite.shellArgs).toContain('ANTHROPIC_API_KEY=secret')
    expect(rewrite.shellArgs.join(' ')).not.toContain('HOME=')
    expect(rewrite.shellArgs.join(' ')).not.toContain('SSH_AUTH_SOCK')
    expect(rewrite.shellArgs.join(' ')).not.toContain(SANDBOX_CONTAINER_ENV)
  })

  it('leaves host spawns untouched without the stamp', () => {
    expect(
      rewritePtySpawnForSandbox({ env: {}, shellPath: '/bin/bash', shellArgs: ['-l'], cwd: '/wt' })
    ).toBeNull()
    const rewrite = rewritePtySpawnForSandbox({
      env: { [SANDBOX_CONTAINER_ENV]: 'orca-sandbox-abc', TERM: 'xterm-256color' },
      shellPath: '/bin/bash',
      shellArgs: ['-l'],
      cwd: '/wt'
    })
    expect(rewrite?.shellPath).toBe('docker')
    expect(rewrite?.shellArgs.slice(0, 2)).toEqual(['exec', '-it'])
  })

  it('stamps per-spawn hook coords while still dropping stamps and secrets', () => {
    const rewrite = buildSandboxExecRewrite({
      containerName: 'orca-sandbox-abc',
      hostShellPath: '/bin/bash',
      hostShellArgs: ['-l'],
      cwd: '/wt',
      env: {
        TERM: 'xterm-256color',
        ORCA_AGENT_HOOK_PORT: '4567',
        ORCA_AGENT_HOOK_TOKEN: 'tok',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: '1',
        ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
        ORCA_AGENT_HOOK_ENDPOINT: '/home/mihail/.orca-orcad-data/agent-hooks/endpoint.env',
        ORCA_PANE_KEY: 'tab:leaf',
        ORCA_TAB_ID: 'tab',
        ORCA_WORKTREE_ID: 'repo::/wt',
        ORCA_AGENT_LAUNCH_TOKEN: 'launch',
        CODEX_HOME: '/home/mihail/.config/orca/codex-runtime-home/home',
        OPENCODE_CONFIG_DIR: '/home/mihail/.orca-orcad-data/opencode-config-overlays/x',
        HOME: '/home/mihail',
        SSH_AUTH_SOCK: '/run/sock',
        [SANDBOX_CONTAINER_ENV]: 'orca-sandbox-abc'
      }
    })
    const joined = rewrite.shellArgs.join(' ')
    expect(joined).toContain('ORCA_PANE_KEY=tab:leaf')
    expect(joined).toContain('ORCA_AGENT_HOOK_PORT=4567')
    expect(joined).toContain(
      'ORCA_AGENT_HOOK_ENDPOINT=/home/mihail/.orca-orcad-data/agent-hooks/endpoint.env'
    )
    expect(joined).toContain('CODEX_HOME=/home/mihail/.config/orca/codex-runtime-home/home')
    expect(joined).toContain(
      'OPENCODE_CONFIG_DIR=/home/mihail/.orca-orcad-data/opencode-config-overlays/x'
    )
    expect(joined).toContain('TERM=xterm-256color')
    expect(joined).not.toContain('-e HOME=')
    expect(joined).not.toContain('SSH_AUTH_SOCK')
    expect(joined).not.toContain(SANDBOX_CONTAINER_ENV)
  })
})
