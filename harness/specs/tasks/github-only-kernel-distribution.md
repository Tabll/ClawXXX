---
id: github-only-kernel-distribution
title: Distribute optional kernels exclusively through GitHub Releases
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Remove COS from kernel downloads and protected publication without weakening signed identity, journal recovery or safe retirement.
touchedAreas:
  - .github/workflows/kernel-runtime-*.yml
  - electron/kernels/package-manager/**
  - resources/kernels/distribution.json
  - kernels/**
  - scripts/kernel-runtime/**
  - tests/unit/kernel-*.test.ts
  - tests/unit/tencent-cos-publisher.test.ts
  - tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - tests/contract/kernels/package-manager.test.ts
  - tests/fixtures/kernels/release-fixture.mjs
  - tests/e2e/kernel-*.spec.ts
  - tests/e2e/fixtures/kernel-github-electron.ts
  - harness/**
  - docs/**
  - README*.md
  - TODO.md
expectedUserBehavior:
  - Optional kernel packages and signed catalogs use only public GitHub Releases without user credentials.
  - Existing canonical SQLite data and installed runtimes are unchanged.
  - Failed publication cannot overwrite immutable identities, reset catalog sequence or delete active packages.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Configured artifact mirrors are the complete transport allowlist; legacy COS descriptor URLs may be authenticated as historical identity but never fetched implicitly.
  - The protected policy binds exactly the reviewed GitHub repository and prerelease container; no COS SDK initialization, credentials, reads, writes or cleanup remain in kernel publication.
  - Preserve complete same-source build and E2E gates, independent artifact/catalog signatures, platform notarization and bounded Range/ETag validation for every configured source and target.
  - Recover a missing single catalog pointer from authenticated immutable journals, never by resetting sequence or assuming bootstrap.
  - An explicit protected manual supersession is bound to the exact pending record digest, advances the signed journal chain and retains the full historical retention ledger; automatic events may not change reserved intent.
  - Changing signed descriptor URLs uses new immutable artifact revisions. Historical COS URLs remain validation-only and are not deletion targets.
  - Only exact inactive GitHub package identities may be deleted after maximum signed-catalog expiry plus grace and successful live catalog checks. Retain all signed records and receipts.
  - Cover bootstrap, expired pending records, missing pointer, changed retry intent, migration, upload/verification failure, stale/forked state and interrupted cleanup with offline failure injection.
docs:
  required: true
---

This change is scoped to optional kernel distribution. Host application installer
COS publication is unchanged. No production mutation, approval, commit or push
is part of local implementation. Design and validation are recorded in
`harness/reference/github-only-kernel-distribution.md`.
