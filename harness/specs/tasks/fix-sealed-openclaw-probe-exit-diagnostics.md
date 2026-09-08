---
id: fix-sealed-openclaw-probe-exit-diagnostics
title: Diagnose the sealed Windows OpenClaw probe termination
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Explain and repair job 101941620174's sealed-probe failure without hiding errors or weakening the complete multi-kernel CI gates.
touchedAreas:
  - scripts/kernel-runtime/runtime-artifact-smoke.mjs
  - scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs
  - scripts/kernel-runtime/lib/openclaw-probe-*.mjs
  - tests/unit/openclaw-probe-lifecycle.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - tests/fixtures/kernels/**
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-sealed-openclaw-probe-exit-diagnostics.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Every sealed real runtime passes real Gateway, ACP, all Channels and no-native-history checks before production installation and shared UI acceptance.
  - Process failures retain actionable bounded diagnostics, never success-shaped evidence.
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
  - Preserve run 34186582673 evidence; Windows dual-runtime completed in 287847 ms, while the single failed in the earlier sealed Gateway/ACP probe, not extraction or installation.
  - Record exit code, signal and fully drained bounded output; distinguish exit from stdio close and preserve finite shutdown limits.
  - Add native Windows reproduction and deterministic regressions for each justified repair; distinguish missing evidence from a known root cause.
  - Do not ignore module warnings as a failure cause or treat an unknown native termination as harmless without evidence.
  - Preserve original runtime, probe, single and dual deadlines; no whole-test retries, skipped gates, relaxed security or dependency upgrades.
  - Keep all payload bytes, pins, signatures, storage fences, native tool and seven-Channel assertions intact unless separately diagnosed code requires a reviewed revision.
  - Persist sanitized phase/failure evidence even when a child terminates before producing its final JSON report.
  - Commit and push verified repairs and continue complete normally approved both-kernel/five-platform staging and same-code E2E until green.
  - Keep MK-1940 pending until complete acceptance; no COS/catalog or production changes.
docs:
  required: true
---

The parent smoke process reports only a MODULE_TYPELESS_PACKAGE_JSON warning
from the failed child. It currently waits for exit rather than stream close,
omits the exit code and signal, and does not persist the nested probe report.
This is insufficient to determine whether the child asserted, suffered native
termination or lost late diagnostic output. Diagnose before assigning a cause.
