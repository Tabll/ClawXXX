---
id: fix-openclaw-early-storage-worker-policy
title: Apply the Windows storage worker policy to the early OpenClaw build gate
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the early Windows SQLite contract timeout without relaxing storage, runtime or CI acceptance.
touchedAreas:
  - .github/workflows/kernel-runtime-build.yml
  - tests/unit/kernel-runtime-build.test.ts
  - tests/contract/kernels/openclaw-conversation-store.test.ts
  - tests/fixtures/kernels/**
  - tests/unit/kernel-artifact-test-support.test.ts
  - harness/specs/tasks/fix-openclaw-early-storage-worker-policy.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - A real OpenClaw session rehydrates, compacts, branches and restarts through one on-disk ClawX SQLite authority without native history.
  - Complete staging acceptance preserves full durability and per-test deadlines on all platforms.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
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
  - Preserve run 34190465955 job 101947300320 evidence: all 174 early regressions passed, but one of 11 subsequent closure cases exceeded 5000 ms before payload building.
  - Apply the existing Windows-only single-file-worker storage policy to the earlier duplicate OpenClaw closure gate as well as the later canonical suite; other platforms retain default workers.
  - Cover LF and CRLF workflow checkouts, complete selected suites, unchanged deadlines and always-uploaded early failure evidence.
  - Retain full real SQLite reopen, compaction, branching, checkpoint, native-history and live Agent cancellation assertions with no in-memory database substitution.
  - Use bounded content-free phase evidence for the affected contract and clean only owned fixture state after service teardown.
  - Verify actual Windows behavior where feasible and distinguish controlled samples from an unproven runner stall cause.
  - Do not change runtime bytes, pins, locks, database production behavior, signatures, timeout budgets, test retry or safety gates.
  - Commit and push verified changes; complete normally approved full staging and same-code E2E before closing MK-1940. No COS/catalog promotion.
docs:
  required: true
---

The later canonical storage matrix already uses one file worker on Windows.
The earlier OpenClaw closure gate also runs the real SQLite suite, but still
uses default concurrent file workers. The previous run passed this suite in
434 ms; this run's lifecycle case exceeded 5 seconds. The missing policy is
confirmed, but logs do not identify the specific delayed storage operation.
