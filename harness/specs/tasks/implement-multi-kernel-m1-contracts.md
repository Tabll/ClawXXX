---
id: implement-multi-kernel-m1-contracts
title: Implement Multi-Kernel Canonical Contracts
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Define kernel-independent identities, domain contracts, execution envelopes, store protocol, extension capability boundaries, fake drivers, and replay/cutover tests.
touchedAreas:
  - TODO.md
  - shared/domains/**
  - shared/kernels/**
  - shared/conversations/**
  - shared/extensions/**
  - shared/host-api/**
  - electron/extensions/**
  - tests/contract/kernels/**
  - tests/fixtures/kernels/**
  - harness/specs/tasks/implement-multi-kernel-m*.md
expectedUserBehavior:
  - Conversation identity remains stable when a later turn selects another installed kernel.
  - Agents, providers, skills, channels, cron and usage expose canonical shapes with kernel provenance.
requiredProfiles: [fast, comms]
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - comms-regression
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/kernel-driver-contract.test.ts tests/contract/kernels/protocol-replay-fixture.test.ts tests/contract/kernels/history-cutover.test.ts
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - Both fake drivers pass the identical lifecycle, execution, persistence and canonical-domain suite.
  - Every execution write and event carries conversation, turn, run, kernel and generation identity.
  - Native durable history fallback is absent and direct fake native persistence fails.
docs:
  required: true
---

## Scope

M1 contract and test skeleton only; production storage, packaging and UI are implemented by later milestone specs.
