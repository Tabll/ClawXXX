---
id: kernel-runtime-distribution
title: Kernel Runtime Distribution
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - multi-kernel-runtime
requiredProfiles:
  - fast
---

OpenClaw and DeepSeek Harness runtime packages must be reproducible, immutable, platform-and-architecture-specific CI artifacts. End-user installations must not run package-manager installation, source builds, or patch application.

Development and packaged hosts must prefer active installed artifacts, including
their Node and Channel plugin paths, before any development fallback. Invalid
installed records fail closed. Idle runtime rebinding shares the per-kernel
supervisor lock; mutations include their registration callback in serialization.
Do not replace a live generation, silently unregister a usable peer, or classify
registration failures as missing installations. App-scoped bindings may defer
activation with Main-owned restart requirements exposed in status/events and
localized Settings; inactive downloads are a distinct state. See
`harness/reference/installed-kernel-activation.md`.

Native Agent schema ownership stays with the selected kernel. Auth synchronization
must not create partial native schemas or reset version/ownership markers. Use
the active runtime's SQLite SDK under standalone Node, pass secrets via bounded
stdin and await an atomic auth write. Reject incompatible admission; do not bump
database versions to silence migration errors. Regression must include an existing
Agent database, credential sync while running and restart. Incident repairs need
a retained private backup, proof on an isolated copy and exact live-state guards.
See `harness/reference/openclaw-agent-schema-ownership.md`.

For DSH, use ClawX's explicit awaited service composition, not the removed demo spine or upstream app profiles. Capture the launch environment and own proxy-dispatcher teardown. V3 model-only replacement copies and system messages must never become user replies, tool settlements or repeated usage. Use append-origin settlements and the final reported usage snapshot of failed attempts, keyed by run and stable event identity; never sum live usage or replay durable streams as deltas. Failed usage delivery cannot produce a successful terminal run. Scope persona through the exported prefix section, with system messages in the model request. The optional SessionHandle seam returns explicit detached ownership, requires server-side fencing and drain/release tests, and must not enable another production history store. Register ClawX source aliases and references in the upstream Host graph. See `harness/reference/kernel-upgrade-2026-09-12.md`.

CI must pin and verify upstream inputs, apply reviewed repository patches, run runtime smoke and contract tests, generate license notices, and emit a signed manifest containing artifact integrity, build provenance, capability contract, Conversation Store protocol/checkpoint codecs, entrypoints, and app compatibility.

For OpenClaw upgrades, keep production pins unchanged until every existing
compiled patch has a reviewed semantic disposition and the candidate's actual
SDK, ACP/Gateway, Agents config and bundled channel imports are compatible.
Upstream migration/default changes must not widen session visibility or
permissions. A candidate test must explicitly select its package and exact
version, never silently test the installed old SDK. Failed real-process storage
probes block promotion even when host mocks and control smoke pass. The source
pin is now 2026.9.4+clawx.14; actual per-Run incognito/ACP storage probes run before
sealing and again against extracted artifacts. Verify the sealed file manifest
again after first launch, and never let upstream postinstall prune patch files.
See
`harness/reference/kernel-upgrade-2026-09-12.md`.

License audits must retain compound `AND` expressions and require explicit package-scoped copyleft obligation records, including Windows sharp's bundled libvips. Do not replace the declaration with a permissive component or interpret a machine-readable obligation record as legal approval.

Frozen inputs must retain LF bytes on Windows; raw upstream and prepared lockfile hashes are checked at their respective stages. DeepSeek Harness Linux builds must compile the pinned native Landlock launcher on each architecture before sandbox tests and include it in the audited runtime payload. Platform reports must be retained even after a later build failure.

DSH node-addon-system combines Landlock and POSIX flock: use the full native/system build, not the root host-addon-only shortcut. Audit exact macOS/Linux binaries, retain static Landlock but prune non-target and musl flock packages, and keep the Windows Koffi path. OpenClaw's compiled .mjs patch targets and bounded ACP memory ledger must exist in the actual payload; successful Gateway health alone does not prove ACP readiness. A diagnostic failure before the first provider request must preserve the original error.

Native allowlists must use the integrity-pinned package's actual installed
layout, not an inferred shared layout across operating systems. For esbuild,
Windows has `@esbuild/win32-x64/esbuild.exe` at the package root; macOS/Linux use
`@esbuild/<target>/bin/esbuild`. Keep exact executable paths and exercise the
production native validator for all five targets before expensive CI builds.
Regressions must detect native headers, reject adjacent unreviewed binaries,
obsolete paths and foreign targets, and include Windows-target artifact
assembly. Do not replace the final complete-payload audit with fixtures, skip
native validation, or broaden an allowlist to make an unexpected file pass.

