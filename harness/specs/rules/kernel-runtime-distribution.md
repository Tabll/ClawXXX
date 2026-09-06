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

For DSH 0.1.3+, use ClawX's explicit awaited service composition, not the removed demo spine or upstream app profiles. Capture the process launch environment and own proxy-dispatcher teardown. Live assistant frames and durable v2 message/attempt settlements have separate identities: failed attempts replace transient answer text (including an empty snapshot), and only settled request usage is persisted, keyed by run and stable settlement sequence. Never sum intermediate usage snapshots or replay durable streams as live deltas. A failed usage delivery must not result in a successful terminal run. The optional SessionHandle seam requires server-side single-writer fencing, retained failed batches and drain/release lifecycle tests; it must not enable a second production history store. See `harness/reference/deepseek-harness-0.1.3-upgrade.md`.

CI must pin and verify upstream inputs, apply reviewed repository patches, run runtime smoke and contract tests, generate license notices, and emit a signed manifest containing artifact integrity, build provenance, capability contract, Conversation Store protocol/checkpoint codecs, entrypoints, and app compatibility.

For OpenClaw upgrades, keep production pins unchanged until every existing
compiled patch has a reviewed semantic disposition and the candidate's actual
SDK, ACP/Gateway, Agents config and bundled channel imports are compatible.
Upstream migration/default changes must not widen session visibility or
permissions. A candidate test must explicitly select its package and exact
version, never silently test the installed old SDK. Failed real-process storage
probes block promotion even when host mocks and control smoke pass. The source
pin is now 2026.9.2+clawx.8; actual per-Run incognito/ACP storage probes run before
sealing and again against extracted artifacts. Verify the sealed file manifest
again after first launch, and never let upstream postinstall prune patch files.
See
`harness/reference/openclaw-2026.9.2-upgrade.md`.

License audits must retain compound `AND` expressions and require explicit package-scoped copyleft obligation records, including Windows sharp's bundled libvips. Do not replace the declaration with a permissive component or interpret a machine-readable obligation record as legal approval.

Frozen inputs must retain LF bytes on Windows; raw upstream and prepared lockfile hashes are checked at their respective stages. DeepSeek Harness Linux builds must compile the pinned native Landlock launcher on each architecture before sandbox tests and include it in the audited runtime payload. Platform reports must be retained even after a later build failure.

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

Real Channel package entrypoint tests must use a fresh native Node process when
loading the complete plugin/SDK graph. Bound that child with a kill timeout
shorter than its dedicated test deadline; retain actual export and syntax
assertions. Never fix a cold-start timeout with mocks, retries, skipped checks
or a global timeout increase. Packaged Gateway/ACP/Channel probes remain
independent mandatory gates.

DeepSeek Harness deployment must derive its closure from the shared lockfile (`inject-workspace-packages=true`); legacy hoisted deployment discards the lock and must not be used. Deploy skips lifecycle scripts, then explicitly invokes only the pinned upstream spawn-helper executable-bit repair. Generated deploy lockfiles, workspace settings, and builder-path manifests are removed or replaced with the reviewed runtime root manifest before archiving. The target-specific native allowlist must cover the actual frozen closure, including Koffi, image codecs, builtin loader, PTY, and the Linux Landlock launcher; non-target binaries are pruned before signing.

Windows runtime CI may explicitly select `artifact-signature-only` while Authenticode is deferred by the repository owner. The hash-bound platform report must record `authenticode: false` and `status: deferred`; all Ed25519 descriptor/catalog, archive integrity, extraction, sandbox, and storage checks remain mandatory. Missing credentials or failed Authenticode verification must never silently fall back to this mode. macOS Developer ID, hardened-runtime, and accepted notarization gates remain mandatory.

Standalone macOS runtime tools/addons must pass strict `codesign` plus the explicit `notarized` requirement and `--check-notarization`, per Apple's [Testing a Notarised Product](https://developer.apple.com/forums/thread/130560). Do not use `.app`-only `spctl --type execute` assessment on a bare Node executable, or turn a missing notarization ticket into a signature-only success. Host app/DMG Gatekeeper and stapling checks remain separate. Overlay package file lists must retain emitted root-level JavaScript chunks, not only public entry files.

Every target's real signed descriptor/archive must pass the production `KernelPackageManager` path on a clean runner: injected transfer interruption with exact Range/If-Range resume, catalog/artifact verification, safe extraction, control-bridge smoke, atomic activation, integrity rescan, uninstall, and canonical-data preservation. CI-only trust material may contain only the artifact public key and must never enter the production publish set.

When both kernels are built, a separate clean-runner matrix must install both real artifacts into one package manager and SQLite authority, start both control bridges concurrently, prove distinct process identity, inject and repair a one-sided integrity failure while the other remains healthy, and uninstall independently. Control-plane smoke must not be reported as a real provider/model conversation.

Packaged runtime tests must prove managed OpenClaw and DeepSeek Harness use the ClawX Conversation Store adapter/provider and do not create durable native conversation, cron, channel-message, or usage history. A patch revision that changes persistence behavior requires focused storage regression coverage and a new immutable artifact version.

Platform security policy must be identical at every model-visible execution seam. On Windows, the DeepSeek Harness ACL runner may grant a private per-session temp capability to its confined child, but the in-process file tool must not widen that into ambient `%TEMP%`; source tests and extracted-artifact self-tests must prove both model-visible shell and file-tool writes to ambient temp fail closed.

Main downloads into staging, verifies before activation, uses atomic version-directory activation, and retains a verified last-known-good version for rollback. An update must not overwrite files used by a running process. Failed download, extraction, verification, activation, or health checks must leave the previous active runtime usable.

Install, update, repair, rollback, and uninstall operations are Main-owned and journaled. Renderer must not choose URLs, execute archives, or trust server-provided entrypoints without manifest allowlist validation.

Production host packaging must be blocked on the complete unit/contract/type/lint/chaos/comms/Harness gates, Electron E2E on macOS/Windows/Linux, and a live signed-catalog/two-artifact-host Range drill. Protected signing, notarization, promotion, and legal evidence cannot be replaced by local test results.

Production catalog promotion must normally extend a cryptographically verified, exact N-1 catalog served identically by every configured HTTPS catalog mirror. Sequence 1 requires an explicit protected bootstrap and every mirror must report the catalog absent. A retry may repair only a trusted partial N/N-1 (or N/absent bootstrap) publication: the signed N catalog, requested issue/expiry/revocations, and complete staged artifact set must match exactly; same-sequence divergence remains a hard failure. The GitHub repository/release tag and descriptor URLs must be bound to the reviewed distribution mirrors before any external write. The newly signed catalog must remain verifiable at both issue time and immediately before expiry, including every retained artifact and signing-key validity window; expired entries must be explicitly revoked rather than silently dropped or carried into an invalid catalog.

The primary object mirror is Tencent COS under one reviewed bucket, region and root prefix. CI must use the repository-pinned official SDK, verify bucket location and versioning before writes, constrain every object key below the root, publish public-readable objects with SHA-256 metadata, refuse overwrite of immutable artifacts, and publish the mutable signed catalog last. Tencent credentials belong only to the protected production environment. Artifact and catalog private keys remain separated by environment; the rollback private key is offline-only. Any local recovery backup must be authenticated encryption under a git-ignored owner-only path, and its passphrase must be stored separately.
