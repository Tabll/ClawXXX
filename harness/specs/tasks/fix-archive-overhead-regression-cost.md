---
id: fix-archive-overhead-regression-cost
title: Remove pathological archive-budget regression fixture cost
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Diagnose and repair the five-second Intel macOS preflight timeout in run 34093118132 without weakening signed extraction budgets, then commit, push and dispatch a fresh both-kernel staging run.
touchedAreas:
  - tests/contract/kernels/package-manager.test.ts
  - tests/fixtures/kernels/archive-overhead*.mjs
  - tests/unit/kernel-runtime-archive.test.ts
  - harness/specs/tasks/fix-archive-overhead-regression-cost.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
expectedUserBehavior:
  - Both kernels retain the same immutable payloads and production extraction safety policy.
  - Archive-budget tests finish reliably under the existing per-test deadline on all five CI targets.
  - Exact boundary acceptance and rejection still use real Zstandard files and the production extractor.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/package-manager.test.ts tests/unit/kernel-runtime-archive.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Measure the old fixture cost and identify the cause instead of assuming the runner or notarization service failed.
  - Replace excessive post-EOF padding with bounded valid PAX records and a small trailer, preserving a real stream larger than the signed limit.
  - Prove acceptance at the exact stream budget and rejection one byte above it, including bytes arriving after TAR EOF; assert the exact stream-budget error.
  - Prevent accidental reintroduction of quadratic trailer buffering with deterministic operation-based evidence rather than a brittle timing threshold.
  - Keep the existing five-second test deadline, no global timeout increase, retries, skips, fake extractor or relaxed signed limits.
  - Keep production code, kernel artifact versions, source/runtime/overlay/lock hashes and platform signing policy unchanged for this test-fixture-only repair.
  - Review the three required README locales; document why no user-facing flow or interface change needs translation.
  - Commit and push to Tabll/ClawXXX main, dispatch both kernels on five targets, approve kernel-staging, and report actual status separately from local tests.
  - Do not upload COS artifacts, promote catalogs, modify credentials or replace installed runtimes.
docs:
  required: true
---

See `harness/reference/windows-runtime-ci-repair.md`. Run 34093118132 passed
nine builds, three macOS notarizations and all three Electron E2E platforms.
OpenClaw Intel macOS failed the new archive-overhead test at 5,031 ms before
source preparation; the same test passed in DeepSeek Intel macOS at 3,792 ms.
Both clean-machine matrices were skipped and no full acceptance is claimed.
