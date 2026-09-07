# Windows runtime CI repair — OpenClaw +clawx.8 / +clawx.9 / +clawx.10 / +clawx.11

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

## Follow-up: manifest cache identity and notarization recovery — +clawx.10

[Build 34048363051](https://github.com/Tabll/ClawXXX/actions/runs/34048363051)
at `1b459ff7` passed eight of ten runtime builds and all three Electron E2E
platforms. OpenClaw Windows failed the real registry's manifest-change assertion
**before** the Gateway probe. DeepSeek Intel macOS passed build, seven executable
signatures and credential validation, then `notarytool submit --wait` exited on
`NSURLErrorDomain -1001` while reading submission
`e14fd882-fd40-4450-8b25-55b67951dc13`. This is a transport failure, not evidence
of Apple rejecting the archive. Single/dual clean-machine jobs were skipped.

### Windows reproduction and minimal runtime patch

The same pinned Node 24.15.0 process and copied JavaScript payload passed with
a long TEMP path but failed with a real Windows 8.3 TEMP alias. Instrumentation
did not replace registry logic: it showed that the explicitly configured copies
were selected correctly in both cases. On the short path, however:

1. Discovery first reads a manifest through the configured short alias and
   caches its parsed result on the checked file object.
2. Later registry consumers use the canonical long plugin root. The cached
   `manifestPath` still belongs to the first lexical caller.
3. `path.relative(longRoot, shortManifest)` contains parent traversal. The
   unchanged checked-file reader correctly rejects it. Required manifest hashes
   become empty strings, with `could not hash ...: validation` diagnostics.
4. Mutating the real active manifest then produces the same empty hash and
   registry result, incorrectly accepting `persisted` rather than `derived`.

`loadPluginManifest` now caches `file.path` **after** a successful checked read.
It does not resolve or trust a new arbitrary path, change plugin precedence,
skip safe opening, ignore diagnostics, or relax hardlink/provenance/owner policy.
The parsed manifest and its stored path identify the same physically verified
file. This also fixes the equivalent directory-symlink alias on macOS/Linux.

The real registry probe defaults to an owned directory alias and also exposes
`--fixture-path-mode native`. It requires the expected configured copies,
canonical manifest paths, nonempty SHA-256 hashes and no hash-failure diagnostic
before its original three SQLite round trips and manifest/entrypoint/policy/
diagnostic mutation tests. Additional real checked-file tests reject parent
traversal, directory-link escape and strict hardlinks. All four Windows
long/short TEMP × native/alias combinations passed without diagnostic hooks;
the prior implementation fails the new regression.

The immutable OpenClaw identity is `2026.9.2+clawx.10`, revision 10, with 25 patch
targets. Upstream and dependency versions are unchanged. Patch/lock/source/
runtime/control-overlay hashes are synchronized; the official npm baseline
passes strict preparation with zero offsets/fuzz. Four README locale versions
are synchronized; this repair does not change UI or end-user installation flows.

### Recoverable notarization with unchanged trust requirements

The workflow follows Apple's [custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
and the locally installed `notarytool help submit/info` interfaces. Its archive
is still built from the previously signed kernel and independent Node closure.
The new helper performs a single `submit --no-wait`, persists an archive-SHA-256
bound submission journal, then uses `info` for that exact ID. An existing journal
resumes only for identical archive bytes. An ambiguous upload with no ID leaves
a write-ahead marker and requires reconciliation; it never silently uploads
again. A known ID in a transient Apple submission URL is saved before querying.

Read-only status requests have a 90-second command deadline; transient network,
408/429 and selected 5xx errors retry at 5/10/20/30/30-second backoffs. Submission
is bounded at ten minutes, total helper time at forty minutes and the enclosing
CI step at fifty. Authentication/TLS validation, malformed/unknown/mismatched
responses, Invalid/Rejected results, exhausted retries and late Accepted replies
remain fatal. Only an in-budget Accepted result for the same unchanged archive
can produce the platform-security input. Failure reports replace prior Accepted
state, retain the submission ID and a sanitized classification, and never copy
credential-bearing stderr. Both journal and result JSON are preserved by the
existing always-run report artifact step.

Offline regression covers submit-once ordering, process restart, the exact CI
network timeout, uncertain uploads, malformed IDs, rejection, credential/TLS
failure, changed archives, bounded backoff/deadlines and actual hung-process
termination. Those tests are mandatory before expensive builds/signing. They
are not real Apple acceptance, native archive certification or clean-machine
evidence; record those new CI outcomes separately in TODO MK-1932/1933. No COS,
catalog, user-data or installed-runtime mutation is part of this repair.

### Local verification before the new staging run

The final full host suite passed 2,229 tests with zero failures and six existing
conditional tests pending. Typecheck, lint (zero errors/seven existing warnings),
both frozen source verifications, strict patch preparation, comms replay/compare,
Harness CI and the diff-aware task validation/dry-run passed. An independent
comparison confirms that all 24 root-lock changes only replace the patch hash;
no dependency version or resolution changed.

The uninstrumented Windows probe passed with an actual 8.3 TEMP alias: first
start/restart took 81,711/18,477 ms within the existing 180-second Windows budget.
The rebuilt macOS arm64 closure passed in 3,546/1,828 ms. Both exercised real
Gateway/ACP, all seven lazy Channel execution modules, six loopback-only provider
calls, role/tool approval/output, cancel, forced-crash rehydration, accepted and
rejected canonical Channel ingress, four distinct usage events and no native
durable conversation history. Reports are retained under ignored
`temp/reports/openclaw-registry-notary-repair-{windows,macos}.json`.

The Windows VM uses the copied JavaScript closure plus pinned Windows Node and
the repaired modules; it is not a native CI archive. These local checks do not
certify Apple acceptance, platform signatures, sealed artifacts, clean-machine
installation or COS publication. Those gates remain mandatory in the new
two-kernel/five-target staging run, whose outcome is tracked by MK-1933.

## Follow-up: exact Windows esbuild native allowlist — +clawx.11

[Build 34077942495](https://github.com/Tabll/ClawXXX/actions/runs/34077942495)
at `ae2508be` completed nine of ten runtime builds, all four macOS notarizations
and all three Electron E2E targets. Windows OpenClaw passed the registry's alias,
hash, freshness and boundary regressions plus the full real Gateway/ACP/Channel
probe (94,991/118,570 ms startup/restart within the 180-second budget). It then
failed native payload validation before archive creation because the allowlist
incorrectly expected `@esbuild/win32-x64/bin/esbuild.exe`. Both clean-machine
matrices were skipped; the run retained nine runtime artifacts and ten reports.

The [official frozen npm archive](https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.27.4.tgz)
matches the root lock's SHA-512 integrity and contains `package/esbuild.exe`,
`package/package.json` and `package/README.md`, with no `bin/` directory. The
11,383,296-byte executable has PE machine AMD64 (`0x8664`) and SHA-256
`39ee9d164e9f8969ff10852e81023c7141c2fe750e5ea2807f06c3a586e337a7`.
Only that exact allowlist path is corrected; the native validator, pruning,
signing, notarization, budgets and runtime probes are unchanged. The audit does
not execute the downloaded Windows program or introduce another dependency.

Fifteen offline regressions use the checked-in allowlist and real native
validator across all five targets. Header fixtures must be detected even when
extensionless; exact approved paths pass while adjacent executables, the old
Windows path and wrong platform/architecture paths fail. The old configuration
fails two of these tests, including the same error as CI. The existing
deterministic artifact test now also assembles a Windows-target esbuild fixture,
compares archive/descriptor bytes, and proves unreviewed binaries block output.
The focused allowlist suite runs before expensive source builds in every CI job;
the final complete-payload audit is still mandatory.

The new immutable identity is `2026.9.2+clawx.11`, revision 11. Only runtime
metadata and the control bridge's reported default version change, with source
and overlay hashes synchronized. All 25 existing patch targets, root lock bytes,
upstream version/commit, independent Node pins and DeepSeek files remain intact.
Four README locales, the current design, scenario and distribution rule are
synchronized. Local fixture assembly is not native Windows execution, platform
signing or clean-machine evidence; the new CI result remains a separate gate.

Local verification passed 36 focused tests and the full 2,245-test host suite
with zero failures and six existing conditional tests pending. The real frozen
Windows PE bytes fail the old allowlist and pass the corrected one without
execution. Typecheck, lint (zero errors/seven existing warnings), frozen-source
verification, comms replay/compare, Harness CI and the diff-aware task
validation/dry-run passed. The full report is retained under ignored
`temp/windows-esbuild-allowlist-vitest.json`. No new Apple acceptance, native
Windows execution, clean-machine or COS publication is claimed by these checks.
