---
id: fix-openclaw-koffi-runtime-closure
title: Preserve and exercise the packaged OpenClaw Koffi runtime closure
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the Windows startup failure caused by pruning Koffi runtime JavaScript, verify the actual cleaned native closure, then commit and dispatch the full protected kernel build.
touchedAreas:
  - scripts/**
  - tests/**
  - .github/workflows/kernel-runtime-build.yml
  - harness/**
  - TODO.md
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - comms-regression
  - docs-sync
expectedUserBehavior:
  - CI-built OpenClaw starts on Windows without requiring deleted Koffi loader files or falling back to developer-installed packages.
  - Both kernels retain their existing upstream pins, independent Node, canonical storage and protected signing and publication gates.
  - Local verification uses private payload copies and never changes installed kernels or user databases.
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-bundle-cleanup.test.ts tests/unit/kernel-runtime-build.test.ts tests/unit/openclaw-native-allowlist.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Production cleanup preserves Koffi's nested runtime JavaScript, including src/koffi/index.cjs and src/koffi/src/static.cjs, while retaining existing non-runtime cleanup and native target pruning.
  - A real integrity-pinned Koffi fixture passes the same cleanup and native-pruning code used by CI, loads both CJS and ESM exports and executes a native call; missing loader or native bytes fail.
  - Pre-seal probes on all five OpenClaw targets use the downloaded standalone Node and reject any module or addon resolved outside the payload; the full Gateway/ACP/Channel and single/dual artifact gates remain mandatory.
  - Local evidence, README review and the prior run failure are recorded honestly; the new commit is pushed to Tabll/ClawXXX/main and a new full build is dispatched for that SHA, not a rerun of old code.
docs:
  required: true
---

Follow `harness/reference/kernel-upgrade-2026-09-12.md`. Kernel build #23
(`34683254264`, commit `afa726dc`) passed nine build targets but OpenClaw Windows
failed before Gateway readiness because the old size-pruning rule removed
`node_modules/koffi/src`. The pinned Koffi 3.1.6 entrypoint now requires runtime
code there. Do not treat the wrapping SQLite cache/disk hint as the root cause,
disable Windows probes, relax native allowlists or rebuild native addons on user
machines. Same-source three-platform Electron E2E already passed; new code still
requires new same-source remote acceptance. The unpublished `+clawx.14` candidate
pins remain unchanged; no published artifact bytes are overwritten.
