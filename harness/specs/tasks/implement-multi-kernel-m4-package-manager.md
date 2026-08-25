---
id: implement-multi-kernel-m4-package-manager
title: Implement Kernel Package Manager
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Safely fetch, verify, stage, activate, repair, rollback, import and uninstall immutable kernel artifacts while preserving canonical data.
touchedAreas:
  - TODO.md
  - electron/kernels/package-manager/**
  - shared/kernels/**
  - tests/contract/kernels/package-manager*.test.ts
  - tests/contract/kernels/real-*.test.ts
expectedUserBehavior:
  - No-kernel startup works and failed updates retain last-known-good immediately.
  - Uninstall removes runtime bytes but keeps all canonical user data.
requiredProfiles: [fast, comms]
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/package-manager.test.ts
  - pnpm exec vitest run tests/contract/kernels/real-runtime-artifact-install.test.ts tests/contract/kernels/real-dual-runtime-artifacts.test.ts
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - Compatibility, signature, traversal, link, bomb and disk-space checks run before activation.
  - Resume, cancel, crash, tamper, downgrade, quarantine and rollback are covered.
  - Clean-runner signed artifacts prove interrupted download, smoke, activation, rescan and uninstall without deleting shared SQLite data.
docs:
  required: true
---

## Scope

M4 client-side immutable artifact lifecycle.
