---
id: fix-windows-runtime-registry-and-build-contracts
title: Repair Windows plugin registry persistence and runtime build contracts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Resolve the remaining Windows failures from build 34040448610, retain strict registry and artifact verification, then commit and push the reviewed repair and dispatch the full dual-kernel staging workflow.
touchedAreas:
  - scripts/kernel-runtime/**
  - patches/openclaw@2026.9.2.patch
  - kernels/openclaw/**
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - tests/unit/kernel-*.test.ts
  - tests/unit/openclaw-*.test.ts
  - tests/contract/kernels/deepseek-harness-driver.test.ts
  - tests/fixtures/kernels/**
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-windows-runtime-registry-and-build-contracts.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/**
  - README*.md
  - TODO.md
expectedUserBehavior:
  - Windows managed OpenClaw starts only after the freshly persisted plugin registry agrees with current discovery and metadata.
  - Both runtime artifact builders retain durable file synchronization and immutable signed outputs on Windows.
  - Strict patch tests preserve exact LF bytes and offset rejection regardless of the caller's Git settings.
  - Driver launch-path tests use native absolute filesystem paths without weakening traversal or installation-identity checks.
  - Canonical SQLite history, Channels ownership and shared UI behavior remain unchanged.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-build.test.ts tests/contract/kernels/deepseek-harness-driver.test.ts
  - pnpm exec vitest run tests/unit/openclaw-plugin-registry.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - The registry root cause is reproduced and fixed at its source, with a regression that still rejects actual metadata, policy or source changes.
  - Artifact fsync uses a Windows-compatible writable handle without truncating or swallowing durability failures.
  - Git fixture LF and driver path assertions are platform-correct, including execution under Windows-style Git settings.
  - Any changed kernel payload patch receives a new immutable revision and consistent lock/source/patch/runtime identities.
  - Frozen preparation and focused plus complete local verification pass before committing and pushing to Tabll/ClawXXX main.
  - A new all-kernel workflow uses the repaired commit, kernel-staging approval and explicit Windows artifact-signature-only mode; no COS upload or production promotion is implied.
  - Actual platform and clean-machine results are reported separately from local/simulated evidence.
docs:
  required: true
---

Build 34040448610 succeeded on all eight non-Windows targets. OpenClaw Windows
stopped at `persisted-registry-stale-source` before Gateway readiness. DeepSeek
Windows passed source/sandbox and Node checks, then failed artifact `fsync`,
strict-patch LF comparison and a literal POSIX launch-path expectation. Do not
weaken registry freshness, archive durability, strict patches, native history
isolation or release gates to obtain a green run. Follow
`harness/reference/multi-kernel-runtime.md` and the OpenClaw September upgrade
reference. The user explicitly authorized this repair, commit, push and staging
rebuild; production publication remains outside this task.
