---
id: upgrade-kernels-2026-09-12
title: Adapt OpenClaw 2026.9.4 and DeepSeek Harness 0.1.5-rc.2
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Rebase both optional runtimes onto verified immutable upstream releases, preserving shared canonical SQLite and bounded execution, then commit, push and dispatch the full protected staging build.
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - patches/**
  - kernels/**
  - scripts/**
  - electron/**
  - shared/**
  - src/**
  - tests/**
  - .github/workflows/**
  - .gitignore
  - README*.md
  - THIRD_PARTY_NOTICES.md
  - TODO.md
  - docs/**
  - harness/**
expectedUserBehavior:
  - Both kernels remain optional downloads and can run concurrently through the existing ClawX UI with one canonical Conversation, Usage, Cron, Channel, Agent and Skill authority.
  - Model and tool permissions, provider selection, persona, streaming, final answers, cancellation and settled usage remain isolated by canonical run and generation.
  - Existing installed runtime bytes and user databases are untouched by local candidate validation; all real probes use isolated state and exact candidate identities.
  - End users receive verified CI-built platform packages, never upstream installs, source builds or automatic native-history migrations.
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
  - pnpm exec vitest run tests/contract/kernels/openclaw-driver.test.ts tests/contract/kernels/openclaw-acp-adapter.test.ts tests/contract/kernels/deepseek-harness-driver.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Verified release tags, full commits, trees and npm integrity are frozen; patch, overlay, lock, Node and descriptor hashes agree on new immutable artifact identities.
  - OpenClaw compiled patches are semantically rebased with exact clean-source application, preserving canonical hydration, no-native-history fences, disabled native scheduling, Channel admission and explicit permissions.
  - All seven shipped Channel entrypoints and runtime registry checks pass against the new OpenClaw package, including actual native Gateway and ACP probes.
  - DeepSeek V3 Session events, system prompt prefix/suffix and Agent APIs are adapted without mounting native persistence or scheduler; V3 replacement and usage semantics have executable regression coverage.
  - Frozen DeepSeek build, overlay contracts, real sandbox and deployed-runtime probes pass against the exact new release, retaining Windows temp restrictions and target-specific native closure checks.
  - Previous uncommitted host Node, installation activation and Agent schema ownership repairs are preserved and validated under their existing specs, not silently reverted or excluded from the pushed code.
  - Local gates, documentation, task validate and selected harness flow pass before committing; remote build and E2E run IDs bind the pushed SHA, with pending platform/signing/publication evidence reported honestly.
docs:
  required: true
---

This task follows `harness/reference/multi-kernel-runtime.md` and the
`gateway-backend-communication` scenario. The user explicitly authorizes updating
both kernels and committing/pushing to `Tabll/ClawXXX` to build them. DeepSeek's
latest release is a release candidate, not a stable release. Keep Node 24.20.0
and existing signing/approval/release gates; no live user-state migration or
unverified production catalog replacement is authorized by candidate work.

Use a new upgrade reference and TODO section for patch dispositions, exact
candidate evidence and remote run links. Earlier host repair specs remain
applicable to their retained worktree changes. The previously deferred
installation-status E2E is not a waiver for runtime artifact acceptance.
