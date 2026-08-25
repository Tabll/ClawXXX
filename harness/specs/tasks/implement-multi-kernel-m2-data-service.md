---
id: implement-multi-kernel-m2-data-service
title: Implement Unified ClawX DataService
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Make a versioned utility-process DataService and Blob Store the sole durable owner for multi-kernel conversations, channels, cron, usage, configuration and operations.
touchedAreas:
  - TODO.md
  - electron/data/**
  - shared/conversations/**
  - shared/data/**
  - tests/contract/data/**
  - tests/contract/kernels/**
  - harness/reference/multi-kernel-runtime.md
expectedUserBehavior:
  - Durable history remains available when either runtime is stopped or uninstalled.
  - Admission fails before dispatch when storage cannot commit.
requiredProfiles: [fast, comms]
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - unified-conversation-storage
  - multi-kernel-isolation-and-routing
  - attachment-access-safety
requiredTests:
  - pnpm exec vitest run tests/contract/data tests/contract/kernels/data-service-spike.test.ts
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - Only the DataService owner opens SQLite and Blob Store roots.
  - Concurrent writes, recovery, backup, corruption, disk-full and access boundaries fail closed.
  - Private and secret data cannot leak through context, FTS, backup or blobs.
docs:
  required: true
---

## Scope

M2 durable storage and recovery implementation.
