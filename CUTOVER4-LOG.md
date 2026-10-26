# CUTOVER4-LOG: hardware-GPU default for orca's agent browser (+ software fallback)

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: orca's agent-browser launches default to hardware GL (proven ANGLE/gl-egl
flag set); a WebGL-renderer probe relaunches without the flags + warns on software.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER3-LOG.md` (DRI passthrough, cutover3-20260916 image).

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-16 ~11:2x UTC)

```
$ docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
orca-live             orca-sandbox-orcad:cutover3-20260916   Up 2 hours (healthy)
(+ nativelink ×2, sb-browser-node-1, tablet ×3 — untouched throughout)
```

Pairing snapshot (pre-change, `~/.orca-orcad-data`):
```
009262b48fbae8057d9a4137c1ed02ce  orca-devices.json (9 devices → /tmp/cutover4-devices-before.json)
f5a69bb807f3f57fc0abe38d8c106778  orca-e2ee-keypair.json
```

Image re-verification (not assumed from cutover3):
- `orca-dev:stable` still carries `/ms-playwright` (chromium-1217 + headless-shell-1217),
  global `playwright@1.59.1` (`/usr/lib/node_modules`), `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.
- NEW since cutover3: `libegl-mesa0`, `libegl1`, `mesa-vulkan-drivers` are now baked
  into `orca-dev:stable` (cutover3's "deliberately left out" item got done by a later
  image build — dated tags `20260916-0905/0906` exist). No per-proof apt install needed.
- No `BROWSER.md` under `/tmp/opencode/browser-layer` (absent — derived empirically).
- No `agent-browser` binary in `orca-dev:stable` (sandbox browser stack = playwright chromium).

---

## Step 1 — premise correction (verified, not assumed)

The brief's launch site does NOT exist: there is no `chromium.launch` /
`executablePath` / `launchOptions` anywhere in `src/` (searched). Orca launches
browsers in exactly two TS places, both driving the `agent-browser@0.27.0`
native binary (Rust, pinned in package.json):

1. `src/main/orcad/external-chromium-browser-session.ts` — orcad drives
   `agent-browser <cmd> --json` with `--session/--profile/--args` + env
   (`AGENT_BROWSER_EXECUTABLE_PATH`, `AGENT_BROWSER_ARGS`, ...). Chromium flags
   flow via `ExternalChromiumLaunch.browserArgs`; the provider never set any.
2. `src/main/browser/agent-browser-bridge-*.ts` — desktop Electron path drives
   agent-browser with `--cdp` against Electron webContents (no Chromium launch
   at all — no flags apply).

"Headless-shell vs full-chromium" exists only as `/ms-playwright` binaries used
by raw-playwright scripts (the cutover3 proof layer) and inside the
agent-browser binary itself. Orca TS has no such branch, so the flags ride every
agent-browser launch uniformly via `--args`/`AGENT_BROWSER_ARGS` (which
agent-browser honors for both headless and headed launches). Nothing to branch —
recorded here instead of a dead `if`.

Consequence for the design: hardware-default = default `browserArgs` in the
orcad provider + `AGENT_BROWSER_ARGS` stamped into new sandboxes at create;
probe + relaunch-without-flags + warning lives in `ExternalChromiumBrowserSession.start()`.

---

## Step 2 — implementation (cutover4)

NEW `src/main/browser/agent-browser-gpu-flags.ts` (pure; ships in both the
Electron-main and orcad bundles — `browser-error` precedent):
- `AGENT_BROWSER_GPU_FLAGS` = the cutover3-proven set:
  `--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-sandbox`
- `resolveAgentBrowserGpuArgs(env)` (`ORCA_BROWSER_GPU_ARGS`; default = flags, `''` opts out)
- `sandboxBrowserGpuArgs(env)` (`ORCA_SANDBOX_BROWSER_GPU_ARGS`; same shape)
- `has/stripAgentBrowserGpuFlags`, `joinAgentBrowserArgs` (comma form — agent-browser
  splits `--args`/`AGENT_BROWSER_ARGS` on commas or newlines; comma keeps `docker run -e` one-line)