Build-time npm source and independent Node downloads must create private staging
directories beside their destination, not in system temp: Windows CI can place
the checkout and `%TEMP%` on different volumes. Verify bytes and extracted
identity before the final same-volume rename, refuse existing destinations and
clean owned staging on failure. Do not replace atomic publication with a
cross-volume copy fallback. Offline CLI regression tests must model distinct
volumes, retain real archive/hash checks and run before expensive build/signing.

Installed plugin paths must be scanned in a deterministic owner order before
SQLite serialization. Windows short/long aliases can produce duplicate diagnostics;
changes in insertion order must not produce a false stale registry. Keep strict
freshness and migration checkpoints: real manifest, entrypoint, policy and
diagnostic-content changes must still fail. Run the real isolated registry/SQLite
probe before Gateway startup and signing. Archive fsync needs a writable,
non-truncating handle with fatal flush errors; Git fixture LF bytes and driver
path assertions must be independent of developer Git policy and host separators.
See `harness/reference/windows-runtime-ci-repair.md`.

ACP contract workspaces must use native absolute paths encoded with
`pathToFileURL`, including spaces, Unicode and reserved URL characters. Assert
the actual decoded ACP cwd and exact installed executable paths; Windows Node
fixtures use `runtime/node/node.exe`. Malformed URLs still fail before native
calls and release the execution slot. These contracts run before expensive
builds and remain mandatory after real-artifact installation; never mock or
relax production URL conversion to make a POSIX-only fixture pass on Windows.

Windows storage/build contract suites, including the earlier OpenClaw closure
gate that repeats the SQLite suite, run with one file worker so real Git
processes and FULL-sync SQLite do not compete with unrelated cold SDK imports.
Keep test-internal dual-kernel/message concurrency and all original deadlines.
Use Node environments for pure host contracts; create real Git fixtures with
bounded setup commands and split independent exact/offset cases for both
autocrlf policies. Async readiness must follow actual admission, and terminal
observers must follow successful SQLite writes, never an early request array.
Retain durable readback/reopen assertions, release owned gates on failure and
drain work before closing storage. No in-memory substitutes, relaxed fsync,
blanket retries, skipped tests or enlarged global/per-test timeouts are allowed.
Retain phase evidence for database open/admission/checkpoint/close/reopen and
restored-history assertions. Early closure JSON results and phase journals must
be always-uploaded even if no platform artifact was produced; keep report paths
distinct from the later canonical suite. Remove only test-owned temporary roots
after closing their services, without deleting an active database on failure.

Semantic workflow source-text assertions must cover both LF and CRLF checkout
representations on every host, normalizing EOLs only inside those assertions.
Do not rely on a copied LF-only Windows fixture to cover Git checkout behavior,
change developer Git policy, or apply this normalization to signed/frozen input
hashes or strict patch bytes.

The real Gateway probe's loopback provider must exercise native background
exec and bounded process continuation. Bind normalized tool-call IDs to the
exact owned command and returned session, never reissue exec after any tool
result, and require terminal success plus actual output before ending the turn.
Running output is not completion. Count each completed poll response in usage;
retain cancellation and no-native-history checks, fixed deadlines and a finite
provider-request budget. Invalid fixture continuations must fail immediately.

Sealed probe and CLI output readers must wait for stdio close, not process exit,
before parsing complete reports. Preserve nonzero exit codes, signal-only and
spawn failures, including decimal/hex Windows status, with bounded stdout and
stderr capture. Timeout/overflow remains fatal even if cleanup later returns
zero; bounded post-kill drain time is cleanup, not extra acceptance time.
Persist closed, content-free phase labels before final reports and always
upload nested probe/process evidence on failure. A diagnostic write failure
must not strand owned children or temporary state. Exercise these contracts
before expensive builds and retain the full real Gateway/ACP/Channel gate.
Missing output is not proof of a harmless warning or of any specific native
crash; separate observed runner failure, native reproduction and hypotheses.

Supervise the pre-seal probe as well as the extracted-artifact probe with a
native Node parent. Git Bash can map multiple NTSTATUS failures to 127; retain
the unmodified signed/unsigned decimal status and its hexadecimal form before
shell translation. Journal Gateway launch/ready and ACP launch/initialize/ready
separately across restart, without changing the original readiness deadline.
The packaged Node and runtime CI must use the same reviewed 24.x LTS pin, now
24.20.0 / module ABI 137, which contains the confirmed Windows TCP-connect fix
missing from 24.15.0. Refresh all five official distribution hashes and both
source hash chains, and increment immutable artifact revisions when Node bytes
change. Updating only the CI host while shipping the defective Node is not a
runtime repair. Pin-alignment and native-status regressions run before builds;
the full real Gateway, Channels, single/dual installation and signing gates
remain mandatory. See `harness/reference/windows-runtime-ci-repair.md`.

