# CUTOVER6-LOG: persist all six coding-CLI logins across sandbox sessions

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: every sandbox stamps `:rw` bind mounts for the six CLI auth stores
(claude, codex, cursor-agent, grok, agy, opencode) so logins survive session
respawn; static git identity stays `:ro`. Image carries empty state parent
dirs only — zero secret bytes.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER5-LOG.md` (ssh/gh allowlist live, cutover5-20260916 image).
Reference: `/home/mihail/orca-docker/auth-mounts/GIT-AUTH.md` (baked-vs-mounted,
rotation story, ssh-trap history). Approved by Mihail 2026-09-16, including restart.

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-16 ~14:2x UTC)

```
$ docker ps: orca-live on orca-sandbox-orcad:cutover5-20260916, Up 2h (healthy)
$ docker images orca-dev: :stable = 73cfddd7a0d5 (= 20260916-1409-8535fda56)
```

Pairing snapshot: devices md5 `d4013c14…` (9 entries →
/tmp/opencode/cutover6-devices-before.json), keypair md5 `f5a69bb8…`.

---

## Step 1 — premise checks (verified, not assumed)

- Host auth ground truth — all eight paths exist (stat only, values never
  printed): `~/.claude.json` (file 600), `~/.claude/.credentials.json`
  (600, dir 700), `~/.codex/auth.json` (600), `~/.cursor/` (dir),
  `~/.grok/auth.json` (600), `~/.gemini/antigravity-cli/` (dir),
  `~/.config/gcloud/` (dir), `~/.local/share/opencode/` (dir, holds
  `auth.json` 600 + live `opencode.db` + `-shm`/`-wal`).
- `orca-dev:stable` (pre-change) has NO state dirs under `/var/tmp`
  (only `/var/tmp` itself) but already has the passwd-home fix
  (`ubuntu … /var/tmp`) + `/etc/gitconfig` identity (Layer 21) + all six
  CLI binaries. So only an additive state-dirs layer was needed.
- No `agent-infra` checkout on the live path and no `publish.sh` outside
  scratch clones — so per the brief a FRESH clone was made:
  `git clone git@github.com:Mivr/agent-infra.git /tmp/opencode/agent-infra`
  (@ `ae3eff2a3`, clean). The brief's paths (`images/orca-dev/` +
  `publish.sh`) exist there; canonical Dockerfile = that clone's
  `images/orca-dev/Dockerfile` (440 lines, superset of dev-image's).
- Sandbox HOME is `/var/tmp` (passwd home + stamped `$HOME` agree — the
  GIT-AUTH ssh-trap fix), so all destinations hang under `/var/tmp/<name>`,
  mirroring the `/var/tmp/.ssh` pattern. Manager stamps only `HOME`
  (`XDG_DATA_HOME` is NOT in the env allowlist), so `~/.local/share/*`
  and `~/.config/*` resolve under `/var/tmp` with zero per-tool overrides.
- Hunk review: worktree held cutover4 (GPU) + cutover5 (git-auth) carryover,
  uncommitted. All kept; this round only extends the same sandbox files.

---

## Step 2 — image: state dirs + perms, no secrets (fresh clone, publish.sh)

`images/orca-dev/Dockerfile` +24 lines (Layer 26, before `WORKDIR`):
baked EMPTY dirs `chown 1000:1000`, `0700` where creds live
(`/var/tmp/.claude .codex .cursor .grok .gemini/antigravity-cli
.config/gcloud .local/share/opencode`), `0755` parents
(`.gemini .config .local .local/share`; `.config/gh` fallback unchmodded
755, same as the Layer-21 pointer pattern). `~/.claude.json` (a FILE)
needs no baked path — parent `/var/tmp` exists and the file mount lands
directly. When a host source is absent the orcad existence-gate skips the
mount and the tool sees this safe fallback instead of a docker-created
root-owned dir.

Secret assert (TAGS.md pattern, re-run pre-publish): `grep -rniE
'BEGIN …PRIVATE KEY|api[_-]?key|bearer|session[_-]?token|gh[pousr]_…|
sk-ant-|xox[bpas]-|AKIA…'` over `images/orca-dev/` hits ONLY doc'd
env-var NAMES in `VERSIONS.md`/`TAGS.md` (known-clean) — no Dockerfile
hit, no secret bytes in any layer (verified post-build: zero files under
the new dirs; `ls -ld` shows `ubuntu ubuntu` + modes above).

Publish (single writer, base line only — tablet line untouched):
```
$ bash images/orca-dev/publish.sh   # flock, dated build, smoke gate, move :stable
[publish] OK orca-dev:20260916-1433-ae3eff2a3 -> orca-dev:stable
```
New image `cc229e06ef57`; post-publish smoke all `SMOKE-OK`
(6 CLIs + buck2 pin + agent-browser + chromium + libEGL + 5 sb_* +
sb-index + cargo-absent). `:stable-tablet` NOT moved.

---

## Step 3 — orcad: `:rw` login mounts (worktree, uncommitted, no commits)

- `sandbox-config.ts`: `SANDBOX_AUTH_MOUNT_KEYS` 4 → 12
  (`+ claude-json claude codex cursor grok gemini-antigravity gcloud
  opencode`). Same `ORCA_SANDBOX_AUTH_MOUNTS` default-all/subset/empty
  pattern, unknowns ignored.
- `sandbox-bind-mounts.ts`: spec gains `mode: 'ro'|'rw'`;
  `resolveSandboxAuthMounts` emits `src:dst:mode`. Destinations all under
  `SANDBOX_HOME` except the two absolute gitconfig pointers (unchanged).
- `sandbox-manager.ts`: comment updated (mixed ro/rw + trust reasoning).

ro/rw per path (justification in code comments):

| Mount | Mode | Why |
|---|---|---|
| `~/.ssh`, `~/.config/gh`, git-hooks, gitcookies | `:ro` (unchanged) | Static identity; rotation is host-side re-login + respawn. Sandbox writes could corrupt host git access — no write-back needed. |
| `~/.claude.json` (file), `~/.claude/` | `:rw` | CLI rewrites both on refresh. |
| `~/.codex/` | `:rw` | `auth.json` + sessions refresh in place. |
| `~/.cursor/` | `:rw`, BEST EFFORT | File state carries over; a libsecret/keyring-bound token does NOT live in files and will NOT persist via mount (gap §8). |
| `~/.grok/` | `:rw` | OAuth session + quota state refresh in place. |
| `~/.gemini/antigravity-cli/`, `~/.config/gcloud/` | `:rw` | gcloud `credentials.db`/`access_tokens.db` rewrites FAIL under `:ro` (SECRETS.md caveat) — `:rw` is what makes refresh work. |
| `~/.local/share/opencode/` | `:rw` | `auth.json` refresh + daemon SQLite writes would break under `:ro`. Same-file bind mount keeps SQLite locking correct (one fs, fcntl serializes host+sandbox writers). |

Trust reasoning (code comments + here): the sandbox already holds the
worktree + main `.git` `:rw` — a `:rw` auth mount adds no new trust
boundary. Host-owned files, never baked, never logged.

---

## Step 4 — tests + lint + typecheck + bundles

One-shot `orca-dev:stable` (host has no node — cutover-1..5 constraint):
```
$ pnpm vitest run <3 sandbox files> → 3 files / 37 tests pass
  (config 11, bind-mounts 12 incl. new :rw + wrong-kind tests,
   manager 14 incl. new CLI-:rw + strengthened opt-out tests)
$ pnpm exec oxlint <6 touched> → 0 warnings/errors; oxfmt --write applied
$ pnpm tc:node → 1 error in src/main/runtime/rpc/rpc-params-type-parity.ts
  (PRE-EXISTING — file untouched by this round, same file as CUTOVER4/5)
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+6fe7c6c6c924, 7.77 MB, 4119 modules, zero electron and node:sqlite imports.
ln: ... '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1..5)
Bundle sanity (fresh out/orcad/orcad.js): ORCA_SANDBOX_AUTH_MOUNTS×1,
gemini-antigravity×2, BROWSER-GL-FALLBACK×1 (carryover); out/cli/index.js rebuilt.
```

---

## Step 5 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (`out/orcad + out/cli → ~/orca-docker/orca-sandbox-agent/stage-prove/`,
node-pty tar → pty.node present, 204M; staged `orcad.js` carries the new keys):
```
$ docker build -t orca-sandbox-orcad:cutover6-20260916 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 4.0s → 00767a5f4557
$ docker images: orca-runtime:bun 5c624dd69e07 + orca-runtime:node 27e84c33aa36 UNCHANGED.
```

---

## Step 6 — restart orca-live onto the new image (~14:3x UTC)

`docker inspect orca-live` re-read; restart script
(`/tmp/opencode/restart-orca-live-cutover6.sh`, single shell layer —
cutover5 quote lesson) issues stop → rename → run with IDENTICAL
user/group/binds/env/health/cmd, new image only. `ORCA_SANDBOX_IMAGE`
stays `orca-dev:stable` (now the dated cutover6 image — TAGS.md
recommendation, CUTOVER5 precedent; no bundle env change needed).
:6768 downtime = one stop→run window, seconds.

```
Up ~1min (healthy) — orca-sandbox-orcad:cutover6-20260916
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Build: 0.0.0-orcad (6b54127ff3de3582)  <- NEW bundle hash (was cutover5's 47388326ccd1077e)
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```

Pairing survival: 9 → 9 devices, zero missing, zero new, zero drift on
`token/pairedAt/scope/name/deviceId` (semantic diff). Devices-file md5
`d4013c14…` → `3a64a66d…` is live `lastSeenAt` traffic only (byte-compare
would false-alarm — same as cutover-1..5). `orca-e2ee-keypair.json` md5
UNCHANGED (`f5a69bb8…`, byte-identical). Pairings SURVIVED.

Fallbacks kept stopped: `orca-live-prev-cutover5` (cutover5, newest
instant fallback) + cutover4/3/2/stable/prev/cutover1 chain.

---

## Step 7 — e2e prove on live :6768, then archive

CLI: worktree `out/cli/index.js` via one-shot `orca-dev:stable`, saved env
`--environment live-cutover`. Repo `path:/src/simple-business`.

Sandbox A (`cutover6-authA` → `orca-sandbox-c0561a98`, image
`cc229e06ef57` = the dated cutover6 image, `HOME=/var/tmp`,
GPU `AGENT_BROWSER_ARGS` carryover intact):
```
Mounts: .claude→/var/tmp/.claude:rw  .claude.json→/var/tmp/.claude.json:rw
  .codex:rw  .cursor:rw  .grok:rw  gcloud:rw  antigravity-cli:rw  opencode:rw
  .ssh:ro  .config/gh:ro  (git-hooks/gitcookies correctly absent — host has neither)
```

Marker proof (no real logins needed): A wrote `CUTOVER6-A` into each of the
7 login DIRS — B (`cutover6-authB` → `orca-sandbox-c0561a99`) `cat`s all 7
back byte-identical; all 7 were also `ls`-visible on the HOST (rw
write-back proven both directions). For the `~/.claude.json` FILE mount
(a separate marker file would corrupt the real token): A `touch`ed it —
mtime `1789569578` observed in A, in B, AND on the host (shared inode,
rw proven) while sha256 stayed `8e579a70…` before/after (content intact).
Markers `rm`d from host after B-verify (dirs pristine; only the harmless
mtime bump remains). Token-file hashes sandbox↔host identical throughout
(hashes only, values never printed).

Real-token proof, read-only, no spend, no writes (host already logged in):
- codex: `codex login status` → `Logged in using ChatGPT` (rc 0) in A and B.
- claude: `claude auth status` → `loggedIn:true`, `mivrkiki@gmail.com`,
  `configDirectory:/var/tmp/.claude` (the MOUNTED path) in A and B.
- grok: `grok models` → first `You are not authenticated` on a STALE host
  token — then the host's own `grok models` run refreshed `auth.json`
  (mtime 14:40:38) and the sandbox instantly saw the fresh bytes
  (same sha256 `e647fc1a…` both sides — live refresh propagation through
  the rw mount) → `You are logged in with grok.com.` in A and B.
  Diagnosis notes: same binary both sides (`1.0.30 04b7ffed98c6`), no
  `~/.config/grok`, no `GROK_*` env, no Secret Service on the host bus,
  x.ai reachable from the sandbox (403/401 bare probes) — the verdict
  followed the token bytes, not the mount.

Archive (production clean):
```
$ worktree rm --environment live-cutover --worktree path:…/cutover6-authA --force → {"removed": true}
$ worktree rm --environment live-cutover --worktree path:…/cutover6-authB --force → {"removed": true}
After (~30s reap): NO proof sandboxes; worktree ps shows no cutover6 leftovers;
orca-live healthy on the cutover6 image.
```

Untouched: `orca-sandbox-31bc807e` (third-party proof box),
stale `orca-sandbox-8ba6a1de`, nativelink ×2, sb-browser-node-1, tablet ×3,
repo registrations; `orca-runtime:*`; all prior `orca-live-prev*` fallbacks.

Rollback (NOT tested — cutover6 succeeded, :6768 left migrated):
instant fallback (kept, stopped): `docker start orca-live-prev-cutover5`
(cutover5 image; new sandboxes then lose the CLI-login mounts only —
existing ones keep their mounts). Older chain also kept stopped.

No commits made (worktree `git status`: 9 modified + 4 untracked — same
shape as cutover5 plus this file; image change lives in the fresh
`/tmp/opencode/agent-infra` clone, also uncommitted).

---

## Deliberately left out

- Host `gh auth login` (needs Mihail, interactive — GIT-AUTH gap #1 stands;
  sandbox `gh` still reports the host-identical invalid token).
- `:stable-tablet` NOT moved (tablet line untouched by publish.sh this round).
- No new orca-live env flags (`ORCA_SANDBOX_AUTH_MOUNTS` subset/empty
  opt-out available; e.g. `codex,opencode` subset covered by unit test).
- No `docker build -t orca-dev:<floating>` outside `publish.sh` (single
  writer); `:stable` moved only by the script (flock-serialized).
- Pre-existing `pnpm tc:node` error (`rpc-params-type-parity.ts`) untouched.

---

## Gaps left (need Mihail)

1. **cursor-agent keyring**: if the cursor login is keyring-bound
   (libsecret/OS keychain), the `:rw` dir mount carries file state only —
   the login will NOT persist into sandboxes. Unfixable via mounts (a
   headless container has no Secret Service; forwarding the host bus would
   blow the trust boundary). If cursor shows logged-out in-sandbox while
   the host is logged in, this is why — re-login file-side or accept it.
2. **grok token expiry**: an expired host `auth.json` reads "not
   authenticated" in-sandbox until the host refreshes (observed live above;
   refresh propagates instantly, no respawn needed). Rotation story holds:
   refresh on host, keep working.
3. **`~/.claude.json` mtime bump** (`1789569578`) from the file-mount rw
   proof — content hash unchanged; cosmetic only, noted so it never
   reads as tampering.