- `WEBGL_RENDERER_PROBE_JS` (returns `UNMASKED_RENDERER_WEBGL` or `NO-WEBGL`)
- `classifyWebglRenderer` (software markers matched FIRST — a SwiftShader ANGLE
  string contains "Google"; checks `swiftshader/subzero/0x0000c0de/llvmpipe/softpipe/
  software/basic render*`; non-empty + no marker = hardware; `NO-WEBGL`/empty/null = no-webgl)
  + `extractRendererString` (bare string vs `{result}/{value}/{data}/{output}/{text}/{renderer}` envelopes)
- `browserGlFallbackWarning(reason)` → single line (exact text in Step 7)

`src/main/orcad/external-chromium-browser-session.ts`:
- `activeBrowserArgs` (init from `launch.browserArgs`); `run()` uses it for both
  `--args` and `AGENT_BROWSER_ARGS` (no behavior change when no GPU flags).
- `start()`: after reclaim-`stop()` + `open about:blank`, if GPU flags were
  attempted → `eval` the probe → `hardware` keeps the launch; `software`/`no-webgl`
  (or a failed GPU `open`) → `stop()`, relaunch with GPU flags stripped (non-GPU
  args like `--no-sandbox` kept), `console.warn(BROWSER-GL-FALLBACK …)`, recorded
  on `session.glFallbackWarning` for diagnostics.
