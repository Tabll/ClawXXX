---
id: fix-sqlite-fixture-byte-equality-2026-09-13
title: Compare canonical SQLite fixture bytes without object-deep-equality overhead
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair build 26's macOS Intel fixture-test timeout while preserving complete byte equality, real SQLite durability and all runtime gates, then push a new complete staging build.
touchedAreas:
  - tests/**
  - harness/**
  - TODO.md
  - .github/workflows/kernel-runtime-build.yml
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - backend-communication-boundary
  - comms-regression
  - docs-sync
expectedUserBehavior:
  - Both kernels retain unchanged shared Conversation/Cron authority and frozen runtime versions.
  - All platform build jobs retain the real SQLite copy, fsync, WAL/FULL, foreign-key and close/reopen checks.
  - Binary fixture assertions compare every byte and reject same-length corruption without object-property enumeration or dumping database contents.
requiredTests:
  - pnpm exec vitest run tests/unit/canonical-sqlite-fixture.test.ts tests/unit/kernel-artifact-test-support.test.ts tests/unit/kernel-runtime-build.test.ts tests/contract/domains/scheduler.test.ts tests/contract/kernels/openclaw-conversation-store.test.ts
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Record a before/after phase breakdown with the actual pinned Node and real fixture, distinguishing binary assertion overhead from file copying and SQLite work.
  - Replace large-Buffer object-deep-equality only with exact native Buffer byte comparison, not hashes alone, prefix sampling, same-size checks or shared object identity.
  - Add independently owned equal-buffer, same-size beginning/middle/end corruption, truncation, extension and nonzero-offset view regression cases; malformed inputs fail closed and errors exclude byte contents.
  - Keep all five fixture behavior/safety tests, complete lifecycle assertions and every original timeout, worker policy, retry and signing/publication gate unchanged.
  - Always-uploaded bounded phase journals cover copy, byte comparisons, service operations and cleanup, including failure.
  - Review README documentation, update the task/rule/reference/TODO, then commit and push to main and dispatch both kernels for all five targets through normal staging approval.
docs:
  required: true
---

Build #26 (`34744865743`, `3f38b6f1`) passed both Windows builds, both macOS
arm64 builds and all Linux builds; same-SHA three-platform E2E #45 passed.
Only the macOS Intel canonical suites failed, both at the newly added fixture
test's 5000 ms deadline (OpenClaw 7821 ms, DSH 5442 ms). Their notarizations were
Accepted. Other fixture tests that compare one whole database Buffer took
1580-3030 ms while non-Buffer safety tests took 20-41 ms. Existing scheduler
and OpenClaw restoration contracts passed. The publish job in promotion #22
was skipped, so the candidate has not been released.

Inspect and measure the locked Vitest deep-equality path before assigning the
cost to native SQLite or runner storage. Do not alter production code, user
databases, installed kernels or frozen build inputs. Record evidence under
`harness/reference/kernel-upgrade-2026-09-12.md`; local macOS arm64 timings do
not replace Intel/Windows/Linux artifact acceptance.
