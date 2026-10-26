# CUTOVER8-LOG: resilience rollout — HALTED at build (no restart, no changes live)

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`,
base `c49bca824a` + uncommitted cutover6/7/resilience delta).
Goal: roll the resilience patch live — build orcad from the current worktree, tag
`orca-sandbox-orcad:cutover8-20260916`, restart orca-live with identical flags
(fallback `orca-live-prev-cutover7`), prove via `sessions snapshot`/`verify` +
`terminalReattachNotice`.
Rules: :6768 downtime in seconds; any failure → halt-and-report, no skipping ahead;
no commits. Approved by Mihail 2026-09-16.
Previous round: `CUTOVER7-LOG.md` (hook plane, cutover7-20260916 image).
Reference: `RESTART-RESILIENCE.md` (mandatory snapshot/verify procedure).

---

## Step 0 — live state BEFORE any change (read-only, 2026-09-17 ~13:0x UTC)

```
$ docker ps: orca-live on orca-sandbox-orcad:cutover7-20260916, Up 18h (healthy)
$ orca-dev:stable = cc229e06ef57 (untouched this round)
$ orca-runtime:bun 5c624dd69e07 + orca-runtime:node 27e84c33aa36 (untouched)
```

Pairing snapshot: devices md5 `1b65353b…` (10 entries — cutover7's 9 + orcad's own
`3de1a8ea` boot record), keypair md5 `f5a69bb8…` (unchanged since cutover4).
Inspect flags captured to `/tmp/opencode/orca-live-inspect-cutover8.json` — env,
binds, user/group, network, healthcheck all match the cutover7 restart script
(no flag drift; a cutover8 restart script was NOT issued).

---

## Step 1 — build orcad + CLI from current worktree: FAILED at `build:cli` (HALT)

One-shot `orca-dev:stable` (host has no node — cutover-1..7 constraint):

```
$ pnpm install --frozen-lockfile                      # ok (237ms, lockfile clean)
$ pnpm run build:orcad                                # OK — 0.1.0+afbfd22cc22a,
                                                      # 7.78 MB, 4123 modules, zero
                                                      # electron and node:sqlite imports.
$ pnpm run build:cli                                  # FAIL exit 2:
src/cli/handlers/sessions.ts(228,17): error TS2345: Argument of type '{ result: … }'
  is not assignable to parameter of type 'RuntimeRpcSuccess<…>'.
  … missing: id, ok, _meta
