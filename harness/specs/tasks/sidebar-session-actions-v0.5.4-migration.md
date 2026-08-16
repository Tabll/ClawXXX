---
id: sidebar-session-actions-v0.5.4-migration
title: Migrate sidebar conversation actions onto workspace groups
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Restore pinning, search, context actions, and batch deletion on the v0.5.4 workspace-grouped sidebar without replacing the upstream session catalog, attention, or workspace behavior.
touchedAreas:
  - harness/specs/tasks/sidebar-session-actions-v0.5.4-migration.md
  - electron/services/sessions-api.ts
  - shared/chat/types.ts
  - shared/host-api/contract.ts
  - src/lib/host-api.ts
  - src/stores/chat.ts
  - src/stores/chat/session-catalog.ts
  - src/components/layout/Sidebar.tsx
  - shared/i18n/locales/*/common.json
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - tests/unit/session-catalog.test.ts
  - tests/unit/chat-session-management.test.ts
  - tests/unit/chat-load-sessions-startup.test.ts
  - tests/unit/chat-store-session-label-fetch.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/sidebar-session-buckets.test.ts
  - tests/unit/i18n-locale-parity.test.ts
  - tests/e2e/sidebar-session-actions.spec.ts
expectedUserBehavior:
  - Right-clicking a conversation opens localized Pin or Unpin and Rename actions.
  - Pinning persists in the conversation's sessions.json metadata and moves the conversation above unpinned conversations inside its existing workspace group.
  - Search filters the already-loaded conversation catalog by title, agent, workspace, channel, or session key and opens the selected result.
  - Batch mode expands workspace groups, exposes selection controls, and uses the existing sequential multi-session deletion action with partial-failure feedback.
  - Existing workspace availability, rename, delete, load-more, busy, unread, relative-time, and current-session behavior remains intact.
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
  - pnpm exec vitest run tests/unit/session-catalog.test.ts tests/unit/chat-session-management.test.ts tests/unit/chat-load-sessions-startup.test.ts tests/unit/chat-store-session-label-fetch.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/sidebar-session-buckets.test.ts tests/unit/i18n-locale-parity.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/sidebar-session-actions.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/sidebar-session-actions-v0.5.4-migration.md
  - pnpm harness run --spec harness/specs/tasks/sidebar-session-actions-v0.5.4-migration.md
acceptance:
  - Renderer code uses src/lib/host-api.ts; no direct Renderer IPC or Gateway HTTP call is added.
  - Main validates the agent id and exact session entry before writing pin metadata.
  - Pin metadata supports array-shaped, object-keyed, and legacy string-valued sessions.json entries without discarding unrelated fields.
  - Gateway catalog refreshes and session events preserve local pin state until authoritative sessions.json metadata is rehydrated.
  - The existing renameSession and deleteSessions store actions remain the only Sidebar implementations for those mutations.
  - Pinning changes neither Gateway run authority nor busy and unread projection.
  - Search and batch controls coexist with upstream workspace grouping and do not remove workspace actions or pagination.
  - All added labels and accessible names have matching English, Chinese, Japanese, and Russian translations.
docs:
  required: true
---

This migration spec owns only the conversation-history actions layered on top of
the v0.5.4 workspace sidebar. OpenClaw Gateway remains authoritative for the
session catalog and run state; sessions.json is used only for ClawX pin metadata.
