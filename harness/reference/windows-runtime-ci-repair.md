# Windows runtime CI repair — OpenClaw +clawx.8 / +clawx.9

## Failure and root cause

[Build 34040448610](https://github.com/Tabll/ClawXXX/actions/runs/34040448610)
at `84ae366c` completed with eight successful non-Windows builds and two failed
Windows builds. Single/dual clean-machine matrices were skipped; the same
commit's three-platform Electron E2E passed. This is not production publication.

OpenClaw failed startup's `persisted-registry-stale-source` check. An isolated
Windows 11 / Node 24.15.0 reproduction established this sequence:

1. Configured plugin paths use Windows 8.3 aliases, while async `realpath`
   install records use long paths. Discovery reports duplicate plugin IDs.
2. `prepareInstalledPluginPaths` previously scanned object insertion order.
   SQLite serializes the install-record map in owner order.
3. After a fresh cache and SQLite reread, diagnostic **order**, not diagnostic
   content or the selected plugin records, changes. The whole registry comparison
   fails, while per-plugin `differences` is empty.

The patch sorts install-record entries by owner **before scanning**. Explicit
configured load-path priority, package selection, physical boundary checks,
hashes, strict comparisons, migration leases and checkpoint guards are unchanged.
No diagnostics are ignored or sorted away at the comparison layer. The same
real Windows short-path fixture becomes `persisted` with no differing keys.

`probe-openclaw-plugin-registry.mjs` reproduces the duplicate-discovery condition
on every OS with two separate, never-executed plugin copies and reverse install
order. It uses the exact pinned compiled registry and a private SQLite database,
requires three fresh-cache write/read cycles, and rejects real manifest,
entrypoint, policy and diagnostic-content changes. The old +clawx.7 payload fails
this regression on macOS as well. CI runs it on each OpenClaw payload before the
existing real Gateway/ACP/seven-Channel probe and before signing.

## Other Windows fixes

- Artifact fsync opens `r+`, not `r`: Windows requires write access for flushing.
  The archive is neither recreated nor truncated; flush failures are fatal and
  descriptors close in `finally`. Isolated Node regression covers writable-handle
  enforcement, injected EIO, unchanged bytes and missing-file rejection.
- Strict patch fixtures set local `core.autocrlf=false` and `core.eol=lf`.
  Regression supplies private global configs with both autocrlf values and CRLF
  preference; it does not modify the developer's Git settings. Exact LF and
  offset rejection remain mandatory.
- DeepSeek driver assertions construct native absolute paths with `resolve/join`,
  including spaces, and retain exact install identity and traversal rejection.
  Production path resolution is unchanged.

## Frozen identity and verification boundary

OpenClaw is `2026.9.2+clawx.8` / patch revision 8. The upstream npm version,
commit and archive integrity are unchanged. The patch adds one reviewed compiled
discovery target (23 targets total). Root pnpm lock changes only its 24 affected
patch-hash references; no dependency versions change. Runtime, control overlay,
overlay manifest and source/lock hashes are synchronized. DeepSeek remains
`0.1.3-alpha.1+clawx.11` with its own frozen upstream lock unchanged.

Local verification (2026-09-06–07): 2184 host tests passed, zero failed, six
existing conditional tests pending; focused repair suites passed 20 tests.
Frozen install/preparation, source hashes, typecheck, lint (seven pre-existing
warnings), comms and Harness checks passed. The real Windows registry probe also
passed all three round trips and four negative cases. The rebuilt macOS arm64
payload passed the existing full Gateway/ACP/seven-Channel/storage probe.
Local validation and staging execution are tracked separately in TODO M19 CI.
The Windows VM reproduction is a metadata/SQLite test using a copied payload,
not a substitute for a native Windows CI build, signing, full Gateway/Channels
or clean-machine installation. The new full workflow must use the repaired SHA,
both kernels and all five targets, with explicitly deferred Windows Authenticode.
No COS upload, catalog promotion, installed-kernel replacement or production
release is authorized by this task.

## Follow-up: real Windows Gateway startup — +clawx.9

[Build 34044309931](https://github.com/Tabll/ClawXXX/actions/runs/34044309931)
at `65a87de9` passed nine of ten builds: DeepSeek Windows and the real Windows
registry round-trip probe now passed. The only failure was OpenClaw Windows'
90-second real Gateway readiness deadline. All four macOS signing/notarization
jobs and three-platform Electron E2E succeeded; clean-machine was skipped.

An isolated Windows 11 / pinned x64 Node 24.15.0 run reproduced the deadline.
Upstream startup tracing showed ongoing work, not a stationary deadlock:
process bootstrap took 56.6 seconds, HTTP bound at 77.0 seconds, and real
Channels were still loading at 90 seconds. These are diagnostic timings for
that VM, not CI performance measurements or an application startup SLA.

The same trace revealed a second, previously masked failure: Discord could not
register its keyed store because its configured-path candidate had no install
owner (`record-missing`). Windows' JavaScript `realpathSync` preserves case and
8.3 aliases that asynchronous/native realpath canonicalizes. The two paths can
refer to one directory yet be treated as different candidates. Sorting from +8
fixes persistence determinism but cannot restore the missing physical identity.

The +9 patch changes `pluginCacheRealpathSync`'s default to native realpath on
Windows only. Explicit mode arguments and all other platforms are unchanged.
No ID-based trust fallback, lowercase string comparison, boundary exception or
provenance bypass is introduced. Metadata regression now covers uppercase
physical paths and junction/symlink aliases, a different physical copy claiming
the same official ID, conflicting provenance, and ambiguous install owners,
alongside the previous three SQLite round trips and four stale-change cases.
An in-memory rollback of only the native-realpath default made this Windows
regression fail with `record-missing` instead of `trusted-official`; the final
package passes without diagnostic hooks.

Probe lifecycle changes are limited to verification tooling:

- Windows real Gateway readiness is bounded at 180 seconds; macOS/Linux retain
  90 seconds. The extracted Windows full-probe envelope is 600 seconds (other
  platforms 300), and pre-seal CI has a 15-minute step limit. Control-bridge and
  application budgets are unchanged. Readiness still requires successful live
  HTTP, never a trace message or mock; exited/signalled processes and late
  success fail, and response bodies/error listeners are released.
- Reports record both startup measurements and preserve a bounded log tail on
  failure, with upstream startup tracing enabled in the isolated child.
- Windows denied bare `echo` before approval because no executable identity
  could be bound. The fixture now puts the pinned Node first on its private
  PATH and executes an owned fixed script. It grants `allow_once` only when
  `toolCall.rawInput.command` exactly matches that command and requires actual
  `CLAWX_TOOL_OK` tool output. Permission checks are not disabled or weakened.
- Cleanup closes owned provider connections and retries transient Windows
  filesystem removal; failed spawns are not awaited as live processes.

The final, uninstrumented probe passed in Windows: 34,486 / 21,127 ms for first
start/restart; real ACP, seven lazy Channel execution modules, six loopback
provider calls, exact tool approval/output, cancel, forced-crash rehydration,
one accepted/one rejected canonical Channel ingress, four distinct usage events
and zero native durable history. The VM used a copied JavaScript payload and
the pinned Windows Node; this does not certify a native Windows CI archive,
platform security, sealed-file integrity or clean-machine installation.

Frozen identity is `2026.9.2+clawx.9` / revision 9, with 24 compiled patch targets.
The upstream version/commit, all dependency versions and DeepSeek pins remain
unchanged; patch, root lock's 24 hash references, source, runtime, control overlay
and manifest hashes are synchronized. Full host verification passed 2191 tests,
with six existing conditional tests pending. Typecheck, lint (zero errors,
seven existing warnings), source verification and comms replay/compare passed.
The rebuilt macOS arm64 payload also passed the same full probe (4,560 / 2,517
ms readiness), and Harness CI plus the diff-aware task validation/dry-run passed.
New staging results must still be recorded separately; no COS/catalog write is
authorized by this repair.
