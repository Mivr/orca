/**
 * Hardware-GL default for orca's agent-browser launches.
 *
 * Proven on this host (AMD Navi, renderD128 in cutover3): these flags make
 * Chromium render on radeonsi (`ANGLE (AMD, ...)`) instead of SwiftShader.
 * Orca never selects headless-shell vs full-chromium itself — agent-browser
 * owns that split — so the flags ride every launch uniformly via `--args`
 * / `AGENT_BROWSER_ARGS`, which agent-browser honors for both.
 */

/** Proven flag set: ANGLE on native EGL, blocklist bypass, no GPU sandbox. */
export const AGENT_BROWSER_GPU_FLAGS: readonly string[] = [
  '--use-gl=angle',
  '--use-angle=gl-egl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox'
]

/** Env override for the orcad operator-Chromium launch (empty opts out). */
export const ORCA_BROWSER_GPU_ARGS_ENV = 'ORCA_BROWSER_GPU_ARGS'

/** Env override for the AGENT_BROWSER_ARGS value stamped into sandboxes. */
export const ORCA_SANDBOX_BROWSER_GPU_ARGS_ENV = 'ORCA_SANDBOX_BROWSER_GPU_ARGS'

/** Container env every agent-browser launch reads for default launch args. */
export const AGENT_BROWSER_ARGS_ENV = 'AGENT_BROWSER_ARGS'

function parseGpuArgsEnv(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** GPU flags for the orcad external-Chromium launch; default hardware, '' opts out. */
export function resolveAgentBrowserGpuArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseGpuArgsEnv(env[ORCA_BROWSER_GPU_ARGS_ENV]) ?? [...AGENT_BROWSER_GPU_FLAGS]
}

/** GPU flags stamped as AGENT_BROWSER_ARGS into new sandboxes; '' opts out. */
export function sandboxBrowserGpuArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseGpuArgsEnv(env[ORCA_SANDBOX_BROWSER_GPU_ARGS_ENV]) ?? [...AGENT_BROWSER_GPU_FLAGS]
}

/** Comma-joined form: agent-browser splits `--args`/AGENT_BROWSER_ARGS on commas or newlines. */
export function joinAgentBrowserArgs(args: readonly string[]): string {
  return args.join(',')
}

export function hasAgentBrowserGpuFlags(args: readonly string[] | undefined): boolean {
  return args?.some((arg) => (AGENT_BROWSER_GPU_FLAGS as readonly string[]).includes(arg)) ?? false
}

/** Relaunch-without-the-flags keeps non-GPU args (e.g. --no-sandbox). */
export function stripAgentBrowserGpuFlags(args: readonly string[]): string[] {
  const gpu = new Set<string>(AGENT_BROWSER_GPU_FLAGS)
  return args.filter((arg) => !gpu.has(arg))
}

/** Reports the UNMASKED_RENDERER_WEBGL string, or NO-WEBGL when unavailable. */
export const WEBGL_RENDERER_PROBE_JS =
  '(() => { try { const c = document.createElement("canvas");' +
  ' const gl = c.getContext("webgl") || c.getContext("experimental-webgl");' +
  ' if (!gl) return "NO-WEBGL";' +
  ' const ext = gl.getExtension("WEBGL_debug_renderer_info");' +
  ' if (!ext) return "NO-WEBGL";' +
  ' const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);' +
  ' return typeof r === "string" && r ? r : "NO-WEBGL"; }' +
  ' catch { return "NO-WEBGL"; } })()'

export type WebglRendererClass = 'hardware' | 'software' | 'no-webgl'

// Why software-first: an AMD string never contains these, but a SwiftShader
// ANGLE string contains "Google" — a hardware-first match would misread it.
const SOFTWARE_RENDERER_MARKERS = [
  'swiftshader',
  'subzero',
  '0x0000c0de',
  'llvmpipe',
  'softpipe',
  'software',
  'basic render',
  'basic renderer'
]

export function classifyWebglRenderer(renderer: unknown): WebglRendererClass {
  const text = extractRendererString(renderer)
  if (!text || text === 'NO-WEBGL') {
    return 'no-webgl'
  }
  const lowered = text.toLowerCase()
  if (SOFTWARE_RENDERER_MARKERS.some((marker) => lowered.includes(marker))) {
    return 'software'
  }
  return 'hardware'
}

/** agent-browser eval shapes vary (bare string vs {result}/{value} envelope) — accept both. */
export function extractRendererString(data: unknown): string | null {
  if (typeof data === 'string') {
    return data
  }
  if (Array.isArray(data)) {
    return data.length > 0 ? extractRendererString(data[0]) : null
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    for (const key of ['result', 'value', 'data', 'output', 'text', 'renderer']) {
      if (record[key] !== undefined) {
        return extractRendererString(record[key])
      }
    }
  }
  return null
}

export const BROWSER_GL_FALLBACK_PREFIX = 'BROWSER-GL-FALLBACK'

/** Single-line warning: fixed prefix, the reason, and the action taken. */
export function browserGlFallbackWarning(reason: string): string {
  return `${BROWSER_GL_FALLBACK_PREFIX}: ${reason} — browser relaunched without GPU flags on the software path.`
}
