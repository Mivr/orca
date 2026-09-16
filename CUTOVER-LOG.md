# CUTOVER-LOG: live :6768 orcad → patched docker-exec image

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: production orcad serves the patched bundle so iOS shows docker sessions.
Rules: no other services touched; no commits; every command + output logged here.
Rollback: exact restart command for previous image (section 5).

---

## Step 1 — live state BEFORE any change (read-only inspection, 2026-09-16 ~06:35 UTC)

### 1a. `docker ps` (all containers)

```
$ docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
NAMES                         IMAGE                                 PORTS     STATUS
nativelink-worker             sb-nativelink-rbe:20260915-bdaaf9ea             Up 9 hours
orca-live                     orca-runtime:bun                                Up 10 hours (healthy)
orca-sess-grok-forge-orca-1   orca-dev:3                                      Up 10 hours
orca-sess-prove-1-orca-1      orca-dev:1                                      Up 10 hours
nativelink-store              sb-nativelink-rbe:v1.6.3-fixed                  Up 10 hours
```

```
$ docker ps -a (extra row vs above)
orca-orca-1  orca-runtime:bun  Exited (0) 10 hours ago
```

Finding: current live name is **`orca-live`** (confirms brief note: supervisor
rotated `orca-orca-1` → `orca-live` mid-prove). The old compose container
`orca-orca-1` is Exited (0), kept as a corpse. `orca-live` has **no compose
labels** (`Config.Labels={}`) → it is a plain `docker run` container, NOT
compose-managed (`docker compose ps` in ~/orca-docker returns empty).
No supervisor process manages it (only `restart: unless-stopped` + docker);
`watch-fleet.sh` is an unrelated opencode-session watcher. Tunnel is a host
user unit, independent of the container.

### 1b. Live container identity / image / command

```
$ docker inspect orca-live --format Image/Cmd/User
Image=orca-runtime:bun
Entrypoint=["bun","/app/orcad.js"]
Cmd=["--port","6768","--pairing-address","wss://orca.simple-business-platform.com"]
User=1000:1000
Created=2026-09-15T20:55:50Z   Started same (Up 10h)
RestartPolicy=unless-stopped   NetworkMode=host   Health=healthy
```

Previous-image corpse for reference:
```
$ docker inspect orca-orca-1
Image=orca-runtime:bun  Created=2026-09-15T17:36:19Z  Exited (0)
Labels: com.docker.compose.project=orca,
  project.config_files=/home/mihail/orca-docker/compose.yml  (compose-created)
Env: same ORCA_USER_DATA/HOME set as orca-live (see 1c)
```

### 1c. Live env (pairing-critical)

```
$ docker inspect orca-live --format '{{json .Config.Env}}'
HOME=/home/mihail
ORCA_USER_DATA=/home/mihail/.orca-orcad-data
ORCA_VERSION=0.0.0-orcad
ORCA_DAEMON_EXEC_PATH=/usr/local/bin/node
(+ bun-image defaults: PATH, NODE_VERSION=24.21.0, NODE_ENV=production,
  NODE_PATH=/app/node_modules)
```

Notable ABSENCES vs what the patched image needs: no `ORCA_SANDBOX_AGENTS`,
no `ORCA_SANDBOX_BIND_MAP`, no docker group, no docker.sock mount,
no `docker` CLI inside (`which docker` → empty; only node + bun present).

### 1d. Live mounts (pairing-critical — must be identical after)

```
$ docker inspect orca-live mounts/binds
Binds: ['/home/mihail:/home/mihail']   (same-path, RW, rprivate)
GroupAdd: None
```

Single bind: host `/home/mihail` → container `/home/mihail`. Pairings live in
`/home/mihail/.orca-orcad-data` (inside that bind): `orca-devices.json`,
`orca-e2ee-keypair.json`, daemon socket dir, orchestration.db — all present.
`ORCA_USER_DATA` is an env pointer into that same bind (not a separate mount).

Live orcad processes (host view): `bun /app/orcad.js --port 6768 ...` (pid
756353) + `/usr/local/bin/node /app/daemon-entry.js --socket
/home/mihail/.orca-orcad-data/daemon/daemon-v36.sock ...` (pid 756430).

