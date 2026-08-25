---
id: implement-multi-kernel-m7-conversation-router
title: Implement Unified Conversation Router
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Admit, route, normalize, persist and display concurrent per-kernel runs against one canonical conversation history.
touchedAreas:
  - TODO.md
  - electron/conversations/**
  - electron/services/chat-api.ts
  - electron/data/**
  - shared/acp-chat/**
  - shared/conversations/**
  - src/stores/**
  - src/pages/Chat/**
  - tests/**chat**
expectedUserBehavior:
  - A conversation can switch kernels at a turn boundary without copying or clearing history.
  - Navigation does not cancel background streaming.
requiredProfiles: [fast, comms]
requiredRules:
  - acp-chat-state-and-history
  - backend-communication-boundary
  - comms-regression
  - unified-conversation-storage
  - multi-kernel-isolation-and-routing
requiredTests:
  - pnpm exec vitest run tests/contract/data tests/contract/kernels/conversation-router.test.ts tests/unit/acp-chat-store.test.ts tests/unit/conversation-history-projection.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run typecheck
acceptance:
  - Admission precedes dispatch and terminal state follows atomic terminal commit.
  - Interleaved events, permissions, cancellation and selection races remain run-scoped.
  - A linear Conversation has one active-run lease; comparisons use an explicit lineage branch.
  - DataService restart marks admitted/running work interrupted and never falls back to runtime history.
docs:
  required: true
---

## Scope

M7 canonical chat routing and history cutover.
