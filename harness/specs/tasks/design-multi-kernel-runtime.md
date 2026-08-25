---
id: design-multi-kernel-runtime
title: Design Optional Multi-Kernel Runtime Architecture
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Define the complete target architecture and staged implementation plan for optional CI-built OpenClaw and DeepSeek Harness runtimes that share one ClawX UI and can run concurrently.
touchedAreas:
  - TODO.md
  - docs/zh-CN/multi-kernel-design.md
  - harness/reference/multi-kernel-runtime.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/rules/multi-kernel-isolation-and-routing.md
  - harness/specs/rules/kernel-capability-isomorphism.md
  - harness/specs/rules/unified-conversation-storage.md
  - harness/specs/tasks/design-multi-kernel-runtime.md
  - harness/specs/tasks/design-unified-conversation-storage.md
expectedUserBehavior:
  - No production runtime or UI behavior changes in this design-only task.
  - The design defines how OpenClaw will leave the base installer and become an on-demand verified download.
  - The design defines how DeepSeek Harness will become a second optional kernel without embedding its Web UI.
  - The design defines one UI and canonical contract for Chat, Channels, Cron, Agents, Skills, Providers, Conversations, Usage, and Diagnostics.
  - The design defines how both kernels can remain running and process work concurrently without identity or event cross-talk.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - comms-regression
  - kernel-runtime-distribution
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/design-multi-kernel-runtime.md --since HEAD
  - pnpm exec vitest run tests/unit/harness-specs.test.ts tests/unit/harness-git.test.ts
  - git diff --check
acceptance:
  - The architecture separates a kernel-scoped ACP Chat data plane from a Main-owned KernelDriver control plane.
  - OpenClaw and DeepSeek Harness use independently downloadable, signed, immutable CI artifacts with reviewed patches, atomic activation, and rollback.
  - One DataService-owned SQLite database is the sole durable Conversation, Cron, Channel-message, and Usage authority; native durable history is disabled.
  - Conversation identity is kernel-independent while every execution event is run/kernel-scoped, and the design covers concurrent process isolation and app-quit cleanup.
  - Channels and Cron have single ClawX host authority while both runtimes expose isomorphic user behavior through adapters.
  - Agents, Skills, Providers, Conversations, Usage, and Diagnostics have canonical contracts, projection rules, cutover constraints, and contract-test gates.
  - The TODO is milestone-ordered, identifies critical spikes and release gates, and does not claim implementation is complete.
  - The current task changes only design, reference, scenario, rule, and task-spec documentation.
docs:
  required: true
---

## Scope

Produce the target architecture, durable Harness invariants, risk gates, cutover order, validation strategy, and implementation checklist for optional multi-kernel ClawX.

## Out of Scope

- Production implementation of the package manager, drivers, bridge, scheduler, canonical store, Host API, or Renderer changes.
- Removing the currently bundled OpenClaw payload.
- Downloading or distributing runtime artifacts.
- Claiming upstream DeepSeek Harness ACP is already sufficient for interactive ClawX Chat.
