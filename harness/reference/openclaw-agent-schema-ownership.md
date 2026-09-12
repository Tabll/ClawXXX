# OpenClaw Agent schema ownership and the 2026-09-11 repair

## Root cause

This was not an unconverted legacy Agent database. The local database already
passed OpenClaw 2026.9.2's physical schema validation for version 19, including
the new `session_participants.identity_namespace` key. ClawX auth synchronization
nevertheless executed `PRAGMA user_version = 1` and updated the `primary`
`schema_meta.schema_version` to 1 on every write. The schema owner's app version
remained 2026.9.2. Doctor consequently tried its pre-media structural migration
against already-modern participants, rejected it and rolled back; normal startup
reported media migration required / exit 78. `quick_check = ok` alone could not
identify this semantic mismatch.

The earlier Electron Helper launch defect was separate. Fixing standalone Node
exposed this second blocker. See `electron-kernel-node-launch.md` for that history.

## Durable write boundary

`electron/utils/openclaw-agent-auth-writer.ts` runs a bounded asynchronous worker
under the active, verified kernel's standalone Node. It imports that package's
public `dist/plugin-sdk/sqlite-runtime.js`, opens the Agent database through
`openOpenClawAgentDatabase`, and uses the SDK's immediate transaction helper for
the two auth cells. The kernel owns full schema initialization, admission,
version checks, leases and exit cleanup. Main does not copy native DDL, stamp
schema versions or perform ad-hoc schema migration. Fresh databases receive the
complete kernel schema; unsupported/newer/old owned schemas fail admission.

Secrets and auth state travel over stdin, never command arguments or environment
variables. Input/output and execution time are bounded; error responses contain
only phase/code classifications, not raw JSON, SQL or stderr. Both cells update
in one transaction. Host auth readers and compatibility JSON retain their existing
interfaces, while writes are awaited before reporting success or reloading auth.
No renderer route, canonical storage authority, provider account or runtime
artifact version changes are involved.

The public SQLite SDK is part of the selected runtime contract: missing/incompatible
SDKs fail closed. Do not replace this with Main's Electron SQLite schema bootstrap,
an unverified system Node, a hardcoded v19 schema, or a fallback to another kernel.

## Authorized local repair evidence

The user authorized backup, isolated validation, then repair. Before copying,
the exact dev Electron instance was stopped and Vite hot reload paused; `lsof`
confirmed no open Agent database handle. Restricted, git-ignored rollback material
is retained under `.local-backups/openclaw-agent-schema-20260911-lbAmv6/`:

- `original/`: untouched Agent database plus WAL/SHM and native global-state backup.
- `isolated-proof.json`: integrity/FK checks, per-table row counts/hashes and the
  rejected legacy migration followed by the validated marker-only correction.
- `isolated/`: the repaired SQLite snapshot, created with SQLite's backup API.
- `live-repair.json`: exact original/WAL fingerprint guard, transaction validation,
  changed-table list and proof that canonical `clawx.sqlite` was not changed.

The original Agent main-file SHA-256 is
`61f9d1106f77516ce628c2b8d5b858b19f727e94883387cbfea277ce67c80290`.
Backups contain private auth data, must remain local and must not be uploaded as
CI artifacts or committed. This new backup is not removed by the old automatic
2026.7.1 snapshot cleanup.

On the isolated copy, the actual kernel schema validator passed before mutation.
Doctor's legacy structural step failed and preserved all row hashes. Only after
those checks were the two incorrectly downgraded version markers repaired to 19.
The kernel's strict maintenance validator, quick_check and foreign_key_check then
passed; only `schema_meta` changed, and every business-table fingerprint remained
identical. The same operation on the stopped original was transactional, guarded
by original main/WAL hashes and all row hashes, and matched the isolated result.
Canonical `clawx.sqlite` SHA-256 was identical immediately before and after repair.

This is an incident-specific marker repair, **not** a generic migration strategy.
Do not blindly bump versions on a real old, corrupt, differently owned or unknown
database. Such cases require their own backed-up kernel migration investigation.

## Regression

`tests/e2e/kernel-node-runtime.spec.ts` now seeds a real native Agent database using
the actual host auth writer before starting the real Gateway. It verifies schema
ownership and a non-auth preservation marker through pre-start sync, live sync
and two real Gateway generations, with HTTP/WS readiness and SQLite integrity.

For local incident replay, set `CLAWX_E2E_EXISTING_AGENT_DATABASE` to an independently
repaired copy. The test snapshots it read-only into its isolated root, replaces
credentials with synthetic values before Gateway launch, disables channels/plugins,
cron and heartbeat, and never sends a provider request. The original is not edited.
This incident-copy replay passed on macOS arm64 (10.5 seconds); the default fresh
Agent-state case remains mandatory in the standard three-platform E2E suite.
Windows/Linux results require CI, not inference from a local macOS pass.

Full local validation: 2464 unit/contract passed / 6 existing skips; 153 macOS
Electron E2E passed / 3 existing skips; typecheck, lint (0 errors / 7 existing
Fast Refresh warnings), comms replay/compare, source verification, Harness CI
(19 tests), task validation/dry-run and diff checks passed.

The real `pnpm dev` app was restored after the original database repair. On
2026-09-11 at 15:46:38 +08:00, Gateway PID 66693 started under Node 24.20.0;
the authenticated WebSocket handshake completed at 15:46:45. The same process
remained running for over two minutes without exits/restarts, `healthz` returned
`{"ok":true,"status":"live"}`, and native UI inspection showed OpenClaw ready
with the chat input enabled. Auth synchronization left both Agent version markers
at 19, quick_check=ok and zero foreign-key errors. Existing conversations remained
visible; no real model request was sent. DSH remained stopped as before.

The application's existing successful-start hook removed its old 2026.7.1
one-time upgrade snapshot. The new private incident backup and proofs remain
available and were not deleted. See TODO M22; no commit, push or remote workflow
was performed by this task.