- A REUSED (surviving) session is never probed and never closed (#16367 — it may
  own the operator's live browser).

`src/main/orcad/orcad-browser-provider.ts`: operator-Chromium launch now carries
`browserArgs: resolveAgentBrowserGpuArgs(environment)` (default hardware, env override).

`src/main/sandbox/sandbox-manager.ts` (`ensureSandboxForWorktree` runArgs, after `HOME`):
`-e AGENT_BROWSER_ARGS=<comma-joined flags>` whenever non-empty — every
in-sandbox agent-browser invocation inherits the default with no per-command flags.

---

## Step 3 — tests + lint + typecheck

NEW `src/main/browser/agent-browser-gpu-flags.test.ts` (12): flag construction
(defaults/override/empty opt-out/join/strip-detect) + classification (SwiftShader
vs AMD-radeonsi vs llvmpipe vs NO-WEBGL/empty/null + envelope unwrap) + warning format.

`external-chromium-browser-session.test.ts` (+4): hardware keeps GPU launch;
SwiftShader → 2nd `open` without GPU flags (keeps `--no-sandbox`) + `console.warn`
`BROWSER-GL-FALLBACK:` + `glFallbackWarning` set; failed GPU `open` → fallback +
`GPU launch failed` warning; reused session never probed/closed even with GPU flags.

`sandbox-manager.test.ts` (+2): create stamps
`AGENT_BROWSER_ARGS=--use-gl=angle,--use-angle=gl-egl,--ignore-gpu-blocklist,--disable-gpu-sandbox`;
override + empty opt-out honored.

```
$ pnpm vitest run <5 touched files> → Test Files 5 passed / Tests 53 passed
$ oxlint 7 files → 0 warnings/errors; oxfmt --write applied
$ pnpm tc:node → 1 error in src/main/runtime/rpc/rpc-params-type-parity.ts
  (PRE-EXISTING, upstream commit bc5e67606f, file untouched by this round; zero errors in touched files)
```

Build host: one-shot `orca-dev:stable` (host has no node — same as cutover-1/2/3):
```
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+531a86593de2, 7.77 MB, 4119 modules (+1), zero electron and node:sqlite imports.
ln: ... '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1/2/3)
Bundle sanity (fresh out/orcad/orcad.js): BROWSER-GL-FALLBACK×1, AGENT_BROWSER_ARGS×3,
use-angle×1, ORCA_*_GPU_ARGS×1; out/cli/index.js rebuilt.
```

---

## Step 4 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (build.sh step_stage form): `out/orcad + out/cli → stage-prove/`,
tar of `node-pty agent-browser emojibase-data @parcel` → `STAGE-OK, 204M`
(new bundle marker `BROWSER-GL-FALLBACK` confirmed in staged `orcad.js`).
```
$ docker build -t orca-sandbox-orcad:cutover4-20260916 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 3.9s → bbc8a5651afd
$ docker images: orca-runtime:bun 5c624dd69e07 + orca-runtime:node 27e84c33aa36 UNCHANGED.
```

---

## Step 5 — restart orca-live onto the new image (~11:29 UTC)

`docker inspect orca-live` re-read for exact flags. New container = IDENTICAL
user/group/binds/env/health/cmd, new image only (GPU defaults are code defaults —
no new `-e` flags needed; `ORCA_SANDBOX_*` overrides available when needed):
```
$ docker stop -t 5 orca-live
$ docker rename orca-live orca-live-prev-cutover3   (newest instant fallback)
$ docker run -d --name orca-live --network host --user 1000:1000 \
    --group-add 988 --restart unless-stopped \
    -v /home/mihail:/home/mihail \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v orca-src:/src \
    -e HOME=/home/mihail \
    -e ORCA_USER_DATA=/home/mihail/.orca-orcad-data \
    -e ORCA_VERSION=0.0.0-orcad \
    -e ORCA_DAEMON_EXEC_PATH=/usr/local/bin/node \
    -e ORCA_SANDBOX_AGENTS=1 \
    -e 'ORCA_SANDBOX_BIND_MAP=/src=/work/docker/volumes/orca-src/_data' \
    -e ORCA_SANDBOX_IMAGE=orca-dev:stable \
    -e ORCA_SANDBOX_DRI_DEVICES=/dev/dri/renderD128 \
    -e ORCA_SANDBOX_GPU_GROUPS=44,991 \
    --health-cmd="node -e \"require('net').connect(6768,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})\"" \
    --health-interval=15s --health-timeout=5s --health-start-period=60s --health-retries=3 \
    orca-sandbox-orcad:cutover4-20260916 \
    --port 6768 --pairing-address wss://orca.simple-business-platform.com
```

First boot (`Up ~30s (healthy)` — :6768 downtime = stop→rename→run window, seconds):
```
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Build: 0.0.0-orcad (43a22635f7a1e801)  <- NEW bundle hash
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```

Pairing survival: 9 → 9 devices, zero missing, zero drift on
`token/pairedAt/scope/name` (semantic diff). `orca-devices.json` md5
`009262b4…` → `8008c0d1…` is live `lastSeenAt` traffic only (byte-compare would
false-alarm — same as cutover-1/2/3). `orca-e2ee-keypair.json` md5 UNCHANGED
(`f5a69bb807f3f57fc0abe38d8c106778`, byte-identical). Pairings SURVIVED.

---

## Step 6 — e2e prove on live :6768, then archive

CLI: worktree `out/cli/index.js` via one-shot `orca-dev:stable`, saved env
`--environment live-cutover` (same as cutover-1/2/3).
```
$ worktree create --environment live-cutover --repo path:/src/agent-infra \
    --name cutover4-gpu --agent codex --prompt "Check git status, then wait idle..." → ok
$ (45s) docker ps → orca-sandbox-2ec0e6a7 (orca-dev:stable) Up 51s
$ docker inspect orca-sandbox-2ec0e6a7:
  Devices=[{PathOnHost:/dev/dri/renderD128 → PathInContainer, rwm}]  GroupAdd=["44","991"]
  Env: AGENT_BROWSER_ARGS=--use-gl=angle,--use-angle=gl-egl,--ignore-gpu-blocklist,--disable-gpu-sandbox  <- STAMPED BY DEFAULT
```

Proof drive — orca's own browser path (NOT raw playwright): `agent-browser`
0.27.0 (the exact binary orca shells out to) inside the sandbox, default env,
no manual `--args`. Manual bits only: binary `docker cp`'d in (absent from
orca-dev image) + `--executable-path` → `/ms-playwright/chromium-1217/chrome-linux64/chrome`
(agent-browser ships no default Chrome in the image):
```
$ open https://example.com → {"title":"Example Domain","url":"https://example.com/"}  (REAL page load)
$ eval <WebGL probe> → {"result":"ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22
  LLVM 20.1.2 DRM 3.64 7.0.0-31-generic), OpenGL ES 3.2)"}  <- HARDWARE AMD BY DEFAULT
$ repeat with fresh session → same AMD string (2/2 deterministic with flags)
```

