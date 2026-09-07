---
id: fix-clean-machine-runtime-install
title: Repair immutable-runtime fault injection and bounded install verification
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair run 34125183305 clean-machine failures while preserving signed artifacts, immutable installs, exact verification and finite test deadlines, then commit, push and dispatch both kernels on five staging targets.
touchedAreas:
  - electron/kernels/package-manager/**
  - tests/contract/kernels/**
  - tests/fixtures/kernels/**
  - tests/unit/kernel-*.test.ts
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-clean-machine-runtime-install.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - README*.md
  - TODO.md
expectedUserBehavior:
  - Optional runtime installation and integrity rescans retain all signed file and path checks without serializing every independent filesystem operation.
  - Both kernels remain independently installable and repairable with one canonical SQLite authority.
  - Real-artifact tests report bounded per-stage diagnostics even when they fail or time out.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/package-manager.test.ts tests/unit/kernel-bounded-io.test.ts tests/unit/kernel-artifact-test-support.test.ts tests/unit/kernel-runtime-directory.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Reproduce the readonly fault-injection error; modify only an explicitly owned temporary regular file, restore its mode in finally, and prove subsequent rescan, repair and independent uninstall.
  - Measure filesystem verification work and exercise real hashes and manifest corruption checks; keep bounded concurrency and drain in-flight work before cleanup after failure.
  - Reproduce Windows executable-directory EPERM after process exit and close; allow only finite Windows EPERM/EBUSY atomic directory rename retries (six attempts, 1500 ms accumulated waiting), keep other errors fatal, never copy or relax permissions, and retain active-runtime guards and test deadlines.
  - Retain archive traversal, symlink/hardlink, collision, signature, stream budget, per-file hash, count, size, readonly and canonical data checks; never replace them with mocks in real-artifact acceptance.
  - Emit phase transitions and durable incremental evidence for single and dual real-artifact tests, including failure and timeout, without paths, secrets or file contents.
  - Preserve the existing 10-minute single and 15-minute dual test deadlines and all real Gateway, ACP, Channels, platform signing and notarization gates.
  - Keep both +clawx.12 payload identities, frozen inputs, dependency locks and signing policies unchanged; this change is in the host installer and test harness, not the kernel payload.
  - Update TODO, durable reference, rule and scenario; review README locales and document host behavior changes where needed.
  - Commit and push main to Tabll/ClawXXX, dispatch a fresh both-kernel five-target workflow on the new SHA and approve kernel-staging; report actual CI progress without claiming unobserved acceptance.
  - No COS upload, catalog promotion, secret changes or mutation of the user's installed runtimes or canonical data.
docs:
  required: true
---

Run #12 built all ten artifacts and passed four macOS notarizations and all
three standalone Electron E2E targets. All five dual-runtime tests reached the
readonly integrity-injection append and failed with EACCES/EPERM. Only the
OpenClaw Windows single install test exceeded 600000 ms; its preceding real
Gateway/ACP/seven-Channel artifact probe passed. The old test retained progress
only in memory, so the exact timed-out stage is not established by its logs.
See `harness/reference/windows-runtime-ci-repair.md` for measured evidence and
the distinction between local probes and fresh platform CI acceptance.
