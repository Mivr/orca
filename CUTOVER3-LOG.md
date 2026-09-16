# CUTOVER3-LOG: GPU passthrough for orca docker sandboxes (host AMD dGPU → Chromium)

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: sandboxes created by orcad pass through the host AMD dGPU so Chromium
renders on radeonsi hardware instead of SwiftShader.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER2-LOG.md` (cutover2-20260916 image, `ORCA_SANDBOX_IMAGE` env).

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-16 ~08:55 UTC)

```
$ docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
orca-live             orca-sandbox-orcad:cutover2-20260916   Up 40 min (healthy)
(+ nativelink ×2, sb-browser-node-1, tablet ×3 — untouched throughout)
$ docker ps -a | grep orca-live-prev
orca-live-prev-stable    cutover2-20260916  Exited (0)
orca-live-prev           cutover-20260916   Exited (0)
orca-live-prev-cutover1  orca-runtime:bun   Exited (0)
```

Live env (actual, from `docker inspect`): `ORCA_SANDBOX_IMAGE=orca-dev:stable`
(note: CUTOVER2-LOG says `orca-dev:4`, but live was since moved to
`orca-dev:stable` → same `d6f6d290d883`; restart keeps live's ACTUAL value).

Host GPU (verified, not assumed):
```
$ ls -l /dev/dri → card1 (video), renderD128 (render)
/sys/bus/pci/devices/0000:03:00.0: vendor=0x1002 device=0x73df driver=amdgpu
renderD128 resolves to the same 0000:03:00.0 device
groups: video=44, render=991 (mihail in both); lspci NOT installed (used /sys)
```
No `BROWSER-GPU.md` under `~/orca-docker/dev-image/` (checked — absent).
`orca-dev:stable` already carries mesa userspace (`libgl1-mesa-dri`,
`libdrm-amdgpu1`, `radeonsi_dri.so`) + pre-baked Playwright browsers at
`/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, chromium-1217,
headless-shell-1217) + global `playwright@1.59.1` (`/usr/lib/node_modules`).
Missing: system `libEGL.so.1` and any Vulkan ICD (see step 4).

Pairing snapshot (pre-change, `~/.orca-orcad-data`):
```
2c7cd057233b0e376e37bf48e93c9006  orca-devices.json (9 devices → /tmp/cutover3-devices-before.json)
f5a69bb807f3f57fc0abe38d8c106778  orca-e2ee-keypair.json
```

---

## Step 1 — DRI passthrough in the sandbox create path + tests + bundle rebuild

`sandbox-config.ts` (follows the `SANDBOX_IMAGE` env-override pattern):
- `SANDBOX_DRI_DEVICES_ENV='ORCA_SANDBOX_DRI_DEVICES'`, default `['/dev/dri/renderD128']`
- `SANDBOX_GPU_GROUPS_ENV='ORCA_SANDBOX_GPU_GROUPS'`, default `['44','991']`
  (numeric gids — docker resolves `--group-add` names unreliably when the name
  is absent inside the image; `video=44, render=991` pinned from host `getent`).
- `sandboxDriDevices(env?)` / `sandboxGpuGroups(env?)` — comma-separated,
  whitespace-trimmed; empty string opts out (`[]`); read live from
  `process.env` at create time (stub-able in tests, unlike import-time const).
- card1 deliberately NOT in the default: headless WebGL/compute needs only the
  render node; the primary node widens to display modesetting. Add via
  `ORCA_SANDBOX_DRI_DEVICES=/dev/dri/card1,/dev/dri/renderD128` if ever needed.

`sandbox-manager.ts` (`ensureSandboxForWorktree` runArgs, after `--cpus`):
```
...sandboxDriDevices().flatMap((d) => ['--device', d]),
...sandboxGpuGroups().flatMap((g) => ['--group-add', g]),
```
No `--gpus` (NVIDIA-only flag — refused). No `existsSync` filtering: a missing
device fails fast at create instead of silently falling back to SwiftShader;
hosts without DRI set the env empty.

Tests: `sandbox-config.test.ts` (+2: defaults, overrides incl. empty opt-out),
`sandbox-manager.test.ts` (+2: run args carry `--device /dev/dri/renderD128`
+ `--group-add 44/991`; env override + empty opt-out removes both flags).
```
$ pnpm vitest run src/main/sandbox/sandbox-config.test.ts src/main/sandbox/sandbox-manager.test.ts
Test Files 2 passed (2) / Tests 18 passed (18)
$ oxlint 4 files — 0 warnings/errors; oxfmt --write applied to the 2 touched
  manager files (pre-existing format drift in spawn-admission files untouched)
```

Build host: one-shot `orca-dev:stable` container (no sess containers alive this
round; host itself has no node — same constraint as cutover-1/2):
```
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+e639b7bc838e, 7.77 MB, 4118 modules, zero electron and node:sqlite imports.
ln: ... '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1/2)
Bundle sanity (fresh out/orcad/orcad.js): ORCA_SANDBOX_DRI_DEVICES×1,
ORCA_SANDBOX_GPU_GROUPS×1, renderD128×1, orca-dev:3×0; out/cli/index.js rebuilt.
```

---

## Step 2 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (same recipe as cutover-2): `out/orcad + out/cli → stage-prove/`,
tar of `node-pty agent-browser emojibase-data @parcel` → `STAGE-OK, 204M`.
```
$ docker build -t orca-sandbox-orcad:cutover3-20260916 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 4.1s → 5816f84a20ea
$ docker run --rm --entrypoint bash orca-sandbox-orcad:cutover3-20260916 -lc 'grep ...'
ORCA_SANDBOX_DRI_DEVICES ×1, renderD128 ×1, orca-dev:4 ×1 (image default; live overrides to :stable)
$ docker images: orca-runtime:bun 5c624dd69e07 + orca-runtime:node UNCHANGED.
```

