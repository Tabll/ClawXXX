---
id: fix-windows-gateway-startup-probe
title: Repair Windows real Gateway startup verification
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Diagnose the OpenClaw Windows startup timeout in build 34044309931, implement an evidence-backed repair with bounded regression coverage, then commit, push and rebuild both kernels on all targets.
touchedAreas:
  - scripts/kernel-runtime/**
  - patches/openclaw@2026.9.2.patch
  - kernels/openclaw/**
  - pnpm-lock.yaml
  - tests/unit/kernel-*.test.ts
  - tests/unit/openclaw-*.test.ts
  - tests/fixtures/kernels/**
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-windows-gateway-startup-probe.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/**
  - README*.md
  - TODO.md
expectedUserBehavior:
  - The actual Windows OpenClaw Gateway reaches readiness before ACP, storage and all Channel checks run.
  - Startup failures remain fatal and have bounded, actionable diagnostics; no mocked readiness or skipped contract is accepted.
  - Shared canonical SQLite history, Channel admission, tool approvals and crash recovery remain mandatory.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-build.test.ts tests/unit/openclaw-plugin-registry.test.ts tests/unit/openclaw-probe-lifecycle.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Diagnose the actual cold-start timeout, distinguishing a slow startup from a deadlock or module failure with real process evidence.
  - Add focused tests for the repaired behavior without weakening isolation, registry freshness, storage fences or runtime integrity.
  - Windows path aliases must resolve to one physical plugin identity without granting trust by plugin ID alone; changed runtime bytes receive a new immutable revision with synchronized hashes.
  - Keep process, HTTP and filesystem cleanup bounded and limited to probe-owned resources.
  - Validate locally and report native Windows evidence separately from GitHub CI and clean-machine outcomes.
  - Commit and push the reviewed changes to Tabll/ClawXXX main and dispatch both kernels on all five platforms with explicit artifact-signature-only Windows mode.
  - No COS upload or production catalog promotion is part of this repair.
docs:
  required: true
---

Build 34044309931 at 65a87de9 passed nine of ten runtime builds and all three
Electron E2E jobs. The Windows plugin-registry regression passed, but the real
Gateway stopped at `starting...` until the probe's readiness deadline expired.
Do not equate this with recurrence of the previous stale-registry bug or assume
that increasing a timeout alone proves runtime correctness. Follow
`harness/reference/windows-runtime-ci-repair.md` and retain every existing real
Gateway/ACP/provider/Channel/storage assertion before sealing or installation.
