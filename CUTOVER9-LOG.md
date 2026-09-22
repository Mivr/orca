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
