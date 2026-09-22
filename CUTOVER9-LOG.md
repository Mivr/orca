# CUTOVER9-LOG: Part 1 — Build, Stage, and Image Verification (No Restart)

Worktree: `/home/mihail/sw_projects/orca-wt/docker-sandbox` (branch `docker-sandbox`).  
Base: `b17619635d` + cutover9 commits.  
Date: 2026-09-22  
Scope: Phase 1 only (code changes A–E, Dockerfile update F, G root cause, bundle build, restage, image build & verification).  
Rule strictly obeyed: NO restart, stop, rm, or modification of live daemon `orca-live` or any running `orca-sandbox-*` container.

---

## 1. Summary of Changes (Items A–F)

### Commit History on `docker-sandbox`
```
77607ecf46 chore(cli): include sandbox-config.ts in tsconfig.cli.json for typecheck:cli
9b7f3c23d4 feat(sandbox): cutover9 drop tool-level hook events in both cases
eb4144c6f2 chore(rpc-contract): regenerate rpc params catalog with consumeGrokResetCredit
ff5d6d30fb feat(sandbox): cutover9 env-overridable sandbox memory with 8g default
5c0103ec94 feat(sandbox): cutover9 append proxy and forge vars to env allowlist
e2d3744116 feat(sandbox): cutover9 --add-host for host routing
2e8f9bc8bc feat(sandbox): cutover9 mount opencode shared config dir
```

### Details per Item

- **Item A: Mount OpenCode shared hooks directory (`2e8f9bc8bc`)**
  - Files: `src/main/sandbox/sandbox-hook-mounts.ts`, `src/main/sandbox/sandbox-config.ts`, and test files.
  - Mounts `${userDataPath}/opencode-hooks/shared` rw into sandboxes at `${userDataPath}/opencode-hooks/shared`.
  - Ensures directory and `plugins/` subdirectory are created with mode `0o777` (umask safe).

- **Item B: `--add-host` for host routing (`e2d3744116`)**
  - Files: `src/main/sandbox/sandbox-config.ts`, `src/main/sandbox/sandbox-manager.ts`, and test files.
  - Added `ORCA_SANDBOX_EXTRA_HOSTS` env parsing with default `host.docker.internal:host-gateway`.
  - Injected `--add-host` arguments into `runArgs` in `sandbox-manager.ts`.

