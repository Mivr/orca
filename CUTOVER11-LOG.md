# CUTOVER11 — orcad onto upstream v1.4.222 (2026-10-07)

Branch `docker-sandbox-v1.4.222` = tag `v1.4.222` + the deployment patches of `docker-sandbox`
(cherry-picked with `-x`). Image `orca-sandbox-orcad:v1.4.222-20261007`, built from
`orca-sandbox-agent/Dockerfile.orcad-v1.4.222`; `orca-live` recreated with `run-orca-live.sh --yes`.

## Carried
Sandbox (create path, bind mounts, admission, reaper, exec rewrite, cutover6/7/9 knobs, hook
spool poll), restart resilience + `sessions` CLI, `ORCA_DAEMON_EXEC_PATH` (ported to
`daemon-launched-child-spawn.ts`).

## Dropped
- Cursor / Antigravity usage features: upstream shipped its own (#22633, #24073, ...).
- SuperGrok reset tokens (desktop/mobile UI, consumeGrokResetCredit RPC): not upstream; the
  desktop runs the stock deb, so it never reached a client. Still on `docker-sandbox`.
- Linux daemon-host relocation: packaged-Electron only; orcad is excluded by design.
- cutover10 real-home sweep gate: upstream's sweep now removes only retired command forms.
- Upstream cherry-picks already in v1.4.222 (grok #20090/#20507/#20523/#20534, release v1.4.203).

## Build/runtime changes
- `out/orcad` is self-contained (own node_modules with the node-pty prebuild); the old
  `stage-prove/node_modules` overlay is gone. Staged in `stage-v1.4.222/`.
- The packaged slot refuses any Node but its pin: the image ships `out/runtimes/` at
  `/runtimes/` and the entrypoint is that node. `ORCA_DAEMON_EXEC_PATH` is no longer set.
- `procps` added: the OpenCode binder sweep spawns `ps`.
- Profile state migrates from `orca-data.json` to `profile-state.db` (SQLite) on first start.
  Pre-cutover backup: `/data/home-offload/orca-orcad-data.pre-v1.4.222-20261007.tar`.

## Verification
- typecheck:node, typecheck:cli, oxlint: clean.
- vitest (sandbox, agent-hooks, daemon, orcad, codex, opencode, sessions, terminal-handle):
  only failures are environmental and identical on pristine v1.4.222 (`--expose-gc`, codex child
  env); `orcad-push-startup` flakes on timeout under host load, passes alone.
- Live: server ready, daemon live, PTY self-test healthy, pairing devices unchanged (10 ids),
  all 5 projects + flat layout survived the SQLite migration, club-apps worktree create/rm on
  /data, a sandboxed claude turn (orca-dev:stable, worktree + common .git mounted) completed and
  its spool was drained, sandbox removed with the worktree.