Windows plugin-cache realpath defaults must use native OS canonicalization so
case, 8.3 and junction aliases agree with async installation records. Preserve
strict owner, physical-boundary and provenance checks; an official ID alone
must never confer trust, and ambiguous ownership must still fail closed.
Full Windows Gateway/ACP/seven-Channel probes have a dedicated finite startup
budget (180 seconds, other platforms 90), not a change to control-bridge or app
budgets. Capture startup timings and traces on failure, reject process exit,
signal termination and late HTTP success, and release health response bodies.
The guarded tool fixture must resolve the pinned Node executable, approve only
the exact fixed command and assert actual output, not use a Windows shell
builtin that fails executable-identity binding before approval. Retain all
existing conversation, cancellation, crash, Channel and storage assertions.

Cached plugin manifests must expose the physical path returned by the checked
file read, not the first caller's lexical alias. Root aliases and Windows 8.3
paths must not create escaping relative paths or empty manifest hashes in the
installed registry. Exercise native and directory-alias fixtures against the
real pinned modules; require nonempty SHA-256 hashes, reject changed manifest,
entrypoint, policy and diagnostics, and retain traversal, link-boundary and
strict hardlink rejection. Never make an alias test pass by disabling freshness.

Real Channel package entrypoint tests must use a fresh native Node process when
loading the complete plugin/SDK graph. Bound that child with a kill timeout
shorter than its dedicated test deadline; retain actual export and syntax
assertions. Never fix a cold-start timeout with mocks, retries, skipped checks
or a global timeout increase. Packaged Gateway/ACP/Channel probes remain
independent mandatory gates.

DeepSeek Harness deployment must derive its closure from the shared lockfile (`inject-workspace-packages=true`); legacy hoisted deployment discards the lock and must not be used. Deploy skips lifecycle scripts, then explicitly invokes only the pinned upstream spawn-helper executable-bit repair. Generated deploy lockfiles, workspace settings, and builder-path manifests are removed or replaced with the reviewed runtime root manifest before archiving. The target-specific native allowlist must cover the actual frozen closure, including Koffi, image codecs, builtin loader, PTY, and the Linux Landlock launcher; non-target binaries are pruned before signing.

Windows runtime CI may explicitly select `artifact-signature-only` while Authenticode is deferred by the repository owner. The hash-bound platform report must record `authenticode: false` and `status: deferred`; all Ed25519 descriptor/catalog, archive integrity, extraction, sandbox, and storage checks remain mandatory. Missing credentials or failed Authenticode verification must never silently fall back to this mode. macOS Developer ID, hardened-runtime, and accepted notarization gates remain mandatory.

Standalone macOS runtime tools/addons must pass strict `codesign` plus the explicit `notarized` requirement and `--check-notarization`, per Apple's [Testing a Notarised Product](https://developer.apple.com/forums/thread/130560). Do not use `.app`-only `spctl --type execute` assessment on a bare Node executable, or turn a missing notarization ticket into a signature-only success. Host app/DMG Gatekeeper and stapling checks remain separate. Overlay package file lists must retain emitted root-level JavaScript chunks, not only public entry files.

Notarization submits an archive once without waiting, records its SHA-256 and
submission ID before polling, and queries that same ID with bounded per-command
and total deadlines. Retry only classified transient read-only status failures;
authentication, TLS validation, rejected/unknown/mismatched results remain fatal.
An uncertain submit without an ID requires reconciliation, never automatic
resubmission. Retain submission and sanitized failure reports; no raw credential
diagnostics and no stale Accepted report may survive a failed retry. An existing
journal can resume only for the exact archive bytes, and acceptance is checked
again before emitting platform-security evidence.

Every target's real signed descriptor/archive must pass the production `KernelPackageManager` path on a clean runner: injected transfer interruption with exact Range/If-Range resume, catalog/artifact verification, safe extraction, control-bridge smoke, atomic activation, integrity rescan, uninstall, and canonical-data preservation. CI-only trust material may contain only the artifact public key and must never enter the production publish set.

