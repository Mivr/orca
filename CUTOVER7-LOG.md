# CUTOVER7-LOG: wire Orca's agent-status hook plane into docker sandboxes (all six coding CLIs)

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: hook HTTP posts from sandboxed agents reach orcad's agent-status store for
claude, codex, cursor-agent, grok, agy (antigravity) and opencode.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER6-LOG.md` (CLI-login `:rw` mounts, cutover6-20260916 image).
Approved by Mihail 2026-09-16, including the orca-live restart.

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-16 ~18:5x UTC)

```
$ docker ps: orca-live on orca-sandbox-orcad:cutover6-20260916, Up 4h (healthy)
$ orca-dev:stable = cc229e06ef57 (untouched this round)
$ orca-runtime:bun 5c624dd69e07 + orca-runtime:node 27e84c33aa36 (untouched)
```

Pairing snapshot: devices md5 `8ee13c86…` (9 → /tmp/opencode/cutover7-devices-before.json),
keypair md5 `f5a69bb8…`.

---

## Step 1 — host prerequisite: `orca agent hooks on`

One-shot `orca-dev:stable` (host has no node — cutover-1..6 constraint):
```
$ node out/cli/index.js agent hooks status   # all 14 not_installed (as briefed)
$ node out/cli/index.js agent hooks on --json
```
Result: `ok:true`. Installed: claude (`~/.claude/settings.json`), codex
(managed home `~/.config/orca/codex-runtime-home/home/hooks.json`, plus 8 trust
entries granted into `~/.codex/config.toml` via codex app-server), antigravity
(`~/.gemini/config/hooks.json`), cursor (`~/.cursor/hooks.json`), grok
(`~/.grok/hooks/orca-status.json`). Skipped (CLI not found, correctly):
openclaude, gemini, amp, droid, command-code, copilot, hermes, devin, kimi.
Opencode has no `hooks on` entry by design — its status plugin installs per-pty
via `OPENCODE_CONFIG_DIR` overlays (`OpenCodeHookService.buildPtyEnv`).

Managed scripts now on host: `~/.orca/agent-hooks/{antigravity,claude,codex,cursor,grok}-hook.sh`
(+ claude-statusline). All five shell-hook scripts POST-or-spool
(`|| spool_hook_event`); only the opencode node plugin lacked a spool fallback.

---

## Step 2 — premise checks (verified, not assumed)

- Hook commands embed the ABSOLUTE host path (`/home/mihail/.orca/agent-hooks/*.sh`,
  single-quote guarded; missing script degrades to silent no-op, never exit-127).
- Hook POSTs go to hardcoded `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}`. Sandboxes
  run on `bridge` (inspected `orca-sandbox-eaf08a75`) while orca-live runs
  `--network host` — sandbox loopback ≠ orcad. Gateway-IP POST is not an option
  (server binds 127.0.0.1 only, deliberately).
- The spool fallback + consumer already exist: every POSIX hook writes
  `$ORCA_AGENT_HOOK_ENDPOINT/spool/pane-*.jsonl` on POST failure, and
  `drainAgentHookSpool` replays them — but only at server STARTUP. No poller.
- Per-pane hook coords cannot ride the create-time env file: a container is
  shared per worktree while panes differ. They must cross per spawn via
  `docker exec -e` — i.e. `sandbox-exec-rewrite.ts` (daemon side), which only
  passed the static `pickSandboxEnv` allowlist (brief's file refs were
  approximate; create-time stamping would be wrong).
- Codex hooks live in the MANAGED home (`~/.config/orca/codex-runtime-home/home`,
  same path for desktop/CLI/orcad since none sets `ORCA_USER_DATA_PATH`), selected
  per spawn via `CODEX_HOME` — also dropped by the exec allowlist until now.
- `registerCleanup` REPLACES (orcad-lifecycle.ts:23) — a second registration
  would clobber the rpc/daemon-stop cleanup. The spool poller is cleared by the
  SAME first cleanup (declared `let` before it).

---

## Step 3 — orcad: hook-plane mounts + spawn-env + delivery (worktree, uncommitted)

New modules (300-line lint cap forbids growing the existing files; no
`max-lines` disables, no cap bumps per repo rules):
- `src/main/sandbox/sandbox-hook-mounts.ts` — `SandboxHookMountDirs`,
  `resolveSandboxHookMounts` (ensures orcad-owned spool + overlay dirs at
  admission: mounts freeze at create while spawns arrive later) and the 7 spec
  rows with per-mount ro/rw justification.
- `src/main/sandbox/sandbox-env-file.ts` — moved create-time env-file helpers
  (pure line-count split, zero behavior change).

Changed:
- `sandbox-config.ts` — 7 new auth-mount keys + `SANDBOX_HOOK_SPAWN_ENV_KEYS` /
  `pickSandboxHookSpawnEnv()` (hook port/token/env/version/transport/endpoint,
  pane/tab/worktree/launch-token, `CODEX_HOME`/`ORCA_CODEX_HOME`,
  `OPENCODE_CONFIG_DIR` + `ORCA_*` overlay vars, `GROK_HOME`).
- `sandbox-bind-mounts.ts` — delegates hook specs to the new module.
- `sandbox-manager.ts` — admission passes `hookDirs`; comment records why
  per-spawn coords ride exec, not create.
- `sandbox-exec-rewrite.ts` — appends `pickSandboxHookSpawnEnv` `-e` flags per
  spawn (the break-3 fix; verified live on the host `docker exec` cmdline).
- `status-plugin-post-source.ts` — opencode/mimo plugin gains `spoolHookEvent`
  (shell-hook spool record shape) on transport failure. Plugin digests re-pinned
  (`hook-service.test.ts`) + per-family source assertions.
- `server-lifecycle.ts` — public `drainSandboxHookSpool()` (same args as the
  startup drain; consume-on-replay makes interval polling safe).
- `orcad-entry.ts` — 5s `drainSandboxHookSpool()` poll iff
  `isSandboxRoutingEnabled()`, cleared by the existing cleanup.

Mount table (all existence-gated, never shadow):

| Mount | Mode | Why |
|---|---|---|
| `~/.orca/agent-hooks → /home/mihail/.orca/agent-hooks` | `:ro` | Absolute managed-hook command paths resolve verbatim (git-hooks precedent). Host `hooks on` owns content. |
| `~/.orca/agent-hooks → /var/tmp/.orca/agent-hooks` | `:ro` | `$HOME`-relative callers (remote-install shape). Same source. |
| `~/.gemini/config → /var/tmp/.gemini/config` | `:ro` | Only six-CLI hook config outside login mounts; host-preinstalled, never rewritten by the CLI. (claude/codex/cursor/grok configs already ride inside their `:rw` login mounts.) |
| orcad endpoint dir → same path | `:ro` | Hooks source `endpoint.env` for port/token; dir (not file) mount so orcad-restart rename-writes stay fresh. |
| orcad `spool/` → same path | `:rw` | THE delivery path: hook writers append, orcad drains. Nested under the `:ro` endpoint mount; inner wins. |
| codex-runtime-home → same path | `:rw` | hooks.json + mirrored sessions/state refresh in place (same reasoning as `~/.codex`). Same-path so any `CODEX_HOME` value works. |
| opencode overlays → same path | `:rw` | Per-pty plugin dirs; `OPENCODE_CONFIG_DIR` resolves verbatim. |

Delivery design (1 line): sandbox loopback POSTs fail by topology, so every hook
spools into the mounted spool dir and orcad's 5s poll drains it into the same
store — no server bind change, no hook-script change, reuses the designed
durable fallback (opencode plugin taught the same trick).

---

## Step 4 — tests + lint + typecheck + bundles

One-shot `orca-dev:stable`:
```
$ pnpm vitest run src/main/sandbox/ sandbox-exec-rewrite opencode/hook-service
  → 7 files / 84 tests pass (new: hook-mount keys/specs/modes, admission
    stamping incl. dir-ensuring, exec hook-env passthrough, plugin spool
    source per family; manager tests made hermetic via ORCA_USER_DATA* stubs)
$ pnpm exec oxlint <touched dirs/files> → 0 warnings/errors (unix format)
$ pnpm exec oxfmt --check → clean
$ pnpm tc:node → 1 error in src/main/runtime/rpc/rpc-params-type-parity.ts
  (PRE-EXISTING — file untouched, same file as CUTOVER4/5/6)
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+c624cf70194c, 7.78 MB, 4121 modules, zero electron and node:sqlite imports.
ln: ... '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1..6)
Bundle sanity (fresh out/orcad/orcad.js): drainSandboxHookSpool×2,
hook-spool×2, opencode-config-overlays×2, ORCA_AGENT_HOOK_ENDPOINT×33.
```

No `orca-dev` image change (Layer-26 empty parents already correct; docker-created
mountpoint parents suffice for `:ro` reads and the `:rw` leaves are host dirs).

---

## Step 5 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (`out/orcad + out/cli → ~/orca-docker/orca-sandbox-agent/stage-prove/`,
pty.node present, 204M; staged `orcad.js` carries the payload):
```
$ docker build -t orca-sandbox-orcad:cutover7-20260916 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 4.1s → b94355188625
$ docker images: orca-dev:stable cc229e06ef57 UNCHANGED; orca-runtime:bun/node UNCHANGED.
```

---

## Step 6 — restart orca-live onto the new image (~19:18 UTC)

`docker inspect orca-live` re-read; restart script
(`/tmp/opencode/restart-orca-live-cutover7.sh`, single shell layer) issues
stop → rename → run with IDENTICAL user/group/binds/env/health/cmd, new image
only (no new `-e` flags: hook mounts/env are code defaults; `ORCA_SANDBOX_IMAGE`
stays `orca-dev:stable`). :6768 downtime = one stop→run window, seconds.

```
Up ~1min (healthy) — orca-sandbox-orcad:cutover7-20260916
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Build: 0.0.0-orcad (a71425e1c975b981)  <- NEW bundle hash
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```

Daemon note: the terminal daemon is a separate process that orcad RESPAWNS —
post-restart ps shows a fresh `/app/daemon-entry.js` (cutover7 stage), so the
exec-rewrite change is live; pre-existing PTYs reattached (tests terminal kept
`hasAttachedPty: true`).

Pairing: 9 → 10 devices, zero missing, zero drift on
`token/pairedAt/scope/name/deviceId`. The +1 (`3de1a8ea…`, `CLI 9/16/2026`,
scope runtime) is orcad's OWN fresh boot pairing record — its id is embedded in
the Pairing URL the new orcad printed at boot. `orca-e2ee-keypair.json` md5
UNCHANGED (`f5a69bb8…`, byte-identical). Pairings SURVIVED. (The seven older
`CLI 9/15` records are prior cutover one-shot-CLI pairings, untouched.)

Fallbacks kept stopped: `orca-live-prev-cutover6` (cutover6, newest instant
fallback) + cutover5/4/3/2/test/cutover chain.

---

## Step 7 — e2e prove on live :6768, then archive

CLI: worktree `out/cli/index.js` via one-shot `orca-dev:stable`, saved env
`--environment live-cutover`. Repo `path:/src/simple-business`.

Sandbox A (`cutover7-agy` → `orca-sandbox-79ba8753`, `HOME=/var/tmp`):
inspected mounts carry ALL SEVEN hook rows with the table modes
(scripts-abs/home `:ro`, gemini-config `:ro`, endpoint `:ro`, spool `:rw`,
codex-runtime-home `:rw`, opencode-overlays `:rw`).
Host `docker exec` cmdline for the agent spawn shows the stamped per-spawn
coords (`ORCA_AGENT_HOOK_PORT/TOKEN/ENV/VERSION/TRANSPORT/ENDPOINT`,
`ORCA_PANE_KEY/TAB_ID/WORKTREE_ID/LAUNCH_TOKEN` — key names only recorded).

Drain poller proven live first: a synthetic spool record on the host dir was
consumed (truncated to 0 bytes) within 8s, no restart.

REAL agy turn: `--agent antigravity --prompt 'Reply with exactly the word ok…'`
ran in the sandbox on host auth → `worktree ps` showed
`antigravity | done` (agents[] non-empty) → host spool held the pane's drained
`pane-<leaf>.jsonl` (mtime = turn time). Full chain, real, no spend beyond the
approved trivial turn.

Per-CLI delivery (synthetic, real scripts, real pane, pane's real launch token,
`-i` for stdin — without `-i` the hook reads empty stdin and exits pre-spool,
a genuine pitfall hit once and fixed):

| CLI | Hook config path | Mount | Delivery → store |
|---|---|---|---|
| agy | `~/.gemini/config/hooks.json` | `:ro` NEW | REAL turn → spool → drain → `antigravity/done` in ps. |
| claude | `~/.claude/settings.json` (in `:rw` login mount) | — | Real script → spool → drain → `working`+prompt, `Stop`→`done`. |
| codex | managed home `hooks.json` (`:rw` NEW) | `:rw` NEW | Real script → spool → drain → prompt mutation in ps row. |
| cursor | `~/.cursor/hooks.json` (in `:rw` login mount) | — | Real script → spool → drain → prompt mutation in ps row. |
| grok | `~/.grok/hooks/orca-status.json` (in `:rw` login mount) | — | Real script → spool → drain → prompt mutation (+ persisted in `last-status.json`). |
| opencode | overlay plugin via `OPENCODE_CONFIG_DIR` (`:rw` NEW) | `:rw` NEW | SHIPPED plugin `spoolHookEvent` bytes executed in-sandbox → spool → drained; `SessionBusy` normalization unit-pinned. |

Attribution note: one pane holds one identity — the first prober (claude) took
the scratch pane, later probes mutated state/prompt under it. The launch-token
fence works: fake-token probes were silently dropped at drain (files still
consumed), real-token probes applied. Opencode type-attribution on a fresh pane
needs a real opencode turn (disallowed spend) — gap §8.3.

Archive (production clean):
```
$ worktree rm --environment live-cutover --worktree path:…/simple-business/cutover7-agy --force → {"removed": true}
After (~40s reap): NO proof sandbox (only pre-existing eaf08a75/8ba6a1de +
nativelink/tablet infra); worktree ps shows no cutover7 leftovers;
orca-live healthy on the cutover7 image.
```

Untouched: `orca-sandbox-31bc807e` (third-party proof box),
`orca-sandbox-8ba6a1de`, nativelink ×2, sb-browser-node-1, tablet ×3,
repo registrations; `orca-dev:stable`; `orca-runtime:*`; all prior
`orca-live-prev*` fallbacks (+ new `orca-live-prev-cutover6`).

Rollback (NOT tested — cutover7 succeeded, :6768 left migrated):
instant fallback (kept, stopped): `docker start orca-live-prev-cutover6`
(cutover6 image; new sandboxes then lose the hook plane only — existing
sandbox mounts keep working).

No commits made (worktree `git status`: 15 modified + 5 untracked + this file;
image untouched; orca-docker stage updated, uncommitted).

---

## Deliberately left out

- `ORCA_SANDBOX_IMAGE` stays `orca-dev:stable` (no baked hook files needed —
  everything is mounts + spawn env + drain).
- No gateway-IP POST / no `0.0.0.0` bind widening (rejected: token-auth loopback
  discipline stays; spool is the designed fallback).
- No sandbox-side hook install step: host pre-install + mounts cover all six
  paths, so post-create `docker exec` install is unnecessary (kept as fallback
  option if a CLI ever requires sandbox-local config writes).
- Pre-existing `pnpm tc:node` error (`rpc-params-type-parity.ts`) untouched.
- `:stable-tablet` untouched.

---

## Gaps left (need Mihail)

1. **cursor-agent keyring** (carried from cutover6): keyring-bound tokens don't
   live in files — unchanged by this round.
2. **Opencode type-attribution on a fresh pane**: delivery proven with shipped
   bytes, but a visible `opencode/*` row needs a real opencode turn (spend).
   If you want it closed: one trivial `opencode` prompt in a scratch sandbox.
3. **Codex lane selection**: both lanes mounted (`~/.codex` + managed home) and
   `CODEX_HOME` passes through; which lane a given spawn takes is orcad's
   account selection, unchanged.
4. **CLI device-record growth**: each one-shot CLI invocation pairs a new
   `CLI M/D/YYYY` runtime device (nine historical + this round's). Harmless,
   but prune-worthy someday.
5. **Hook token in host process table**: `docker exec -e ORCA_AGENT_HOOK_TOKEN=…`
   is visible in `ps` to host users (same exposure class as the existing
   `-e ANTHROPIC_API_KEY` flags; loopback-only value).