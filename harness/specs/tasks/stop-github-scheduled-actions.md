---
id: stop-github-scheduled-actions
title: Stop all scheduled GitHub Actions
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Remove every time-based GitHub workflow trigger and cancel outstanding scheduled runs at the user's request.
touchedAreas:
  - .github/workflows/kernel-runtime-promote.yml
  - tests/unit/kernel-release-gate.test.ts
  - harness/**
  - docs/**
  - README*.md
expectedUserBehavior:
  - GitHub does not create workflow runs on a timer.
  - Kernel maintenance can be requested manually through the existing protected workflow.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-release-gate.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - No workflow in the repository declares a schedule trigger.
  - All unfinished runs whose GitHub event is schedule are cancelled.
  - Manual dispatch, build-completion triggers and existing production release checks retain their behavior.
  - Current documentation describes manually requested maintenance and does not promise daily execution.
docs:
  required: true
---

User instruction on 2026-10-15: stop all scheduled GitHub Actions.
Live main has one schedule in `kernel-runtime-promote.yml`, with outstanding
runs `35684375457` (waiting for production approval) and `38508049714`
(pending in the production concurrency queue). Cancel only scheduled runs.
See `harness/reference/github-only-kernel-distribution.md` and
`harness/reference/kernel-automatic-release.md` for retained publication and
manual maintenance protections.