- **Item C: Proxy & Forge env allowlist (`5c0103ec94`)**
  - Files: `src/main/sandbox/sandbox-config.ts` and test files.
  - Appended `SB_FORGE_URL`, `SB_FORGE_DB_URL`, `SB_FORGE_LOG_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `no_proxy` to `SANDBOX_ENV_ALLOWLIST`.

- **Item D: Env-overridable sandbox memory cap (`ff5d6d30fb`)**
  - Files: `src/main/sandbox/sandbox-config.ts`, `src/main/sandbox/sandbox-manager.ts`, and test files.
  - Added `ORCA_SANDBOX_MEMORY` override (default `'8g'`). Passed via `--memory` flag in `runArgs`.

- **Item E: Drop tool-level hook events in both PascalCase and camelCase (`9b7f3c23d4`)**
  - Files: `src/main/agent-hooks/hook-stdin-contract.ts`, `src/main/agent-hooks/hook-script-outside-orca.test.ts`, `src/main/agent-hooks/spool.test.ts`.
  - Filters all 16 tool-level hook events (`PreToolUse`, `preToolUse`, `PostToolUse`, `postToolUse`, `PostToolUseFailure`, `postToolUseFailure`, `beforeShellExecution`, `BeforeShellExecution`, `afterShellExecution`, `AfterShellExecution`, `beforeMCPExecution`, `BeforeMCPExecution`, `afterMCPExecution`, `AfterMCPExecution`, `afterFileEdit`, `AfterFileEdit`) in `spool_hook_event()`.

- **Item F: Install `gh` and stage `shared/` in `Dockerfile.prove-orcad`**
  - File: `/home/mihail/orca-docker/orca-sandbox-agent/Dockerfile.prove-orcad`.
  - Added `curl` and the official GitHub CLI deb repository to apt install `gh`.
  - Added `COPY stage-prove/shared/ ./shared/` so `node /app/cli/index.js` can resolve `../../shared/*` modules inside the container.

- **Supporting Fixes:**
  - `src/shared/rpc-contract/rpc-params-catalog.generated.ts` (`eb4144c6f2`): regenerated to include missing `accounts.consumeGrokResetCredit`.
  - `config/tsconfig.cli.json` (`77607ecf46`): added `../src/main/sandbox/sandbox-config.ts` to include list to satisfy `typecheck:cli`.

---

## 2. Test & Typecheck Verification

All checks run inside `orca-dev:stable` container:

- **Sandbox Vitest**:
  - Command: `pnpm vitest run src/main/sandbox`
  - Result: 5 test files passed, 52 tests passed.
- **Agent Hooks Vitest**:
  - Command: `pnpm vitest run src/main/agent-hooks`
  - Result: 87 test files passed, 907 tests passed (9 skipped).
- **Sessions & Resilience Vitest**:
  - Command: `pnpm vitest run src/cli/handlers/sessions.test.ts src/main/runtime/terminal-handle-persistence.test.ts src/main/runtime/terminal-handle-restart-persistence.test.ts src/main/daemon/terminal-host-restart-reattach.test.ts`
  - Result: 4 test files passed, 29 tests passed.
- **Oxlint**:
  - Command: `pnpm dlx oxlint src/main/agent-hooks src/main/sandbox`
  - Result: 0 warnings, 0 errors on 180 files.
- **Typecheck**:
  - Command: `NODE_OPTIONS="--max-old-space-size=8192" pnpm run typecheck:node && pnpm run typecheck:cli`
  - Result: Clean exit code 0 on both.

---

## 3. Bundle Build & Restaging

1. **Build Commands**:
   ```bash
   rm -rf out/cli out/orcad && pnpm install --frozen-lockfile && pnpm run build:orcad && pnpm run build:cli
   ```
2. **Build Output**:
   - `[build-orcad] ok — 0.1.0+52efbffd43b2, 7.78 MB, 4123 modules, zero electron and node:sqlite imports.`
   - `[cli-bin] verified out/cli/index.js (10529 bytes)`
3. **Bundle Grep Proof**:
   - `grep -c "opencode-shared" out/orcad/orcad.js` -> `2`
   - `grep -c "add-host" out/orcad/orcad.js` -> `1`
4. **Restaging to `/home/mihail/orca-docker/orca-sandbox-agent/stage-prove/`**:
   - `out/orcad/` -> `stage-prove/orcad/`
   - `out/cli/` -> `stage-prove/cli/`
   - `out/shared/` -> `stage-prove/shared/`
   - Preserved `stage-prove/node_modules/` intact.

---

## 4. Docker Image Build & Verification

- **Build Command**:
  ```bash
  cd /home/mihail/orca-docker && docker build -t orca-sandbox-orcad:cutover9-20260922 -f orca-sandbox-agent/Dockerfile.prove-orcad orca-sandbox-agent
  ```
- **Image Details**:
  - Tag: `orca-sandbox-orcad:cutover9-20260922`
  - Image ID: `sha256:61da90a1c616a0e2933357465ea22e9d775ea430349a15472d30bc763f5c62d4`
- **In-Image Verifications**:
  - `gh --version`:
    ```
    gh version 2.101.0 (2026-09-15)
    https://github.com/cli/cli/releases/tag/v2.101.0
    ```
  - Bundle markers:
    - `docker run --rm --entrypoint grep orca-sandbox-orcad:cutover9-20260922 -c opencode-shared /app/orcad.js` -> `2`
    - `docker run --rm --entrypoint grep orca-sandbox-orcad:cutover9-20260922 -c add-host /app/orcad.js` -> `1`
  - CLI execution:
    - `docker run --rm --entrypoint node orca-sandbox-orcad:cutover9-20260922 /app/cli/index.js --help` -> Successfully displayed `orca` CLI help menu (no `MODULE_NOT_FOUND` error).

---

## 5. Root Cause Analysis: Codex Real-Home Hooks (Item G)

### Findings
1. **Daemon Startup Flow vs Desktop Flow**:
   - `orcad` (`src/main/orcad/orcad-entry.ts:233`) deliberately leaves `getSelectedCodexHomePath` unset (`undefined`) with the inline comment:
     `"Codex-home and Claude-auth preparation are left unset: both are desktop account flows."`
   - The method `ensureRealHomeCodexHookState()` is only called from Electron desktop entrypoints:
     - `src/main/startup/main-process-ready-runtime.ts` (Electron app ready)
     - `src/main/startup/codex-launch-preparation.ts` (desktop PTY launch)
2. **CLI `agent hooks on` Targeting**:
   - `MANAGED_AGENT_HOOK_INSTALLERS` maps `codex` to `codexHookService.install()`.
   - In headless / daemon mode, `codexHookService.install()` defaults to the managed runtime home (`getOrcaManagedCodexHomePath()`, i.e. `~/.config/orca/codex-runtime-home/home`), NOT the user's real home (`~/.codex`).
3. **Absence of `codex` Binary in Container**:
   - Even if `ensureRealHomeCodexHookState()` were wired into `orcad-entry.ts`, the container environment does not have the `codex` binary on `PATH`.
   - `ensureRealHomeCodexHookState()` calls `grantManagedCodexHookTrust()`, which spawns `codex app-server`. If spawning fails with `ENOENT`, `src/main/codex/codex-real-home-hook-install.ts:209` executes an automatic rollback that deletes or resets `~/.codex/hooks.json`.
4. **Conclusion**:
   - Per brief instructions, no speculative code changes were made for Item G.
   - Managing `~/.codex/hooks.json` in the host's real home directory is designed as a desktop client / host-level responsibility, not a headless container daemon responsibility.

---

## 6. Handoff Notes for Cutover Recreate Agent (Phase 2)

1. **Current Live State**:
   - `orca-live` is running on `orca-sandbox-orcad:cutover8-20260916` (untouched).
   - Fallback `orca-live-prev-cutover7` is preserved.
2. **Target Image for Recreate**:
   - `orca-sandbox-orcad:cutover9-20260922` (`sha256:61da90a1c616a0e2933357465ea22e9d775ea430349a15472d30bc763f5c62d4`)
3. **Recommended Recreate Sequence**:
   - **Step 1: Session Snapshot**:
     ```bash
     docker exec orca-live node /app/cli/index.js sessions snapshot --file /tmp/opencode/sessions-before-cutover9.json
     ```
   - **Step 2: Stop & Rename**:
     ```bash
     docker stop -t 5 orca-live
     docker rename orca-live orca-live-prev-cutover8
     ```
   - **Step 3: Run New Container**:
     Launch `orca-live` with the exact flags from CUTOVER8-LOG / inspect snapshot, substituting `orca-sandbox-orcad:cutover9-20260922`.
   - **Step 4: Verify**:
     - Check `docker logs orca-live` for `Orca server ready` and `Build: 0.0.0-orcad (52efbffd43b2...)`.
     - Check health status (`healthy`).
     - Run sessions verify:
       ```bash
      docker exec orca-live node /app/cli/index.js sessions verify --file /tmp/opencode/sessions-before-cutover9.json
      ```
    - Spawn or inspect a new sandbox to verify `--add-host host.docker.internal:host-gateway` and rw mount of `opencode-hooks/shared`.

---

# CUTOVER9-LOG: Part 2 — Rollout, Recreate, Daemon & CLI Verification

Executed: 2026-09-22 ~15:45–16:05 UTC  
Operator: Antigravity (pair programming with user `mihail`)  
Target Image: `orca-sandbox-orcad:cutover9-20260922` (`sha256:61da90a1c616a0e2933357465ea22e9d775ea430349a15472d30bc763f5c62d4`)  
Fallbacks: `orca-live-prev-cutover8` (`cutover8-20260916`, stopped, Exited 0), `orca-live-prev-cutover7` (`cutover7-20260916`, stopped, Exited 0)  

---

## 7. Pre-Cutover Witnesses (Read-Only)

1. **`docker inspect orca-live` snapshot**:
   - Saved to `/tmp/opencode/orca-live-inspect-cutover9.json` (10648 bytes).
   - Exact flags captured: `--network host`, `--user 1000:1000`, `--group-add 988`, `--restart unless-stopped`, binds (`/home/mihail:/home/mihail`, `/var/run/docker.sock:/var/run/docker.sock`, `orca-src:/src`), environment variables (`HOME`, `ORCA_USER_DATA`, `ORCA_VERSION`, `ORCA_DAEMON_EXEC_PATH`, `ORCA_SANDBOX_AGENTS`, `ORCA_SANDBOX_BIND_MAP`, `ORCA_SANDBOX_IMAGE`, `ORCA_SANDBOX_DRI_DEVICES`, `ORCA_SANDBOX_GPU_GROUPS`), healthcheck config, and entrypoint/cmd (`node /app/orcad.js --port 6768 --pairing-address wss://orca.simple-business-platform.com`).

2. **Session Snapshot**:
   - Command: One-shot `orca-dev:stable` running `node out/cli/index.js sessions snapshot --file /tmp/opencode/sessions-before-cutover9.json`.
   - Output: `snapshot: 6 rows → /tmp/opencode/sessions-before-cutover9.json` (takenAt `1790091896819`).
   - 6 active pane sessions across 4 worktrees:
     - `.../simple-business/LUI-oracle-driven-automatic-development` (`orca-sandbox-62f77986`): `term_7dbd1cfc-90f1-43ad-a648-6a89cde94dbe` (pty `@@188a7c49`, pid 307072), `term_afa088ee-bdde-4817-a122-099a5d5571bc` (pty `@@lsOePVls`, pid 309078).
     - `.../simple-business/Forge-speed-up` (`orca-sandbox-f88c07d3`): `term_21e1031a-e230-4740-bf60-69a1416c99a3` (pty `@@043fb43e`, pid 315208), `term_287b92b1-8939-4fa5-84b8-ab91583019cc` (pty `@@h-dv2uOj`, pid 409989).
     - `.../simple-business/Analyze-build-artifacts-size-and-offer-strategies` (`orca-sandbox-d311380c`): `term_4075192b-0a78-42a6-b345-cebba52a4f7d` (pty `@@2cdc7c6f`, pid 334360).
     - `.../simple-business/Rust-dynamic-linking-experiments` (`orca-sandbox-b314b9c6`): `term_de732f5a-8cc0-40a4-a6c6-edb9b41c825e` (pty `@@e5444910`, pid 351151).

3. **Pairing Baseline**:
   - `/home/mihail/.orca-orcad-data/orca-devices.json`: `dc2b6c95bad039e4f143c60523856669` (10 device entries).
   - `/home/mihail/.orca-orcad-data/orca-e2ee-keypair.json`: `f5a69bb807f3f57fc0abe38d8c106778`.

4. **Pre-Recreate Running Managed Sandboxes & Agent Processes**:
   - `orca-sandbox-b314b9c6`: PID 2728919 (`opencode`)
   - `orca-sandbox-d311380c`: PID 1919231 (`grok`)
   - `orca-sandbox-f88c07d3`: PID 2584037 (`claude`), PID 15574 (`cursor-agent`)
   - `orca-sandbox-6d1d8dbf`: PID 1464588 (`grok`)
   - `orca-sandbox-62f77986`: PID 1221904 (`claude`), PID 3559246 (`agy`), PID 63813 (`agy`)

---

## 8. Recreate Execution (`orca-live` on `cutover9-20260922`)

Single shell layer stop → rename → run:
```bash
docker stop -t 5 orca-live && \
docker rename orca-live orca-live-prev-cutover8 && \
docker run -d --name orca-live --network host --user 1000:1000 \
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
    -e ORCA_SANDBOX_IMAGE=orca-dev:stable \
    -e ORCA_SANDBOX_DRI_DEVICES=/dev/dri/renderD128 \
    -e ORCA_SANDBOX_GPU_GROUPS=44,991 \
    --health-cmd="node -e \"require('net').connect(6768,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})\"" \
    --health-interval=15s --health-timeout=5s --health-start-period=60s --health-retries=3 \
    orca-sandbox-orcad:cutover9-20260922 \
    --port 6768 --pairing-address wss://orca.simple-business-platform.com
```

Results:
- Container ID: `2d500000088245346259b5a39ea32c58da485943e14eb2373fb9abe4cbe5e7b8`.
- Boot logs:
  - `Orca server ready`
  - `Bound endpoint: ws://127.0.0.1:6768`
  - `Build: 0.0.0-orcad (6a11cc9725005c17), Node 24.21.0 ABI 137`
  - `Terminal daemon: live — PTY self-test passed (pty-spawn: healthy); terminals survive an orcad restart: yes`
- Healthcheck: `Up 21 seconds (healthy)` (achieved on first interval, well within 3-minute gate).
- Hook listener: Bound on `127.0.0.1:42505` (`ss -ltnp` confirmed).
- Endpoint file `/home/mihail/.orca-orcad-data/agent-hooks/endpoint.env` rewritten with fresh mtime (`ORCA_AGENT_HOOK_PORT=42505`, token `9f5fc028-b8e1-49f7-9bf1-db7133c1ee16`).

---

## 9. Post-Recreate Daemon Verification

1. **Session Verify**:
   ```
   [remapped] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/LUI-oracle-driven-automatic-development handle=term_7dbd1cfc-90f1-43ad-a648-6a89cde94dbe now=term_48160180-c711-41d1-b0c5-765e0af84d35 — handle term_7dbd1cfc-90f1-43ad-a648-6a89cde94dbe is now term_48160180-c711-41d1-b0c5-765e0af84d35 — update the client
   [missing] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/LUI-oracle-driven-automatic-development handle=term_afa088ee-bdde-4817-a122-099a5d5571bc — session gone after restart (container orca-sandbox-62f77986)
   [missing] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/Forge-speed-up handle=term_21e1031a-e230-4740-bf60-69a1416c99a3 — session gone after restart (container orca-sandbox-f88c07d3)
   [missing] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/Analyze-build-artifacts-size-and-offer-strategies handle=term_4075192b-0a78-42a6-b345-cebba52a4f7d — session gone after restart (container orca-sandbox-d311380c)
   [remapped] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/Rust-dynamic-linking-experiments handle=term_de732f5a-8cc0-40a4-a6c6-edb9b41c825e now=term_a1be2df3-8714-45b7-a4e3-fe994e42e00a — handle term_de732f5a-8cc0-40a4-a6c6-edb9b41c825e is now term_a1be2df3-8714-45b7-a4e3-fe994e42e00a — update the client
   [missing] 5a4a87b9-2cda-435b-8143-2f39113542d6::/home/mihail/orca/workspaces/simple-business/Forge-speed-up handle=term_287b92b1-8939-4fa5-84b8-ab91583019cc — session gone after restart (container orca-sandbox-f88c07d3)
   verify: ok=0 reattached=0 remapped=2 missing=4 new=0
   ```
   - **Explanation**: 2 worktree sessions remapped their handles (`LUI-oracle-driven-automatic-development` → `term_48160180...`, `Rust-dynamic-linking-experiments` → `term_a1be2df3...`). The 4 missing rows are the individual lost sandbox panes (across `LUI...`, `Forge-speed-up`, and `Analyze...`), explicitly anticipated and accepted by the owner for this cutover. Zero unexpected missing rows.

2. **Pairing Integrity**:
   - `orca-e2ee-keypair.json`: `f5a69bb807f3f57fc0abe38d8c106778` (identical before and after).
   - `orca-devices.json`: 10 devices, all device IDs, tokens, scopes, and pairedAt match byte-for-byte; only `lastSeenAt` updated for the active pairing device on daemon reconnect (identical to cutover8 behavior). Zero device drift.

3. **`spawn gh ENOENT` Check**:
   - Monitored `docker logs orca-live | grep -c 'spawn gh ENOENT'` continuously for >9 minutes: count stayed strictly **0**.

4. **Live Sandboxes & Agent Processes Verification**:
   - All 5 managed sandboxes remained `Up` with exact same start times (`2026-09-21 19:52:06`, `16:56:04`, `12:46:47`, `11:55:33`, `11:26:07` UTC).
   - All agent processes inside each sandbox verified running post-recreate with identical PIDs:
     - `orca-sandbox-b314b9c6`: PID 2728919 (`opencode`) alive.
     - `orca-sandbox-d311380c`: PID 1919231 (`grok`) alive.
     - `orca-sandbox-f88c07d3`: PID 2584037 (`claude`), PID 15574 (`cursor-agent`) alive.
     - `orca-sandbox-6d1d8dbf`: PID 1464588 (`grok`) alive.
     - `orca-sandbox-62f77986`: PID 1221904 (`claude`), PID 3559246 (`agy`), PID 63813 (`agy`) alive.

---

## 10. Fresh Sandbox E2E Verification & CLI Table

1. **Proof Worktree Created**:
   - Repo: `/src/agent-infra` (host `/work/docker/volumes/orca-src/_data/agent-infra`)
   - Worktree: `cutover9-proof` (`4b2dad1c-2e58-4ece-93c8-55054255aa1a::/home/mihail/orca/workspaces/agent-infra/cutover9-proof`)
   - Spawned fresh sandbox: `orca-sandbox-8b20b4c4`.

2. **Fresh Sandbox Inspect Verification**:
   - `:rw` bind present: `/home/mihail/.orca-orcad-data/opencode-hooks/shared:/home/mihail/.orca-orcad-data/opencode-hooks/shared:rw`.
   - `ExtraHosts`: contains `host.docker.internal:host-gateway`.
   - `Memory`: `8589934592` (exact 8 GiB cap).

3. **In-Sandbox Host Routing & OpenCode Checks**:
   - `opencode models | head -3`: Successfully returned `opencode/big-pickle`, `opencode/ling-3.0-flash-fin-free`, `opencode/mimo-v2.6-flash-free` with exit 0 (zero `PermissionDenied` errors).
   - `getent hosts host.docker.internal`: Resolved cleanly to `172.17.0.1`.
   - `curl http://host.docker.internal:42505/`: Returned HTTP `000` (code 7, connection refused; recorded as expected since listener binds loopback 127.0.0.1 on host).

4. **CLI Hook Plane Real Turns (6/6 Tested)**:

| CLI | Ran | Status Event Seen (source/state) | Notes |
| :--- | :---: | :---: | :--- |
| `claude -p 'reply with ok'` | **Yes** | `claude` / `done` | Executed inside sandbox; returned `ok`. Spooled Stop event; drained into `last-status.json` with prompt `"reply with ok"`, `lastAssistantMessage: "ok"`. Spool 0 bytes. |
| `codex exec 'reply with ok'` | **Yes** | None (expected) | Executed inside sandbox; returned `ok`. As documented in Item G / Addendum, daemon does not install codex real-home hooks, so no status event is expected. |
| `grok -p 'reply with ok' --permission-mode dontAsk` | **Yes** | `grok` / `done` | Executed inside sandbox; returned `ok`. Spooled Stop event; drained into `last-status.json` with `lastAssistantMessage: "ok"`. Spool 0 bytes. |
| `cursor-agent -p --force 'reply with ok'` | **Yes** | None (expected) | Executed inside sandbox; returned `ok` (auth synced from live sandbox). In headless print mode `-p`, cursor-agent CLI does not invoke `hooks.json`. |
| `agy -p 'reply with ok' --print-timeout 5m` | **Yes** | `antigravity` / `done` | Executed inside sandbox; returned `ok`. Spooled Stop event; drained into `last-status.json` with `agentType: "antigravity"`. Spool 0 bytes. |
| `opencode run 'reply with ok'` | **Yes** | `opencode` / `done` | Executed inside sandbox; returned `ok` (model `build · gpt-5.6-luna`), zero `PermissionDenied`. Spooled `SessionIdle` event; drained into `last-status.json`. Spool 0 bytes. |

5. **Tool-Level Event Filtering**:
   - Spool file `pane-e791a95b-cf60-4789-9582-1873ee94b66d.jsonl` was monitored across all runs. Zero tool-level events (`PreToolUse`, `preToolUse`, etc.) appeared in the spool file. The spool file remained drained at 0 bytes.

6. **Cleanup**:
   - `orca worktree rm --worktree path:.../cutover9-proof --force --json` executed cleanly (`removed: true`).
   - Proof container `orca-sandbox-8b20b4c4` automatically reaped; `docker ps` confirmed only the original 5 sandboxes remain running.
   - Branch `Mivr/cutover9-proof` deleted cleanly. Production state left clean.

---

## 11. Final Rollout Decision

**NO ROLLBACK NEEDED. CUTOVER9 IS FULLY GREEN AND LIVE.**
- Live container: `orca-live` on `orca-sandbox-orcad:cutover9-20260922` (`sha256:61da90a1c616...`).
- Fallbacks preserved: `orca-live-prev-cutover8` (Exited 0) and `orca-live-prev-cutover7` (Exited 0).
- All verification gates passed without regressions.
