---
id: implement-multi-kernel-m8-dsh-bridges
title: Implement DeepSeek Harness Runtime Bridges
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Ship one long-lived DSH runtime host with rich ACP, control and ClawX-only persistence bridges.
touchedAreas:
  - TODO.md
  - kernels/deepseek-harness/**
  - electron/kernels/deepseek-harness/**
  - scripts/kernel-runtime/runtime-artifact-smoke.mjs
  - .github/workflows/kernel-runtime-build.yml
  - harness/reference/multi-kernel-runtime.md
  - tests/**dsh**
expectedUserBehavior:
  - DeepSeek Harness uses the existing ClawX chat timeline, composer and control pages without a separate Web UI.
requiredProfiles: [fast, comms]
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/deepseek-harness-driver.test.ts
  - pnpm exec vitest run tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run typecheck:node
acceptance:
  - Rich ordered events, permissions, attachments, cancellation, resume and configuration pass.
  - stdout is protocol-only and runtime home contains no durable transcript.
  - Windows workspace-write rejects ambient TEMP through both the ACL-confined shell and model-facing file tool; only the shell receives an ephemeral private temp capability.
docs:
  required: true
---

## Scope

M8 DSH runtime host and protocol bridges.
