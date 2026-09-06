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

CI must pin and verify upstream inputs, apply reviewed repository patches, run runtime smoke and contract tests, generate license notices, and emit a signed manifest containing artifact integrity, build provenance, capability contract, Conversation Store protocol/checkpoint codecs, entrypoints, and app compatibility.

Frozen inputs must retain LF bytes on Windows; raw upstream and prepared lockfile hashes are checked at their respective stages. DeepSeek Harness Linux builds must compile the pinned native Landlock launcher on each architecture before sandbox tests and include it in the audited runtime payload. Platform reports must be retained even after a later build failure.

DeepSeek Harness deployment must derive its closure from the shared lockfile (`inject-workspace-packages=true`); legacy hoisted deployment discards the lock and must not be used. Deploy skips lifecycle scripts, then explicitly invokes only the pinned upstream spawn-helper executable-bit repair. Generated deploy lockfiles, workspace settings, and builder-path manifests are removed or replaced with the reviewed runtime root manifest before archiving. The target-specific native allowlist must cover the actual frozen closure, including Koffi, image codecs, builtin loader, PTY, and the Linux Landlock launcher; non-target binaries are pruned before signing.

Windows runtime CI may explicitly select `artifact-signature-only` while Authenticode is deferred by the repository owner. The hash-bound platform report must record `authenticode: false` and `status: deferred`; all Ed25519 descriptor/catalog, archive integrity, extraction, sandbox, and storage checks remain mandatory. Missing credentials or failed Authenticode verification must never silently fall back to this mode. macOS Developer ID, hardened-runtime, and accepted notarization gates remain mandatory.

Every target's real signed descriptor/archive must pass the production `KernelPackageManager` path on a clean runner: injected transfer interruption with exact Range/If-Range resume, catalog/artifact verification, safe extraction, control-bridge smoke, atomic activation, integrity rescan, uninstall, and canonical-data preservation. CI-only trust material may contain only the artifact public key and must never enter the production publish set.

When both kernels are built, a separate clean-runner matrix must install both real artifacts into one package manager and SQLite authority, start both control bridges concurrently, prove distinct process identity, inject and repair a one-sided integrity failure while the other remains healthy, and uninstall independently. Control-plane smoke must not be reported as a real provider/model conversation.

Packaged runtime tests must prove managed OpenClaw and DeepSeek Harness use the ClawX Conversation Store adapter/provider and do not create durable native conversation, cron, channel-message, or usage history. A patch revision that changes persistence behavior requires focused storage regression coverage and a new immutable artifact version.

Platform security policy must be identical at every model-visible execution seam. On Windows, the DeepSeek Harness ACL runner may grant a private per-session temp capability to its confined child, but the in-process file tool must not widen that into ambient `%TEMP%`; source tests and extracted-artifact self-tests must prove both model-visible shell and file-tool writes to ambient temp fail closed.

Main downloads into staging, verifies before activation, uses atomic version-directory activation, and retains a verified last-known-good version for rollback. An update must not overwrite files used by a running process. Failed download, extraction, verification, activation, or health checks must leave the previous active runtime usable.

Install, update, repair, rollback, and uninstall operations are Main-owned and journaled. Renderer must not choose URLs, execute archives, or trust server-provided entrypoints without manifest allowlist validation.

Production host packaging must be blocked on the complete unit/contract/type/lint/chaos/comms/Harness gates, Electron E2E on macOS/Windows/Linux, and a live signed-catalog/two-artifact-host Range drill. Protected signing, notarization, promotion, and legal evidence cannot be replaced by local test results.

Production catalog promotion must normally extend a cryptographically verified, exact N-1 catalog served identically by every configured HTTPS catalog mirror. Sequence 1 requires an explicit protected bootstrap and every mirror must report the catalog absent. A retry may repair only a trusted partial N/N-1 (or N/absent bootstrap) publication: the signed N catalog, requested issue/expiry/revocations, and complete staged artifact set must match exactly; same-sequence divergence remains a hard failure. The GitHub repository/release tag and descriptor URLs must be bound to the reviewed distribution mirrors before any external write. The newly signed catalog must remain verifiable at both issue time and immediately before expiry, including every retained artifact and signing-key validity window; expired entries must be explicitly revoked rather than silently dropped or carried into an invalid catalog.

The primary object mirror is Tencent COS under one reviewed bucket, region and root prefix. CI must use the repository-pinned official SDK, verify bucket location and versioning before writes, constrain every object key below the root, publish public-readable objects with SHA-256 metadata, refuse overwrite of immutable artifacts, and publish the mutable signed catalog last. Tencent credentials belong only to the protected production environment. Artifact and catalog private keys remain separated by environment; the rollback private key is offline-only. Any local recovery backup must be authenticated encryption under a git-ignored owner-only path, and its passphrase must be stored separately.
