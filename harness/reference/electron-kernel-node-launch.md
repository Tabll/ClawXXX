# Standalone Node launch from Electron

## Incident and scope

On 2026-09-11 the local OpenClaw 2026.9.2 Gateway ran inside Electron 43.4.0
`utilityProcess`. The existing native state database caused its readonly worker
to execute `process.execPath`, i.e. Electron Helper. Chromium GPU/network children
failed and the CLI exited with code 1. Four supervisor generations, each with
three startup attempts, exhausted the restart budget. The native state database
passed read-only `PRAGMA quick_check`; deleting it is not a repair.

This host-only fix does not change kernel revisions, signed artifacts or the
canonical DataService history authority. DataService itself remains an Electron
utility process; its MessagePort protocol and SQLite ownership are unchanged.

## Launch contract

- OpenClaw Gateway, ACP, CLI, Doctor and device-approval CLI fallback select the
  active location's absolute standalone `nodeExecutable`. Gateway uses native
  `child_process.spawn` with `shell: false`, not `utilityProcess.fork`.
- Installed packages exclusively use their verified `runtime/node` executable.
  Development resolvers require the reviewed Node pin in
  `temp/kernel-node/<version>/<platform>-<arch>` and never use Electron or PATH
  as a fallback. `pnpm dev`, standard Electron tests and profiling prepare it.
- `pnpm run kernel:dev:prepare` invokes the existing official-archive downloader,
  verifies the locked archive SHA-256, and rechecks the cached receipt and actual
  Node version, platform, architecture and ABI. Invalid existing caches fail;
  they are not silently overwritten. The downloaded cache remains git-ignored.
- Strip Electron-only flags, inherited `NODE_OPTIONS` and `NODE_PATH`; prepend
  the selected Node directory so `process.execPath` workers and `node` tools use
  the same runtime. Retain the existing dev-only host preload after sanitizing.
- Stdio kernels opt into `nodeRuntime` so sanitization happens after inherited
  environment merging. DeepSeek Harness uses this policy; future non-Node
  kernels are not forced through Node. CLI wrappers clear Node/Electron launch
  overrides and use the selected runtime directory. Host-owned CLI launches
  always bypass convenience wrappers that may refer to an earlier activation.
- Signal-only Node exits fail readiness promptly with the original signal.
  Spawn errors carry the failed child explicitly; no callback reads the child
  binding before the launch promise resolves. Keep existing ownership, bounded
  retries, Windows tree termination, and kernel isolation.

## Public trust setup

Production public roots are locally materialized in
`resources/kernels/trust/roots.production.json` (git-ignored); release CI still
materializes its protected public bundle independently. No private signing keys
are needed for development catalog verification.

Retrieve roots from authenticated, accepted release evidence and independently
verify its fingerprint. Never establish trust by downloading a catalog and its
unverified keys from the same endpoint. Import with:

```sh
pnpm run kernel:trust:import --source /absolute/path/to/verified/roots.production.json --sha256 VERIFIED_SHA256
pnpm run kernel:distribution:drill
```

The importer rejects a hash mismatch, private material, invalid/inactive public
keys and replacement of different existing roots. Matching roots are idempotent.
Rotation still requires deliberate review; expiry/signature/rollback checks stay
enabled. Public roots must not be confused with offline private-key backups.

Local restoration evidence:

- Successful protected publication run `34296346239`, artifact `10083318832`.
- Evidence ZIP SHA-256:
  `7258a3329505d2bae2efef358b5ba95d47c184c83349c0967f52fa08cffd328c`.
- Public roots file SHA-256:
  `e886cb9073bced2b74a4a0f38d6398247d2824d7b771edb83e8ad8de373648f0`.
- Verified on 2026-09-11: both production catalogs sequence 1, HTTP 200 and
  conditional 304; OpenClaw/DSH darwin-arm64, both hosts, all eight Range/If-Range
  requests HTTP 206. No object upload, overwrite or deletion.

## Regression and remaining local blocker

`tests/e2e/kernel-node-runtime.spec.ts` launches real Electron and the patched
OpenClaw dependency through the production Gateway launcher. Each isolated test
owns its roots and random loopback port. It seeds an existing native SQLite
database using the host plugin-index schema and a preservation marker, verifies
the actual readonly worker and Node grandchild identity, launches two distinct
Gateway PIDs, checks HTTP and WebSocket readiness, verifies the marker and
quick_check after stops, and asserts no active child remains. It does not use
the mocked kernel API or any provider account. Evidence is attached to Playwright
artifacts, including on failure. Standard three-platform E2E runs include it.

Local macOS arm64 real Electron warm-start regression passed. Windows/Linux
execution of the added regression requires the next CI run; no remote workflow
was triggered by this task. On 2026-09-11 the full local suite passed:

- Unit/contract: 2458 passed, 6 existing conditional skips.
- Electron E2E: 153 passed, 3 existing conditional skips; Electron 43.4.0,
  kernel Node 24.20.0, both real Gateway generations ready and stopped.
- Typecheck, lint (0 errors, 7 existing Fast Refresh warnings), comms replay and
  compare, both kernel source locks, Harness CI, task validation/dry-run and
  `git diff --check` passed. The Harness dry-run is plan/boundary validation;
  the lint/typecheck/unit/comms/E2E commands were executed separately above.

The checklist and the independent unresolved local blocker are tracked in TODO.

After the running dev app hot-reloaded this fix, its workers successfully ran
with Node 24.20.0. Startup then exposed a separate pre-existing native **Agent**
database schema-v1 media migration requirement (`openclaw-agent.sqlite`), now
reported as exit 78, plus session_participants schema drift. The application's
existing automatic Doctor attempt did not resolve it. The passing new regression
does not claim to validate migration of that old Agent schema. Do not delete or
reset native or canonical databases, reinterpret quick_check as schema migration
success, or report the user's actual kernel as ready. A separate backed-up,
isolated migration investigation and user authorization was required. The user
subsequently authorized it; see `openclaw-agent-schema-ownership.md` for the
confirmed auth-sync version-marker downgrade, backed-up repair and regression.
That follow-up restored the actual local app to ready; the blocker described
above is historical, not the current post-repair state.