src/cli/handlers/sessions.ts(239,17): error TS2345: (same, verify path)
```

Root cause (verified, not assumed): `printResult` (`src/cli/format.ts:66`) takes a
full `RuntimeRpcSuccess<TResult>` envelope. Local-only commands must wrap with the
established `localSuccess(result)` helper (`agent-hooks.ts:164`,
`environment.ts:126` → `{ id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }`).
`sessions.ts:228` (snapshot) and `:239` (verify) pass a bare `{ result }` — the
only two call sites in the tree that do. Likely fix: wrap both in `localSuccess`
(2 lines + import), then re-run `build:cli`. NOT applied — halt-and-report rule.

Consequence chain (why this blocks everything, not just the CLI):
- `orca sessions snapshot` (mandatory pre-restart witness per RESTART-RESILIENCE.md)
  cannot be produced from a red build — the stale `out/cli/index.js` predates the
  sessions command (`grep -c "sessions snapshot" out/cli/index.js` → 0), and
  shipping a witness from a failed build's emit would be skipping ahead.
- No snapshot → no restart (verify would have nothing to diff; missing>0 gate
  unprovable). No `cutover8-20260916` image was built. No container was stopped,
  renamed, or started. Pairing untouched (md5s re-read identical after the halt).

`tsc` did emit despite the errors (noEmitOnError off): `out/orcad/orcad.js`
(8.16 MB, fresh, carries `drainSandboxHookSpool`) and `out/cli/*` now contain
unverified emit from a red build. Next run should rebuild clean after the fix;
do NOT stage or ship these outputs as-is.

---

## State at halt (nothing live changed)

- `orca-live`: still `cutover7-20260916`, `Up 18h (healthy)` — zero downtime taken.
- No `orca-sandbox-orcad:cutover8-20260916` tag exists. No `orca-live-prev-cutover7`.
- Pairing: devices `1b65353b…`, keypair `f5a69bb8…` — byte-identical before/after.
- Fallbacks, sandboxes, images, tablet stack, tunnels, Hermes, sshd: untouched.
- Phase 2 (commit+push) and Phase 3 (cleanup) NOT started — gated on Phase 1 green.

---

## To resume (needs Mihail or a follow-up fix-forward approval)

1. In the worktree, wrap both `printResult({ result… })` calls in
   `src/cli/handlers/sessions.ts` with the `localSuccess` pattern, rebuild
   (`build:orcad` + `build:cli` green), re-run the resilience unit tests
   (`terminal-handle-persistence`, `terminal-handle-restart-persistence`,
   `terminal-host-restart-reattach`, `sessions`).
2. Re-run this cutover from Step 0 (fresh snapshot — session set will have moved on).
3. Then Phases 2–3 per the brief.

No commits made (worktree `git status` shape unchanged apart from rebuilt `out/`;
this file is the only addition).

---

# RESUME (fix-forward authorized 2026-09-16 by Mihail) — executed 2026-09-17 ~13:15 UTC

## Step 1 — localSuccess fix + clean rebuild + tests: GREEN

Fix (the 2 authorized lines + import + helper, `src/cli/handlers/sessions.ts`):
- import: `RuntimeClientError` → `RuntimeClientError, type RuntimeRpcSuccess`.
- `:228` snapshot path: `printResult({ result: … })` →
  `printResult(localSuccess(file ? { file, …snapshot } : snapshot), …)`.
- `:239` verify path: `printResult({ result }, …)` →
  `printResult(localSuccess(result), …)`.
- appended `localSuccess()` helper (same shape as `agent-hooks.ts:164` /
  `environment.ts:126`). No other typecheck errors appeared — nothing else touched.

Clean rebuild (one-shot `orca-dev:stable`, host has no node):
- `rm -rf out/cli out/orcad` first (red-build emit purged).
- `pnpm install --frozen-lockfile` ok (lockfile clean).
- `build:orcad` ok — `0.1.0+afbfd22cc22a`, 7.78 MB, 4123 modules.
- `build:cli` ok, exit 0 (`tsc` clean — no new errors beyond the two known
  lines, both fixed by the same trivial pattern). `out/cli/index.js` verified
  (10529 bytes); the `ln … /usr/local/bin/orca-dev: Permission denied` is the
  known benign one (cutover-1..7). Fresh `out/cli/handlers/sessions.js` carries
  `localSuccess` (3 hits: def + 2 calls).
- Note: `grep -c "sessions snapshot" out/cli/index.js → 0` is EXPECTED, not a
  regression — `build:cli` emits per-file JS and `index.js` is only the 10 KB
  entry. Proof the command shipped: `sessions snapshot`/`verify` both dispatch
  against live below.

Tests (one-shot `orca-dev:stable`):
- `pnpm vitest run src/cli/handlers/sessions.test.ts
  src/main/runtime/terminal-handle-persistence.test.ts
  src/main/runtime/terminal-handle-restart-persistence.test.ts
  src/main/daemon/terminal-host-restart-reattach.test.ts`
  → 4 files / 29 tests pass.

## Step 2 — pre-restart snapshot: 1 row, pairing baseline matches prior state

- `node out/cli/index.js sessions snapshot --file
  /tmp/opencode/sessions-before-cutover8.json` (one-shot,
  `ORCA_USER_DATA_PATH=/home/mihail/.orca-orcad-data`, `-v
  /tmp/opencode:/tmp/opencode`, `--network host`)
  → `snapshot: 1 rows → /tmp/opencode/sessions-before-cutover8.json`
  (takenAt 1789650989522). Single row: tests worktree
  (`5a4a87b9…::/home/mihail/orca/workspaces/simple-business/tests`),
  handle `term_39f51a92-c5fc-470b-a165-760d0259aad4`
  (== cutover7's post-restart handle — session set moved on since cutover7, as
  predicted), pty `…@@8dad5a1d`, incarnation `caa95e9b-…`,
  sandbox running `orca-sandbox-eaf08a75`, pid null.
- Pairing pre-restart: devices md5 `1b65353b…` (10 entries), keypair md5
  `f5a69bb8…` — identical to the Step-0 baseline.

## Step 3 — image + restart: orca-live on cutover8-20260916, healthy

- Restage (`out/orcad + out/cli → …/stage-prove/`, node_modules/pty.node kept,
  204M). Payload: `publishTerminalReattachReport`×2 in staged `orcad.js`,
  `localSuccess`×3 in staged `cli/handlers/sessions.js`.
- `docker build -t orca-sandbox-orcad:cutover8-20260916
  -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent` → DONE 4.0s
  → `b9494a46c220`.
- `orca-dev:stable cc229e06ef57`, `orca-runtime:bun 5c624dd69e07`,
  `orca-runtime:node 27e84c33aa36`: UNCHANGED (re-verified post-restart).
- Restart (single shell layer, flags re-verified identical against
  `/tmp/opencode/orca-live-inspect-cutover8.json` — user/group/binds/env/
  health/cmd, new image only):
  `docker stop -t 5 orca-live` → `docker rename orca-live
  orca-live-prev-cutover7` → `docker run -d --name orca-live …`
  → `orca-live orca-sandbox-orcad:cutover8-20260916 Up 3s (health: starting)`.
  :6768 downtime = one stop→run window, seconds.
- Post-boot (`Up 50s (healthy)`): `Orca server ready`, `Bound endpoint:
  ws://127.0.0.1:6768`, `Build: 0.0.0-orcad (c1832409e19603cd)` (NEW hash),
  `Terminal daemon: live — PTY self-test passed; terminals survive an orcad
  restart: yes`. Boot log has 6 lines, zero errors. (Boot also printed its
  Pairing URL — token material, NOT recorded here.)
- Fallback intact: `orca-live-prev-cutover7` (`cutover7-20260916`, Exited 0,
  stopped) — instant rollback available.

## Step 4 — post-restart verify: GATE FIRED (missing=1, exit 1), then resolved

First run (shortly after `healthy`):
```
[missing] 5a4a87b9-…::…/tests handle=term_39f51a92-… — session gone after restart (container orca-sandbox-eaf08a75)
verify: ok=0 reattached=0 remapped=0 missing=1 new=0
1 session(s) … are missing after the restart   (EXIT=1)
```
Per the brief (`stop on missing>0`) this is a STOP — Phase 2/3 NOT started.
Read-only diagnosis (nothing live touched):

- `terminal list` (minutes later): the session IS alive —
  `term_5ae448a5-bb26-4123-8f1e-6abeb3bd4d3d`, `connected`, same tests
  worktree, `sandbox:running`; `worktree ps` shows the tests row `live:1
  pty:yes sandbox:running`. Same ptyId (`…@@8dad5a1d`).
- `orca-terminal-handles.json` now maps that ptyId → NEW handle
  `term_5ae448a5-…`, incarnation `f754c5cd-…`, `updatedAt 1789651098232`
  (≈109 s after the snapshot — i.e. the daemon adopt completed AFTER the first
  verify ran). `remaps=[]`, `lastReport=null`.
- Re-run `sessions verify --file …sessions-before-cutover8.json`:
```
[remapped] …::…/tests handle=term_39f51a92-… now=term_5ae448a5-… — … update the client
verify: ok=0 reattached=0 remapped=1 missing=0 new=0   (EXIT=0)
```

Root cause (verified, not assumed) — one-time cold-store migration, two parts:
1. The FIRST `missing=1` was TIMING: the first verify ran while the daemon
   reattach was still in flight (`terminal.list` momentarily empty; store
   adopt landed ~1 min later). Self-resolved, no intervention.
2. The `remapped` (old handle → new handle, NO server-side remap record) was
   UNAVOIDABLE on this rollout: the durable handle store was EMPTY at boot —
   cutover7's orcad predates the persistence code and never wrote
   `orca-terminal-handles.json` — so there was no stable handle to replay and
   the adopt path minted fresh. `remaps` stays empty by design (a first mint
   is not a replacement), and `publishTerminalReattachReport()` correctly
   returned null (no `knownPtyIds` at boot) — hence NO `[orcad] restart
   reattach:` log line and `lastReport=null`. The `terminalReattachNotice`
   proof goal is therefore NOT met on this cutover (nothing was published).

Consequences:
- Agent flow: UNINTERRUPTED. Sandbox `orca-sandbox-eaf08a75` running 19h+;
  PTY connected post-restart. No live `agy` process exists in the sandbox
  (only `sleep infinity` + old defunct `buck2`) — but that predates the
  restart (transcript tail shows the turn ended via `/exit` on its own), and
  orcad restarts never touch sandbox containers. Nothing was killed by this
  cutover.
- Client-visible handle CHANGED (`term_39f51a92` → `term_5ae448a5`): any
  client holding the old handle (Mihail's UI) shows the session vanished —
  the exact cutover7 symptom, one last time. From THIS boot forward the
  mapping is durable: future restarts replay `term_5ae448a5` (store is warm).
- Pairing post-restart: devices 10 entries, device-ID set byte-identical to
  pre-restart (cutover7's 9 + orcad boot record `3de1a8ea`; no new record
  minted — the boot Pairing URL re-uses the existing device id), keypair md5
  `f5a69bb8…` unchanged. NOTE: devices-file md5 now reads `b21d0769…` vs
  `1b65353b…` at Step 0 — that delta is `lastSeenAt` churn only, NOT device
  drift (IDs/names/scopes/pairedAt all match). Zero missing, zero drift.

## State at halt (Phase 2/3 gated — see below)

- `orca-live`: `cutover8-20260916` (`b9494a46c220`), `Up … (healthy)`.
- Fallback: `orca-live-prev-cutover7` (`cutover7-20260916`, stopped, Exited 0).
  Older `prev-*` fallbacks, sandboxes (`eaf08a75`, `8ba6a1de`), tablet stack,
  tunnels, Hermes, sshd: untouched (cleanup NOT started).
- Images: only ADD is `orca-sandbox-orcad:cutover8-20260916`. `:stable`,
  `:stable-tablet`, `orca-runtime:*` untouched.
- No commits made. Worktree delta = pre-existing cutover6/7/resilience files +
  the sessions.ts fix + this log + rebuilt `out/` (fresh, green-build emit).

## Phase 2/3 gating decision (needs Mihail)

Phase 1 is NOT fully green: the verify gate fired (`missing=1`, exit 1) even
though it self-resolved to `remapped=1 / missing=0` (exit 0), and the
`terminalReattachNotice` proof is absent (null report by design on a cold
store). Per `RESTART-RESILIENCE.md` (`missing > 0` OR unexplained `remapped`
→ stop and report), Phase 2 (commit+push) and Phase 3 (cleanup) are NOT
started. Open questions for Mihail: (a) accept the one-time handle rotation
as the migration cost and proceed to Phases 2–3 on approval; or (b) roll back
to `orca-live-prev-cutover7` (one rename+run, seconds downtime — note: the old
binary would mint handles its own way again and would NOT read the warm
store). Either way the client holding `term_39f51a92` needs a refresh to
`term_5ae448a5`.
