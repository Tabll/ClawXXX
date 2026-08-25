---
id: implement-multi-kernel-m0-gates
title: Prove Multi-Kernel Technical Gates
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Freeze the v1 kernel contract and prove that OpenClaw and DeepSeek Harness can execute concurrently while ClawX remains the only durable conversation authority.
touchedAreas:
  - TODO.md
  - docs/zh-CN/architecture/kernel-contract-v1.md
  - docs/zh-CN/architecture/m0-*.{md,json}
  - docs/zh-CN/multi-kernel-design.md
  - THIRD_PARTY_NOTICES.md
  - kernels/**
  - scripts/kernel-runtime/**
  - shared/kernels/**
  - shared/conversations/**
  - electron/data/**
  - electron/kernels/**
  - tests/contract/kernels/**
  - tests/unit/kernel-*.test.ts
  - tests/unit/conversation-*.test.ts
  - .github/workflows/multi-kernel-runtime-smoke.yml
  - vitest.config.ts
  - harness/reference/multi-kernel-runtime.md
  - harness/specs/tasks/implement-multi-kernel-m0-gates.md
expectedUserBehavior:
  - This milestone does not expose unfinished kernel controls in the Renderer.
  - A user conversation has one durable ClawX identity independent of the runtime selected for an individual run.
  - OpenClaw and DeepSeek Harness spike processes can run concurrently without sharing request, run, event, or process state.
  - Restart recovery uses canonical ClawX records and never a native runtime transcript.
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
  - pnpm harness validate --spec harness/specs/tasks/implement-multi-kernel-m0-gates.md --since HEAD
  - pnpm exec vitest run tests/unit/kernel-source-manifests.test.ts tests/contract/kernels
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - git diff --check
acceptance:
  - Kernel Contract v1 freezes kernel-independent conversation identity, run-scoped provenance, lifecycle, event ordering, cancellation, permissions, and canonical control-plane boundaries.
  - The release platform matrix and exact upstream sources, integrity evidence, license records, and patch policy are machine-readable and tested.
  - OpenClaw can hydrate canonical context into disposable runtime state, exercise prompt/cancel/compact/branch/restart, and leave no durable runtime history.
  - DeepSeek Harness uses a ClawX persistence provider and rich ACP bridge for prompt/tool/permission/cancel/resume/config/usage without durable native JSONL.
  - One DataService owner survives interleaved dual-kernel writes, abrupt client loss, backup/restore, and injected storage failure with fail-closed admission.
  - Cross-kernel continuation excludes private reasoning, secrets, revoked attachments, and opaque checkpoints belonging to another kernel.
  - The measured artifact/process baselines and explicit Go/No-Go decision are recorded before M1 implementation is accepted.
docs:
  required: true
---

## Scope

M0 architecture freeze and executable feasibility spikes only. Renderer feature rollout and production package download flows start in later milestones.
