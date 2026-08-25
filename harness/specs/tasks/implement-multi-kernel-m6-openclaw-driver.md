---
id: implement-multi-kernel-m6-openclaw-driver
title: Extract Optional OpenClaw Runtime and Driver
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Remove OpenClaw from the base installer and wrap all managed OpenClaw lifecycle, chat and control behavior behind OpenClawKernelDriver and unified repositories.
touchedAreas:
  - TODO.md
  - electron/kernels/openclaw/**
  - electron/gateway/**
  - electron/services/**
  - scripts/**
  - electron-builder.yml
  - package.json
  - tests/**openclaw**
expectedUserBehavior:
  - ClawX has no OpenClaw side effects until the optional runtime is installed and started.
requiredProfiles: [fast, comms]
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - kernel-runtime-distribution
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/openclaw-conversation-store.test.ts tests/contract/kernels/openclaw-driver.test.ts tests/contract/kernels/openclaw-runtime-dir.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run typecheck
acceptance:
  - Base package contains no OpenClaw runtime payload.
  - Managed OpenClaw writes new conversation, cron and usage history only through ClawX repositories.
docs:
  required: true
---

## Scope

M6 OpenClaw optional-runtime cutover.
