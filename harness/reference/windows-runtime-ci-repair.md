# Runtime CI repair — OpenClaw +clawx.8 through +clawx.12

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

## Follow-up: lossless archives and clean UI compilation — both kernels +clawx.12

[Build 34088424748](https://github.com/Tabll/ClawXXX/actions/runs/34088424748)
at `33b3c7a7` completed all ten runtime builds and all four macOS notarizations.
The same commit's [Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34088337964)
passed all three platforms. Its subsequent fifteen clean-machine jobs failed
in two shared places, not fifteen unrelated runtime failures:

- All five OpenClaw single-runtime and all five dual-runtime jobs rejected a
  truncated Jimp snapshot path at **initial** file-manifest verification, before
  managed startup or concurrent-process assertions. `tar.c({ noPax: true })`
  silently truncates basenames that USTAR cannot split into its name/prefix
  fields. Eight of the 24 local pinned Jimp snapshot names were not retained
  by the old encoder; one truncation exactly matches the CI diagnostic.
- All five DeepSeek jobs passed real extracted-runtime smoke and production
  signed installation, then failed to resolve `../extensions/_ext-bridge.generated`
  during UI compilation. That file is intentionally ignored. The separate E2E
  workflow generated it explicitly, while `build:vite` did not.

The shared encoder now permits PAX and retains `portable`, fixed source epoch,
sorted input paths and deterministic single-worker Zstandard settings. Portable
PAX omits filesystem ownership, inode/device and access/change timestamps; it
does not remove any payload file or shorten any name. Before compression and
immutable output, a decoded tar preflight compares effective paths, uniqueness,
file type/link absence, SHA-256, byte lengths and permission modes with a source
manifest. Missing, aliased or modified files fail before descriptor signing.

The existing production safe extractor already checks effective PAX paths in
both preflight and extraction. Its implementation and limits are unchanged.
New contracts prove signed package-manager installation and integrity rescan of
long/shared-prefix/Unicode files, plus rejection of traversal, absolute/drive and
reserved paths, case/Unicode collisions, file nesting, link overrides and signed
size/decompressed-stream overflow before touching the destination. Encoder
tests vary creation order/inodes/timestamps and inject path truncation, duplicate
or missing entries, altered bytes and altered header permissions. The permission
fault is injected into the tar header so it does not rely on Unix chmod behavior
on Windows.

`build:vite` explicitly generates both bridges before invoking the real compiler;
`build` and `package` reuse that entrypoint. This does not depend on pnpm implicit
pre/post hooks, generated files in Git, or a developer's prior `pnpm dev` session.
Two isolated command regressions cover no extensions and configured-but-absent
external packages. These tests use a compiler sentinel only to assert ordering;
the separate real clean-copy build below validates actual compilation. CI runs
archive, package-manager and bridge-build regressions before expensive runtime
builds on every target. All real clean-machine, signing and storage gates remain.

Both immutable artifact identities become revision 12 because the encoder is
shared: OpenClaw `2026.9.2+clawx.12`, DeepSeek `0.1.3-alpha.1+clawx.12`.
Runtime descriptors/source hashes and OpenClaw's default control-bridge version
and overlay hash chain are synchronized. The new recorded epoch is 1788763473.
Upstream commits/versions, all dependency lock bytes, compiled patches, Node
inputs and DeepSeek overlays remain unchanged. Installed runtimes are untouched.

Local validation with Node 24.15.0:

- 49 focused archive/build/package-manager checks passed; the old implementation
  failed six relevant checks, including both missing-bridge cases and truncated
  or colliding archive names.
- The exact new six-suite early CI command passed all 96 tests locally; YAML
  inspection retains `kernel: all` and the same five platform/architecture targets.
- Full host suite: 259 files, **2,265 passed / 0 failed / 6 existing conditional
  pending**, recorded in ignored `temp/archive-clean-build-vitest.json`.
- A new isolated copy of 528 tracked build inputs, with neither generated bridge
  present, completed actual Vite UI plus Electron Main/Preload/SQLite utility
  bundles using installed pinned dependencies. The first manually assembled
  copy omitted Tailwind configuration; rebuilding a fresh copy including both
  checked-in CSS configs passed. This was a validation-fixture omission, not a
  production stylesheet change.
- All 24 real Jimp snapshots (79,674 bytes), copied into the actual runtime path
  layout, passed the new path/content/mode round-trip preflight. Compressed
  subset size was 40,974 bytes. This is a local pinned payload subset, **not a
  downloaded exported CI archive** or a full platform/security certification.
- Source verification, typecheck, lint (zero errors/seven existing warnings),
  comms replay/compare, Harness CI and diff-aware task validate/dry-run passed.
  Four README locales, design references, scenario/rule/task and TODO are synced.

The new SHA must be committed/pushed and dispatched as a fresh two-kernel,
five-target `kernel-staging` run, with Windows `artifact-signature-only`. New
platform signatures/notarizations and complete single/dual clean-machine
acceptance are not established by local tests. No COS upload, catalog promotion,
production publication, credential changes or installed-runtime replacement is
part of this repair. Track the new remote outcome in MK-1940.

## Follow-up: bounded archive-budget regression cost — unchanged +clawx.12

[Build 34093118132](https://github.com/Tabll/ClawXXX/actions/runs/34093118132)
at `02560a1a` passed nine of ten runtime builds and three macOS notarizations.
All five DeepSeek targets and four OpenClaw targets produced artifacts. The
same commit's [Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34093008809)
passed all three platforms. OpenClaw Intel macOS stopped at the early 96-test
preflight: 95 passed, and the decompressed-stream overhead test timed out after
5,031 ms. The same test took 3,792 ms in the successful DeepSeek Intel job.
OpenClaw Intel did not reach source preparation or notarization; both
clean-machine matrices were skipped. Nine runtime artifacts and nine reports
were retained. This was not an Apple signing/notarization rejection.

The fixture appended 11 MiB of zero padding **after** a complete TAR EOF. The
pinned node-tar 6.2.1 parser stops interpreting entries at EOF, but subsequent
16 KiB decompressor chunks repeatedly concatenate its retained trailer buffer.
The production limiter still rejects the oversized stream, but the fixture
performs quadratic copy work on its way to that rejection.

An isolated real-parser probe, instrumenting only `Buffer.concat` after fixture
creation, measured 640 concatenations and **3,369,189,377 copied bytes** before
the signed boundary (321.3 times its budget). The replacement measures four
concatenations and **212,993 copied bytes**. The old fixture deterministically
fails the new copy-work bound; elapsed-time thresholds are not used to make
this regression pass. The explicit `--legacy` diagnostic preserves the old
fixture for reproduction, but CI never runs that expensive mode.

The replacement fills the same 10 MiB-plus-one-file-byte signed stream limit
with valid, bounded PAX metadata records before the regular file and EOF. Each
record stays below tar's existing 1 MiB metadata limit. A 64 KiB trailer remains
after EOF so later decompressor chunks still exercise the production limiter.
Two real Zstandard-file/`SafeKernelArtifactExtractor` contracts prove acceptance
at exactly **10,485,761 bytes** and rejection at **10,485,762 bytes**, asserting
the exact `archive-bomb` stream-overhead message, not an unrelated parse/quota
error. One real-parser child regression caps buffer-copy work below one stream
budget with a four-second kill deadline inside the unchanged five-second test
deadline. There are no retries, skips, global timeout increases, synthetic
extractor substitutes or production limit changes.

Local Node 24.15.0 validation on 2026-09-07:

- 32 focused tests and the exact six-suite CI preflight's 98 tests passed.
- The two boundary checks took approximately 19/16 ms in the initial focused
  run, compared with approximately 296 ms for the old fixture on this host.
  Ten additional runs passed all 30 selected checks, with a maximum of 48 ms,
  including child startup. Native Intel CI timing still requires the new run.
- Full host suite: **2,267 passed / 0 failed / 6 existing conditional pending**
  across 259 files (`temp/archive-overhead-vitest.json`). Typecheck, lint (zero
  errors/seven existing warnings), source hashes and comms replay/compare passed.
  Harness CI plus diff-aware task validation/dry-run and diff checks also passed.
- Production Main/extractor code, builder, workflow, both kernel descriptors,
  artifact revisions, overlays, dependency locks and platform-security inputs
  are byte-for-byte unchanged. Both kernels remain `+clawx.12`; no runtime
  payload or archive encoding change requires a new immutable version.
- English/Chinese/Japanese/Russian READMEs were reviewed. User-visible flows,
  build commands and interfaces are unchanged, so no translation edits are
  needed. The distribution rule, scenario, task and TODO record the new test
  constraint. This turn inspected logs and fixtures, not exported CI archives.

The new main SHA must undergo a fresh both-kernel/five-target staging run with
its normal approval and complete single/dual clean-machine gates. Existing
macOS evidence is not a new acceptance result. Windows remains explicitly
artifact-signature-only. No COS upload, catalog promotion, credential changes
or installed-runtime mutations are authorized by this test-only repair.

## Follow-up: immutable fault injection and bounded host installation

[Build 34125183305](https://github.com/Tabll/ClawXXX/actions/runs/34125183305)
at `ada7ba25` passed all ten runtime builds, all four macOS signing/notarization
targets and nine of ten single-runtime clean-machine jobs. The same commit's
[Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34124844465) passed
all three platforms. Thirty-five artifacts were retained: ten runtime bundles,
ten build reports and fifteen clean-machine evidence bundles.

All five dual-runtime tests failed at their raw append to OpenClaw's installed
`runtime/kernel/clawx-control-bridge.mjs`: EACCES on Unix, EPERM on Windows.
The production installer correctly seals payload files readonly; the test
failed to grant temporary write permission for its deliberate corruption.
Both installations and concurrent control health checks succeeded before that
line. Repair, independent uninstall and the later data-preservation checks
were not reached and must not be counted as passed.

Only the Windows OpenClaw single-runtime job exceeded its 600000 ms test
deadline. Its earlier actual Gateway, ACP, seven-Channel and canonical-storage
artifact probe passed; observed Gateway startups of 112871/126480 ms remained
inside the dedicated 180000 ms budget. The old installer test retained phase
progress only in memory, so its log does not establish which stage timed out.
The Windows archive contains **52,729 files / 807,751,063 unpacked bytes**.

The repair is in the host installer and acceptance harness, not runtime code:

- Independent metadata hashes, every runtime file's stat/hash, breadth-first
  directory checks, byte totals and readonly sealing use a fixed eight-worker
  pool. A first failure stops new admissions and drains already running work
  before cleanup; no per-file unlimited promises, cached hashes or omitted
  verification passes are introduced. A readonly chmod failure now fails
  closed instead of being swallowed. Runtime directories retain owner-write
  for quarantine/removal; payload files remain readonly.
- Fault injection is test-only and requires a caller-owned temporary root,
  relative contained path, regular file and one physical link. Traversal,
  directories, symlink/junction ancestors and hardlinks are rejected. Owner
  write permission is granted only around mutation and the original mode is
  restored in finally, including writer failures. Production never uses this
  helper and no user-installed runtime is modified.
- Both real-artifact contracts emit incremental phase JSONL, bounded to 256
  events with 15-second in-progress heartbeats. Failure/timeout stops timers;
  workflow evidence upload uses always() and includes these sidecars. Only
  closed labels/status/elapsed times are emitted, not error contents, paths,
  environment variables or secrets. Concurrent dual operations settle fully
  before cleanup on a one-sided failure.
- Original 10-minute single and 15-minute dual test deadlines and every
  signed identity, archive path/type, byte/file budget, hash, Range/If-Range,
  smoke, independent repair/uninstall and canonical SQLite assertion remain.
  Real Gateway/ACP/Channels probes and platform-signing gates are unchanged.

Local Node 24.15.0 evidence on 2026-09-07:

- 48 focused checks and the exact nine-suite CI preflight's **121 tests**
  passed. Negative cases cover missing/unlisted files, directory links,
  same-size corruption, readonly failure and asynchronous failure draining.
- Full host suite: **2,290 passed / 0 failed / 6 existing conditional pending**
  across 262 files (`temp/install-fix-vitest-final.json`). Typecheck, lint (zero errors/seven existing warnings),
  source verification and comms replay/compare passed.
- Eight focused Electron E2E interactions for kernel catalog/lifecycle,
  Agents, Channels, Cron and Skills passed. The first sandboxed attempt could
  not launch Electron; the same unchanged command outside that restriction
  passed. Actual Vite/Main/Preload build also passed.
- Downloaded actual build #12 macOS arm64 OpenClaw and DeepSeek archives were
  SHA-256 checked against GitHub artifact metadata. The real single-runtime
  Vitest acceptance passed in **49,824 ms**, including interrupted download,
  exact-identity resume, production activation, full rescan and uninstall.
  The real dual-runtime acceptance passed in **90,189 ms**, including both
  installations, concurrent control processes, readonly corruption injection,
  detection, independent repair/uninstall and shared SQLite preservation.
  Ignored evidence is under `temp/install-fix-real-{single,dual}*`; these are
  actual CI archive tests, not fake driver fixtures, but not a substitute for
  the complete five-target fresh CI matrix or a production-release audit.
- Both kernel payloads remain `+clawx.12`. Source hashes, compiled patches,
  overlays, dependency lock bytes, bundled Node inputs and signing policies
  are unchanged. The four README locales and harness scenario/rule/task/TODO
  document host installation and test constraints.

Supplementary Windows 11 VM diagnosis uses the **actual build #12 Windows x64
OpenClaw archive** and bundled Node 24.15.0, with a fresh task-owned temporary
root each time. This is Windows on this Mac's Parallels VM, not a native GitHub
runner performance certification. The unchanged host installer reached smoke
at 426609 ms (staging began at 1673 ms); bounded verification reached it at
198682 ms (staging began at 1258 ms), reducing that observed stage by about
54%. Both probes then independently hit EPERM at staging-to-install rename,
after successful control smoke. That local failure is additional evidence, not
proof of the unlogged CI timeout's precise cause.

A separate eight-case real Windows child-process experiment isolated the lock:
four processes whose executable was inside the moved directory hit EPERM even
after waiting for child `close`, and could rename after roughly 136–640 ms.
Four equivalent processes using Node outside that directory renamed immediately.
Changing `exit` to `close` alone is therefore not a fix for the observed lock.
The underlying Windows component retaining the executable is not established.

Runtime-directory moves for activation, quarantine and trash now use the same
native atomic rename with **Windows-only EPERM/EBUSY** backoff: 50/100/200/400/750
ms, at most six attempts and 1500 ms accumulated delays. Other platforms and
other errors fail immediately; a persistent Windows lock still fails. No
copy/delete/chmod fallback, running-version bypass, full-install retry or test
retry is added. Unit contracts prove the exact delays/attempt cap, fatal error
paths, absent mutation fallbacks and actual readonly file identity preservation.
Existing single/dual test deadlines and immutable payload identities remain.

The final Windows probe **passed** with the production installer: smoke at
211423 ms, atomic activation at 212227 ms, full installed rescan at 225499 ms,
another actual control process exited at 225994 ms, immediate uninstall at
229880 ms, and task-root cleanup at **229888 ms**. Payload readonly mode and
preserved canonical SQLite Conversation were asserted. Evidence is retained in
ignored `temp/install-fix-vm-after.log`. This manual offline-import probe does
not test HTTP Range, the complete Windows Vitest dual contract, real provider
chat or all five native runners; those stay required in the fresh CI matrix.
Final Vite build, Harness CI (19 checks), diff-aware task validation/dry-run,
comms/source verification and the eight shared-UI E2E interactions passed again
after the Windows rename fix. Temporary VM test roots were isolated from any
installed user runtime, and the task-started VM is shut down after validation.

Commit/push must be followed by a **fresh new-SHA** both-kernel/five-target
staging dispatch and approval, with Windows artifact-signature-only. Do not
rerun the old SHA or mark MK-1940 complete until every required remote gate
passes. No COS upload, catalog promotion, credentials or installed-runtime
changes are included.

## Follow-up: Windows shared-contract stalls in build #13

[Build 34135100335](https://github.com/Tabll/ClawXXX/actions/runs/34135100335)
at `dc2ec968` passed eight runtime builds, all four macOS signing/notarization
targets and all **121 early installer regressions on both Windows targets**.
The same commit's [Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34135022724)
passed all three platforms. Windows failed later in the shared storage/build
contract step, before archive sealing: OpenClaw's LF patch and Cron restart
checks took 9704/9679 ms; DSH's Channel queue and combined Cron skip/replace
checks took 8660/7255 ms, exceeding their unchanged 5000 ms test deadlines.
The 18 retained artifacts are eight runtime bundles plus ten build reports.
Both clean-machine matrices were skipped; the previous installer repair does
not yet have complete remote acceptance.

The logs establish deadline overruns, not the precise scheduler/host component
responsible for the delay. The original three suites also passed in this Mac's
Windows 11 VM after completing the isolated test dependency closure (35 tests,
Node 24.15.0 x64 and Git 2.55.0.windows.5, four file workers). This is not a
reproduction of CI's failures or a native GitHub runner benchmark. Before that,
missing `punycode/` and `THIRD_PARTY_NOTICES.md` in the temporary diagnostic copy
were corrected without changing repository dependencies or product code.
Official Node/MinGit SHA-256 and Windows esbuild/Rollup lockfile SHA-512 were
verified; no toolchain was installed globally and no user runtime was touched.

The repair keeps production code, SQLite durability, source locks and both
`+clawx.12` payloads unchanged:

- Pure host build contracts use the Node test environment, not jsdom. Real Git
  fixture setup uses three native commands instead of seven; local config is
  written only inside the owned temporary repository. Exact and shifted patch
  cases have separate default-deadline tests for both autocrlf policies. Real
  patch application, LF bytes, offset rejection and an unchanged clean index
  remain asserted. The original combined test launched 22 Git processes; each
  new exact/offset test launches nine/six, with setup operation-count assertions.
- Test-only bounded event barriers observe completed driver/router admission
  and successful actual `putCronRun` writes. They do not replace SQLite work or
  manufacture terminal state. Tests query real persisted data, retain reopen
  and deduplication, and release execution gates/drain owned work on failure.
  Skip and replace use independent fixtures/tests. Four helper regressions
  cover already-completed events, exact matching, timeout and teardown.
- Only the Windows storage-contract step uses `--maxWorkers=1`, avoiding file
  worker competition with unrelated native/SDK startup. Internal simultaneous
  kernel/jobs/messages are still tested. Other platforms retain default file
  workers. A workflow regression guards that scope and unchanged deadlines.
  There are no whole-test retries, skips, in-memory databases, weaker fsync,
  global Vitest config changes or relaxed integrity/signing checks.

Local Node 24.15.0 validation on 2026-09-07: **2,298 passed / 0 failed / six
existing conditional pending** across 263 files; both actual CI storage-suite
selectors with Windows file-worker policy passed **99 OpenClaw / 71 DSH**
tests. Typecheck, lint (zero errors/seven existing warnings), source hashes,
comms replay/compare and Harness CI (19 checks) passed. Diff-aware task
validation/dry-run passed. Ignored reports use the `temp/contracts-stall-*`
prefix. English/Chinese/Japanese/Russian READMEs were reviewed; no user-visible
flow, API, runtime version or development command changed, so no translation
edits were needed. Rule/scenario/task/TODO capture the test/CI constraints.

The repaired four-suite Windows VM run passed **43/43** with four file workers
and again **43/43** with the final single-file-worker policy. All Git exact and
offset cases completed in 367–544 ms; the old combined Git cases had taken
1274–1349 ms. Channel queue completed in 51–53 ms; skip/replace in 21–27 ms;
restart deduplication in 29–36 ms. These are observed VM samples, not timing
assertions or proof that a particular Windows component caused CI's stalls.
Reports are `temp/contracts-stall-windows-{baseline-4,candidate-4,candidate-1}`.
The task-owned portable tools/source copy is removed after verification, with
host reports retained and the initially stopped VM returned to stopped state.

Commit/push must dispatch a fresh both-kernel/five-target staging run on the new
SHA and pass normal `kernel-staging` approval. Keep Windows explicitly
artifact-signature-only, macOS signing/notarization and every single/dual
clean-machine gate. MK-1940 remains open until full new remote acceptance;
no COS upload, catalog promotion, secret changes or installed-data mutation.

## Follow-up: CRLF in the workflow-policy regression

[Build #14](https://github.com/Tabll/ClawXXX/actions/runs/34173221385) was
dispatched and normally approved on 2026-09-08 for `aa687d2b`. DSH Windows
passed its 121 early regressions and 69 overlay tests, then passed **70/71**
storage/build checks. The only failure was the newly added workflow policy
assertion: the actual Windows checkout contained CRLF, while its multiline
expected string used LF. This is a regression in the test, not a storage,
runtime or file-worker policy failure. The earlier VM source copy retained LF
and therefore did not cover this checkout representation.

OpenClaw Windows independently passed its 121 early regressions and 11 overlay
tests, then passed **98/99** storage/build checks. Its only failure was the same
CRLF-sensitive assertion; the actual Gateway checks preceding it passed.

The actual Windows runner now passed every Git exact/offset case in 315–409 ms,
Channel same-thread queue in 769 ms, Cron skip/replace in 420/435 ms, and restart
deduplication in 632 ms. Other build targets were still running when this
repair was prepared; none of these observations is complete matrix acceptance.

The test now parameterizes the real checked-in workflow as LF and CRLF text on
every host. Before the fix, LF passed and CRLF reproduced the exact CI assertion
failure. Normalizing CRLF only inside the semantic workflow comparison fixes
both cases while preserving all conditional worker/invocation/deadline checks.
The production workflow, global Git configuration, strict patch/hash checks,
runtime payloads, dependency locks and signing inputs are unchanged. There is
no need for a new kernel artifact revision; both remain `+clawx.12`.

Node 24.15.0 validation passed **44 focused tests** and **2,299 full host tests**
(zero failures, six existing artifact-conditional skips). Both actual workflow
storage selectors passed **100 OpenClaw / 72 DSH tests**, without skips, using
the Windows single-file-worker policy on the macOS host; this is not native
Windows runner evidence. Typecheck, lint (zero errors, seven existing warnings),
frozen source verification, comms replay/compare, Harness CI and diff-aware task
validate/dry-run all passed. Evidence uses ignored `temp/workflow-eol-*` and
`temp/contracts-stall-storage-*` reports. The four README locales were
reviewed: no user-facing behavior or command changed, so no translation update
is required. Rule/scenario/task/TODO record the new EOL coverage constraint.
Fresh new-SHA remote acceptance is still required by MK-1940.

## Follow-up: sealed Windows probe background execution

[Build #15](https://github.com/Tabll/ClawXXX/actions/runs/34174116971) on
`1f85184cc9a005879f091780913ea95185fe7344` passed all **10 builds**, all **4 macOS
notarizations** and **13/15 clean-machine jobs**. Both Windows storage suites
passed completely (**100 OpenClaw / 72 DSH**); the CRLF regression is resolved.
[Electron E2E #29](https://github.com/Tabll/ClawXXX/actions/runs/34174075068)
passed all three platforms on the same commit. Two later Windows checks failed:

- Sealed OpenClaw's real Gateway/ACP probe approved the fixed script, but the
  loopback model returned its final response after a tool response without
  waiting for background execution. Approval at 01:24:39 UTC was followed by
  background-task registration and another provider call at 01:24:49 UTC,
  matching the native exec default 10-second yield. CI did not retain the tool
  response body, so timing alone was not used as proof.
- The dual-runtime test completed installation and concurrent control startup
  at **457,486 ms**, detected the injected corruption at **463,196 ms**, then
  reached the unchanged **900,000 ms** deadline during `repair-openclaw`.
  This is a separate installer performance investigation, not a passing gate.

Forcing `background: true` through the real local Gateway/ACP reproduced the
exact old assertion with three provider calls (`temp/probe-background-before.*`).
The fixture now performs at most eight read-only process polls of 5 seconds,
under unchanged outer deadlines, tied to the exact command and the native
session. It handles call IDs normalized by the provider adapter, retains output
across running polls, and requires successful terminal exit plus the actual
marker. It never treats a running command or `tool_call_update` as completion.
A separate finite request budget and immediate rejection prevent malformed
fixtures from repeatedly executing the command. This is probe code only; native
tool authorization, production kernel payloads and storage fences are unchanged.

The final real local probe (`temp/probe-background-after2.*`) passed the full
Gateway/ACP path, one background continuation, all seven Channels, cancellation,
crash rehydration, rejected ingress and zero native durable history. It observed
seven requests (including two interrupted responses) and five distinct known
usage events. The exact baseline request counts now add only validated process
poll responses; unknown provider cost remains absent. Deterministic tests cover
running/terminal/error results, partial output, normalized IDs, foreign or
missing identities, and exhausted bounds in the existing CI-selected suite.
The four README locales need no change for this isolated test-probe correction.
Rule/scenario/task/TODO retain the pending Windows repair and full CI acceptance.

Local Node 24.15.0 validation passed **42 focused tests**, **2,313 full host
tests** (zero failures, six existing artifact-conditional skips), typecheck,
lint (zero errors, seven existing warnings), frozen-source verification, comms
replay/compare, Harness CI and diff-aware task validate/dry-run. No Windows
background-continuation success is claimed before the next native CI run.

## Follow-up: bounded tar directory-cache pruning

The Windows dual-runtime failure in build #15 is a separate measured throughput
problem: installation finished at 457,376 ms, corruption detection at 463,196 ms,
and repair started at 463,277 ms but exhausted the existing 900,000 ms deadline.
There was no observed integrity or permission failure at that point.

Profiling the production extractor on an isolated Windows 11 VM used the actual
CI #12 signed OpenClaw `+clawx.12` archive (52,729 files, 807,751,063 unpacked
bytes), pinned x64 Node 24.15.0, a fresh destination for each sample, and unchanged
Windows security settings. It is not a reproduction of GitHub runner speed.
CPU samples exposed node-tar 6.2.1's `pruneCache`: before and after every file it
normalizes and scans the entire positive directory cache. An unbounded cache
adds quadratic work as the directory tree grows. Windows' deliberate serialized
path reservations protect against alias collisions and must not be bypassed.

Production and standalone CI extraction now share a fresh **256-entry FIFO
positive directory cache**. Eviction only removes a successful-directory hint,
so tar must check the filesystem again; it cannot grant trust or skip a path
reservation. Dependency versions, archive bytes, timestamps, modes, preflight
and extraction guards, signed counts/sizes, full file hashes, readonly sealing
and atomic activation remain unchanged. The cache is never shared between
concurrent installs. No AV exclusions, fake platforms, looser permissions,
skipped verification, whole-test retries or enlarged deadlines were introduced.

The observed extractor-plus-sealing time fell from **181,014 to 149,385 ms**;
including a subsequent complete rescan, **193,552 to 162,342 ms**. The sampled
`pruneCache` frame dropped from **12,257 to 1,298 ms**, and Windows path
normalization from **21,138 to 2,702 ms**. File-I/O timing varied between runs;
these are one before/after VM sample, not a cross-platform speed guarantee or
native CI acceptance. Ignored `temp/repair-throughput-vm-{before,after}.log`
retains phase and operation counts, with bounded CPU summaries rather than
runtime content or credentials.

Regression covers the fixed capacity with 10,000 insertions, Map invalidation
semantics, independent caches, and two simultaneous actual signed fixture
extractions containing 512 additional directories. Every signed file is fully
rescanned and readonly modes remain asserted; existing malicious archive,
corruption, link and failure-cleanup cases still pass. The final native
single/dual Windows jobs remain required before MK-1940 can be completed.

The uninstrumented VM dual-artifact probe used both actual CI #12 signed
archives, their original artifact-only public trust, the production Package
Manager and disk-backed DataService. Both installed by **164,947 ms**; concurrent
control bridges had distinct PIDs. After injected OpenClaw corruption was
rejected, DeepSeek remained healthy. OpenClaw repair ran from **167,578 to
319,928 ms**. Independent uninstall/rescan and reopening the same SQLite file
preserved the canonical conversation; all assertions passed by **328,871 ms**
(cleanup finished at **332,322 ms**), inside the unchanged fifteen-minute budget.
This task-owned assertion probe mirrors the dual contract but is not a GitHub
Vitest job or a real provider conversation. Its log is
`temp/repair-throughput-vm-dual.log`; native runner acceptance is still pending.

Final host validation passed **90 focused tests** and **2,316 full tests**
(zero failures, six existing artifact-conditional skips), typecheck, lint
(zero errors/seven existing warnings), frozen sources, comms replay/compare,
Harness CI and diff-aware task validate/dry-run. Four README locales now document
the bounded directory cache. Both repairs are submitted together; no runtime
revision, lock, signing secret, workflow gate, COS or production catalog changes.

## Follow-up: native workspace paths in post-artifact contracts

[Build #16](https://github.com/Tabll/ClawXXX/actions/runs/34178442166) on
`5aaf52eaa5e83ad68d4ac51c77e5e275019c8e06` completed **24/25 jobs** successfully:
all ten builds, all four accepted macOS notarizations, all five dual-runtime
jobs and nine of ten single-runtime jobs. The same commit's
[Electron E2E #30](https://github.com/Tabll/ClawXXX/actions/runs/34178397696)
passed macOS, Windows and Linux. This is not complete matrix acceptance.

Both previous Windows defects now passed on the actual GitHub runner. The
sealed real Gateway/ACP background-exec probe succeeded. The Windows single
production installer passed interruption/Range resume, install, full integrity
rescan, uninstall and cleanup in **454,156 ms**, under the unchanged 600,000 ms
budget. The dual-runtime contract passed in **730,583 ms**, under 900,000 ms:
both installed by 313,751 ms, corruption was detected at 319,044 ms, OpenClaw
repair ran from 319,124 to 690,978 ms, and independent uninstall/rescan retained
the canonical SQLite data. No security or verification gates were disabled.

The remaining single job failed only in the subsequent nine-suite host
regression step: **24/29 tests passed**. Four ACP tests supplied
`file:///workspace`, which Node rejects on Windows because it has no drive.
One driver test expected `/kernels/openclaw/` in a native backslash path. These
are test-fixture defects, not evidence of another real installation timeout.

Fixtures now use `pathToFileURL` on native absolute workspaces containing
spaces, Unicode, `#` and `%`. They verify the exact decoded cwd passed to the
unchanged production adapter, reject malformed encoded separators before
native calls and prove the execution slot is released. Driver fixtures assert
exact installed paths and all three executable layouts, including Windows
`runtime/node/node.exe`, with missing-runtime rejection. Owned temporary roots
are cleaned; original event, cancellation, usage, attachment, queue, lifecycle
and data-isolation assertions remain. No production source, runtime pin, lock,
deadline, retry policy, signing input or user runtime changed.

The two repaired suites also run in all ten builds' early checks, while staying
in the mandatory post-artifact step. Workflow-policy tests enforce both
placements. On an isolated Windows 11 VM with pinned x64 Node 24.15.0, the exact
old three-suite selector (ACP, driver and build-policy) reproduced **5 failures
/24 passes**; after the repair and five additional cases it passed **34/34**
with default deadlines and file workers. Initial VM setup lacked notices and
unrelated OpenClaw SDK test dependencies; the recorded focused comparison was
rerun with its complete fixture inputs, not counted as a nine-suite CI run.
Ignored reports are `temp/path-contract-windows-{baseline,candidate}.json`.

Host validation passed **2,321 tests**, zero failures and six existing
artifact-conditional skips, plus the actual **137-test** early CI selector,
typecheck, lint (zero errors/seven existing warnings), frozen-source verification,
comms replay/compare, Harness CI and diff-aware task validate/dry-run. The four
README locales were reviewed; this test-only correction changes no user-facing
behavior or commands, so no translation update is required. Rule/scenario/task
and TODO record the added portability guard. MK-1940 remains pending until a
fresh pushed-SHA both-kernel/five-target staging run passes every job. Normal
environment review, Windows artifact-signature-only and all existing macOS
notarization gates remain; no COS or production catalog publication is included.

## Follow-up: ordinary Windows extraction writes and stage diagnostics

[Build #17](https://github.com/Tabll/ClawXXX/actions/runs/34182369085) on
`721f3600dddd8df86795bdd5b4dffbbf9494d8c1` completed with **23/25 successful
jobs**: ten builds, four dual-runtime and nine single-runtime jobs. All four
macOS notarizations were accepted. Both Windows builds passed the full
137-test preflight, including the repaired native workspace path contracts.
The sealed Windows OpenClaw Gateway/ACP probe also passed. The same commit's
[Electron E2E #31](https://github.com/Tabll/ClawXXX/actions/runs/34182316212)
passed all three platforms. GitHub retained 35 nonexpired artifacts: ten runtime
packages, ten build reports and fifteen clean-machine evidence archives.

The two failures were file-operation throughput, not those old path fixtures:

- Windows dual job `101928142967` installed both at **628468 ms**, passed
  concurrent control and corruption rejection, then began OpenClaw repair at
  **634333 ms** and exceeded the unchanged **900000 ms** deadline. Repair and
  subsequent uninstall/SQLite checks did not complete.
- Windows OpenClaw single job `101928143073` installed at **571913 ms** and
  began full rescan at **571915 ms**, exceeding **600000 ms** before it finished.
  Later host/UI steps were not reached. The equivalent #16 single install had
  passed in 454156 ms; that prior pass does not establish robust throughput.

### Native controlled measurement

node-tar 6.2.1 selects `UV_FS_O_FILEMAP` for Windows files smaller than 512 KiB.
The official [libuv filesystem documentation](https://docs.libuv.org/en/v1.x/fs.html)
identifies this as memory-mapped Windows I/O, and the
[Windows implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)
has additional mapping state. That suggested an ordinary-write comparison,
not evidence that antivirus or any particular runner component was responsible.
Both #16 and #17 reported the same runner image version; no causal image-change
claim is supported.

An isolated Windows 11 ARM64 VM, running official x64 Node 24.15.0, used the
same original CI #12 signed OpenClaw `2026.9.2+clawx.12` archive in fresh owned
directories: **52729 files / 807751063 unpacked bytes**. No security settings,
signature checks, file counts, read-only protection or runtime bytes changed.
The baseline/candidate/baseline sequence retained the production 256-entry
directory cache and all integrity checks:

| Mode | Extract, verify and seal | Including full integrity rescan |
| --- | ---: | ---: |
| Original mapped writes A | 134152 ms | 146258 ms |
| Ordinary writes B | 114041 ms | 125835 ms |
| Original mapped writes A repeat | 136011 ms | 189952 ms |

These are VM samples with x64 emulation, not native GitHub runner acceptance or
a guaranteed speedup. Aggregate open/read/close waiting fell for B, while
`lstat` work and CPU usage increased; the repeat also shows rescan variance.
Reports remain ignored under `temp/filemap-vm-{baseline,candidate,baseline-repeat}.log`.

### Minimal production change and regression boundary

`patches/tar@6.2.1.patch` changes only `lib/get-write-flag.js` to select ordinary
`'w'` writes; create/truncate/mode semantics, close/error handling, Windows path
reservations and all archive guards remain unchanged. The exact patch SHA-256 is
`3ecc5f7df99a41a333edd0714e67cb8a3ab3e173c5215b734e43e4dba20652f9`.
The root workspace/lock pins this host-tooling patch. Frozen offline installation
replaced just one tar instance without dependency upgrades or install scripts.
OpenClaw's repository-lock provenance is also updated: root lock SHA-256
`b9c2608509e47be1870d74065e8ac4f86ad5f676550de8aa5d219987b6a05ea4`
and lock descriptor SHA-256
`46efefa988347b339c854a95e86af9cc3682ddeeb7c08f42ac76598790a36017`.
Its actual kernel dependency still resolves tar 7.5.22, not the host's 6.2.1.
The kernel upstream versions, source/overlay patches and +clawx.12 revisions,
and the separate DeepSeek Harness prepared lock remain unchanged. No
platform/global fs override is used in production or CI.

Five regression cases evaluate the actual installed selector for Windows,
macOS and Linux inside an isolated VM context, verify original path reservation
code remains, and check exact raw patch bytes against both LF/CRLF semantic lock
inputs. The original dependency fails the Windows ordinary-write assertion.
These tests run before every expensive runtime build.

Production extraction and rescans accept an optional per-operation observer
with only closed, path-free stage labels: archive digest/preflight/extraction,
tree inventory, metadata validation, runtime hashes and read-only sealing.
Observer failures are ignored, never treated as verification success or failure.
The final verified stage occurs only after sealing succeeds. Two new contract
cases cover ordered forwarding, failing sinks and actual corruption rejection;
the existing read-only-failure regression also proves verified is not emitted.
Single/dual real-artifact traces consume these stages with their original
deadlines and always-uploaded failure evidence. No whole-test retry, security
relaxation, skipped gate, COS upload or production promotion is introduced.

The final native Windows dual probe used the actual production bundle and
installed patched dependency, with no file-operation instrumentation or
experimental patch plugin. Both original signed artifacts installed by
**124952 ms**, concurrent control processes were distinct, injected corruption
was rejected, and independent OpenClaw repair completed at **244451 ms**.
Both uninstalls, surviving-kernel rescan/control and reopened canonical SQLite
assertions passed by **248804 ms**; owned cleanup completed at **251845 ms**.
The VM was restored to its originally stopped state, its exact GUID fixture
root was removed, and the private VM-only fixture server was stopped. Original
downloaded archives and ignored diagnostic reports were retained. This is
real-artifact VM evidence, not the GitHub Vitest gate or a provider conversation.

Host validation passed **59 focused**, **2328 full** (zero failures/six existing
artifact-conditional skips) and **144 actual CI preflight** tests, plus
typecheck, lint (zero errors/seven existing warnings), frozen source verification,
comms replay/compare, Harness CI and diff-aware task validation/dry-run. After
updating repository-lock provenance, all **33 source/patch/build-policy** cases
passed again. Four README locales, rule/scenario/task and TODO are synchronized.
MK-1940 remains pending until a fresh pushed-SHA complete staging matrix and
same-code three-platform Electron E2E succeed.
