# CUTOVER12 — orcad onto upstream v1.4.223 (2026-10-09)

Branch `docker-sandbox-v1.4.223` = tag `v1.4.223` + the 16 commits of `docker-sandbox-v1.4.222`
(cherry-picked with `-x`). Image `orca-sandbox-orcad:v1.4.223-20261009`, built from
`orca-sandbox-agent/Dockerfile.orcad-v1.4.223`; `orca-live` recreated with `run-orca-live.sh --yes`.
Desktop: stock `orca-ide_1.4.223_amd64.deb`.

## Port
- Release tags are cut from main separately (v1.4.222 is not an ancestor of v1.4.223), so the
  fork is replayed onto the new tag rather than merged.
- Two textual conflicts, both "both sides added lines here", resolved by keeping both:
  - `orca-runtime-get-worktree-ps.ts`: upstream's native-chat imports + our sandbox-manager import.
  - `orca-runtime-resolve-worktree-removal-target.ts`: upstream's
    `dropAgentStatusForRemovedWorktreeFn` call, then our fire-and-forget `removeSandboxForWorktree`.
- Upstream touched `orcad-entry.ts` and `server-lifecycle.ts` only additively (new hook-server
  wiring); nothing to re-port. Node pin unchanged (24.21.0, runtime sha 7fde7b8a...), so the
  image entrypoint is unchanged.

## Image fix: in-container CLI
Since the v1.4.222 image, `node /app/cli/index.js <any runtime command>` died with
`Cannot find module 'zod'` (`--help` worked, so the smoke check missed it). The tsc-built `cli/`,
`shared/` and `main/` are not bundled. The image now also ships:
- `stage-v1.4.223/main/` (out/main; e.g. `cli/handlers/worktree-gitlab-link-context` needs it),
- `stage-v1.4.223/cli-node_modules/` -> `/app/node_modules/`: zod, ws, yaml, tweetnacl,
  stream-json, stream-chain, jsonc-parser, smol-toml, @xterm/{headless,xterm,addon-unicode11,
  addon-serialize}, copied dereferenced (`cp -rL`) from the build's node_modules.
A require-every-module sweep loads 2258 of 2261 non-test modules (the rest import vitest).
Inside orca-live, point the CLI at orcad, not the desktop runtime:
`docker exec -e ORCA_USER_DATA_PATH=/home/mihail/.orca-orcad-data orca-live <node> /app/cli/index.js ...`

## Rollback
v1.4.223 bumps the agent-session journal schema (3 -> 4) and adds a profile-state authority
marker. Restore `/data/home-offload/orca-orcad-data.pre-v1.4.223-20261009.tar` (taken with
orca-live stopped), then `ORCA_LIVE_IMAGE=orca-sandbox-orcad:v1.4.222-20261007 run-orca-live.sh --yes`.

## Verification
- typecheck:node, typecheck:cli: clean. oxlint (agent-hooks, sandbox, orcad, daemon): one
  `max-lines` hit on `daemon-pty-session-spawn.ts` (302/300), identical on v1.4.222.
- vitest (sandbox, agent-hooks, daemon, orcad, codex, opencode, sessions, terminal-handle):
  7308 passed, 19 failed. The same 18 fail on pristine v1.4.223 (environmental: codex child env,
  `--expose-gc`, process-group signals). `orcad-push-startup` timed out under load, passes 3/3
  alone.
- Live: server ready, daemon live, PTY self-test healthy; pairing devices unchanged (10); all 5
  project setups and worktree base paths intact; club-apps worktree created on /data with a
  claude agent -> sandbox `orca-dev:stable` with the worktree + common .git mounted, turn replied
  and its spool drained; `worktree rm` removed the sandbox, the directory and the branch, and all
  16 fleet worktrees under /data/club-apps/wt stayed registered.

## Known, not from this cutover
- orcad's `git fetch` for club-apps (`git@github.com:Mivr/club-apps.git`) fails inside the
  container with "Host key verification failed" (seen since 2026-10-07). v1.4.223 now creates
  from the local branch and says so (#26009).
- `[agent-state-rules] download failed: HTTP 404` at startup.
