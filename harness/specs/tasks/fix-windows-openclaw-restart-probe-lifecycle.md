---
id: fix-windows-openclaw-restart-probe-lifecycle
title: Diagnose and repair abrupt Windows OpenClaw probe termination during restart
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Complete real Windows restart acceptance without hiding native process failures or weakening runtime gates.
touchedAreas:
  - .github/workflows/kernel-runtime-build.yml
  - .github/workflows/kernel-runtime-promote.yml
  - .github/workflows/multi-kernel-runtime-smoke.yml
  - kernels/node-runtime.json
  - kernels/openclaw/source.json
  - kernels/openclaw/runtime.json
  - kernels/openclaw/overlay/clawx-control-bridge.mjs
  - kernels/openclaw/overlay.manifest.json
  - kernels/deepseek-harness/source.json
  - kernels/deepseek-harness/runtime.json
  - scripts/kernel-runtime/run-openclaw-managed-probe.mjs
  - scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs
  - scripts/kernel-runtime/runtime-artifact-smoke.mjs
  - scripts/kernel-runtime/lib/openclaw-probe-*.mjs
  - tests/unit/openclaw-probe-*.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - tests/unit/kernel-source-manifests.test.ts
  - tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - harness/specs/tasks/fix-windows-openclaw-restart-probe-lifecycle.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - OpenClaw crash recovery rehydrates canonical shared history exactly once and still exercises real ACP, tools, Channels and storage fences.
  - A failed native process remains a failed staging gate with bounded diagnostic evidence.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - docs-sync
requiredTests:
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Preserve run 34191696751 job 101951749069 evidence, including successful 11-case early closure and phase trace ending at restart before shell exit 127.
  - Distinguish observed native exit, shell status, owned child lifecycle, deadline and assertion failure; do not infer missing Node or a timeout from 127 alone.
  - Use isolated Windows diagnostics with owned fixture state and unchanged verified kernel bytes; restore the initially stopped VM and remove only that fixture.
  - Keep strict output, deadlines, finite process polls, mandatory reports, all real runtime assertions and normal environment approval.
  - Cover any repaired lifecycle or workflow behavior with regressions including Windows-native execution when feasible.
  - Upgrade only the shared Node 24 LTS runtime to 24.20.0 with verified official distribution hashes and new immutable ClawX artifact revisions; preserve both upstream kernel versions, module ABI 137, dependency locks and semantic kernel patches.
  - Align runtime-related CI Node setup with the shared pin; do not change trust, signatures, notarization, installed user state, production storage, retries or COS/catalog contents.
  - Commit and push verified changes and finish full staging and same-code E2E successfully before marking MK-1940 complete.
docs:
  required: true
---

The initial prompt, real background tool, cancellation and deliberately
interrupted run completed before the abrupt restart-phase exit. The report
contains neither a failure/cleanup phase nor a final JSON result. This narrows
the failure location but does not yet identify the terminating process or
native exit status. Start with primary source inspection and an isolated
Windows reproduction rather than weakening assertions or retrying blindly.

Primary investigation found Node issue 63620 and its maintainer-confirmed
fix (Node PR 62561) for silent Windows TCP-connect failures on 24.15.0.
Git for Windows maps otherwise-unclassified NTSTATUS failures to 127, so
retain native decimal/hex process evidence as well. Node 24.20.0 is the
current same-ABI 24.x LTS release and includes this fix and subsequent
24.x security fixes. Compare the old/new runtimes with bounded owned
loopback traffic and the complete real kernel probe; distinguish a
reproduced platform defect from a crash stack unavailable in run 20.
