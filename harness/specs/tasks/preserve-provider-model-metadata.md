---
id: preserve-provider-model-metadata
title: Preserve explicit provider model capabilities during runtime sync
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent ClawX provider save, update, and default-switch flows from deleting user-authored models.providers model metadata, expose reasoning/image-input capability controls in Settings > Models, and give newly selected custom-provider models the same image-input inference used by OpenClaw onboarding.
touchedAreas:
  - docs/superpowers/specs/2026-06-09-provider-model-metadata-preservation-design.md
  - docs/superpowers/plans/2026-06-09-provider-model-metadata-preservation.md
  - harness/specs/tasks/preserve-provider-model-metadata.md
  - harness/specs/rules/provider-model-metadata-preservation.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - electron/shared/providers/model-capabilities.ts
  - electron/shared/providers/types.ts
  - electron/shared/pi-ai-model-cost.ts
  - electron/services/providers/provider-service.ts
  - electron/services/providers/provider-store.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/utils/openclaw-auth.ts
  - src/components/settings/ProvidersSettings.tsx
  - src/lib/provider-accounts.ts
  - src/lib/providers.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/en/settings.json
  - shared/i18n/locales/zh/settings.json
  - shared/i18n/locales/ja/settings.json
  - shared/i18n/locales/ru/settings.json
  - tests/e2e/provider-lifecycle.spec.ts
  - tests/unit/provider-model-capabilities.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/provider-model-sync.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Switching away from and back to a custom provider keeps manually configured model input capabilities and other model-level metadata.
  - Settings > Models > Edit Provider shows switches for whether the configured chat model supports thinking and image input.
  - Saving those switches updates the provider account, OpenClaw `models.providers.*.models[]` rows, and per-agent `models.json` rows so chat model catalogs expose the chosen capabilities.
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
  - User-configured reasoning and image-input flags take precedence over automatic image-input inference for the configured model.
  - Agent `models.json` sync writes the same configured model capabilities for matching provider/model pairs.
  - Settings UI capability labels are localized for en, zh, ja, and ru.
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
- Add regression tests and translated documentation.

## Out Of Scope

- Copying capability metadata between different model IDs.
