---
id: multi-kernel-runtime
title: Multi-Kernel Runtime
type: runtime-bridge
ownedPaths:
  - kernels/**
  - patches/openclaw@*.patch
  - patches/deepseek-harness@*.patch
  - scripts/kernel-runtime/**
  - electron/kernels/**
  - electron/data/**
  - electron/services/conversation-*.ts
  - electron/services/kernel-*.ts
  - electron/services/acp-*.ts
  - electron/main/ipc/**
  - shared/kernels/**
  - shared/conversations/**
  - shared/host-api/**
  - src/lib/host-api.ts
  - src/lib/api-client.ts
  - src/stores/**
  - src/pages/**
  - tests/contract/kernels/**
  - tests/e2e/kernel-*.spec.ts
  - electron-builder.yml
  - package.json
  - pnpm-lock.yaml
requiredProfiles:
  - fast
  - comms
conditionalProfiles:
  e2e:
    when:
      - optional kernel install, update, rollback, or uninstall behavior changes
      - visible kernel selection, status, capability, or error behavior changes
      - dual-runtime lifecycle, routing, channels, cron, agents, or skills behavior changes
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - comms-regression
  - kernel-runtime-distribution
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
  - ui-i18n-design-tokens
  - e2e-parallel-isolation
  - docs-sync
forbiddenPatterns:
  - window.electron.ipcRenderer.invoke in src/pages/**
  - window.electron.ipcRenderer.invoke in src/components/**
  - npm install in electron/kernels/**
  - pnpm install in electron/kernels/**
  - deepseek-harness-web in src/**
  - node:sqlite in electron/kernels/**
  - new DatabaseSync in electron/kernels/**
---

This scenario governs optional OpenClaw and DeepSeek Harness runtime packages, the Main-owned multi-kernel abstraction, kernel-scoped execution routing, a kernel-independent Conversation identity, the single SQLite Conversation Store, concurrent process lifecycle, canonical capability projections, and host-owned Channels/Cron orchestration.

The durable architecture and release gates are defined in `harness/reference/multi-kernel-runtime.md`. Work in this scenario must also use `gateway-backend-communication` when it changes Renderer/Main, Host API, ACP, Gateway, bridge, or runtime message paths.

Both runtimes must satisfy one canonical ClawX UI and storage contract. Upstream-specific models stay inside drivers and bridges. Runtime packages are immutable CI products downloaded on demand, not dependencies installed or patched on the end-user machine. Managed runtimes do not retain a second durable conversation, cron, channel-message, or usage history.

Builder portability includes checkout/system-temp volume separation, verified
same-volume staging and failure cleanup for both source and Node downloads.
Complete native Channel entrypoint imports use bounded isolated processes,
without weakening syntax/export assertions or the real packaged-runtime
probes. The CI checks and remaining release gates are documented under
`harness/reference/multi-kernel-runtime.md`.

Windows portability also covers deterministic plugin-registry diagnostics across
SQLite round trips, writable archive flush handles, LF-exact Git fixtures and
native driver path assertions. Keep actual metadata/policy changes fail-closed;
see `harness/reference/windows-runtime-ci-repair.md` for reproduction and gates.
Case/8.3/junction aliases must retain the same verified physical install owner,
without trusting a different package by ID. Full real-process startup probes
must retain bounded platform-specific readiness, failure traces, signal/exit
checks and exact-command approval plus execution evidence on Windows as well.

Skills are canonical immutable packages with per-kernel desired and projection state. OpenClaw and DeepSeek Harness roots must be physically independent: no shared root, nesting, root/package symlink, or cross-root resource reference is allowed. Both-target mutations report each result and retain partial state. DeepSeek Harness registers converted instructions through its process-local `ctx.skills` adapter while SQLite remains the sole metadata authority.
