# Phase-1 prove: docker-exec transport for orca worktree agents

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).
Spec: `/home/mihail/orca-docker/orca-sandbox-agent/DESIGN.md` (decision b).

## What was built (phase 1 only)

- `src/main/sandbox/sandbox-config.ts` — cap-10, labels, image `orca-dev:3`,
  `--memory=4g --cpus=2.0`, env allowlist, `ORCA_SANDBOX_AGENTS=1` gate, bind map.
- `src/main/sandbox/sandbox-manager.ts` — admission (reject `sandbox_slots_full`,
  never queue), create/remove, `worktree ps` describe, orphan reaper, env-file secrets.
- `src/main/sandbox/sandbox-bind-mounts.ts` — worktree + whole main `.git` same-path
  binds; host-source resolution (explicit map → self-inspect → /proc).
- `src/main/sandbox/sandbox-spawn-admission.ts` — stamps fresh agent spawns only
  (plain shells stay on host; reattaches untouched).
- `src/main/daemon/pty-subprocess/sandbox-exec-rewrite.ts` — argument-layer rewrite
  to `docker exec -it -e <allowlist> -w <cwd> <sandbox> <shell> <args>`.
  `-it` (not `-i`): agent TUIs refuse non-terminal stdin outright (verified).
  HOME=`/var/tmp` (image `/root` unreadable as uid 1000; codex refuses `/tmp`).
- `worktree ps`: `sandbox: running|absent` + `sandboxReason: sandbox_slots_full`
  (JSON + text) — the exact list the iOS app displays.
- Lifecycle: create on first agent launch, remove on `worktree rm`, reap orphans
  on orcad start only.

## Prove (TEST orcad on :6771, live :6768 never touched)

Runtime image rebuilt from this worktree (`out/orcad` @ `02e4b4f5`, staged CLI):

```bash
# build (inside orca-sess-prove-1-orca-1, which has node/pnpm + synced /src)
pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
# stage + image (host docker)
docker build -t orca-sandbox-orcad:test \
  -f /home/mihail/orca-docker/orca-sandbox-agent/Dockerfile.prove-orcad \
  /home/mihail/orca-docker/orca-sandbox-agent
# TEST orcad, fresh ORCA_USER_DATA, :6771
docker run -d --name orca-prove-sandbox-1 --network host --user 1000:1000 --group-add 988 \
  -v /home/mihail:/home/mihail -v orca-src:/src -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOME=/home/mihail \
  -e ORCA_USER_DATA=/home/mihail/orca-docker/orca-sandbox-agent/prove-data \
  -e ORCA_SANDBOX_AGENTS=1 \
  -e 'ORCA_SANDBOX_BIND_MAP=/src=/work/docker/volumes/orca-src/_data' \
  -e ORCA_VERSION=0.0.0-orcad orca-sandbox-orcad:test \
  --port 6771 --pairing-address 127.0.0.1:6771
# drive via built CLI from inside (same-path bind + localhost):
CODE=<pairing-code from `docker logs orca-prove-sandbox-1`>
docker exec orca-prove-sandbox-1 bash -lc \
  'cd /home/mihail/sw_projects/orca-wt/docker-sandbox && node out/cli/index.js ... --pairing-code "$CODE"'
```

| # | Check | Result |
|---|-------|--------|
| 1 | `repo add --path /src/simple-business` on fresh data root | PASS — repo `23f54b91…`, path `/src/simple-business` |
| 2 | `worktree create … --name prove7 --agent codex --prompt …` returns agent handle | PASS — `term_65224851…` |
| 3 | `docker ps` shows sandbox + exec | PASS — `orca-sandbox-4ee36c47` (`orca-dev:3`); `docker top` shows `sleep infinity`, `bash --rcfile …shell-ready…`, and `node /usr/bin/codex …` + native `codex` on `pts/0` |
| 4 | Session listed via orcad API (`worktree ps --json`) | PASS — `prove7 sandbox=running live=1 pty=true`; text shows `sandbox:running` (main row `sandbox:absent`) |
| 5 | Same-path mounts | PASS — `…/prove7:…/prove7` rw + `/work/docker/volumes/orca-src/_data/simple-business/.git:/src/simple-business/.git` rw; labels `orca.sandbox.managed=1`, `orca.sandbox.worktree=<id>` |
| 6 | Agent works in sandbox | PASS — `git status` → `## prove7`, `git rev-parse --git-common-dir` → `/src/simple-business/.git`; `echo SANDBOX-WRITE > .prove-write` visible on host; codex TUI renders (readable via `terminal read`, `status: running`) |
| 7 | Deny rules (§2) | PASS — `~/.ssh` absent, live + prove `ORCA_USER_DATA` absent, only the two binds; `memory.max=4294967296` |
| 8 | `worktree rm --force` removes sandbox | PASS (repeated 4×) — container gone |
| 9 | Orphan reaper on orcad start | PASS — planted `orca-sandbox-deadbeef` (bogus worktree) → log `[orcad] reaped orphan sandboxes: orca-sandbox-deadbeef`, container removed; live worktree sandboxes adopted, not reaped |
| 10 | Unit tests | PASS — 28 new tests (manager, bind-mounts, admission, rewrite, reaper); adjacent suites pass (daemon adapter adoption 36, format 23, rpc-worktree-queries, startup-delivery, orcad incl. push-startup) |
| 11 | Lint | PASS — `oxlint` 0 errors on all touched files (no disables; manager split to respect `max-lines`) |
| 12 | Typecheck | PASS with note — zero errors in touched files; single pre-existing error in untouched `src/main/runtime/rpc/rpc-params-type-parity.ts` (`accounts.consumeGrokResetCredit`) |
| 13 | Cap-10 live fill | NOT RUN live (unit-tested: 10 admits, 11th rejects `sandbox_slots_full`, never queues; rejection surfaces as `sandboxReason`) |
| 14 | Live `:6768` | UNTOUCHED — no restart/rebuild; note: the supervised live stack rotated `orca-orca-1` (exit 0) → `orca-live` on its own during prove, not by any command here |

Two prove-driven fixes (found live, covered by tests): mount the whole main `.git`
(pointer-only breaks commits); map volume paths to host bind sources
(`ORCA_SANDBOX_BIND_MAP`, `/dev/*` excluded from `/proc` mapping).

## What iOS will now show

`worktree.ps` rows gain `sandbox: "running" | "absent"` (+ `sandboxReason:
"sandbox_slots_full"` for ~5 min after a cap rejection). Sandboxed agent
worktrees render their live PTY sessions exactly as today, with a sandbox badge
source; rejection text should advise retry after another agent finishes (no queue
in phase 1). No wire break: fields are optional, old clients ignore them.
