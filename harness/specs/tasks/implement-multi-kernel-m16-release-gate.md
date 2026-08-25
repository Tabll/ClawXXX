---
id: implement-multi-kernel-m16-release-gate
title: Close Multi-Kernel Security and Release Gates
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Complete signing, notarization, platform compatibility, chaos, threat model, policy, documentation and full release validation for optional multi-kernel delivery.
touchedAreas:
  - TODO.md
  - docs/**
  - README*.md
  - kernels/**
  - scripts/**
  - .github/workflows/**
  - tests/**
expectedUserBehavior:
  - Runtime artifacts are verifiable, repairable and removable without losing canonical data.
requiredProfiles: [fast, comms]
requiredRules:
  - kernel-runtime-distribution
  - packaged-runtime-pruning-guards
  - docs-sync
  - comms-regression
  - unified-conversation-storage
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run test:e2e
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Base installers contain no runtime and both signed artifacts pass all contract and packaged E2E matrices.
  - The protected release workflow reruns full validation, three-platform Electron E2E and live two-mirror Range drills before packaging.
  - Every production catalog promotion binds its repository and artifact URLs to the reviewed mirrors, verifies identical signed N-1 state (or safely repairs an exact signed partial N publication), requires explicit sequence-1 bootstrap, and proves the complete catalog remains valid through its expiry.
  - Two real artifacts pass same-machine concurrency and one-sided failure/repair isolation on all required targets.
  - SQLite and Blob Store remain the sole durable history authority with tested backup, recovery and deletion policy.
  - Security, license, compatibility, EOL, localization, performance and documentation gates are complete.
docs:
  required: true
---

## Scope

M16 release readiness and final multi-kernel acceptance.
