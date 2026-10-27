import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import './automation-extra-agent-args'
import { buildAgentStartupPlan } from './tui-agent-startup'
import '../choices/tui-agent-launch-defaults'

const SETTINGS = {
  agentDefaultArgs: { claude: '--dangerously-skip-permissions --model sonnet' },
  terminalWindowsShell: 'powershell.exe'
}

describe('resolveAgentStartupPlanInputs with extra agent args', () => {
  it.each([
    ['linux', false],
    ['win32', false],
    ['win32', true]
  ] as const)('merges over the host defaults on %s (remote %s)', (platform, isRemote) => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: SETTINGS,
      platform,
      isRemote,
      shell: undefined,
      extraAgentArgs: '--model opus --add-dir "my docs"'
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'go' })
    expect(plan?.launchCommand).toContain("'--add-dir' 'my docs'")
    expect(plan?.launchCommand).toContain('opus')
    expect(plan?.launchCommand).not.toContain('sonnet')
    expect(plan?.launchCommand).toContain('--dangerously-skip-permissions')
  })

  it('throws on extras the executing host refuses', () => {
    expect(() =>
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: SETTINGS,
        platform: 'linux',
        isRemote: false,
        shell: undefined,
        extraAgentArgs: '--permission-mode bypassPermissions'
      })
    ).toThrow('"--permission-mode"')
  })

  it('translates opencode --model / -m into --standalone plus OPENCODE_CONFIG_CONTENT', () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'opencode',
      settings: {
        ...SETTINGS,
        agentDefaultEnv: {
          opencode: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }) }
        }
      },
      platform: 'linux',
      isRemote: false,
      shell: 'posix',
      extraAgentArgs: '--model opencode-go/deepseek-v4-pro'
    })
    expect(inputs.agentArgs).toBe("'--standalone'")
    expect(JSON.parse(inputs.agentEnv.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({
      autoupdate: false,
      model: 'opencode-go/deepseek-v4-pro',
      agents: { build: { model: 'opencode-go/deepseek-v4-pro' } }
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'Run date' })
    expect(plan?.launchCommand).toBe("opencode '--standalone' --prompt 'Run date'")
    expect(plan?.launchCommand).not.toContain('--model')
  })
})
