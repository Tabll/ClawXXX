---
id: fix-installed-kernel-activation
title: Resolve installed kernels in development and synchronize launch registration
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair DeepSeek Harness installation-to-launch handoff without replacing live generations or modifying user data.
touchedAreas:
  - electron/kernels/**
  - electron/main/index.ts
  - shared/kernels/contracts.ts
  - src/stores/kernels.ts
  - src/components/settings/KernelSettings.tsx
  - shared/i18n/locales/**/settings.json
  - tests/unit/**
  - tests/contract/kernels/supervisor-registry.test.ts
  - harness/specs/tasks/fix-installed-kernel-activation.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/installed-kernel-activation.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - TODO.md
  - .github/workflows/electron-e2e.yml
  - .gitignore
  - package.json
  - scripts/kernel-runtime/import-local-trust.mjs
  - scripts/kernel-runtime/prepare-dev-node.mjs
  - tests/e2e/fixtures/kernel-node-electron.ts
  - tests/e2e/kernel-node-runtime.spec.ts
  - tests/fixtures/kernels/stdio-runtime.mjs
  - harness/reference/electron-kernel-node-launch.md
  - harness/reference/openclaw-agent-schema-ownership.md
  - harness/specs/tasks/fix-electron-kernel-node-launch.md
  - harness/specs/tasks/repair-openclaw-agent-schema-ownership.md
expectedUserBehavior:
  - Both development and packaged apps resolve an active installed runtime before any development fallback, using its verified Node and entrypoint.
  - Installing or repairing idle DeepSeek Harness makes it launchable in the same app session without restarting OpenClaw.
  - Installed, failed, and app-restart-required are distinct; Settings explains deferred activation and never calls an installed runtime uninstalled after a launch error.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - multi-kernel-isolation-and-routing
  - unified-conversation-storage
  - ui-i18n-design-tokens
  - docs-sync
requiredTests:
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - An invalid active installation fails closed; neither an environment override nor node_modules silently replaces it.
  - Launch registration shares the supervisor per-kernel lifecycle lock, clears stale errors after successful registration, and does not replace a running generation or another kernel.
  - DeepSeek Harness hot registration uses the active immutable artifact; OpenClaw ACP/Channel composition explicitly requires an app restart after activation.
  - Runtime restart requirements survive renderer refresh and are cleared by successful registration or uninstall, not by a sticky renderer flag.
  - Unit and real-child-process contract tests cover resolution, post-install registration, failure recovery, concurrency, and localized Settings behavior.
  - The user explicitly defers adding the corresponding Electron E2E in this task; preserve existing E2E files and do not claim new end-to-end coverage.
  - Do not reset databases, rewrite installed artifacts, change upstream versions, or commit/push/deploy remotely.
docs:
  required: true
---

See `harness/reference/installed-kernel-activation.md`. This also implements the
multi-kernel-runtime lifecycle contract. Keep gateway-backend-communication
Renderer/Main boundaries intact. Existing unrelated working-tree changes are
preserved and tested together, not part of this task's change scope.
