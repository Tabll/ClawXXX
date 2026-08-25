---
id: implement-multi-kernel-m12-channels
title: Implement Channel Orchestrator and DSH Relay
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Own canonical channel accounts, leases, bindings, message identity, relay delivery and retries while adapting OpenClaw and DSH behind one UI.
touchedAreas:
  - TODO.md
  - electron/channels/**
  - electron/services/channels-api.ts
  - shared/domains/channels.ts
  - src/pages/Channels/**
  - tests/**channel**
expectedUserBehavior:
  - Channel accounts bind to a kernel and agent with identical status and delivery behavior.
requiredProfiles: [fast, comms]
requiredRules:
  - channel-plugin-migration-guards
  - backend-communication-boundary
  - comms-regression
  - unified-conversation-storage
requiredTests:
  - pnpm exec vitest run tests/contract/domains/channels.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run typecheck
acceptance:
  - One active owner exists per external account and duplicate messages cannot create duplicate turns.
  - Connectors keep no private message history.
docs:
  required: true
---

## Scope

M12 channel ownership, relay and delivery unification.
