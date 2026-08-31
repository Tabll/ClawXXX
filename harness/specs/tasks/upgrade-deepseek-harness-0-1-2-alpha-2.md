---
id: upgrade-deepseek-harness-0-1-2-alpha-2
title: Upgrade DeepSeek Harness to 0.1.2-alpha.2
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Rebase the optional DeepSeek Harness runtime and every ClawX bridge patch onto the immutable dsh-v0.1.2-alpha.2 release without weakening canonical storage, capability isomorphism, sandboxing, or reproducible distribution.
touchedAreas:
  - THIRD_PARTY_NOTICES.md
  - kernels/deepseek-harness/**
  - scripts/kernel-runtime/**
  - tests/contract/kernels/**
  - tests/contract/domains/diagnostics.test.ts
  - tests/fixtures/kernels/**
  - tests/unit/credential-broker.test.ts
  - tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - tests/unit/kernel-source-manifests.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - docs/**
  - harness/reference/multi-kernel-runtime.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/tasks/upgrade-deepseek-harness-0-1-2-alpha-2.md
expectedUserBehavior:
  - DeepSeek Harness remains an optional, independently installable kernel and continues to share the complete ClawX UI and canonical SQLite data authority with OpenClaw.
  - Existing ClawX conversations, cron jobs, agents, skills, channels, provider selections, and usage rows are not migrated into or reconstructed from DeepSeek Harness native storage.
  - OpenClaw and DeepSeek Harness can remain ready and execute concurrently; upgrading DeepSeek Harness does not stop, replace, or mutate OpenClaw.
  - DeepSeek Harness continues to use the ClawX conversation, credential, agent, skill, channel, cron, usage, permission, cancellation, and rich-event bridges rather than its Web UI or native durable history.
  - The runtime is downloaded only as a signed, platform-specific CI artifact pinned to the reviewed immutable upstream release and ClawX patch revision.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - kernel-capability-isomorphism
  - multi-kernel-isolation-and-routing
  - unified-conversation-storage
  - backend-communication-boundary
  - comms-regression
  - docs-sync
requiredTests:
  - node scripts/kernel-runtime/verify-sources.mjs --kernel deepseek-harness --source-checkout temp/kernel-source
  - pnpm exec vitest run tests/unit/kernel-runtime-build.test.ts
  - pnpm exec vitest run tests/contract/kernels/deepseek-harness-driver.test.ts
  - pnpm exec vitest run tests/contract/kernels/kernel-driver-contract.test.ts tests/contract/kernels/concurrent-spike.test.ts
  - pnpm run typecheck:node
  - pnpm run comms:replay
  - pnpm run comms:compare
  - git diff --check
acceptance:
  - The source manifest pins dsh-v0.1.2-alpha.2 by full commit and tree and records freshly verified lockfile and third-party-notice hashes.
  - Every reviewed ClawX overlay importer is represented in the patched upstream lockfile, installed with frozen lifecycle policy, and included in the immutable overlay manifest.
  - All source patches apply with three-way context disabled against the new exact commit; stale patches are regenerated or removed after verifying equivalent upstream behavior.
  - DeepSeek Harness bridge packages build and pass their upstream-workspace tests on the new source baseline.
  - Conversation persistence, rich ACP events, control, providers/models, agents, skills, channels, cron, usage, credentials, cancellation, permissions, sandbox policy, and runtime-host closure pass focused regression tests.
  - Runtime descriptors, artifact version, patch revision, hashes, release notes, architecture references, and TODO evidence agree on 0.1.2-alpha.2.
  - The protected five-target runtime build is restarted only from the committed upgraded source and remains fail-closed for signing, notarization, catalog promotion, COS publication, and Range drills.
docs:
  required: true
---

Use this task spec for the immutable DeepSeek Harness `dsh-v0.1.2-alpha.2`
rebase. The runtime/bridge path is governed by
`harness/specs/scenarios/gateway-backend-communication.md`; the multi-kernel
architecture and release gates remain defined by
`harness/reference/multi-kernel-runtime.md`.
