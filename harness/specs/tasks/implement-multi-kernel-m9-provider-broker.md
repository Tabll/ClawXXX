---
id: implement-multi-kernel-m9-provider-broker
title: Implement Canonical Providers and Credential Broker
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Project canonical provider accounts to each kernel and authorize short-lived credentials by process identity, account and purpose.
touchedAreas:
  - TODO.md
  - electron/services/providers/**
  - electron/security/**
  - electron/kernels/**credential**
  - shared/domains/providers.ts
  - src/pages/Models/**
  - tests/**provider**
expectedUserBehavior:
  - One provider account can be projected independently to both kernels with clear partial failure.
requiredProfiles: [fast, comms]
requiredRules:
  - provider-default-invariant
  - provider-model-selection-authority
  - provider-model-metadata-preservation
  - backend-communication-boundary
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/contract/providers tests/unit/credential-broker.test.ts
  - pnpm run typecheck
acceptance:
  - Secrets never enter Renderer, SQLite, logs, command lines or runtime manifests.
  - Projection failure in one kernel does not disable the other.
docs:
  required: true
---

## Scope

M9 provider and secret-delivery unification.
