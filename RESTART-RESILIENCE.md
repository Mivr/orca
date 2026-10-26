# RESTART-RESILIENCE.md — orcad/daemon restarts must never break agent flow or the UI

Background: cutover7 restarted `orca-live` onto a new orcad image. The daemon reattached the
sandbox PTY cleanly (same daemon session `@@8dad5a1d`, new host pid, `startup-command-delivery
written:false, hasCommand:false`), the agent (`agy` pid 14 in `orca-sandbox-eaf08a75`) ran
untouched — but the runtime minted a NEW terminal handle (`term_66d57a08` → `term_39f51a92`,
new incarnationId). Mihail's client still held the old handle, so the session "vanished" from
the UI, and a resume attempt then hit agy's conversation lock. This document is the guarantee
and the procedure that prevents a repeat. No `orca-live` restart is part of this change;
rollout happens in a future cutover window.

## The guarantee

1. **Stable terminal identity.** `ORCA_TERMINAL_HANDLE` (the `term_*` identity agents and
   paired clients hold) is durable per ptyId in `<userData>/orca-terminal-handles.json`
   (atomic tmp+rename writes, best-effort — a lost file degrades to today's minting, never to
   a failed spawn). After an orcad restart the same ptyId replays the SAME handle:
   `preAllocateHandleForPty` / `issuePtyHandle` consult the store before minting, and the
   startup reattach path (`adoptControllerTerminalHandle`, `registerPty` incarnation-change
   branch) re-seats the exported stable handle instead of refusing it. Rotation only happens
   for a genuinely new process, and then an old→new remap record is appended (bounded ring,
   last 200) that `sessions verify` and the reattach report can resolve.
2. **Reattach notification, not silence.** After orcad startup, `publishTerminalReattachReport`
   diffs the durable handle map against the live controller inventory and publishes one
   `terminalReattachNotice` client event (`runtime.clientEvents.subscribe`) listing reattached
   sessions (same handle, flagging incarnation changes), remapped handles (old→new), and
   sessions that failed to reattach with a reason (`absent-from-inventory`, `not-connected`).
   The report also persists server-side (`lastReport` in the handle store file) for late
   readers and future RPC exposure. The UI must render this as "restarted, your session is
   now X" / "session Y did not come back (reason)". `sessions verify` independently recomputes
   old→new handle mappings by diffing the pre-restart snapshot against live state.
3. **Reattach never injects.** A post-restart reattach re-creates the daemon session with NO
   startup command (`written:false, hasCommand:false`). It never writes bytes into the PTY,
   never closes/reaps running sandbox containers, and never touches pairing state. Doubly
   important for agents: re-injecting the launch command double-starts the agent and wedges
   it on a conversation lock — exactly what the cutover7 resume hit.

## Mandatory pre/post procedure for future CUTOVER-LOGs

BEFORE any `orca-live` restart (seconds, read-only — these call `terminal.list` and
`worktree.ps` only):

```
orca sessions snapshot --file /tmp/opencode/sessions-before-<date>.json
```

AFTER the restart, once `:6768` is healthy:

```
orca sessions verify --file /tmp/opencode/sessions-before-<date>.json
```

`verify` prints one line per row — `ok`, `reattached` (same handle, new incarnation/pid:
expected and healthy), `remapped` (old handle → new handle: update the client), `missing`
(session gone: investigate before proceeding), `new` (appeared after the snapshot) — plus a
summary count and the host's own reattach report when present. It exits non-zero iff snapshot
rows are missing. A cutover with `missing > 0` or unexplained `remapped` rows must stop and
report; it must not proceed to e2e proves.

## Files (restart-resilience slice)

- `src/main/runtime/terminal-handle-persistence.ts` — durable handle store + remap ring.
- `src/main/runtime/orca-runtime-terminal-handle-durability.ts` — runtime mixin: persistence
  dir setter, stable-handle helpers, `publishTerminalReattachReport`.
- `src/main/runtime/orca-runtime-resolve-known-workspace-file-target.ts` — issuance/
  adoption consult the store.
- `src/main/runtime/orca-runtime-register-pty.ts`, `orca-runtime-bind-pty-incarnation-handle.ts`
  — incarnation-change preserves the stable handle.
- `src/main/orcad/orcad-entry.ts` — orcad startup enables persistence + publishes the report.
- `src/shared/runtime-client-events.ts` — `terminalReattachNotice` event + report shape.
- `src/shared/runtime-terminal-contracts.ts`, runtime record/summary files — optional
  `processId` on terminal rows (feeds the snapshot's pid column).
- `src/cli/handlers/sessions.ts`, `src/cli/specs/core.ts`, `src/cli/handler-group-manifest.ts`,
  `src/main/startup/cli-command-names.ts` — `sessions snapshot` / `sessions verify`.
