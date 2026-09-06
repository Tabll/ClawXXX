# Kernel Runtime Security, Support, and EOL Policy

Effective for ClawX 0.6.0. This policy covers the separately downloadable OpenClaw and DeepSeek Harness runtimes. A runtime is not a public release merely because CI can build it: every protected release gate below must have retained evidence.

## Supported matrix

| Host | Architectures | Runtime baseline | Status |
| --- | --- | --- | --- |
| macOS 13.5+ | arm64, x64 | Hardened runtime, Developer ID signing, Apple notarization | Required |
| Windows 10 / Server 2016+ | x64 | Ed25519 artifact signature; Authenticode deferred | Required |
| Ubuntu 24.04 or compatible glibc distribution | x64, arm64 | glibc >= 2.39, kernel >= 6.8, sandbox smoke | Required |
| Linux musl/Alpine | — | No glibc runtime contract | Unsupported |
| Windows arm64 | — | No released runtime artifact | Deferred |
| Linux arm64 RPM | arm64 | tar.zst and deb remain supported | Deferred |

The base application may open offline data on a broader OS range, but installing or starting an optional kernel is supported only on this matrix. Five target artifacts are mandatory for each kernel: Darwin arm64/x64, Windows x64, and Linux arm64/x64.

## Release and supply-chain gates

1. Source manifests pin the upstream commit or npm integrity, lockfile, patch series, overlay manifest, Node distribution, and reproducible timestamp.
2. Protected CI builds each platform payload. End-user machines never run npm or pnpm to install a kernel.
3. The exact payload passes contract tests, no-native-history scanning, license audit, platform signing checks, SPDX and CycloneDX generation, and provenance generation.
4. macOS Mach-O files are signed leaf-first and the complete runtime closure must receive an `Accepted` notarization result. Windows may explicitly select `artifact-signature-only`, recording `authenticode: false` and `status: deferred` in hash-bound platform metadata; otherwise PE files must pass Authenticode. Failed signatures never select the deferred mode automatically. Linux records and verifies its ABI/support baseline.
5. An Ed25519 artifact key signs the immutable descriptor. A separate Ed25519 catalog key signs a monotonically increasing, expiring production catalog. Promotion never rebuilds an approved artifact.
6. The complete two-kernel/five-target set is verified before publication. Immutable artifacts are published to Tencent COS and GitHub first; the signed catalog is published last.
7. A post-publication drill requires identical signed catalogs, cache validation, and two independent range-capable artifact hosts. Failure stops promotion.

Every artifact contains its source/patch identity, SHA-256 archive digest, storage authority, test report hashes, license report, platform-security report, SBOMs, and provenance. The host rejects expired, revoked, downgraded, incompatible, non-HTTPS, oversized, traversal-containing, symlink-containing, or incorrectly signed inputs before activation.

## Signing key runbook

Private artifact, catalog, and offline rollback keys live only in protected CI environments or an approved offline signing system. They must never be committed, placed in runtime archives, printed to logs, or copied to an end-user profile. Public trust roots are materialized into the host installer from a protected secret.

Routine rotation:

1. Generate a new Ed25519 key offline and assign a new, production-form key ID.
2. Ship a host release whose trust store contains both the old and new public keys. Both must have explicit purpose, `notBefore`, and `notAfter` values.
3. Keep the overlap for at least one supported host release and until every still-valid catalog/artifact can be verified by a non-revoked key in supported hosts.
4. Start signing new descriptors/catalogs with the new key, verify a production drill, then stop use of the old private key.
5. Mark the old root expired only after its verification window closes. Do not delete roots needed by valid metadata or a supported rollback.

Emergency revocation:

1. Freeze catalog promotion and preserve logs/evidence.
2. Add `revokedAt` to the compromised public root and add affected descriptor identities to catalog revocations, signed with an unaffected catalog or offline rollback key.
3. Publish a higher-sequence, short-lived recovery catalog to both mirrors; never reuse a sequence or overwrite an immutable artifact.
4. Release a host trust-store update if no unaffected online key remains. The client fails closed until that update is installed.
5. Rebuild from reviewed source with a new patch/artifact version. Do not relabel or re-sign compromised bytes as a new version.
6. Record scope, affected versions, replacement, and user action in release notes and the incident record.

The rollback key is not used for normal releases. It is kept offline, has the `rollback` purpose, and may authorize only an explicit emergency catalog/rollback path. Rollback never bypasses host compatibility, revocation, digest, platform signature, or storage-authority checks.

## Platform signing and app updates

Protected macOS release CI verifies the ClawX app with strict `codesign`, Gatekeeper assessment, and a stapled notarization ticket. Runtime executables use their dedicated entitlements only where the standalone Node runtime requires JIT/unsigned executable memory; those entitlements are not granted to arbitrary payload files.

Optional runtime tools/addons are standalone Mach-O files, not `.app` bundles: verify each with `codesign --verify --strict --check-notarization -R=notarized`. They cannot carry a stapled app ticket and require online Apple ticket retrieval for this check. Do not apply `.app`-only `spctl --type execute` to bare Node tools or describe this check as a completed host-app Gatekeeper test. See [Apple's testing guidance](https://developer.apple.com/forums/thread/130560).

Protected Windows release CI signs during electron-builder packaging, not after wrapping. This covers the installed app and installer and enables electron-updater publisher verification. The packaged smoke performs install, process-tree/file-lock update, signature checks, uninstall, and user-data preservation. Alpha, beta, and stable releases use the same signing gate.

## Compatibility, updates, rollback, and EOL

- Host/runtime compatibility is enforced by `minHostVersion`, optional `maxHostVersion`, protocol version, bridge identity, platform, architecture, and mandatory capabilities.
- OpenClaw and DeepSeek Harness are versioned independently. Updating one must not stop, replace, or roll back the other.
- The package manager retains the active and previous verified versions. Activation is atomic; failed health checks revert to the previous version. Repair re-verifies or redownloads immutable bytes.
- A runtime release is supported while its catalog entry is unexpired and unrevoked and its host line is supported. At least the active and immediately previous compatible runtime are retained for rollback during the host line's support window.
- Security revocation may end support immediately. Normal EOL is announced in release notes before removal from a future catalog. Removal from the current catalog does not delete installed bytes or canonical user data.
- DeepSeek Harness is upstream prerelease software. ClawX supports only the exact patched revision named in the descriptor, not arbitrary upstream builds.

## License release approval

The generated license audit is an engineering gate, not legal advice. Public OpenClaw promotion additionally requires fulfillment and approval of all recorded obligations, including exact corresponding-source delivery for GPL/LGPL components and MPL-covered source availability. `libsignal` is a mandatory legal-release checkpoint. The unlicensed QQ QR connector is excluded; manual AppID/AppSecret setup remains available.

## Evidence and ownership

`kernel-runtime-build.yml` produces per-target evidence, sends each real artifact through the production package-manager path, and runs a separate same-machine dual-artifact concurrency/failure-isolation job. `kernel-runtime-promote.yml` verifies and publishes the complete set. `release.yml` reruns the full unit/contract/type/lint/chaos/comms/Harness gates, three-platform Electron E2E, and the live two-mirror Range drill before packaging; `win-build-test.yml` retains the focused signed-installer check. Protected environment approvals, signing/notarization logs, catalog sequence, artifact hashes, distribution-drill output, and legal approval are retained with the release. A local test run cannot substitute for those records.
