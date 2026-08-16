---
id: upgrade-electron-43-4-0
title: Upgrade the desktop runtime to Electron 43.4.0
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Move ClawX from the unsupported Electron 40 line to the supported Electron 43.4.0 runtime without regressing desktop, ACP, Gateway, browser, preview, or packaging behavior.
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - electron-builder.yml
  - scripts/after-pack.cjs
  - scripts/bundle-openclaw.mjs
  - src/pages/Chat/AcpImagePart.tsx
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - docs/en-US/development.md
  - docs/zh-CN/development.md
  - docs/ja-JP/development.md
  - docs/ru-RU/development.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/tasks/upgrade-electron-43-4-0.md
  - tests/unit/electron-runtime-version.test.ts
  - tests/unit/openclaw-bundle-config.test.ts
  - tests/unit/openclaw-cli.test.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
expectedUserBehavior:
  - ClawX starts, renders, and shuts down normally on Electron 43.4.0.
  - New Chat creates an ACP session and sends its first prompt through the Electron-owned compatible Node runtime.
  - Gateway lifecycle, local HTML preview, embedded web content, PDF preview, clipboard actions, dialogs, updates, and native window chrome keep their existing behavior.
  - Generated-image copy and save controls retain a usable hit area for very small images and accept pointer input under Chromium 150.
  - Packaged macOS artifacts retain signing, entitlements, bundled OpenClaw resources, and launchable Electron helpers.
  - The documented `pnpm run init` setup downloads the Electron binary explicitly before development starts.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - acp-chat-state-and-history
  - backend-communication-boundary
  - packaged-runtime-pruning-guards
  - web-browser-security-and-lifecycle
  - e2e-parallel-isolation
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/electron-runtime-version.test.ts tests/unit/openclaw-cli.test.ts
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm run test:e2e
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run package:mac:local
acceptance:
  - `package.json` and `pnpm-lock.yaml` resolve Electron exactly to 43.4.0 with no unrelated dependency upgrades.
  - The installed Electron reports Electron 43.4.0 and its bundled Node 24.18.1, which satisfies the pinned OpenClaw runtime requirement.
  - Electron 41 PDF WebContents changes, Electron 42 notification and binary-download changes, and Electron 43 Linux window behavior are reviewed against ClawX-owned surfaces.
  - The Electron 42 on-demand installer is exposed as `pnpm run electron:download` and remains part of `pnpm run init`.
  - Development ACP continues to use Electron's pinned Node runtime instead of an arbitrary PATH Node.
  - Generated-image copy and save controls remain clickable in the Electron 43 renderer.
  - Full unit, type, lint, build, Electron E2E, communication regression, and macOS local packaging checks pass.
  - README badges and development runtime tables in all four locales state the Electron 43+ baseline.
docs:
  required: true
---

## Compatibility Scope

- Upgrade only the exact Electron dependency and lockfile resolution.
- Keep Electron Builder, Playwright, Vite, OpenClaw, and all application dependencies pinned at their current versions unless a demonstrated Electron 43 incompatibility requires a scoped change.
- Verify the Electron 42 on-demand binary installation behavior through the normal pnpm install and build flow.
- Keep ClawX's existing `pdfjs-dist` preview independent of Chromium's built-in PDF guest behavior.
- Keep Renderer clipboard access on `navigator.clipboard`; do not introduce direct Electron clipboard imports.
- Preserve the existing isolated `<webview>` policy, permission handlers, popup denial, download policy, and guest teardown.

## Packaging Scope

- Verify a local macOS package contains the Electron 43 framework, ClawX Helper executables, OpenClaw resources, and expected entitlements.
- Do not publish, notarize externally, or modify release channels as part of this task.
- Windows and Linux packaging remain covered structurally and by CI configuration; this macOS workspace must not fabricate cross-platform success without the corresponding runners.

## Out Of Scope

- Electron 44 prerelease adoption.
- Changing the minimum supported macOS, Windows, or Linux versions.
- Refactoring window chrome, notification UX, PDF rendering, or Web Browser features.
- Upgrading unrelated dependencies.