---

## Step 3 — restart orca-live onto the new image (live :6768, ~09:0x UTC)

`docker inspect orca-live` re-read for exact flags. New container = IDENTICAL
user/group/binds/env/health/cmd plus exactly three env additions
(`ORCA_SANDBOX_DRI_DEVICES`, `ORCA_SANDBOX_GPU_GROUPS`; `ORCA_SANDBOX_IMAGE`
kept at live's actual `orca-dev:stable`):
```
$ docker stop -t 5 orca-live
$ docker rename orca-live orca-live-prev-cutover2   (newest instant fallback)
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
    orca-sandbox-orcad:cutover3-20260916 \
    --port 6768 --pairing-address wss://orca.simple-business-platform.com
```

First boot (`Up 22s (healthy)` — :6768 downtime = stop→rename→run window, seconds):
```
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Build: 0.0.0-orcad (b566b50de559c2f2)  <- NEW bundle hash (was cutover2's)
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```

Pairing survival: 9 → 9 devices, zero missing, zero drift on
`token/pairedAt/scope/name` (semantic diff before vs after); devices-file md5
moves across reads (`2c7cd057…` → `a4f1d716…`) from live `lastSeenAt` traffic
only. `orca-e2ee-keypair.json` md5 UNCHANGED (`f5a69bb807f3f57fc0abe38d8c106778`,
byte-identical). Pairings SURVIVED. (A fresh pending pairing row is minted in
the boot log, same as cutover-1 — normal.)

---

## Step 4 — e2e prove on live :6768, then archive

CLI: worktree `out/cli/index.js` via one-shot `orca-dev:stable`, saved env
`--environment live-cutover` (same as cutover-1/2).
```
$ worktree create --environment live-cutover --repo path:/src/agent-infra \
    --name cutover3-gpu --agent codex --prompt "Check git status, then wait idle..." → ok
$ (45s) docker ps → orca-sandbox-2eb2cf26 (orca-dev:stable) Up 47s
$ docker inspect orca-sandbox-2eb2cf26:
  Devices=[{PathOnHost:/dev/dri/renderD128 → PathInContainer, rwm}]  GroupAdd=["44","991"]
$ inside: ls -l /dev/dri → renderD128 (root:991, rw for our groups);
  id → groups=1000(ubuntu),44(video),991
$ worktree ps → cutover3-gpu | sandbox: running, status: active (iOS-visible)
```

Playwright proof (`docker exec` in the sandbox, global playwright 1.59.1,
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, headless, `page.evaluate`
`WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`):
1. Default headless-shell launch → `ANGLE (Google, Vulkan 1.3.0 (SwiftShader
   Device (Subzero) (0x0000C0DE)), SwiftShader driver)` — SwiftShader baseline.
2. Full chromium + xvfb → still SwiftShader. GPU-process log root cause:
   `Could not dlopen native EGL: libEGL.so.1: No such file or directory` —
   image has no system EGL (gl-egl backend can't init; Vulkan path also
   impossible: no ICD in `/usr/share/vulkan/icd.d/`).
3. Fix (proof sandbox ONLY, `docker exec -u 0`, throwaway container):
   `apt-get install -y libegl-mesa0 libegl1` → retry with
   `--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-sandbox` →
   **`ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 LLVM 20.1.2 DRM 3.64 7.0.0-31-generic), OpenGL ES 3.2)`**
   — HARDWARE AMD/radeonsi, NOT SwiftShader. PROVEN.
   (Driver-reported board name says navi22/6700 XT while the PCI id is
   73DF/Navi33-class — recorded verbatim; identity of the render node itself
   is unambiguous: it is the host dGPU's `0000:03:00.0`.)

Archive (production clean):
```
$ worktree rm --environment live-cutover --worktree path:.../agent-infra/cutover3-gpu --force → {"removed": true}
After: NO sandbox containers (2eb2cf26 gone with its apt-installed libEGL —
nothing persists); agent-infra dir clean; orca-live healthy on cutover3 image.
```

Untouched: nativelink ×2, sb-browser-node-1, tablet ×3; repo registrations;
`orca-runtime:*`; all prior `orca-live-prev*` fallbacks.

---

## Step 5 — rollback (NOT tested — cutover3 succeeded, :6768 left migrated)

Instant fallback (kept, stopped): `docker start orca-live-prev-cutover2`
(cutover2 image; GPUs then absent from NEW sandboxes only — existing ones keep
their devices). Older chain also kept stopped: `orca-live-prev-stable`,
`orca-live-prev`, `orca-live-prev-cutover1`.

No commits made (worktree `git status` shows only the pre-existing patch +
untracked `CUTOVER-LOG.md`/`PROVE.md`/`CUTOVER2-LOG.md`/this file — same shape
as before; sandbox sources were already untracked).

---

## Deliberately left out

- `libegl-mesa0`/`libegl1` (and optionally `mesa-vulkan-drivers` for the
  Vulkan/radv path) NOT baked into `orca-dev` — the proof sandbox got them via
  `docker exec -u 0` and was then destroyed. Next `orca-dev` rebuild should add
  them (plus keep `radeonsi_dri.so`) or every GPU proof pays an apt install.
- `/dev/dri/card1` NOT passed (render node suffices; modesetting unjustified).
- No `--gpus` (NVIDIA-only — N/A on this AMD host).
- `ORCA_SANDBOX_IMAGE` default stays `orca-dev:4`; live pins `orca-dev:stable`
  via env (unchanged by this round).
