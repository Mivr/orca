# CUTOVER2-LOG: sandbox-image bump orca-dev:3 → orca-dev:4 (all 6 CLIs) + e2e re-prove

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Goal: live orcad stamps `orca-dev:4` (all six agent CLIs baked) instead of hardcoded `orca-dev:3`.
Rules: :6768 downtime in seconds; any surprise → roll back to fallback, report; no commits.
Previous round: `CUTOVER-LOG.md` (cutover-20260916 image, :3 default, cutover1 e2e).

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-16 ~06:54 UTC)

```
$ docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
orca-sandbox-1a3065c1  orca-dev:3                            Up 8 min   <- prev-round e2e-cli sandbox
orca-sandbox-14d2e4a2  orca-dev:3                            Up 9 min   <- Test-the-env (not ours)
orca-live              orca-sandbox-orcad:cutover-20260916   Up 10 min (healthy)
orca-live-prev         orca-runtime:bun                      Exited (0) (cutover-1 fallback, kept stopped)
nativelink-worker / nativelink-store / orca-sess-*           untouched
```

Note: `orca-live` (created 06:33:53Z at cutover-1) shows `StartedAt 06:44:28Z` —
something restarted it ~10 min after cutover-1. Healthy, serving cutover-1 bundle
(`ff7f2d4a727a265a` per cutover-1 log). No action taken; used as-is as the baseline.

Pairing snapshot (pre-change):
```
$ md5sum orca-devices.json orca-e2ee-keypair.json
71ab6913b584d120e4fc63d35520908c  orca-devices.json   (9 devices, saved to /tmp/cutover2-devices-before.json)
f5a69bb807f3f57fc0abe38d8c106778  orca-e2ee-keypair.json
```
(devices md5 drifted since cutover-1's `7d876afe…` — live `lastSeenAt` traffic, not loss;
semantic check in step 3 confirms all rows intact.)

---

## Step 1 — image env-override + test + bundle rebuild

Change (`src/main/sandbox/sandbox-config.ts`):
```diff
 /** Sandbox container image (phase 1 pinned tag — has buck2 + agent CLIs). */
-export const SANDBOX_IMAGE = 'orca-dev:3'
+export const SANDBOX_IMAGE = process.env.ORCA_SANDBOX_IMAGE ?? 'orca-dev:4'
```
`sandbox-manager.ts` needs no change (imports `SANDBOX_IMAGE`; orcad env is fixed
at container start, before module import).

Test (`src/main/sandbox/sandbox-config.test.ts`): new case
"pins the sandbox image to orca-dev:4 unless overridden" — `vi.resetModules()` +
dynamic re-import asserts default `orca-dev:4` with env unset and the override
value with `ORCA_SANDBOX_IMAGE=orca-dev:9-test`.

Build host: `orca-sess-prove-1-orca-1` (host itself has no node/pnpm — same as cutover-1):
```
$ docker exec orca-sess-prove-1-orca-1 bash -lc 'cd .../docker-sandbox &&
    pnpm vitest run src/main/sandbox/sandbox-config.test.ts src/main/sandbox/sandbox-manager.test.ts'
Test Files 2 passed (2) / Tests 14 passed (14)
$ pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
[build-orcad] ok — 0.1.0+1b090785e1ba, 7.77 MB, 4118 modules, zero electron and node:sqlite imports.
[cli-bin] verified out/cli/index.js (10529 bytes)
ln: failed to create symbolic link '/usr/local/bin/orca-dev': Permission denied  <- known benign (cutover-1 §Image)
```

Bundle sanity (fresh `out/orcad/orcad.js`): `sandbox`×15, `ORCA_SANDBOX_IMAGE`×1,
`orca-dev:4`×1, `orca-dev:3`×0; `daemon-entry.js` 0 `sandbox` refs (matches proven shape).

---

## Step 2 — build new orcad image (NEW tag, `orca-runtime:*` untouched)

