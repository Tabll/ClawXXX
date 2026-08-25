---
id: implement-multi-kernel-m14-usage-diagnostics
title: Implement Canonical Usage and Diagnostics
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Persist live per-request usage once and expose unified filters, diagnostics, logs and artifact provenance without transcript scans.
touchedAreas:
  - TODO.md
  - electron/services/usage-api.ts
  - electron/services/diagnostics-api.ts
  - electron/domains/usage/**
  - shared/domains/usage.ts
  - src/pages/Dashboard/**
  - tests/**usage**
expectedUserBehavior:
  - Dashboard can filter All, OpenClaw and DSH while preserving unknown values as unknown.
requiredProfiles: [fast, comms]
requiredRules:
  - diagnostics-trace-safety
  - backend-communication-boundary
  - comms-regression
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/domains/usage.test.ts
  - pnpm run typecheck
acceptance:
  - Usage reads only SQLite records and retries cannot double-charge.
  - Diagnostics identifies artifact, patch revision and process generation.
docs:
  required: true
---

## Scope

M14 usage, dashboard and diagnostics unification.
