---
id: implement-multi-kernel-m5-supervisors
title: Implement Concurrent Kernel Supervisors
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Own independent process trees, generations, health, logs, restart budgets and per-kernel auto-start policies in one supervisor registry.
touchedAreas:
  - TODO.md
  - electron/kernels/**
  - electron/main/**
  - electron/services/kernel*.ts
  - shared/host-api/**
  - tests/contract/kernels/supervisor*.test.ts
expectedUserBehavior:
  - Both kernels can be ready concurrently and failure of one does not interrupt the other.
requiredProfiles: [fast, comms]
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - host-events-fallback-policy
  - multi-kernel-isolation-and-routing
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/concurrent-runtime-spike.test.ts tests/contract/kernels/supervisor-registry.test.ts
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - PID, generation, status, logs and restart budget are kernel-scoped.
  - Bounded parallel app shutdown leaves no owned descendants.
docs:
  required: true
---

## Scope

M5 process supervision and Host API.
