---
id: fix-artifact-identity-assertion-2026-09-13
title: Remove hidden deep comparison from artifact fixture identity assertions
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Fix build 27's common preflight timeout without changing kernel behavior or test deadlines, then push and dispatch the complete staging matrix.
touchedAreas:
  - tests/**
  - harness/**
  - TODO.md
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - comms-regression
  - docs-sync
expectedUserBehavior:
  - Both kernels keep their frozen versions, canonical storage and existing installation behavior.
  - Complete runtime builds retain all native, storage, signing and protected publication checks.
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-artifact-test-support.test.ts tests/unit/kernel-runtime-archive.test.ts tests/unit/kernel-runtime-build.test.ts tests/unit/canonical-sqlite-fixture.test.ts tests/contract/kernels/package-manager.test.ts
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Assert distinct fixture references via Object.is boolean results, never by passing large objects to Vitest toBe or not.toBe.
  - Make the original equal-buffer test reject object inspection deterministically; prove red before the identity fix and green after, without a new timing threshold.
  - Keep independent 2 MiB buffers, full native byte comparison, corruption, truncation, extension, offset and malformed-input coverage.
  - Audit related archive and package-manager assertions and retain exact byte equality and independent cache ownership.
  - Run the complete unchanged CI preflight selector with pinned Node 24.20.0, then the full local suite and required checks.
  - Preserve every existing timeout, retry, worker, frozen input and release gate; do not touch user databases or installed kernels.
  - Review README files, record evidence and local versus remote status, commit and push main, and dispatch both kernels on all five platforms using normal staging approval.
docs:
  required: true
---

Build #27 (`34754108891`, `d6860c92`) failed nine build jobs at the same
preflight test; each passed the other 197 checks. DeepSeek Harness macOS arm64
completed successfully. The added `expect(actual).not.toBe(expected)` on two
independent 2 MiB Buffers invokes Vitest 4.1.1's deep-equality diagnostic path
before negation, taking 5083-16046 ms in the failed jobs against the unchanged
5000 ms deadline. Local success does not prove platform acceptance.

Keep evidence in `harness/reference/kernel-upgrade-2026-09-12.md`. This is a
test-only repair, not a production SQLite, upstream kernel or signing change.
