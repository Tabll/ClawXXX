---
id: fix-electron-kernel-node-launch
title: Launch managed kernels with standalone Node and verify warm Electron startup
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the Electron Helper SQLite-worker crash without deleting existing state or weakening runtime trust.
touchedAreas:
  - electron/gateway/**
  - electron/kernels/**
  - electron/main/index.ts
  - electron/utils/openclaw-*.ts
  - electron/utils/control-ui-device-pairing.ts
  - scripts/kernel-runtime/**
  - resources/kernels/trust/**
  - tests/unit/**
  - tests/contract/kernels/**
  - tests/e2e/**
  - tests/fixtures/kernels/stdio-runtime.mjs
  - package.json
  - .gitignore
  - .github/workflows/electron-e2e.yml
  - harness/specs/tasks/fix-electron-kernel-node-launch.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/electron-kernel-node-launch.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - TODO.md
expectedUserBehavior:
  - pnpm dev starts the real OpenClaw Gateway and its SQLite workers with the pinned standalone Node runtime, including with an existing native state database.
  - Installed kernels continue to use their own verified Node executable; development never falls back to Electron or an arbitrary PATH node.
  - Production catalogs are verified using the previously accepted public trust roots without exposing or regenerating private keys.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - e2e-parallel-isolation
  - docs-sync
requiredTests:
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run test:e2e
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Gateway, ACP, CLI and Doctor select an explicit standalone Node executable and sanitize Electron-only execution variables; Node grandchildren inherit the same runtime identity.
  - Both development kernel resolvers require a real Node executable; packaged resolvers never fall back to development files or the system Node.
  - Development preparation downloads only the repository-pinned official Node archive, verifies its SHA-256 and identity, and reuses a validated local cache.
  - A mandatory macOS, Linux and Windows regression launches actual Electron plus the real patched OpenClaw through the production launcher, starts with an existing SQLite database, verifies readiness and a successful restart, and checks database preservation and process cleanup.
  - Tests isolate state, ports, provider credentials and subprocesses; no production database reset, real provider request or native conversation-history fallback.
  - Restore only previously authenticated public trust roots, verify the live signed production catalog, and retain all signature, expiry and rollback checks.
  - Do not change upstream kernel versions, published artifacts, private secrets, COS objects or GitHub workflows remotely; no commit or push is requested.
docs:
  required: true
---

Incident on 2026-09-11: Electron 43.4.0 utilityProcess runs the local
OpenClaw 2026.9.2 development dependency. Its SQLite readonly worker executes
process.execPath, which is Electron Helper rather than standalone Node. Twelve
failed starts across four supervisor generations terminate in crash-loop.
The native SQLite database passes a read-only quick_check. Production trust
roots are separately absent from the local resources directory.

See `harness/reference/electron-kernel-node-launch.md` for the repaired launch
contract and actual validation evidence. Preserve the canonical DataService
authority and all gateway-backend-communication boundaries.