Runtime archives must preserve long and multibyte file names losslessly. Use
portable PAX with sorted paths and the recorded source epoch; do not suppress
extended headers to obtain determinism. Before writing/signing an immutable
artifact, decode the tar and compare effective file paths, uniqueness, content
hashes, sizes and modes against the source manifest. Regression fixtures must
include names sharing the first 100 bytes and independent filesystem metadata.
Production extraction must continue rejecting effective PAX traversal, reserved
paths, case/Unicode collisions, links and signed size/stream-budget violations.

`pnpm run build:vite` must explicitly generate both ignored extension bridges
before compiling, including on a clean checkout with no external extensions.
Do not depend on a previous dev run, implicit lifecycle hooks or untracked local
outputs. Archive and clean-build regressions run before expensive platform builds;
real single/dual clean-machine gates remain mandatory after artifact production.

Oversized-stream regression fixtures must not accumulate megabytes of post-EOF
padding in node-tar's repeatedly concatenated buffer. Fill the real signed stream
budget with bounded valid PAX records and retain a small multi-chunk EOF trailer.
Prove exact-boundary acceptance and one-byte-overflow rejection through the real
Zstandard/production-extractor path, asserting the stream limiter's specific
error. Bound fixture copy work deterministically in an isolated parser probe;
do not hide quadratic fixture cost with retries, skips, relaxed safety limits
or higher global/per-test timeouts.

When both kernels are built, a separate clean-runner matrix must install both real artifacts into one package manager and SQLite authority, start both control bridges concurrently, prove distinct process identity, inject and repair a one-sided integrity failure while the other remains healthy, and uninstall independently. Control-plane smoke must not be reported as a real provider/model conversation.

Installed files remain readonly. Integrity fault injection must explicitly own
its temporary regular file, refuse traversal/links/hardlinks, and restore its
original mode in finally; never remove production readonly protection to make a
test pass. Verification and permission work use a fixed bounded worker pool,
retaining every signed file/hash/size/path check and draining in-flight work on
failure before quarantine or deletion. Readonly sealing errors are fatal.
Both production and clean-machine tar extraction use a fresh per-extraction
positive directory cache capped at 256 entries. Eviction must only require
filesystem rechecks, never bypass node-tar's Windows path reservations or any
archive guard. Cover capacity, invalidation, concurrent isolation and actual
signed-tree extraction beyond the capacity; measure real archives, not mocks.
Host node-tar 6.2.1 uses a byte-hash-pinned minimal patch to select ordinary
Windows writes instead of UV_FS_O_FILEMAP for small files. Keep its create,
truncate, mode, close/error handling, Windows path reservations and all archive
checks intact. Cover the installed selector on Windows/macOS/Linux and exact
patch/lock identity with both LF and CRLF semantic lockfile inputs. Never fake
the running platform, override global fs or disable security software to improve
a host installer benchmark. Update repository-lock provenance digests when the
reviewed host lock changes; preserve upstream versions and separate runtime
locks rather than bypassing their verifiers.
Runtime directory moves remain native atomic renames. Windows alone may retry
transient EPERM/EBUSY locks with at most six attempts and 1500 ms accumulated
delays; persistent locks and all other errors remain failures. Never copy,
delete or relax permissions to bypass a lock, or bypass active-runtime guards.
Concurrent real-artifact test operations also settle before cleanup. Single/dual
clean-machine tests must persist sanitized phase transitions and bounded
heartbeats incrementally, including on timeout, without changing their existing
10/15-minute deadlines. Keep detailed phase evidence as always-uploaded CI
artifacts; test-only trust keys and local timing results are not release proof.
Optional extraction/rescan diagnostics emit only closed stage labels. Their
failure cannot alter acceptance or mask corruption; emit verified only after
readonly sealing succeeds. Record digest, preflight, extraction, inventory,
metadata, hashing and sealing separately for single/dual real-artifact gates.

Packaged runtime tests must prove managed OpenClaw and DeepSeek Harness use the ClawX Conversation Store adapter/provider and do not create durable native conversation, cron, channel-message, or usage history. A patch revision that changes persistence behavior requires focused storage regression coverage and a new immutable artifact version.

Platform security policy must be identical at every model-visible execution seam. On Windows, the DeepSeek Harness ACL runner may grant a private per-session temp capability to its confined child, but the in-process file tool must not widen that into ambient `%TEMP%`; source tests and extracted-artifact self-tests must prove both model-visible shell and file-tool writes to ambient temp fail closed.

Main downloads into staging, verifies before activation, uses atomic version-directory activation, and retains a verified last-known-good version for rollback. An update must not overwrite files used by a running process. Failed download, extraction, verification, activation, or health checks must leave the previous active runtime usable.

