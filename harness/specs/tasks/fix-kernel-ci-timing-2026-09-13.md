---
id: fix-kernel-ci-timing-2026-09-13
title: Make Cron timeout and patched executable CI checks deterministic
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the two remaining test-timing failures from kernel build 24, retain real durable storage and native syntax checks, then commit and dispatch a new full protected build.
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
  - Both kernels keep canonical SQLite Cron and Conversation records with the same timeout, cancellation and overlap semantics.
  - CI verifies every patched executable and all existing storage, signing and single/dual installation gates without host-speed-dependent fixture races.
  - No installed kernel, user database, frozen runtime input or production catalog is modified by local verification.
requiredTests:
  - pnpm exec vitest run tests/contract/domains/scheduler.test.ts tests/unit/openclaw-restart-recovery-patch.test.ts tests/unit/kernel-contract-signal.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Cron deadline tests advance only scheduler timers, wait for actual router admission and successful SQLite terminal writes, and prove before/at-deadline behavior, exact cancellation identity and persisted readback after reopening.
  - Manual cancellation and timeout have separate contracts, and delayed terminal persistence cannot be mistaken for premature Cron completion.
  - Every JavaScript file targeted by the exact pinned patch receives an individually named real Node --check test with a child deadline shorter than the unchanged test deadline; a separate inventory test retains lifecycle-pruning checks.
  - No full-suite or test timeout increases, blanket retries, skipped cases, mocked storage, reduced fsync or relaxed signing/native gates are introduced.
  - Local evidence and README review are documented; the new commit is pushed to Tabll/ClawXXX/main and both-kernel/five-target staging is explicitly dispatched for the new SHA.
docs:
  required: true
---

Build #24 (`34691870061`, `8e33ab0c`) passed all five DeepSeek targets and three
OpenClaw targets. OpenClaw Windows passed the repaired Koffi and real
Gateway/ACP/Channel checks, then failed the Cron test's two-second wall-clock
poll (running versus timed-out). OpenClaw Intel macOS timed out a single test
containing 23 sequential Node syntax-check processes at 5000 ms; no particular
file was identified as syntactically invalid. Same-source E2E #43 passed all
three platforms; promotion #17 was ineligible and skipped publishing.

Keep the distinction between observed CI failures and unproven production
defects. Investigate the actual execution/persistence ordering before changing
runtime semantics. This task currently targets test synchronization; a verified
production defect requires updating this scope and its behavioral coverage
before implementation. Follow `harness/reference/kernel-upgrade-2026-09-12.md`.
