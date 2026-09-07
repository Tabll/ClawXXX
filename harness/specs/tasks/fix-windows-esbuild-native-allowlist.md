---
id: fix-windows-esbuild-native-allowlist
title: Repair the exact Windows esbuild native payload allowlist
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the OpenClaw Windows artifact sealing failure in build 34077942495 without widening native payload trust, then commit, push and dispatch a new all-target staging build.
touchedAreas:
  - kernels/openclaw/runtime.json
  - kernels/openclaw/source.json
  - kernels/openclaw/overlay.manifest.json
  - kernels/openclaw/overlay/clawx-control-bridge.mjs
  - tests/unit/kernel-runtime-build.test.ts
  - tests/unit/openclaw-native-allowlist.test.ts
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-windows-esbuild-native-allowlist.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/**
  - README*.md
  - TODO.md
expectedUserBehavior:
  - The audited Windows x64 esbuild executable passes the same native validation and deterministic artifact builder as other platforms.
  - Unexpected executable paths and foreign platform or architecture payloads remain rejected.
  - The new immutable OpenClaw identity does not replace installed runtimes or reuse published descriptor identity.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-native-allowlist.test.ts tests/unit/kernel-runtime-build.test.ts tests/unit/kernel-platform-security.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Verify the frozen Windows esbuild package layout and replace only the incorrect bin/esbuild.exe path with its actual root-level esbuild.exe path.
  - Add a real native-validator regression using the checked-in allowlist for all five targets, plus negative cases for wrong targets, the obsolete Windows path and unrelated executables.
  - Exercise Windows-target deterministic artifact assembly locally with isolated fixture evidence; do not report that as native Windows execution or clean-machine acceptance.
  - Run the focused native allowlist regression before expensive runtime builds in CI and retain the final payload audit without wildcards or bypasses.
  - Increment the immutable OpenClaw artifact revision and synchronize source/runtime/control-overlay hashes; keep compiled patches, dependency locks, upstream pins and DeepSeek bytes unchanged.
  - Preserve Windows artifact-signature-only policy and macOS signing/notarization, Gateway, Channels, integrity and clean-machine gates.
  - Commit and push to Tabll/ClawXXX main, dispatch both kernels on all five targets, approve kernel-staging and report the new run status separately from local validation.
  - No COS or catalog promotion, credential changes, or installed-runtime replacement is part of this repair.
docs:
  required: true
---

See `harness/reference/windows-runtime-ci-repair.md`. Run 34077942495 at
ae2508be completed nine of ten runtime builds, all four macOS notarizations and
all three Electron E2E targets. OpenClaw Windows passed the registry and real
Gateway probes before the artifact native allowlist rejected the root-level
`@esbuild/win32-x64/esbuild.exe`. Both clean-machine matrices were skipped.
