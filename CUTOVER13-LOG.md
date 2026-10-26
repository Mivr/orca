# CUTOVER13 — orcad onto upstream v1.4.237, in place, no session lost (2026-10-23)

Why: the v1.4.223 orcad was too old for the current iOS app. Constraint: live agents (an `agy` and
a `claude` directly in `orca-live`, `claude` in two sandboxes) were mid-work and must not die.

Branch `docker-sandbox-v1.4.237` = tag `v1.4.237` + one squashed fork commit (net diff
`v1.4.223..docker-sandbox-v1.4.223`, cherry-picked with `-x`) + `fix(orcad): port fork to v1.4.237
layout`. Image `orca-sandbox-orcad:v1.4.237-20261023` from
`~/orca-docker/orca-sandbox-agent/Dockerfile.orcad-v1.4.237`. Scripts in `~/orca-docker/cutover13/`.

## Port
- Replayed as ONE squashed commit, not 16: per-commit replay re-fights conflicts in files the fork
  rewrote twice (orcad-entry.ts). 13 conflicted files; upstream moved runtime files into
  `runtime/{workspaces,terminal/*,construction}/` and made `registerCleanup` chain.
- Dropped `ORCA_DAEMON_EXEC_PATH` (unused since v1.4.222).
- Stable terminal-handle helpers moved onto `OrcaRuntimeWithRuntimeId` (owner of
  `terminalHandleStore`): upstream now puts pty registration ahead of the durability mixin.
- Sandbox spool poll uses `drainAgentHookSpoolAsync`, gated against overlapping ticks.
- New knob `ORCA_SANDBOX_SKIP_START_REAP=1`: skips the start-time orphan-sandbox reap.
- Build needs `pnpm --dir mobile install` + `pnpm build:mobile-web` before `build:orcad` now.
- out/orcad ships a bundled CLI (`out/cli/index.js`); the image symlinks `/app/cli` to it, so the
  v1.4.223 tsc-CLI + hand-copied node_modules workaround is gone.

## Verification (build)
typecheck:node (17,276 files) and typecheck:cli clean. Fork suites (sandbox, reaper, push-startup,
chromium session, gpu flags, terminal-handle persistence/restart, restart-reattach, exec rewrite,
sessions CLI, spool, hook-script): 16 files, 133 tests passed.

## The in-place swap
A container restart kills every PTY: orcad is the direct child of `docker-init`, so its exit ends
the container. Upstream already keeps PTY daemons across app updates (newer orcad adopts an older
protocol daemon as a legacy adapter), so only the old orcad's *exit* had to be avoided:

1. `retire.mjs <pid>` (run with the old image's node via `docker exec orca-live`): SIGUSR1 opens
   the inspector, `process.exit` is neutralized (with a verify step before anything else), then
   SIGTERM runs orcad's own graceful stop: RPC down, profile flush, daemon *disconnect*, lock and
   profile admission released. The process stays as an idle PID-namespace keeper; the inspector
   is closed afterwards.
2. Backup: `/data/home-offload/orca-orcad-data.pre-v1.4.237-20261023.tar` (taken after the retire).
3. `docker exec -d --user 1000:1000 -e ORCA_SANDBOX_SKIP_START_REAP=1 orca-live
   /home/mihail/orcad-slots/v1.4.237-20261023/run-orcad-inplace.sh --port 6768 --pairing-address
   wss://orca.simple-business-platform.com`. The slot is `/app` + `/runtimes` copied out of the
   new image; the wrapper restarts orcad on a crash (not on exit 78), logs to
   `~/.orca-orcad-data/logs/orcad-inplace.log`.

Proved first on a throwaway container from the old image (isolated HOME/data, bridge network):
the retire left the shell ticking; the new orcad reported `1 reattached`; the old-daemon terminal
kept its handle and took input; new terminals landed on the v50 daemon.

Live: ~5 s without a server (14:00:34–14:00:39Z). `restart reattach: 5 reattached, 0 remapped,
3 failed` (the 3 are stale map entries, not live sessions). `sessions verify`: ok=5, missing=0,
handles unchanged. Process diff: only transient `sleep`/`ps` gone. Both sandboxes and their
`claude` still running. Tunnel errors only inside the 5 s gap.

## State now / known gaps
- `orca-live` PID 7 = retired v1.4.223 orcad (keeper). Do NOT kill it: that ends the container.
  PID 42 = v41 daemon holding the pre-cutover sessions; the new orcad runs its own v50 daemon.
- Reboot handling: `orca-live` is `--restart=no` (its own entrypoint is the old orcad), and the
  user unit `orca-live-boot.service` (enabled, linger on) runs `~/orca-docker/orca-live-boot.sh`
  at boot: if `orca-live` is not running it execs `run-orca-live.sh --yes`, whose default image is
  now `orca-sandbox-orcad:v1.4.237-20261023`. A running `orca-live` is never touched.
- The agent hook server moved 40913 -> 37871 with a new token, as on any orcad restart.
- Rollback: stop the in-place orcad (`touch <slot>/STOP`, SIGTERM it), restore the tar, recreate
  with `ORCA_LIVE_IMAGE=orca-sandbox-orcad:v1.4.223-20261009`.
