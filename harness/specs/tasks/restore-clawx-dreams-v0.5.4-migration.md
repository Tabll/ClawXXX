---
id: restore-clawx-dreams-v0.5.4-migration
title: Restore the native ClawX Dreams experience on v0.5.4
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Reintroduce the developer-only native Dreams dashboard on the v0.5.4 baseline while preserving typed Host API transport ownership, current OpenClaw memory doctor contracts, and explicit confirmation for maintenance actions.
touchedAreas:
  - harness/specs/tasks/restore-clawx-dreams-v0.5.4-migration.md
  - src/pages/Dreams/**
  - src/App.tsx
  - src/components/layout/Sidebar.tsx
  - src/styles/globals.css
  - src/lib/host-api.ts
  - shared/host-api/contract.ts
  - electron/services/gateway-api.ts
  - electron/utils/openclaw-control-ui.ts
  - shared/i18n/resources.ts
  - shared/i18n/locales/*/common.json
  - shared/i18n/locales/*/dreams.json
  - tests/unit/dreams-page.test.tsx
  - tests/unit/openclaw-control-ui.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/i18n-locale-parity.test.ts
  - tests/e2e/openclaw-dreams.spec.ts
  - tests/e2e/developer-mode.spec.ts
  - tests/e2e/main-navigation.spec.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Dreams remains hidden from navigation and inaccessible by route until Developer Mode is enabled.
  - The native page waits for a ready Gateway, then shows the current OpenClaw dreaming status, phase schedules, signals, and parsed DREAMS.md diary entries.
  - Users can enable or disable dreaming and run supported memory maintenance actions; rewriting or clearing actions require explicit confirmation.
  - The full upstream OpenClaw Dreams view opens at /dreaming with the Gateway token kept in the URL fragment.
  - Existing Models, Image Generation, Chat, and generic OpenClaw Control UI navigation remain unchanged.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - gateway-readiness-policy
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run tests/unit/dreams-page.test.tsx tests/unit/openclaw-control-ui.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/i18n-locale-parity.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/openclaw-dreams.spec.ts tests/e2e/developer-mode.spec.ts tests/e2e/main-navigation.spec.ts --project=parallel --no-deps
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/restore-clawx-dreams-v0.5.4-migration.md
  - pnpm harness run --spec harness/specs/tasks/restore-clawx-dreams-v0.5.4-migration.md
acceptance:
  - Renderer Dreams code uses hostApi-backed Gateway RPC and shell methods, with no direct Gateway HTTP, WebSocket, fetch, or ipcRenderer calls.
  - Gateway controlUi accepts only the typed optional dreams view and maps it to /dreaming in Electron Main.
  - Read-only status and diary calls are startup-gated and refresh-coalesced; maintenance calls use current doctor.memory methods and bounded timeouts.
  - Config enable/disable uses config.get baseHash plus config.patch and does not replace unrelated memory-core configuration.
  - Dedupe, repair, diary reset, and replay reset actions cannot run without their confirmation dialog.
  - All page, navigation, status, action, error, and accessibility strings have matching English, Chinese, Japanese, and Russian translations.
  - The v0.5.4 ACP timeline, session catalog, provider settings, and Image Generation route are not reverted by the Dreams migration.
docs:
  required: true
---

This migration intentionally reverses the earlier ClawX UI removal recorded by
`remove-clawx-dreams.md`. OpenClaw 2026.7.1-2 still exposes the Dreams route and
memory doctor methods, so the native ClawX view can be restored without adding
a renderer-owned backend transport or altering existing Dreams data.
