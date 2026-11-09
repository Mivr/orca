import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const runProcessMock = vi.fn<(spec: Spec) => Promise<unknown>>()
vi.mock('@orca/process-host', () => ({
  runProcess: (spec: Spec) => runProcessMock(spec)
}))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('')),
  realpath: vi.fn(async (path: string) => path),
  access: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined)
}))

import { ExternalChromiumBrowserSession } from './external-chromium-browser-session'
import { agentBrowserCommandOf } from '../browser/agent-browser/testing/agent-browser-bridge-test-harness'
import { AGENT_BROWSER_GPU_FLAGS } from '../browser/agent-browser-gpu-flags'

const BASE = {
  executablePath: '/opt/orca/chromium',
  profilePath: '/state/browser-chromium',
  sessionName: 'orca-orcad-0123456789abcdef'
}

type Spec = {
  args?: readonly string[]
  input?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

function commandOf(spec: Spec): string[] {
  return agentBrowserCommandOf(spec.args ?? [], spec.input)
}

describe('orcad external-chromium agent-browser environment', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    vi.mocked(mkdir).mockClear()
  })

  it('does no work when startup is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mkdir).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('reports a ref whose element is gone as stale', async () => {
    runProcessMock.mockResolvedValue({
      code: 1,
      signal: null,
      stdout: JSON.stringify({
        success: false,
        error:
          'Stale ref for role=button name=Approve cannot be recovered: several elements now match.'
      }),
      stderr: '',
      timedOut: false
    })
    const session = new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    )
    await expect(session.run(['click', '@e2'])).rejects.toMatchObject({ code: 'browser_stale_ref' })
  })

  function startFailingOpen(error: string): Promise<string> {
    runProcessMock.mockImplementation((spec: Spec) =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify(
          commandOf(spec)[0] === 'open'
            ? { success: false, error }
            : { success: true, data: { tabs: [] } }
        ),
        stderr: '',
        timedOut: false
      })
    )
    return new ExternalChromiumBrowserSession(
      '/opt/orca/agent-browser',
      { executablePath: BASE.executablePath, provider: 'chromium' },
      '/state'
    ).start()
  }

  it('names the unwritable profile instead of the driver sandbox hint', async () => {
    const failure = startFailingOpen(
      'Chrome exited early (exit code: 21) without writing DevToolsActivePort\n' +
        'ERROR: Failed to create /state/browser-chromium/SingletonLock: Permission denied (13)\n' +
        'Failed to create a ProcessSingleton for your profile directory.\n' +
        'Hint: try --args "--no-sandbox"'
    )
    await expect(failure).rejects.toMatchObject({
      code: 'browser_unavailable',
      message: expect.stringContaining(join('/state', 'browser-chromium'))
    })
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining('SingletonLock: Permission denied (13)')
    })
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining('--no-sandbox')
    })
  })

  it('keeps the profile, which holds browser state and captures, owner-only', async () => {
    await startFailingOpen('Chrome exited early').catch(() => undefined)
    const profile = join('/state', 'browser-chromium')
    expect(mkdir).toHaveBeenCalledWith(profile, { recursive: true, mode: 0o700 })
    expect(chmod).toHaveBeenCalledWith(profile, 0o700)
  })

  it("keeps Chromium's own explanation when another process holds the profile", async () => {
    const inUse =
      'The profile appears to be in use by another Chromium process (4242) on another computer (build-box).\n' +
      'Failed to create a ProcessSingleton for your profile directory.'
    await expect(startFailingOpen(inUse)).rejects.toMatchObject({
      message: expect.stringContaining('in use by another Chromium process (4242)')
    })
  })

  function gpuLaunch() {
    return {
      executablePath: BASE.executablePath,
      provider: 'chromium' as const,
      browserArgs: ['--no-sandbox', ...AGENT_BROWSER_GPU_FLAGS]
    }
  }

  function installGpuStartMock(renderer: string, failFirstOpen = false): void {
    let tabs = false
    let opened = 0
    runProcessMock.mockImplementation((spec: Spec) => {
      const verb = commandOf(spec)[0]
      if (verb === 'tab') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            success: true,
            data: tabs
              ? { tabs: [{ active: true, tabId: 'tab-gpu', title: 'x', url: 'about:blank' }] }
              : { tabs: [] }
          }),
          stderr: '',
          timedOut: false
        })
      }
      if (verb === 'open') {
        opened += 1
        if (failFirstOpen && opened === 1) {
          return Promise.reject(new Error('spawn EXDEV'))
        }
        tabs = true
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ success: true, data: {} }),
          stderr: '',
          timedOut: false
        })
      }
      if (verb === 'eval') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ success: true, data: renderer }),
          stderr: '',
          timedOut: false
        })
      }
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ success: true, data: {} }),
        stderr: '',
        timedOut: false
      })
    })
  }

  // Why: hardware by default must not relaunch — the fallback path is for software only.
  it('keeps the GPU launch when the renderer is hardware', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installGpuStartMock(
        'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 LLVM 20.1.2 DRM 3.64 7.0.0-31-generic), OpenGL ES 3.2)'
      )
      const session = new ExternalChromiumBrowserSession(
        '/opt/orca/agent-browser',
        gpuLaunch(),
        '/state'
      )
      await expect(session.start()).resolves.toBe('tab-gpu')
      expect(warn).not.toHaveBeenCalled()
      expect(session.glFallbackWarning).toBeNull()
      const opens = runProcessMock.mock.calls.filter((call) => commandOf(call[0])[0] === 'open')
      expect(opens).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  // Why: the fallback trigger — SwiftShader means the flags did not take, so
  // relaunch without them and warn instead of serving software GL silently.
  it('relaunches without GPU flags and warns when the renderer is software', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installGpuStartMock(
        'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
      )
      const session = new ExternalChromiumBrowserSession(
        '/opt/orca/agent-browser',
        gpuLaunch(),
        '/state'
      )
      await expect(session.start()).resolves.toBe('tab-gpu')

      const opens = runProcessMock.mock.calls.filter((call) => commandOf(call[0])[0] === 'open')
      expect(opens).toHaveLength(2)
      const openPayload = (call: (typeof opens)[number]): string | undefined => {
        const args = [...(((call[0] as Spec).args ?? []) as string[])]
        const at = args.indexOf('--args')
        return at === -1 ? undefined : args[at + 1]
      }
      expect(openPayload(opens[0])).toContain('--use-gl=angle')
      // Relaunch drops the GPU flags but keeps the rest.
      expect(openPayload(opens[1])).toBe('--no-sandbox')

      expect(warn).toHaveBeenCalledOnce()
      const message = String(warn.mock.calls[0]?.[0] ?? '')
      expect(message.startsWith('BROWSER-GL-FALLBACK:')).toBe(true)
      expect(message).toContain('software')
      expect(session.glFallbackWarning).toBe(message)
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back without GPU flags when the GPU launch itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      installGpuStartMock('NO-WEBGL', true)
      const session = new ExternalChromiumBrowserSession(
        '/opt/orca/agent-browser',
        gpuLaunch(),
        '/state'
      )
      await expect(session.start()).resolves.toBe('tab-gpu')
      const message = String(warn.mock.calls[0]?.[0] ?? '')
      expect(message.startsWith('BROWSER-GL-FALLBACK:')).toBe(true)
      expect(message).toContain('GPU launch failed')
    } finally {
      warn.mockRestore()
    }
  })

  // Why (#16367): a reused session may own the user's live browser — never
  // probe it, and never close it for a GPU relaunch.
  it('never probes a reused session, even with GPU flags configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runProcessMock.mockImplementation((spec: Spec) => {
        const verb = commandOf(spec)[0]
        const data =
          verb === 'tab'
            ? { tabs: [{ active: true, tabId: 'tab-live', title: 'x', url: 'https://x.test' }] }
            : {}
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ success: true, data }),
          stderr: '',
          timedOut: false
        })
      })
      const session = new ExternalChromiumBrowserSession(
        '/opt/orca/agent-browser',
        gpuLaunch(),
        '/state'
      )
      await expect(session.start()).resolves.toBe('tab-live')
      const verbs = runProcessMock.mock.calls
        .map(([spec]) => commandOf(spec))
        .map((args) => args.filter((arg) => !arg.startsWith('-')))
      expect(verbs.some((args) => args.includes('eval'))).toBe(false)
      expect(verbs.some((args) => args.includes('close'))).toBe(false)
      expect(verbs.some((args) => args.includes('open'))).toBe(false)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
