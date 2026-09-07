---
id: fix-registry-freshness-and-notary-recovery
title: Repair Windows registry freshness and recover notarization polling
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Diagnose the Windows manifest freshness assertion and Intel macOS notarization network timeout in build 34048363051, repair the underlying behavior with regression coverage, then push and dispatch a new all-target staging build.
touchedAreas:
  - scripts/kernel-runtime/**
  - tests/unit/kernel-*.test.ts
  - tests/unit/openclaw-*.test.ts
  - tests/fixtures/kernels/**
  - patches/openclaw@2026.9.2.patch
  - kernels/openclaw/**
  - pnpm-lock.yaml
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-registry-freshness-and-notary-recovery.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/**
  - README*.md
  - TODO.md
expectedUserBehavior:
  - The real installed registry rejects changes to the active plugin manifest or entrypoint on Windows and other targets.
  - An interrupted notarization status request resumes the same submission within a finite deadline; rejection and authentication failures remain fatal.
  - Runtime publication still requires accepted notarization and all existing real Gateway, Channel, storage and clean-machine checks.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-plugin-registry.test.ts tests/unit/kernel-notarization.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Establish why the manifest mutation is accepted in Windows CI before changing the registry or fixture; preserve all original freshness and trust checks.
  - Prove the selected active plugin is mutated, reject metadata and entrypoint changes with fresh caches, and retain duplicate-diagnostic and physical-identity regressions.
  - Persist the notarization submission identity before polling and never blindly resubmit after an uncertain submit response.
  - Retry only explicitly transient read-only status failures with bounded backoff and a total deadline; reject invalid, unknown or mismatched responses.
  - Keep signing, accepted-notarization and integrity gates mandatory, retain useful failure reports without credentials, and add deterministic offline failure-injection tests.
  - Synchronize frozen identities only if shipped runtime bytes change; do not change dependencies or the DeepSeek version unnecessarily.
  - Commit and push the reviewed repair to Tabll/ClawXXX main, dispatch both kernels on five targets with artifact-signature-only Windows policy, and report actual CI status separately from local tests.
  - No COS upload, production promotion or installed-runtime replacement is authorized by this repair.
docs:
  required: true
---

See `harness/reference/windows-runtime-ci-repair.md`. Build 34048363051 on
1b459ff7 passed eight runtime builds and all three Electron E2E platforms.
Windows stopped at the manifest stale-source assertion before Gateway startup.
DeepSeek Intel macOS passed signing and credential validation, then timed out
reading an existing Apple notarization submission. Single/dual clean-machine
matrices were skipped, so neither local evidence nor this staging run is full
release certification.
