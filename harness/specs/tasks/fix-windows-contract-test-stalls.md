---
id: fix-windows-contract-test-stalls
title: Remove Windows contract fixture stalls without weakening runtime gates
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Diagnose and repair the Windows contract test timeouts in run 34135100335, verify real SQLite and Git semantics, then commit, push and dispatch a new both-kernel five-target staging run.
touchedAreas:
  - tests/contract/domains/**
  - tests/contract/kernels/**
  - tests/unit/kernel-*.test.ts
  - tests/fixtures/**
  - electron/scheduler/**
  - electron/channels/**
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-windows-contract-test-stalls.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - README*.md
  - TODO.md
expectedUserBehavior:
  - Canonical Channels preserve per-thread serialization and persist both messages exactly once.
  - Canonical Cron preserves skip/replace, restart misfire and unique admission semantics in real SQLite.
  - Exact Git patches still reject offsets under both inherited Windows line-ending policies.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-contract-signal.test.ts tests/unit/kernel-runtime-build.test.ts tests/contract/domains/channels-runtime.test.ts tests/contract/domains/scheduler.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Measure fixture setup and asynchronous admission/settlement work; distinguish observed CI timeout from unproven root-cause claims.
  - Keep real on-disk SQLite, FULL synchronization, reopen persistence and durable state assertions; no in-memory replacement or weaker production durability.
  - Keep actual Git patch execution, both autocrlf policies, LF-exact bytes and clean rejection of offsets; reduce fixture work instead of mocking Git.
  - Use explicit readiness and completion barriers for asynchronous contract work where appropriate, release test gates on failure and drain owned work before closing storage.
  - Preserve default test deadlines and all existing signed artifact, macOS signing/notarization and single/dual clean-machine gates; no whole-test retries or skips.
  - Limit only Windows storage-suite file workers to one, retaining within-test multi-kernel and message concurrency and other platform worker defaults.
  - Preserve both +clawx.12 payloads, source hashes, dependency locks and signing inputs; no user-installed runtime or canonical-data mutation.
  - Run the complete CI-selected storage suites and focused repetitions, with Windows verification where feasible; record unverified native CI acceptance honestly.
  - Update durable evidence, TODO and scenario/rule constraints; review README locales and update them only if behavior changes.
  - Commit and push main to Tabll/ClawXXX, dispatch a fresh both-kernel/five-target run on the new SHA and approve kernel-staging; no COS upload, catalog promotion or secret changes.
docs:
  required: true
---

Build #13 at dc2ec968 passed eight builds, all four macOS signing/notarization
targets and three-platform Electron E2E. Both Windows targets passed all 121
early regressions, then failed default 5000 ms storage/build contract tests:
OpenClaw LF-exact Git and Cron restart/misfire; DeepSeek channel thread queue
and Cron skip/replace. Both clean-machine matrices were skipped. See
`harness/reference/windows-runtime-ci-repair.md` for measurements and final gates.