Restage (mirrors `build.sh step_stage`, SRC=worktree, DEST=`~/orca-docker/orca-sandbox-agent/stage-prove`;
note: cutover-1's log line omits `tar -cf -` — the working form is the `build.sh` one):
```
$ rm -rf stage-prove && mkdir -p stage-prove/node_modules
$ cp -a out/orcad out/cli → stage-prove/
$ tar -C "$SRC/node_modules" -cf - --dereference --exclude='*/.tmp' node-pty agent-browser emojibase-data @parcel \
    | tar -C stage-prove/node_modules -xf -
STAGE-OK: pty.node present / 204M total
```

Image (same Dockerfile path as cutover-1, NEW tag):
```
$ cd ~/orca-docker && docker build -t orca-sandbox-orcad:cutover2-20260916 \
    -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
DONE 4.0s — naming to orca-sandbox-orcad:cutover2-20260916 (f7471a97faec)
$ docker images → orca-sandbox-orcad:cutover2-20260916 (f7471a97faec) alongside
  cutover-20260916 (e26ea8bb1d40) + :test (b18bed23c3fd);
  orca-runtime:bun (5c624dd69e07) and orca-runtime:node (27e84c33aa36) UNCHANGED.
$ docker run --rm --entrypoint bash orca-sandbox-orcad:cutover2-20260916 -lc
  'which docker node; docker --version; grep -o "orca-dev:[0-9]" /app/orcad.js'
/usr/bin/docker / node v24.21.0 / docker 20.10.24 / orca-dev:4 ×1, ORCA_SANDBOX_IMAGE ×1
```

Pre-restart pairing snapshot (assert survival after):
```
$ md5sum orca-devices.json → 71ab6913b584d120e4fc63d35520908c (9 devices, /tmp/cutover2-devices-prestop.json)
$ md5sum orca-e2ee-keypair.json → f5a69bb807f3f57fc0abe38d8c106778
```

---

## Step 3 — restart orca-live onto the new image (live :6768, ~06:56:45 UTC)

Fallback wrinkle: `orca-live-prev` name was already taken (cutover-1's stopped
`orca-runtime:bun` fallback). Preserved the chain instead of destroying it:
existing `orca-live-prev` → `orca-live-prev-cutover1`, then current `orca-live` →
`orca-live-prev`, then start the new `orca-live`. Two instant fallbacks kept, both stopped.

`docker inspect orca-live` (cutover-1 container) was re-read for exact flags —
not retyped from memory. New container carries IDENTICAL user/group/binds/env/health/cmd
plus exactly one addition: `-e ORCA_SANDBOX_IMAGE=orca-dev:4`:
```
$ docker stop -t 5 orca-live
$ docker rename orca-live-prev orca-live-prev-cutover1
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
    -e ORCA_SANDBOX_IMAGE=orca-dev:4 \
    --health-cmd="node -e \"require('net').connect(6768,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})\"" \
    --health-interval=15s --health-timeout=5s --health-start-period=60s --health-retries=3 \
    orca-sandbox-orcad:cutover2-20260916 \
    --port 6768 --pairing-address wss://orca.simple-business-platform.com
29ba4f830c21...
```

First boot (`Up 8s (healthy)` — :6768 downtime was the stop→rename→run window, seconds):
```
Orca server ready / Bound endpoint: ws://127.0.0.1:6768
Advertised endpoint: wss://orca.simple-business-platform.com
Build: 0.0.0-orcad (68b8d002ffeccbe0)  <- NEW bundle hash (was ff7f2d4a): patched bundle serving
Terminal daemon: live — PTY self-test passed; terminals survive an orcad restart: yes
```
Post-start `docker inspect` verified byte-identical healthcheck/user/group/binds
vs the cutover-1 container, env = same set + `ORCA_SANDBOX_IMAGE=orca-dev:4`.

Pairing survival: before 9 → after 9 devices, zero missing, zero drift on
`token/pairedAt/scope/name` for all 9 rows (re-checked after e2e too — same).
Devices-file md5 moves across reads (`71ab6913…` → `8b0d228c…` → `5d17de5c…`) from
live `lastSeenAt` traffic + one `mobilePairingConnectionMode` backfill on the fresh
pairing row only — no token/pairing loss. `orca-e2ee-keypair.json` md5 UNCHANGED
(`f5a69bb807f3f57fc0abe38d8c106778`, byte-identical before/after). Pairings SURVIVED.

Observed (benign, no action): one log line
`[refreshRemoteTrackingBase] origin/main refresh failed for /src/agent-infra`
(background best-effort fetch; all foreground repo/worktree RPCs returned `ok:true`).

---

## Step 4 — e2e re-prove on live :6768 (all six CLIs), then archive

CLI path: worktree `out/cli/index.js` via `orca-sess-prove-1-orca-1`, saved env
`--environment live-cutover` (083d1cc5…, device `aaee0c43…`, same as cutover-1).

```
$ worktree create --environment live-cutover --repo path:/src/agent-infra \
    --name cutover2 --agent codex --prompt "Check git status..., then wait..." → ok:true,
  id 4b2dad1c…::/home/mihail/orca/workspaces/agent-infra/cutover2
$ (45s) docker ps → orca-sandbox-519ec546 (orca-dev:4) Up 46s  <- NEW image stamped
$ worktree ps → cutover2 | sandbox: running, live:1, pty:yes, status active  (iOS-visible)
$ docker exec orca-sandbox-519ec546 <cli> --version  (6/6 PRESENT, exact pins):
  claude 2.1.272 (Claude Code) / codex-cli 0.154.0 / 2026.09.10-fd3934a /
  grok 1.0.30 (04b7ffed98c6) / 1.2.3 / 1.18.31
$ worktree rm --worktree path:.../agent-infra/cutover2 --force → {"removed": true}
$ worktree rm --worktree path:.../agent-infra/e2e-cli --force → {"removed": true}  <- prev-round leftover
  After: NO sandbox containers for either (519ec546 + 1a3065c1 gone);
  ps shows only Test-the-env + mains; agent-infra dir holds only `.orca-worktree-trash`.
```

Untouched: `orca-sandbox-14d2e4a2` (Test-the-env, orca-dev:3, still Up — not ours);
`/src/agent-infra` + `/src/simple-business` repo registrations stay (metadata only,
same precedent as cutover-1); nativelink ×2, sess ×2 kept uptimes.

---

## Step 5 — rollback (NOT tested — cutover2 succeeded, :6768 left migrated)

Instant fallbacks (both kept, stopped):
- `docker start orca-live-prev` (cutover-1 image `orca-sandbox-orcad:cutover-20260916`, :3 default)
- original bun image: `docker start orca-live-prev-cutover1` (`orca-runtime:bun`, pre-cutover-1)

Final container set: `orca-live` (cutover2 image, healthy) + stopped `orca-live-prev`
+ stopped `orca-live-prev-cutover1` + exited `orca-orca-1` corpse (pre-existing).
No commits made (worktree `git status` shows only the pre-existing patch + untracked
`CUTOVER-LOG.md`/`PROVE.md`/`CUTOVER2-LOG.md`(this file) — same shape as before).
