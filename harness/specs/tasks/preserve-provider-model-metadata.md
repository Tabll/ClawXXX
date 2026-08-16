---
id: preserve-provider-model-metadata
title: Preserve explicit provider model capabilities during runtime sync
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent provider lifecycle flows from deleting model metadata, expose reasoning/image-input ownership in Models, and preserve v0.5.4 context-window inference and config delivery.
touchedAreas:
  - harness/specs/tasks/preserve-provider-model-metadata.md
  - harness/specs/rules/provider-model-metadata-preservation.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - electron/main/provider-model-sync.ts
  - electron/services/providers-api.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/provider-service.ts
  - electron/services/providers/provider-store.ts
  - electron/shared/pi-ai-model-cost.ts
  - electron/shared/providers/model-capabilities.ts
  - electron/shared/providers/types.ts
  - electron/utils/openclaw-auth.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/*/settings.json
  - src/components/settings/ProvidersSettings.tsx
  - src/lib/provider-accounts.ts
  - src/lib/providers.ts
  - src/stores/providers.ts
  - tests/e2e/provider-lifecycle.spec.ts
  - tests/unit/provider-model-capabilities.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/provider-model-sync.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/provider-service-stale-cleanup.test.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Switching away from and back to a custom provider keeps manually configured model input capabilities and other model-level metadata.
  - Models > Edit Provider exposes localized switches for thinking and image-input support.
  - Saving the switches updates provider accounts, OpenClaw provider model rows, and matching per-agent model rows.
  - Changing a custom provider to a known vision model such as Claude or Gemini writes image-capable input metadata without copying metadata from the previous model ID.
  - Changing to an unknown model creates a conservative text-only model row instead of silently claiming image support.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - active-config-guards
  - backend-communication-boundary
  - provider-model-metadata-preservation
  - renderer-main-boundary
requiredTests:
  - tests/unit/provider-model-capabilities.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/provider-model-sync.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/e2e/provider-lifecycle.spec.ts
acceptance:
  - Explicit provider synchronization merges existing models.providers model rows by exact model ID and preserves all fields on existing rows.
  - Explicit reasoning/image choices override automatic inference only for the configured model ID.
  - Per-agent model synchronization carries the same explicit capability fields.
  - Capability labels have en, zh, ja, and ru translations.
  - Newly created runtime model rows receive input metadata matching OpenClaw custom-provider onboarding inference.
  - Metadata from one model ID is never copied to a different model ID.
  - Renderer transport boundaries remain unchanged.
  - Focused tests, harness validation, communication replay, and communication compare pass.
docs:
  required: true
---

## Background

ClawX explicit-provider sync paths rebuild model rows from the currently selected
model ID. Before this task, those paths replaced rich rows such as
`{ id, name, input, reasoning, contextWindow, maxTokens, cost }` with
`{ id, name }`. OpenClaw then treated previously image-capable custom models as
text-only.

## Scope

- Preserve existing explicit provider model rows during save, update, and
  default-provider switch.
- Mirror OpenClaw onboarding's custom-model image-input inference for new model
  IDs.
- Persist explicit reasoning and image-input controls through account, runtime,
  and per-agent model synchronization.
- Add regression tests and translated documentation.

## Out Of Scope

- Copying capability metadata between different model IDs.
