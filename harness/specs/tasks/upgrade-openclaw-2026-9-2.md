---
id: upgrade-openclaw-2026-9-2
title: Adapt the optional OpenClaw 2026.9.2 runtime safely
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Rebase the optional OpenClaw runtime and reviewed patches onto the current stable release while preserving canonical SQLite, scoped permissions and the shared multi-kernel UI.
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - patches/**
  - kernels/openclaw/**
  - kernels/deepseek-harness/**
  - kernels/license-policy.json
  - scripts/**
  - electron/**
  - shared/**
  - tests/**
  - .github/workflows/kernel-runtime-build.yml
  - README*.md
  - THIRD_PARTY_NOTICES.md
  - TODO.md
  - docs/**
  - harness/reference/**
  - harness/specs/tasks/**
  - harness/specs/rules/**
  - harness/specs/scenarios/gateway-backend-communication.md
expectedUserBehavior:
  - OpenClaw and DeepSeek Harness retain independent lifecycle and run identities while sharing the ClawX UI and canonical Conversations, Usage, Cron, Channels, Agents and Skills.
  - Streaming, final answers, provider usage, tools, approvals and cancellation remain correctly scoped and ordered across kernel generations.
  - Native history, native schedulers and cross-agent visibility cannot bypass canonical admission or create a second history authority.
  - End users install verified prebuilt runtime packages without compiling upstream code or running package managers.
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
  - pnpm exec vitest run tests/contract/kernels/openclaw-driver.test.ts tests/contract/kernels/openclaw-acp-adapter.test.ts tests/contract/kernels/openclaw-conversation-store.test.ts
  - pnpm exec vitest run tests/unit/openclaw-session-manager-compatibility.test.ts tests/contract/kernels/openclaw-runtime-dir.test.ts
  - pnpm exec vitest run tests/unit/openclaw-managed-session.test.ts tests/unit/openclaw-managed-storage-fence.test.ts tests/unit/openclaw-channel-handoff.test.ts tests/unit/openclaw-channel-package-patches.test.ts tests/unit/openclaw-config-projection.test.ts tests/unit/openclaw-native-pruning.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - git diff --check
acceptance:
  - Official release tag, full commit and npm SHA-512 integrity are independently verified and frozen; runtime, lock, patch and overlay identities agree.
  - Every prior compiled-runtime patch is accounted for as rebased, upstreamed or intentionally replaced with regression evidence; strict source preparation rejects fuzz and offsets.
  - Changed Gateway, ACP, provider, plugin, permission and session interfaces are checked against the actual new payload, not merely version-string assertions.
  - Managed storage and scheduler guards fail closed, including fresh-directory runtime probes, and new upstream defaults cannot widen ClawX conversation or approval authority.
  - The pinned Node runtime, bundled plugin closure and pruning/import checks are compatible with the upgraded release.
  - Local compatibility, host tests, communication checks and harness checks pass; unexecuted platform, real-provider, signing and publication gates remain explicitly pending.
  - Prior uncommitted DeepSeek and user changes are retained. No push, publication or installed user-runtime mutation is implied by this local upgrade.
docs:
  required: true
---

Follow `harness/reference/multi-kernel-runtime.md` and the
`gateway-backend-communication` scenario. Review the official September stable
release against the frozen July npm payload before changing production pins.
Local checks do not substitute for five-platform CI, notarization, COS/Range
validation or real-provider acceptance.

Current status: **source/dev pins switched to 2026.9.2+clawx.7; publication pending**.
The production bridge, versioned config projection and seven Channel plugin
compatibility repairs are implemented. Per-Run incognito hydration replaces
native durable replay; rejected ingress and interrupted executions fail closed.
The narrow real-ACP probe and real Gateway/ACP loopback-provider probe now pass,
including the packaged macOS arm64 payload. Neither proves real external account
behavior or five-platform signing/publication. Follow the exact evidence and
old-patch disposition in `harness/reference/openclaw-2026.9.2-upgrade.md` and TODO M19.

The worktree also contains the preceding uncommitted DeepSeek 0.1.3 upgrade and
license-obligation changes. Their paths are included in touchedAreas so normal
diff-aware validation covers the actual shared worktree; they remain governed
by their own task/review and are not new OpenClaw changes. Do not revert them or
use this scope declaration to waive their tests or authorize publication.
