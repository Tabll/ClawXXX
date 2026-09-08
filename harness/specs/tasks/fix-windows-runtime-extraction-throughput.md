---
id: fix-windows-runtime-extraction-throughput
title: Diagnose and bound native Windows runtime extraction I/O overhead
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Fix the repeat Windows dual-artifact extraction/repair timeout in run 34182369085 using measured native I/O improvements while preserving every acceptance gate.
touchedAreas:
  - electron/kernels/package-manager/**
  - scripts/kernel-runtime/**
  - shared/types/tar.d.ts
  - tests/unit/kernel-*.test.ts
  - tests/contract/kernels/package-manager.test.ts
  - tests/contract/kernels/real-*.test.ts
  - tests/fixtures/kernels/**
  - patches/tar@6.2.1.patch
  - pnpm-workspace.yaml
  - pnpm-lock.yaml
  - kernels/openclaw/lock.json
  - kernels/openclaw/source.json
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-windows-runtime-extraction-throughput.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Both real signed kernels install concurrently and repair independently without modifying canonical SQLite data.
  - Windows installation retains exact signed bytes, paths, hashes, budgets, readonly sealing and atomic activation.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Record build 34182369085 and distinguish fixed Windows path contracts from its later dual-runtime throughput timeout; await and record the single-runtime outcome too.
  - Measure native Windows extraction on the exact same real signed artifact before and after any change; distinguish VM samples from GitHub runner acceptance.
  - Investigate memory-mapped small-file writes and other I/O overhead as hypotheses, never assume antivirus or a specific Windows component is responsible without evidence.
  - Preserve node-tar Windows path reservations, bounded independent directory caches, complete preflight/post-extraction verification and readonly protection.
  - Do not introduce fake platform globals, global fs monkey patches, relaxed archive limits, disabled security settings, whole-test retries, skipped gates or larger deadlines in production or CI.
  - If a host-tooling dependency patch is justified, pin and test the exact minimal patch; update OpenClaw's repository-lock provenance digests to match without altering runtime source or upstream package versions, and retain the separate DSH frozen lock.
  - Add deterministic regression and native before/after evidence, review every README locale and synchronize rule/scenario/reference/TODO.
  - Commit and push verified repairs, run and normally approve a fresh complete both-kernel/five-platform staging matrix, and continue until all required jobs succeed.
  - Keep MK-1940 pending until complete remote acceptance; no COS/catalog promotion, credentials or protection changes.
docs:
  required: true
---

The Windows dual-runtime job 101928142967 completed its initial two-kernel
installation in 628468 ms, detected corruption, began OpenClaw repair at
634333 ms and exceeded the unchanged 900000 ms limit. The previous same-payload
run passed in 730583 ms with an initial install of 313751 ms. A one-off pass is
not robust acceptance; diagnose the repeated extraction cost without weakening
the production verifier or test assertions.

The Windows single job 101928143073 passed its sealed Gateway/ACP probe, then
completed installation at 571913 ms but timed out during the subsequent full
integrity rescan at 600000 ms. Both failures are file-operation throughput gates;
the native path-contract preflight passed all 137 cases on both Windows builds.
