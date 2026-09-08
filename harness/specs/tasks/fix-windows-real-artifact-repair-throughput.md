---
id: fix-windows-real-artifact-repair-throughput
title: Remove the measured Windows real-artifact repair bottleneck without weakening verification
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Profile and repair the Windows dual-runtime install/repair deadline exposed by staging run 34174116971, then complete new-SHA native staging acceptance.
touchedAreas:
  - scripts/kernel-runtime/lib/openclaw-probe-provider.mjs
  - scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs
  - tests/unit/openclaw-probe-lifecycle.test.ts
  - harness/specs/tasks/fix-openclaw-probe-background-exec.md
  - electron/kernels/package-manager/safe-extractor.ts
  - electron/kernels/package-manager/bounded-io.ts
  - electron/kernels/package-manager/index.ts
  - scripts/kernel-runtime/runtime-artifact-smoke.mjs
  - shared/types/tar.d.ts
  - tests/fixtures/kernels/artifact-test-support.mjs
  - tests/unit/kernel-runtime-archive.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - tests/unit/kernel-bounded-io.test.ts
  - tests/unit/kernel-artifact-test-support.test.ts
  - tests/contract/kernels/package-manager.test.ts
  - tests/contract/kernels/real-runtime-artifact-install.test.ts
  - tests/contract/kernels/real-dual-runtime-artifacts.test.ts
  - harness/specs/tasks/fix-windows-real-artifact-repair-throughput.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Both real runtimes install concurrently, independently detect corruption and repair, and uninstall without losing shared SQLite data on Windows.
  - Every signed byte, archive safety check and readonly payload boundary remains enforced.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-archive.test.ts tests/unit/kernel-bounded-io.test.ts tests/unit/kernel-artifact-test-support.test.ts tests/contract/kernels/package-manager.test.ts tests/unit/kernel-runtime-build.test.ts tests/unit/openclaw-probe-lifecycle.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Record actual CI phase timings and isolate the slow operation using a real signed archive on an isolated Windows VM, distinguishing VM samples from GitHub runner acceptance.
  - Preserve preflight and extraction guards, duplicate/case/path/link checks, signed file counts and sizes, full manifests and hash verification, immutable files and atomic activation.
  - Optimize only the measured bottleneck with bounded work; do not skip verification, substitute fake artifacts, disable antivirus or sandboxing, retry whole tests, or enlarge deadlines.
  - Cover the changed behavior and failure cleanup with deterministic regression tests and real artifact before/after evidence.
  - Retain real SQLite FULL persistence, concurrent two-kernel execution, one-sided fault injection and repair, independent uninstall and shared-data retention.
  - Preserve frozen +clawx.12 source/payload identities, dependency locks, production signing inputs and workflow gates unless separate evidence requires an explicitly documented change.
  - Clean up only newly created task-owned VM fixtures and return an initially stopped VM to its original state.
  - Review all README locales and update relevant user-visible behavior documentation if necessary.
  - Commit and push the verified repair together with 09502303, dispatch both kernels on all five platforms with normal kernel-staging approval, and continue until all required jobs and same-code E2E pass.
  - Keep COS/catalog promotion, credentials and protection-rule changes out of scope; leave MK-1940 unchecked until remote acceptance is complete.
docs:
  required: true
---

Build #15 passed 23/25 jobs. Windows dual-runtime job 101904963001 installed
both artifacts at 457376 ms, concurrently started their control bridges at
457486 ms, detected injected OpenClaw corruption at 463196 ms and entered
repair at 463277 ms. It then timed out at the existing 900000 ms deadline.
The independent Windows sealed-probe background-exec defect is fixed locally
in 09502303; this task must not obscure or weaken its native acceptance gate.
Its paths are included above because the diff-aware validation covers both
locally committed repairs in the same pending push to origin/main.
