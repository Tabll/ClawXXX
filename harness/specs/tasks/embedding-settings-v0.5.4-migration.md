---
id: embedding-settings-v0.5.4-migration
title: Port advanced embedding settings onto the v0.5.4 Models page
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Preserve ClawX's advanced OpenClaw memory-search and embedding configuration while adopting the v0.5.4 Models, host API, and transactional config-delivery architecture.
touchedAreas:
  - harness/specs/tasks/embedding-settings-v0.5.4-migration.md
  - electron/main/ipc-handlers.ts
  - electron/services/embeddings-api.ts
  - electron/utils/openclaw-embeddings.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/*/dashboard.json
  - src/components/settings/EmbeddingSettings.tsx
  - src/lib/embeddings.ts
  - src/lib/host-api.ts
  - src/pages/Models/index.tsx
  - tests/unit/openclaw-embeddings.test.ts
  - tests/e2e/embedding-settings.spec.ts
expectedUserBehavior:
  - The Models page contains provider configuration and a separate advanced embedding configuration section.
  - Users can configure OpenAI-compatible, local, and advanced memory-search fields without exposing a previously saved API key.
  - Saving or clearing embedding settings updates agents.defaults.memorySearch while preserving unrelated OpenClaw configuration.
  - A running Gateway receives configuration through the v0.5.4 transactional config-delivery coordinator.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - openclaw-config-delivery
  - ui-i18n-design-tokens
requiredTests:
  - tests/unit/openclaw-embeddings.test.ts
  - tests/e2e/embedding-settings.spec.ts
acceptance:
  - Renderer calls typed hostApi embedding methods and does not invoke Electron IPC or Gateway HTTP directly.
  - Main-process embedding writes use mutateOpenClawConfig and preserve unknown sibling fields.
  - API keys are represented only by configured status after persistence and are never echoed to the renderer.
  - Unit tests cover default reads, advanced-field persistence, unknown-field preservation, and clearing.
  - E2E covers the v0.5.4 Models route, compatible endpoint saving, and advanced memory-search controls.
docs:
  required: true
---

## Migration boundary

This task ports the embedding feature rather than the pre-v0.5.4 Settings page
structure. Provider and Gateway ownership remains with the upstream Models and
Main-process services. Embedding configuration is additive and uses the same
transactional configuration path as other v0.5.4 OpenClaw settings.
