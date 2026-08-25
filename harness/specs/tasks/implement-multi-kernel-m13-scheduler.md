---
id: implement-multi-kernel-m13-scheduler
title: Implement Unified ClawX Scheduler
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Execute canonical cron schedules once through kernel-scoped turn admission, shared conversation history and channel delivery.
touchedAreas:
  - TODO.md
  - electron/scheduler/**
  - electron/services/cron-api.ts
  - shared/domains/cron.ts
  - src/pages/Cron/**
  - tests/**cron**
expectedUserBehavior:
  - OpenClaw and DSH scheduled jobs share one UI, run history and delivery contract.
requiredProfiles: [fast, comms]
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/domains/scheduler.test.ts
  - pnpm run typecheck
acceptance:
  - Due admission is unique by job and scheduled time and commits before dispatch.
  - Native schedulers and runtime run-history writes are disabled.
docs:
  required: true
---

## Scope

M13 canonical scheduler and Cron cutover.