### 1e. Port / health / tunnel

```
$ ss -ltnp | grep 6768
LISTEN 127.0.0.1:6768  users:(("bun",pid=756353,fd=19))
$ docker inspect orca-live --format Health → "healthy"
$ systemctl --user status orca-tunnel.service → active (running) since
  2026-09-15 17:36:32 UTC; ExecStart cloudflared tunnel run (sb-orca token);
  target http://127.0.0.1:6768 (per unit desc + "dial tcp 127.0.0.1:6768" errors
  in its log during the brief :6768 outage window on 9/15 19:03).
```

orcad log tail: `Orca server ready / Bound endpoint: ws://127.0.0.1:6768 /
Advertised endpoint: wss://orca.simple-business-platform.com / Build:
0.0.0-orcad (6a54be58...) / Terminal daemon: live — PTY self-test passed`.

Note: HTTP GET / and /health on :6768 return empty/000 — orcad speaks
ws/pairing, not HTTP; health is judged via docker HEALTHCHECK (tcp connect)
+ `worktree ps` over pairing (step 4).

### 1f. Compose baseline (for reference only — live is NOT compose-managed)

`~/orca-docker/compose.yml`: project `orca`, service `orca`,
`image: ${ORCA_IMAGE:-orca-runtime:bun}`, `network_mode: host`,
`user: "1000:1000"`, volume `/home/mihail:/home/mihail`, env
`ORCA_VERSION/ORCA_DAEMON_EXEC_PATH/HOME=/home/mihail/ORCA_USER_DATA=/home/mihail/.orca-orcad-data`,
`command: --port ${ORCA_PORT:-6769} ${ORCA_PAIRING_ADDRESS:+...}`.
Live's actual `--port 6768 --pairing-address wss://...` corresponds to
`ORCA_PORT=6768 ORCA_PAIRING_ADDRESS=wss://orca.simple-business-platform.com`.

### 1g. Pre-change git state of worktree (patch = uncommitted changes, NOT committed)

```
$ git status --short / git diff --stat (same before and after — no commits allowed)
 M src/cli/workspace-format.ts
 M src/main/daemon/daemon-pty-session-spawn.ts
 M src/main/daemon/pty-subprocess.ts
 M src/main/orcad/orcad-entry.ts
 M src/main/runtime/orca-runtime-get-worktree-ps.ts
 M src/main/runtime/orca-runtime-resolve-worktree-removal-target.ts
 M src/shared/runtime-worktree-contracts.ts
?? PROVE.md, src/main/sandbox/*, sandbox-exec-rewrite*, orcad-host-adapters*,
   orcad-sandbox-reaper*
```

---

## Step 2 — build patched runtime image from THIS worktree (new tag)

Build host: inside `orca-sess-prove-1-orca-1` (has node/pnpm, runs as uid 1000,
sees this worktree via the `/home/mihail` same-path bind) — same build path as
prove. Host itself has no node/pnpm (`which node pnpm` → not found), so host
build was not an option.

```
$ docker exec orca-sess-prove-1-orca-1 bash -lc 'cd
  /home/mihail/sw_projects/orca-wt/docker-sandbox && pnpm install
  --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli'
Scope: all 2 workspace projects / Lockfile ... up to date
[build-orcad] ok — 0.1.0+02e4b4f57623, 7.77 MB, 4118 modules, zero electron
  and node:sqlite imports.
[cli-bin] verified out/cli/index.js (10529 bytes)
ln: failed to create symbolic link '/usr/local/bin/orca-dev': Permission
  denied  ← benign dev-convenience symlink only; correctly NOT sudo'd, skipped.
```

Bundle sanity (fresh `out/orcad/orcad.js`): `sandbox`×15, `sandbox_slots_full`×2,
`orca.sandbox.worktree`×1, `ORCA_SANDBOX_AGENTS`×1 — and byte-identical to the
prove-stage bundle (`cmp` IDENTICAL for both `orcad.js` and `daemon-entry.js`;
`daemon-entry.js` carries 0 `sandbox` refs in BOTH, matching the proven shape).

