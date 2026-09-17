import { describe, expect, it } from 'vitest'
import {
  AGENT_BROWSER_GPU_FLAGS,
  BROWSER_GL_FALLBACK_PREFIX,
  ORCA_BROWSER_GPU_ARGS_ENV,
  ORCA_SANDBOX_BROWSER_GPU_ARGS_ENV,
  WEBGL_RENDERER_PROBE_JS,
  browserGlFallbackWarning,
  classifyWebglRenderer,
  extractRendererString,
  hasAgentBrowserGpuFlags,
  joinAgentBrowserArgs,
  resolveAgentBrowserGpuArgs,
  sandboxBrowserGpuArgs,
  stripAgentBrowserGpuFlags
} from './agent-browser-gpu-flags'

describe('agent-browser GPU flag construction', () => {
  it('defaults to the proven hardware flag set', () => {
    expect(resolveAgentBrowserGpuArgs({})).toEqual([
      '--use-gl=angle',
      '--use-angle=gl-egl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox'
    ])
    expect(sandboxBrowserGpuArgs({})).toEqual([...AGENT_BROWSER_GPU_FLAGS])
  })

  it('overrides via env, comma-separated and trimmed', () => {
    expect(resolveAgentBrowserGpuArgs({ [ORCA_BROWSER_GPU_ARGS_ENV]: ' --foo , --bar ' })).toEqual([
      '--foo',
      '--bar'
    ])
    expect(
      sandboxBrowserGpuArgs({ [ORCA_SANDBOX_BROWSER_GPU_ARGS_ENV]: '--use-gl=swiftshader' })
    ).toEqual(['--use-gl=swiftshader'])
  })

  it('opts out on empty env', () => {
    expect(resolveAgentBrowserGpuArgs({ [ORCA_BROWSER_GPU_ARGS_ENV]: '' })).toEqual([])
    expect(sandboxBrowserGpuArgs({ [ORCA_SANDBOX_BROWSER_GPU_ARGS_ENV]: '' })).toEqual([])
  })

  it('joins comma-separated for AGENT_BROWSER_ARGS stamping', () => {
    expect(joinAgentBrowserArgs(AGENT_BROWSER_GPU_FLAGS)).toBe(
      '--use-gl=angle,--use-angle=gl-egl,--ignore-gpu-blocklist,--disable-gpu-sandbox'
    )
  })

  it('detects and strips GPU flags, keeping the rest', () => {
    const args = ['--no-sandbox', ...AGENT_BROWSER_GPU_FLAGS]
    expect(hasAgentBrowserGpuFlags(args)).toBe(true)
    expect(hasAgentBrowserGpuFlags(['--no-sandbox'])).toBe(false)
    expect(hasAgentBrowserGpuFlags(undefined)).toBe(false)
    expect(stripAgentBrowserGpuFlags(args)).toEqual(['--no-sandbox'])
  })
})

describe('WebGL renderer classification', () => {
  it('reads SwiftShader as software', () => {
    expect(
      classifyWebglRenderer(
        'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'
      )
    ).toBe('software')
  })

  it('reads llvmpipe as software', () => {
    expect(classifyWebglRenderer('llvmpipe (LLVM 20.1.2, 256 bits)')).toBe('software')
  })

  it('reads the AMD radeonsi string as hardware', () => {
    expect(
      classifyWebglRenderer(
        'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 LLVM 20.1.2 DRM 3.64 7.0.0-31-generic), OpenGL ES 3.2)'
      )
    ).toBe('hardware')
  })

  it('reads NO-WEBGL, empty, and null as no-webgl', () => {
    expect(classifyWebglRenderer('NO-WEBGL')).toBe('no-webgl')
    expect(classifyWebglRenderer('')).toBe('no-webgl')
    expect(classifyWebglRenderer(null)).toBe('no-webgl')
    expect(classifyWebglRenderer(undefined)).toBe('no-webgl')
  })

  it('unwraps eval envelope shapes before classifying', () => {
    const amd =
      'ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 LLVM 20.1.2 DRM 3.64 7.0.0-31-generic), OpenGL ES 3.2)'
    expect(extractRendererString({ result: amd })).toBe(amd)
    expect(extractRendererString({ value: amd })).toBe(amd)
    expect(classifyWebglRenderer({ result: amd })).toBe('hardware')
    expect(classifyWebglRenderer([amd])).toBe('hardware')
    expect(extractRendererString({ result: 42 })).toBeNull()
  })

  it('keeps the probe self-contained and sentinel-shaped', () => {
    expect(WEBGL_RENDERER_PROBE_JS).toContain('UNMASKED_RENDERER_WEBGL')
    expect(WEBGL_RENDERER_PROBE_JS).toContain('NO-WEBGL')
  })
})

describe('GL fallback warning', () => {
  it('carries the prefix and the reason', () => {
    const warning = browserGlFallbackWarning('WebGL renderer "llvmpipe" is software')
    expect(warning.startsWith(`${BROWSER_GL_FALLBACK_PREFIX}:`)).toBe(true)
    expect(warning).toContain('WebGL renderer "llvmpipe" is software')
    expect(warning).toContain('without GPU flags')
  })
})
