---
id: acp-session-controls-v0.5.4-migration
title: Migrate session model, reasoning, context, and follow-up controls to ACP
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Restore the local chat controls on the v0.5.4 ACP timeline without reintroducing renderer-owned transport switching or a second conversation authority.
touchedAreas:
  - harness/specs/tasks/acp-session-controls-v0.5.4-migration.md
  - shared/acp-chat/types.ts
  - shared/acp-chat/contract-assertions.ts
  - shared/chat/types.ts
  - shared/host-api/contract.ts
  - electron/services/chat-api.ts
  - electron/services/acp-chat-service.ts
  - electron/services/sessions-api.ts
  - src/lib/host-api.ts
  - src/lib/acp/assistant-metadata.ts
  - src/lib/acp/reducer.ts
  - src/lib/acp/timeline-types.ts
  - src/lib/acp/transcript-supplement.ts
  - src/stores/chat.ts
  - src/stores/acp-chat-session.ts
  - src/components/settings/ProvidersSettings.tsx
  - src/pages/Chat/AcpAssistantTurn.tsx
  - src/pages/Chat/AcpMessageSegment.tsx
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatInput.tsx
  - shared/i18n/locales/*/chat.json
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/acp-host-contract.test.ts
  - tests/unit/acp-assistant-metadata.test.tsx
  - tests/unit/acp-chat-components.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/i18n-locale-parity.test.ts
  - tests/e2e/chat-model-picker.spec.ts
  - tests/e2e/chat-acp-session-controls.spec.ts
  - tests/e2e/chat-new-session-date.spec.ts
  - tests/e2e/embedding-settings.spec.ts
  - tests/e2e/provider-lifecycle.spec.ts
expectedUserBehavior:
  - When the ACP agent advertises a model or thought-level session option, the composer shows its current value and updates only the active ACP session.
  - Agents without ACP session configuration options retain the upstream agent-model picker as a compatibility fallback.
  - Fresh ACP usage updates show used and total context near the composer, and manual compaction is sent as the existing ACP `/compact` command.
  - Follow-up messages entered during an active run are kept in a visible bounded local queue and sent sequentially through ACP after the active prompt finishes.
  - Cancelling the active prompt does not bypass ACP or silently dispatch a queued prompt.
  - Hovering a replayed assistant turn shows bounded transcript-supplemented timestamp, model/provider, and token usage without replacing the ACP timeline.
  - Cold-start heartbeat replacement waits for session discovery instead of prematurely creating the default main session.
  - Existing embedding and provider model-capability settings remain saveable after the migration.
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
  - comms-regression
  - docs-sync
requiredTests:
  - NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run tests/unit/acp-assistant-metadata.test.tsx tests/unit/acp-chat-components.test.tsx tests/unit/acp-chat-service.test.ts tests/unit/acp-chat-store.test.ts tests/unit/chat-acp-page.test.tsx tests/unit/chat-input.test.tsx tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/i18n-locale-parity.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-model-picker.spec.ts tests/e2e/chat-acp-session-controls.spec.ts tests/e2e/chat-new-session-date.spec.ts tests/e2e/embedding-settings.spec.ts tests/e2e/provider-lifecycle.spec.ts --project=parallel --no-deps
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/acp-session-controls-v0.5.4-migration.md
  - pnpm harness run --spec harness/specs/tasks/acp-session-controls-v0.5.4-migration.md
acceptance:
  - Renderer code uses src/lib/host-api.ts and never calls ACP, Gateway HTTP, or Electron IPC directly.
  - Main verifies the active loaded ACP session and delegates configuration changes through session/set_config_option.
  - Returned ACP configOptions replace the renderer projection atomically; a failed change preserves the previous value.
  - Session-native model changes do not mutate the agent's persisted default or override model.
  - Context usage comes only from ACP usage_update metadata and is hidden until valid used and size values exist.
  - Manual compaction and queued follow-ups use the existing ACP prompt path and cannot overlap an active ACP prompt.
  - The queue is scoped to the selected session, capped at five entries, removable, and never automatically drained after an explicit cancel.
  - Transcript reads add hover-only metadata to matched ACP assistant turns and never append or replace visible conversation history.
  - Default-session ACP creation waits for a canonical catalog publication for the current Gateway generation, and existing settings save buttons account for their migrated fields.
  - All new labels and accessible names have matching English, Chinese, Japanese, and Russian translations.
docs:
  required: true
---

This migration keeps the v0.5.4 ACP connection, prompt lifecycle, and ordered
timeline authoritative. Legacy Gateway `sessions.patch`, `sessions.compact`, and
concurrent `chat.send` steering are intentionally not restored.
