---
id: design-unified-conversation-storage
title: Design Unified Multi-Kernel Conversation Storage
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Replace per-kernel durable history with one DataService-owned local SQLite authority shared by current and future kernels, including conversations, cron, channels, and usage, without migrating legacy history.
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
  - Future OpenClaw, DeepSeek Harness, and additional kernels read and write one canonical Conversation history through ClawX APIs.
  - One conversation may use different kernels on different turns while retaining one ordered history and per-run kernel provenance.
  - Cron jobs, admissions, runs, channel messages, delivery attempts, and usage share the same SQLite authority and conversation/run identities.
  - Uninstalled or stopped kernels do not prevent offline history browsing, and legacy runtime history is neither imported nor used as fallback.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - comms-regression
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/design-unified-conversation-storage.md --since HEAD
  - pnpm exec vitest run tests/unit/harness-specs.test.ts tests/unit/harness-git.test.ts
  - git diff --check
acceptance:
  - The feasibility analysis identifies OpenClaw JSONL coupling, DSH persistence requirements, single-database failure modes, and strict Go/No-Go spikes.
  - ClawXDataService is the only SQLite owner and all kernels use authenticated versioned context/event RPC rather than direct SQL.
  - The schema and write protocol cover conversations, turns, content blocks, runs, events, tools, permissions, usage, channel messages, cron admissions/runs, runtime checkpoints, and blob references.
  - Prompt admission precedes dispatch, streaming is durably batched, terminal state commits atomically, and persistence failure is fail-closed.
  - Conversation identity is kernel-independent, each run has immutable kernel provenance, and cross-kernel context excludes private or unsafe state.
  - Managed runtimes cannot retain a second durable history, while attachments and large artifacts use a referenced content-addressed blob store.
  - Legacy conversation and cron history is explicitly not migrated, scanned, deleted, or used as fallback.
  - TODO milestones and release gates include storage adapters, concurrency, backup/recovery, no-native-history scans, cross-kernel continuation, and future-kernel eligibility.
  - This task changes only design, reference, scenario, rule, and task-spec documentation.
docs:
  required: true
---

## Scope

Define the single-authority SQLite architecture, context portability model, persistence protocol, failure behavior, kernel adapter requirements, and implementation checklist for unified multi-kernel history.

## Out of Scope

- Production implementation or schema migration code.
- Importing legacy OpenClaw or DeepSeek Harness conversations, cron jobs, run history, or usage.
- Deleting legacy runtime files.
- Promising bit-identical transfer of private runtime state or hidden reasoning across kernels.