Restage (mirrors `build.sh step_stage`, SRC=this worktree, DEST=stage-prove):
```
$ rm -rf stage-prove && mkdir -p stage-prove/node_modules
$ cp -a out/orcad + out/cli → stage-prove/
$ tar -C node_modules --dereference node-pty agent-browser emojibase-data @parcel \
  | tar -C stage-prove/node_modules -xf -
STAGE-OK: pty.node present / 204M total
```

Image (same Dockerfile path as prove, NEW tag; `orca-runtime:*` never touched):
```
$ docker build -t orca-sandbox-orcad:cutover-20260916 \
    -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE — naming to orca-sandbox-orcad:cutover-20260916 (layers cached: stage
  content byte-identical to prove; tag is what differs)
$ docker images → orca-sandbox-orcad:cutover-20260916 (e26ea8bb1d40) alongside
  orca-sandbox-orcad:test (b18bed23c3fd); orca-runtime:bun (5c624dd69e07) and
  orca-runtime:node (27e84c33aa36) UNCHANGED (ids match step 1).
$ docker run --rm --entrypoint bash orca-sandbox-orcad:cutover-20260916 -lc
  'which docker node; docker --version'
/usr/bin/docker / docker 20.10.24 / node v24.21.0  ← docker CLI present (live
  image lacks it), node entrypoint as in prove.
```

Pre-restart pairing snapshot (assert survival after):
```
$ python3: orca-devices.json → 7 devices (all "CLI 9/15/2026", scope runtime)
$ md5sum orca-devices.json → 7d876afe80b77e14cc645db9aaeab72e
$ md5sum orca-e2ee-keypair.json → f5a69bb807f3f57fc0abe38d8c106778
```

---

## Step 3 — restart ONLY orcad onto the new image (live :6768)

Strategy: keep the original container as instant fallback (`orca-live-prev`,
stopped, image `orca-runtime:bun`), run the new image as `orca-live`.
No other service touched (nativelink ×2, sess ×2 all kept their uptimes).

```
$ docker stop orca-live
orca-live
$ docker ps -a | grep orca-live → Exited (0); :6768 DOWN (expected, ~10s window)
$ docker rename orca-live orca-live-prev
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
    --health-cmd='node -e "require(...).connect(6768,...)"' \
    --health-interval=15s --health-timeout=5s --health-start-period=60s \
    --health-retries=3 \
    orca-sandbox-orcad:cutover-20260916 \
    --port 6768 --pairing-address wss://orca.simple-business-platform.com
b7c39863c2940bbc66226e6e7a1bb576d38c18ec7622b9af8c8ac2d5e8ee3da3
```