Negative control (flags unset/empty → SwiftShader baseline reproduced):
- `env -u AGENT_BROWSER_ARGS` → `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero) (0x0000C0DE)), SwiftShader driver)` (matches cutover3 baseline).
- `AGENT_BROWSER_ARGS=` (empty) → SwiftShader 2/2 on re-run; ONE earlier
  empty-string run read AMD once (likely the follow-up eval re-launched the daemon
  under the default stamped env — single unexplained reading, recorded as-is).
  Net: flagless launch is SwiftShader-at-best and flaky; the default flags make
  hardware deterministic.

Headless-shell binary (`chromium_headless_shell-1217`) was NOT exercised:
agent-browser drove full chromium headless by default, which is the path orca uses.

Archive (production clean):
```
$ worktree rm --environment live-cutover --worktree path:.../agent-infra/cutover4-gpu --force → {"removed": true}
After: NO sandbox containers; worktree ps shows no cutover4-gpu; agent-infra dir holds
only .orca-worktree-trash; orca-live healthy on the cutover4 image.
```

Untouched: nativelink ×2, sb-browser-node-1, tablet ×3; repo registrations;
`orca-runtime:*`; all prior `orca-live-prev*` fallbacks (+ new `orca-live-prev-cutover3`).

---

## Step 7 — fallback warning text (exact)

```
BROWSER-GL-FALLBACK: WebGL renderer "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)" is software — browser relaunched without GPU flags on the software path.
```

Shape: `BROWSER-GL-FALLBACK: <reason> — browser relaunched without GPU flags on
the software path.` Reasons: `WebGL renderer <json> is software` | `GPU launch
failed: <error>`. Emitted via `console.warn` (orcad log = `docker logs orca-live`)
and kept on `session.glFallbackWarning`. No fallback fired during this round's
proof (hardware held) — the trigger is covered by unit tests.

Rollback (NOT tested — cutover4 succeeded, :6768 left migrated):
instant fallback (kept, stopped): `docker start orca-live-prev-cutover3`
(cutover3 image; new sandboxes then lose the AGENT_BROWSER_ARGS stamp only —
existing ones keep their env). Older chain also kept stopped.

No commits made (worktree `git status`: 5 modified + 2 new files, all this round).

---

## Deliberately left out

- `agent-browser` binary NOT baked into `orca-dev` — the proof `docker cp`'d the
  repo-pinned 0.27.0 binary into a throwaway sandbox. Baking it (plus a default
  Chrome or `AGENT_BROWSER_EXECUTABLE_PATH` → /ms-playwright) is a dev-image change,
  outside this repo.
- orca-live carries NO new env: GPU defaults are code defaults. Set
  `ORCA_SANDBOX_BROWSER_GPU_ARGS=''` (per-sandbox stamp off) or
  `ORCA_BROWSER_GPU_ARGS=''` (orcad operator-launch off) to opt out.
- No `--gpus` (NVIDIA-only — N/A on this AMD host); no `/dev/dri/card1`
  (render node suffices — cutover3 decision stands).
- `browserGoto`/`browserEval` via `ORCA` CLI against live orcad were NOT the proof
  path: live orcad has no browser provider configured (no Electron, no
  `ORCA_BROWSER_EXECUTABLE`) so those reject `browser_unavailable` — the
  in-sandbox agent-browser drive above is the closest runnable layer of orca's
  own browser path, plus launch-options unit tests.
- Pre-existing `pnpm tc:node` error (`rpc-params-type-parity.ts`, upstream
  bc5e67606f) untouched.
