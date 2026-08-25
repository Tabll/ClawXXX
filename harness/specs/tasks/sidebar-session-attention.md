---
id: sidebar-session-attention
title: Show canonical Conversation sidebar attention
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Show active and unread-completion state from the unified SQLite Conversation catalog for every kernel.
touchedAreas:
  - harness/reference/sidebar-session-attention.md
  - harness/specs/tasks/sidebar-session-attention.md
  - harness/specs/rules/sidebar-session-attention-authority.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/scenarios/chat-workspace-and-navigation.md
  - tests/unit/harness-specs.test.ts
  - shared/host-events/contract.ts
  - electron/conversations/conversation-router.ts
  - electron/data/clawx-data-store.ts
  - electron/main/index.ts
  - src/App.tsx
  - src/stores/session-attention.ts
  - tests/unit/session-attention.test.ts
  - src/stores/chat.ts
  - src/components/layout/Sidebar.tsx
  - src/pages/Chat/index.tsx
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - tests/unit/host-events.test.ts
  - tests/contract/conversation-router.test.ts
  - tests/unit/chat-session-management.test.ts
  - tests/unit/chat-store-session-label-fetch.test.ts
  - tests/unit/sidebar-session-buckets.test.ts
  - tests/unit/i18n-locale-parity.test.ts
  - tests/e2e/chat-sidebar-session-attention.spec.ts
  - harness/reference/chat-workspace-and-navigation.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - A sidebar Conversation shows a loading indicator while its canonical SQLite run is active, regardless of kernel.
  - An observed completion outside the visible Chat session shows an unread indicator until the conversation is opened.
  - The visible Chat session remains read when its active run completes, while retaining a current session on another route does not mark it read.
  - App restart and persisted observed-busy state recover only transitions that ClawX can prove from canonical run rows.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - gateway-readiness-policy
  - ui-i18n-design-tokens
  - sidebar-session-attention-authority
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/harness-specs.test.ts tests/unit/session-attention.test.ts tests/unit/host-events.test.ts tests/unit/chat-session-management.test.ts tests/unit/sidebar-session-buckets.test.ts
  - pnpm exec vitest run tests/contract/conversation-router.test.ts tests/unit/i18n-locale-parity.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-sidebar-session-attention.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/sidebar-session-attention.md
  - pnpm harness run --spec harness/specs/tasks/sidebar-session-attention.md
acceptance:
  - Sidebar busy and completion state comes only from exact-ID SQLite Conversation rows and post-commit lifecycle events; runtime session metadata, ACP replay, and global Gateway events are never secondary authorities.
  - Unknown lifecycle IDs force a DataService catalog reload; runtime reconnects cannot replace newer canonical state.
  - Busy replaces the relative timestamp, unread completion replaces busy, and a read conversation restores the relative timestamp.
  - Unread clears only when the user opens the conversation or that conversation is visibly mounted in Chat; retaining its key on another route does not clear it.
  - Exact-key observed-busy and unread state persists across restart without inferring unread from updatedAt or an entirely unobserved offline run.
  - Cron runs use the same canonical Conversation and lifecycle projection as interactive runs.
docs:
  required: true
---

## Scope

The implementation uses the Main-owned ConversationRouter and DataService catalog. Renderer keeps only local presentation attention state.

The durable architecture, commit ordering, restart recovery, and concurrency semantics are documented in `harness/reference/sidebar-session-attention.md`.

## Out Of Scope

- Using runtime session/transcript APIs as a second catalog.
- Guessing unread completion from activity timestamps.
- Persisting per-kernel copies of Conversation attention.