Mount/env assertion (before → after):
- bind `/home/mihail:/home/mihail` (RW, rprivate): IDENTICAL.
- `ORCA_USER_DATA=/home/mihail/.orca-orcad-data`: IDENTICAL (env pointer into
  that same bind — pairings' home).
- Additions (sandbox-enabling, pairings-neutral): `orca-src:/src` volume,
  `/var/run/docker.sock` bind, `--group-add 988` (docker), `ORCA_SANDBOX_AGENTS=1`,
  `ORCA_SANDBOX_BIND_MAP`, live-identical healthcheck flags.
- Entry point change (intended): `bun /app/orcad.js` → `node /app/orcad.js`
  (same as reference `orca-runtime:node` + docker CLI; prove-validated).

First boot:
```
$ docker ps → orca-live  orca-sandbox-orcad:cutover-20260916  Up 12s (healthy)
$ docker logs orca-live
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Advertised endpoint: wss://orca.simple-business-platform.com
Build: 0.0.0-orcad (ff7f2d4a727a265a)  ← NEW bundle hash (was 6a54be58): patched
  bundle is serving. Node 24.21.0 ABI 137.
Terminal daemon: live — PTY self-test passed; terminals survive restart: yes
  ← adopted the pre-existing daemon socket in ORCA_USER_DATA, no terminal loss.
```

Pairing survival: all 7 pre-existing devices byte-identical
(tokens/timestamps); +1 pending row for the freshly minted pairing URL
(`aaee0c43…`, lastSeen 0 at mint). `orca-e2ee-keypair.json` md5 UNCHANGED
(f5a69bb807f3f57fc0abe38d8c106778). Pairings SURVIVED.

---

## Step 4 — verify on live :6768

- `:6768 healthy`: YES — `Up (healthy)`, healthcheck passing since boot.
- Tunnel connected: YES — `orca-tunnel.service` active; refused-origin errors
  only inside the ~10s stop window (06:33:48–51), zero errors after the new
  container came up (quiet at 06:34+ and 5-min check).
- `worktree ps` works: YES — `ok:true` over pairing (see host-scope note below).
- ONE test worktree from `/src/agent-infra` + agent → `sandbox:running` →
  session visible in orcad API (= iOS list): YES (details below).
- Test worktree ARCHIVED, production left clean: YES.

Host-scope note (read-only discovery, no code change): unscoped `worktree ps`
over a fresh pairing returns zero rows with `omittedHostIds: ["local"]` when
the runtime genuinely tracks zero worktrees — that was live's idle state, not
an error (same via public-wss and via endpoint-swapped `ws://127.0.0.1:6768`
pairing code, so no loopback dependence). After creating the test worktree the
same call covered `hostIds: ["local"]` with full rows.

```
$ repo add --path /src/agent-infra → ok, id 4b2dad1c-2e58-4ece-93c8-55054255aa1a
$ worktree create --repo path:/src/agent-infra --name cutover1 --agent codex \
    --prompt "Check git status..., then wait..." → ok,
  id 4b2dad1c…::/home/mihail/orca/workspaces/agent-infra/cutover1,
  agentTerminalHandle term_55485b86-fcb1-4f4b-8756-cf8579699f05
$ (45s) docker ps → orca-sandbox-519ec545 (orca-dev:3) Up 50s  ← sandbox created
$ worktree ps --json → total 2, scope {hostIds:[local], omitted:[]}:
  cutover1 | sandbox: running      ← iOS-VISIBLE SESSION PROOF
  main     | sandbox: absent
  Full row: sandbox "running", liveTerminalCount 1, hasAttachedPty true,
    status active.
  Text:  agent-infra refs/heads/cutover1 host=local live:1 pty:yes unread:no
    sandbox:running
$ docker top orca-sandbox-519ec545 → sleep infinity; bash --rcfile
  .../shell-wrappers/.../shell-ready/bash/rcfile; node /usr/bin/codex ...;
  native codex vendor binary  ← agent genuinely executing INSIDE the sandbox.
$ worktree rm --worktree path:/home/mihail/orca/workspaces/agent-infra/cutover1 \
    --force → {"removed": true}
  After: NO sandbox containers; ps shows only main/absent; worktree dir gone
    (only standard `.orca-worktree-trash` left under agent-infra/).
```

Leftovers (inert, noted): `/src/agent-infra` repo registration stays on the
live data root (same precedent as the existing `prove-repo-*` entries — metadata
only, no worktree); saved CLI env `live-cutover` (083d1cc5…) in local CLI config
for future checks; verification pairing row `aaee0c43…` now seen (like the 7
existing CLI rows). No commits made (git status shows only the pre-existing
patch + untracked PROVE.md/CUTOVER-LOG.md).

---

## Step 5 — rollback (NOT tested — cutover succeeded, :6768 left migrated)

Instant fallback (kept, stopped): `docker start orca-live-prev`
(original `orca-runtime:bun` container, pre-cutover state).

Full previous-image restart command (exact live params, for rebuild if needed):
```
docker run -d --name orca-live --network host --user 1000:1000 \
  --restart unless-stopped \
  -v /home/mihail:/home/mihail \
  -e HOME=/home/mihail \
  -e ORCA_USER_DATA=/home/mihail/.orca-orcad-data \
  -e ORCA_VERSION=0.0.0-orcad \
  -e ORCA_DAEMON_EXEC_PATH=/usr/local/bin/node \
  orca-runtime:bun \
  --port 6768 --pairing-address wss://orca.simple-business-platform.com
```

Final container set: `orca-live` (new image, healthy) + stopped `orca-live-prev`
+ exited `orca-orca-1` corpse (pre-existing). All other services untouched.

