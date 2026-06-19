---
id: chat-context-compaction-control
title: Show chat context usage and trigger manual compaction from the composer
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Surface OpenClaw session context-window usage beside the chat send button and let users trigger the existing sessions.compact Gateway RPC without bypassing the Main-owned host API boundary.
touchedAreas:
  - harness/specs/tasks/chat-context-compaction-control.md
  - shared/chat/types.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/index.tsx
  - src/stores/chat.ts
  - src/stores/chat/internal.ts
  - src/stores/chat/session-actions.ts
  - tests/e2e/chat-context-compaction.spec.ts
expectedUserBehavior:
  - When sessions.list includes fresh totalTokens and contextTokens/defaults.contextTokens, the chat composer shows a context-usage ring immediately left of Send.
  - Hovering the ring opens a detail card with the usage ratio, used tokens, context window, and a compact-context action.
  - Clicking compact context calls sessions.compact through hostApi.gateway.rpc, shows a compacting status while pending, and shows a compacted status when Gateway returns compacted=true.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - gateway-readiness-policy
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
requiredTests:
  - pnpm run typecheck
  - pnpm run test:e2e -- tests/e2e/chat-context-compaction.spec.ts
acceptance:
  - Renderer does not add direct IPC calls outside host-api/api-client.
  - Renderer does not fetch Gateway HTTP directly.
  - The UI uses localized text for all new user-visible labels.
  - Compaction result parsing uses sessions.compact fields compacted, reason, result.tokensBefore, and result.tokensAfter.
docs:
  required: false
---
