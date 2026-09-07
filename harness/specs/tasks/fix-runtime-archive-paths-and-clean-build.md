---
id: fix-runtime-archive-paths-and-clean-build
title: Preserve runtime archive paths and make clean UI builds self-contained
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the two clean-machine failures in build 34088424748, preserve all distribution security gates, then commit, push and dispatch both kernels on the new main SHA.
touchedAreas:
  - scripts/kernel-runtime/lib/artifact.mjs
  - package.json
  - tests/unit/kernel-runtime-build.test.ts
  - tests/unit/kernel-runtime-archive.test.ts
  - tests/unit/extension-bridge-build.test.ts
  - tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - tests/contract/kernels/package-manager.test.ts
  - .github/workflows/kernel-runtime-build.yml
  - kernels/openclaw/**
  - kernels/deepseek-harness/**
  - harness/specs/tasks/fix-runtime-archive-paths-and-clean-build.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/**
  - README*.md
  - docs/zh-CN/multi-kernel-design.md
  - docs/*/release-notes-0.6.0.md
  - TODO.md
expectedUserBehavior:
  - Both optional kernels install losslessly using the existing signed package manager, including long and Unicode file names.
  - A clean checkout can build the shared UI without pre-existing generated extension bridges.
  - Archive integrity, safe extraction, canonical storage and platform security remain mandatory.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-archive.test.ts tests/unit/extension-bridge-build.test.ts tests/unit/kernel-runtime-build.test.ts tests/contract/kernels/package-manager.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run build:vite
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Reproduce the old archive truncation and missing extension generation before fixing them.
  - Preserve PAX long and multibyte paths with deterministic bytes independent of inode and filesystem timestamps; check decoded paths and content before emitting a signed artifact.
  - Exercise signed production extraction and reject effective PAX traversal, absolute or reserved paths, collisions, links and decompression limits without bypasses.
  - Make build:vite explicitly generate both ignored bridges before compilation without relying on implicit package-manager lifecycle hooks.
  - Validate the actual Vite/Electron build in an isolated clean copy without inherited generated bridges.
  - Increment both immutable artifact revisions for the shared archive-format repair and synchronize runtime, overlay and source hashes without changing upstream versions or dependency locks.
  - Preserve all five targets, four macOS signing/notarization gates, Windows artifact-signature-only policy and single/dual clean-machine verification.
  - Commit and push to Tabll/ClawXXX main, dispatch and approve a new all-target staging build, and report actual status separately from local evidence.
  - No COS/catalog promotion, credentials change or installed-runtime replacement is authorized by this task.
docs:
  required: true
---

See `harness/reference/windows-runtime-ci-repair.md`. Run 34088424748 passed
all ten builds and four macOS notarizations. Five OpenClaw and five dual-runtime
clean-machine jobs failed at initial file-manifest integrity verification after
USTAR truncated long Jimp snapshot names. Five DeepSeek clean-machine jobs passed
runtime smoke and signed installation, then failed to resolve the ignored main
extension bridge during the shared UI build. Three-platform Electron E2E passed.
