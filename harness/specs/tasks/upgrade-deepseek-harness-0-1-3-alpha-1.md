---
id: upgrade-deepseek-harness-0-1-3-alpha-1
title: Adapt DeepSeek Harness 0.1.3-alpha.1 breaking interfaces
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Upgrade the optional DeepSeek Harness runtime to immutable dsh-v0.1.3-alpha.1 with ClawX-owned composition, attempt-scoped streaming and usage, SessionHandle persistence, and unchanged canonical SQLite authority.
touchedAreas:
  - kernels/deepseek-harness/**
  - scripts/kernel-runtime/**
  - tests/unit/**
  - tests/contract/**
  - tests/fixtures/kernels/**
  - tests/e2e/**
  - electron/**
  - shared/**
  - .github/workflows/kernel-runtime-build.yml
  - kernels/license-policy.json
  - THIRD_PARTY_NOTICES.md
  - TODO.md
  - README*.md
  - docs/**
  - harness/reference/**
  - harness/specs/tasks/**
  - harness/specs/rules/**
  - harness/specs/scenarios/gateway-backend-communication.md
expectedUserBehavior:
  - Both optional kernels use the same UI, canonical Conversations, Cron, Channels, Agents, Skills and Usage records, without native history migration or secondary durable stores.
  - DSH streams text live and commits final answers and provider-reported usage exactly once, including retries, cancellation and replayed delivery.
  - Concurrent runs and kernel generations retain isolated identities, credentials, permissions and workspaces; DSH Session write ownership is not a global multi-kernel lock.
  - Users download prebuilt verified artifacts and never install upstream dependencies or apply patches locally.
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
  - pnpm run kernel:sources:verify
  - pnpm exec vitest run tests/unit/kernel-source-manifests.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm exec vitest run tests/contract/kernels/deepseek-harness-driver.test.ts tests/contract/kernels/kernel-driver-contract.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - git diff --check
acceptance:
  - The reviewed release is pinned by full commit and tree; upstream and prepared lock hashes, overlay bytes, patches, descriptors and notices agree on a new immutable artifact identity.
  - ClawX mounts explicit underlying services without the removed agent-spine-demo package, native durable history, native schedulers, local credential stores or upstream UI.
  - Transient agent/assistant-stream frames and v2 durable settlements have separate delivery identities and reconcile without losing text, repeating final content or double-counting usage.
  - SessionHandle providers enforce single-writer ownership, ordered reads and writes, flush durability, cancellation and idempotent close through an authenticated client, never native files.
  - Frozen upstream host compilation, focused overlay tests, real local sandbox and extracted-runtime checks pass; platform-specific and production gates remain pending until actually executed.
  - Existing uncommitted changes are preserved; no remote push, CI dispatch, signing, promotion or user runtime installation is implied by the local upgrade.
docs:
  required: true
---

Upstream release `dsh-v0.1.3-alpha.1` resolves to
`d347e703908d0406b7a7ef80e3a0e594d86b2215` (verified 2026-09-06).
This task follows `harness/reference/multi-kernel-runtime.md` and preserves
`gateway-backend-communication`. Upstream reports a performance regression;
local results are not cross-platform CI, real-provider or publication evidence.

The versioned compatibility contract and local evidence are recorded in
`harness/reference/deepseek-harness-0.1.3-upgrade.md`.
