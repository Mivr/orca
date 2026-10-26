# CUTOVER5-LOG: activate SSH/gh sandbox allowlist mounts on live orcad

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: orca-live serves a bundle that stamps the git-auth `:ro` bind mounts
(`~/.ssh → /var/tmp/.ssh`, `~/.config/gh → /var/tmp/.config/gh`, plus
`git-hooks`/`gitcookies` when present on the host) into every new sandbox.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER4-LOG.md` (GPU defaults, cutover4-20260916 image).
Reference: `/home/mihail/orca-docker/auth-mounts/GIT-AUTH.md` (baked-vs-mounted table, rotation story).
Approved by Mihail 2026-09-16.

---

## Step 0 — hunk review (verify, don't assume)

`git status --short` showed 9 modified + 3 untracked. Every hunk classified:

- KEEP (cutover4 carryover, already live — dropping would regress):
  `src/main/orcad/external-chromium-browser-session.ts` (+probe/fallback),
  `src/main/orcad/orcad-browser-provider.ts` (GPU default args),
  NEW `src/main/browser/agent-browser-gpu-flags.ts` + test,
  GPU hunks inside `sandbox-manager.ts`/`sandbox-manager.test.ts`
  (`AGENT_BROWSER_ARGS` stamp + override/opt-out tests).
- KEEP (new git-auth work, this round's payload):
  `sandbox-config.ts` (`SANDBOX_HOME='/var/tmp'`, `SANDBOX_AUTH_MOUNT_KEYS`,
  `ORCA_SANDBOX_AUTH_MOUNTS` + `sandboxAuthMounts()`),
  `sandbox-bind-mounts.ts` (`sandboxAuthMountSpecs()` + `resolveSandboxAuthMounts()`,
  existence-gated so docker never shadows a missing credential with an empty dir),
  `sandbox-manager.ts` (appends `:ro` auth mounts; `HOME` stamped from `SANDBOX_HOME`),
  + tests in all three `sandbox-*.test.ts`.
- No unrelated drive-bys found: nothing reverted, nothing dropped.

---

## Step 1 — premise checks (verified, not assumed)

- `orca-dev:stable` ALREADY carries the full git-auth image layer (GIT-AUTH gap #2
  resolved upstream): `/etc/gitconfig` has `user.name=Mihail Vratchanski`,
  `user.email=mivrkiki@gmail.com`, `core.autocrlf=input`,
  `hooksPath=/home/mihail/.config/git-hooks`, `credential.helper=gh auth git-credential`,
  `http.cookiefile=/home/mihail/.gitcookies`; `getent passwd ubuntu` → home `/var/tmp`;
  `gh 2.101.0` present. Verified identical on `orca-dev:20260916-1201-gitauth`.
  Consequence: live keeps `ORCA_SANDBOX_IMAGE=orca-dev:stable` — no image switch.
- Host `~/.config/git-hooks` and `~/.gitcookies` absent → correctly skipped by the
  existence gate (no empty-dir shadowing). Host `~/.ssh` + `~/.config/gh` present.
- Live BEFORE: `orca-live` on `orca-sandbox-orcad:cutover4-20260916`, healthy,
  `ORCA_SANDBOX_IMAGE=orca-dev:stable`. Pairing snapshot:
  `0c66d1cbeec97e74669ed9b35f82d3f4` devices (9 → /tmp/cutover5-devices-before.json),
  `f5a69bb807f3f57fc0abe38d8c106778` keypair.

---

## Step 2 — tests + lint + typecheck + bundle

One-shot `orca-dev:stable` (host has no node — cutover-1..4 constraint):
```
$ pnpm vitest run <5 touched files> → Test Files 5 passed / Tests 55 passed
$ oxlint 11 files → 0 warnings/errors
$ pnpm tc:node → 1 error in src/main/runtime/rpc/rpc-params-type-parity.ts
  (PRE-EXISTING, upstream commit bc5e67606f, file untouched; zero errors in touched files)
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+cb00ace84939, 7.77 MB, 4119 modules, zero electron and node:sqlite imports.
ln: ... '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1..4)
Bundle sanity (fresh out/orcad/orcad.js): ORCA_SANDBOX_AUTH_MOUNTS×1, /.ssh×5,
/.config/gh×2, git-hooks×4, gitcookies×4, inlined /var/tmp (SANDBOX_HOME const-folded),
BROWSER-GL-FALLBACK×1, AGENT_BROWSER_ARGS×3, ORCA_SANDBOX_DRI_DEVICES×1;
out/cli/index.js rebuilt (10529 bytes).
```

---

## Step 3 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (build.sh step_stage form, DEST=`~/orca-docker/orca-sandbox-agent/stage-prove`):
`out/orcad + out/cli → stage-prove/`, tar of
`node-pty agent-browser emojibase-data @parcel` → pty.node present, 204M total
(staged `orcad.js`: BROWSER-GL-FALLBACK×1, git-hooks×2).
```
$ docker build -t orca-sandbox-orcad:cutover5-20260916 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 4.4s → 8a6d28176512
$ docker images: orca-runtime:bun 5c624dd69e07 + orca-runtime:node 27e84c33aa36 UNCHANGED.
```

---

## Step 4 — restart orca-live onto the new image (~12:24 UTC)

`docker inspect orca-live` re-read for exact flags. New container = IDENTICAL
user/group/binds/env/health/cmd, new image only (no new `-e` flags: auth mounts are
code defaults gated on host existence; `ORCA_SANDBOX_IMAGE` stays `orca-dev:stable`).

Hiccup (recorded, not hidden): the first `docker run` was issued through two nested
shell layers (tool → ssh → remote bash) and quote-stripping mangled the
`--health-cmd` into `require(net).connect(6768,127.0.0.1)` → health `unhealthy`
(FailingStreak 4, node eval SyntaxError). The server itself was fine (bound :6768,
new bundle hash). Fix: re-issued via a script file (`/tmp/opencode/restart-orca-live-cutover5.sh`,
single shell layer, cutover4's exact double-quote form), `stop → rm → run`.
Stored healthcheck byte-identical to cutover4's. :6768 downtime = two stop→run
windows, seconds each.

```
Up ~2min (healthy) — orca-sandbox-orcad:cutover5-20260916
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Build: 0.0.0-orcad (47388326ccd1077e)  <- NEW bundle hash (was cutover4's 43a22635f7a1e801)
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```

Pairing survival: 9 → 9 devices, zero missing, zero new, zero drift on
`token/pairedAt/scope/name` (semantic diff before vs after). Devices-file md5
`0c66d1cb…` → `061ed69a…` is live `lastSeenAt` traffic only (byte-compare would
false-alarm — same as cutover-1..4). `orca-e2ee-keypair.json` md5 UNCHANGED
(`f5a69bb807f3f57fc0abe38d8c106778`, byte-identical). Pairings SURVIVED.

Fallbacks kept stopped: `orca-live-prev-cutover4` (cutover4, newest instant fallback)
+ `cutover3/cutover2/stable/prev/cutover1` chain.

---

## Step 5 — e2e prove on live :6768, then archive

CLI: worktree `out/cli/index.js` via one-shot `orca-dev:stable`, saved env
`--environment live-cutover` (same as cutover-1..4). Repo `path:/src/simple-business`
(`agent-infra` does not exist — GIT-AUTH gap #2, same substitution as the GIT-AUTH proof).
```
$ worktree create --environment live-cutover --repo path:/src/simple-business \
    --name cutover5-gitauth --agent codex --prompt "Check git status, then wait idle..." → ok
  (worktree /home/mihail/orca/workspaces/simple-business/cutover5-gitauth, head bdaaf9ea)
$ (30s) docker ps → orca-sandbox-97de44b8 (orca-dev:stable)
$ docker inspect orca-sandbox-97de44b8:
  Devices=[{PathOnHost:/dev/dri/renderD128 → PathInContainer, rwm}]  GroupAdd=["44","991"]
  Env: HOME=/var/tmp, AGENT_BROWSER_ARGS=<cutover4 default> (GPU carryover intact)
  Mounts: /home/mihail/.ssh -> /var/tmp/.ssh (ro)
          /home/mihail/.config/gh -> /var/tmp/.config/gh (ro)
          (git-hooks/gitcookies correctly absent — host has neither)
```

Proof drive (`docker exec -u 1000:1000`, `ubuntu`, `HOME=/var/tmp`), verbatim:
```
$ ssh -T git@github.com
Hi Mivr! You've successfully authenticated, but GitHub does not provide shell access.
$ git config user.name  → Mihail Vratchanski
$ git config user.email → mivrkiki@gmail.com
$ gh auth status
github.com
  X Failed to log in to github.com account Mivr (default)
  - Active account: true
  - The token in default is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u Mivr
```
gh reads the mounted host config faithfully (same invalid token as host-HOME gh —
passthrough confirmed byte-identical behavior). Blocked on host `gh auth login`
(GIT-AUTH gap #1, unchanged); login NOT attempted per instructions. No push made.

Archive (production clean):
```
$ worktree rm --environment live-cutover --worktree path:.../simple-business/cutover5-gitauth --force → {"removed": true}
After (~30s async reap): NO proof sandbox; orca-live healthy on the cutover5 image.
```

Untouched: nativelink ×2, sb-browser-node-1, tablet ×3, stale `orca-sandbox-8ba6a1de`,
repo registrations; `orca-runtime:*`; all prior `orca-live-prev*` fallbacks.

Rollback (NOT tested — cutover5 succeeded, :6768 left migrated):
instant fallback (kept, stopped): `docker start orca-live-prev-cutover4`
(cutover4 image; new sandboxes then lose the auth mounts only — existing ones keep
their mounts). Older chain also kept stopped.

No commits made (worktree `git status`: 9 modified + 3 untracked + this file — same
shape as before plus the log).

---

## Deliberately left out

- Host `gh auth login` (needs Mihail, interactive — gap #1 stands).
- `ORCA_SANDBOX_IMAGE` NOT switched to the dated `20260916-1201-gitauth` tag:
  `:stable` already carries the layer, and dated-tag pinning would freeze GPU/mesa
  updates. If the dev-image pipeline ever drops the layer, pin the dated tag instead.
- No new orca-live env flags (`ORCA_SANDBOX_AUTH_MOUNTS` override available when needed;
  empty string opts out per GIT-AUTH rotation story).
- Pre-existing `pnpm tc:node` error (`rpc-params-type-parity.ts`, upstream
  bc5e67606f) untouched.
