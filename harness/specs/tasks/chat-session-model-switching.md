---
id: chat-session-model-switching
title: Switch the active chat session model from the composer
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Mirror the OpenClaw WebUI model switcher in ClawX by listing configured runtime models through Gateway and patching only the active chat session model override.
touchedAreas:
  - harness/specs/tasks/chat-session-model-switching.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - shared/chat/types.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/pages/Chat/ChatInput.tsx
  - src/stores/chat.ts
  - src/stores/chat/session-actions.ts
  - tests/e2e/chat-model-picker.spec.ts
expectedUserBehavior:
  - The chat composer model picker shows configured runtime models for the active chat.
  - Choosing a model updates the active session via sessions.patch without changing the agent's saved model override.
  - The default option clears the session model override and falls back to the session default model.
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
  - pnpm run test:e2e -- tests/e2e/chat-model-picker.spec.ts
acceptance:
  - Renderer does not add direct ipcRenderer calls outside host-api/api-client.
  - Renderer does not fetch Gateway HTTP directly.
  - Model catalog loading uses models.list with view=configured through hostApi.gateway.rpc.
  - Model switching uses sessions.patch with the active session key and current agent id.
  - Agent-level updateModel is not called when switching the active chat model.
  - New user-visible labels are localized in every supported chat locale.
docs:
  required: false
---
