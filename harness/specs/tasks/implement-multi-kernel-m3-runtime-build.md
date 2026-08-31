---
id: implement-multi-kernel-m3-runtime-build
title: Build Reproducible Kernel Runtime Artifacts
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Build pinned, patched, deterministic and signed OpenClaw and DeepSeek Harness Node 24 runtime artifacts in CI without client-side package installation.
touchedAreas:
  - TODO.md
  - kernels/**
  - scripts/kernel-runtime/**
  - .github/workflows/kernel-runtime-*.yml
  - THIRD_PARTY_NOTICES.md
  - tests/unit/kernel-*.test.ts
expectedUserBehavior:
  - Runtime installation never executes npm, pnpm or postinstall on the user machine.
requiredProfiles: [fast, comms]
requiredRules:
  - kernel-runtime-distribution
  - packaged-runtime-pruning-guards
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-build.test.ts
  - pnpm exec vitest run tests/unit/kernel-key-backup.test.ts tests/unit/tencent-cos-publisher.test.ts
  - pnpm exec vitest run tests/contract/kernels/real-runtime-artifact-install.test.ts tests/contract/kernels/real-dual-runtime-artifacts.test.ts
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - Source, lock, patches, manifest, SBOM, notices, signature and provenance are traceable.
  - Runtime storage contract scans find no native durable history.
  - Platform artifacts pass production package-manager install and startup/budget gates before catalog promotion.
  - A two-kernel build passes same-machine real-artifact concurrency, one-sided integrity recovery, independent uninstall and SQLite-preservation gates.
docs:
  required: true
---

## Scope

M3 runtime CI supply chain and immutable catalog inputs.