Install, update, repair, rollback, and uninstall operations are Main-owned and journaled. Renderer must not choose URLs, execute archives, or trust server-provided entrypoints without manifest allowlist validation.

Production host packaging must be blocked on the complete unit/contract/type/lint/chaos/comms/Harness gates, Electron E2E on macOS/Windows/Linux, and a live signed-catalog/two-artifact-host Range drill. Protected signing, notarization, promotion, and legal evidence cannot be replaced by local test results.

The Electron host must launch Node kernels using their selected standalone Node,
never Electron Helper or a PATH fallback. Development uses the same reviewed Node
pin; sanitize Node/Electron overrides after inheritance, including grandchildren.
Require real Electron warm-start/restart coverage with an existing native SQLite
database; mocked UI E2E and standalone artifact probes alone do not prove host
integration. Public trust roots need independently authenticated provenance and
must not be TOFU-fetched with an unverified catalog. See
`harness/reference/electron-kernel-node-launch.md`.

Production catalog promotion must normally extend a cryptographically verified, exact N-1 catalog served identically by every configured HTTPS catalog mirror. Sequence 1 requires an explicit protected bootstrap and every mirror must report the catalog absent. Persist an immutable signed release record before uploads/pointer writes, binding exact catalog bytes, accepted source/run/attempt/artifact evidence and its predecessor digest. A retry may repair N/N-1 or N/absent only through that record; N/absent after sequence 1 additionally requires the verified predecessor record. Changed candidate intent and same-sequence divergence are hard failures. Publisher code uses the reviewed workflow commit, not an arbitrary artifact source checkout. The read-only gate and protected recheck must bind trusted repository/main/workflow path, current frozen sources, all required build/single/dual jobs, same-source three-platform E2E, artifact IDs/digests and expiry; a workflow_run completion alone is not acceptance.

Production catalogs offer exactly one latest immutable artifact per enabled kernel/required target, deriving the matrix from release policy and the shared platform manifest. Ordinary retirement is not security revocation: preserve the revocation ledger, reject downgrades or changed bytes under a published revision, and record every removed descriptor in a signed retirement inventory. Track the maximum expiry of every issued catalog referencing an artifact, even if later catalogs shorten validity. Delete only after this maximum expiry plus the configured download grace and successful exact two-mirror catalog/all-target Range checks. Verify scoped name, signed digest and size before deleting each exact archive/descriptor/checksum; never list-delete a runtime prefix, touch a current reference, host installer, installed runtime or canonical data. Retain small signed journals/receipts, retry missing objects idempotently, and reject Enabled/Suspended COS versioning rather than pretending deletes remove history. Scheduled maintenance keeps the same production environment protection, may renew catalog metadata only within descriptor/key validity, and must not bypass reviewer approval. A catalog/key/descriptor expiry that cannot support valid renewal requires operator intervention, not a verification bypass. See `harness/reference/kernel-automatic-release.md`.

After a catalog pointer write, run bounded exact-release propagation checks
before the final strict catalog readback. Both mirrors agreeing on an older
valid catalog is not acceptance. Temporary absence/staleness may be retried, but
signed same-sequence conflicts or a newer catalog fail immediately. Exhausted
retries, final divergence or failed Range checks forbid all cleanup; recovery
reuses the immutable signed record, never a fresh sequence or signature.

The GitHub repository/release tag and descriptor URLs must be bound to the reviewed distribution mirrors before any external write. The newly signed catalog must remain verifiable at both issue time and immediately before expiry, including every offered artifact and signing-key validity window. The stable kernel GitHub release must not replace the host application's latest-release pointer.

The fixed-tag GitHub kernel asset container must use prerelease=true and
make_latest=false; the latter alone does not exclude a sole full release from
/releases/latest. This metadata label is separate from the signed production
catalog channel. Reject false/missing prerelease flags on existing containers
instead of silently competing with App releases. Reclassification must preserve
all immutable assets, tag identity, signatures and fixed download URLs.

The primary object mirror is Tencent COS under one reviewed bucket, region and root prefix. CI must use the repository-pinned official SDK, verify bucket location and versioning before writes, constrain every object key below the root, publish public-readable objects with SHA-256 metadata, refuse overwrite of immutable artifacts, and publish the mutable signed catalog last. Tencent credentials belong only to the protected production environment. Artifact and catalog private keys remain separated by environment; the rollback private key is offline-only. Any local recovery backup must be authenticated encryption under a git-ignored owner-only path, and its passphrase must be stored separately.
