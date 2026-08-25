---
id: implement-multi-kernel-m15-ui-e2e
title: Implement Multi-Kernel UI and E2E
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Expose optional installation, independent status, unified history, provenance and per-turn kernel selection with complete i18n, tokens, E2E and performance coverage.
touchedAreas:
  - TODO.md
  - src/**
  - shared/i18n/**
  - tests/e2e/**
  - electron/services/**
expectedUserBehavior:
  - Users can install either kernel, run both, switch the next turn kernel and browse history with no runtime installed.
requiredProfiles: [fast, comms]
requiredRules:
  - renderer-main-boundary
  - api-client-transport-policy
  - ui-i18n-design-tokens
  - electron-rendering-performance
  - comms-regression
requiredTests:
  - pnpm run test:e2e
  - pnpm run perf:chat
  - pnpm run typecheck
acceptance:
  - Renderer contains no kernel-specific backend branches or direct transport decisions.
  - Every visible flow has en, zh, ja, ru strings and Electron E2E coverage.
docs:
  required: true
---

## Scope

M15 renderer, setup and complete user-flow validation.
