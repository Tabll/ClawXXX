---
id: fix-windows-workflow-line-endings
title: Make the Windows storage workflow regression independent of checkout line endings
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the CRLF-sensitive workflow assertion exposed by staging build 34173221385, then validate, commit, push and continue complete new-SHA staging acceptance.
touchedAreas:
  - tests/unit/kernel-runtime-build.test.ts
  - harness/specs/tasks/fix-windows-workflow-line-endings.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
expectedUserBehavior:
  - Both kernel CI builds retain the same Windows file-worker policy with LF or CRLF checkouts.
  - Real Git, Channels, Cron and canonical SQLite contracts remain mandatory on every platform.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-build.test.ts tests/unit/kernel-contract-signal.test.ts tests/contract/domains/channels-runtime.test.ts tests/contract/domains/scheduler.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Confirm the failing assertion against actual CI logs and distinguish it from the already-passing prior timeout regressions.
  - Exercise the actual checked-in workflow in both LF and CRLF representations; reproduce the old CRLF failure before fixing it.
  - Normalize checkout line endings only for semantic workflow assertions, retaining every conditional worker, invocation and unchanged-deadline check.
  - Keep strict source and Git patch byte verification unchanged; do not normalize signed or frozen payload inputs.
  - Preserve production files, the workflow itself, global Git settings, both +clawx.12 payloads, dependency locks and all signing/clean-machine gates.
  - Validate all focused and full host suites, both actual CI storage selectors, and diff-aware Harness checks; document remaining remote acceptance accurately.
  - Commit only the repair and its evidence, push main, dispatch both kernels on all five targets using the new SHA and approve kernel-staging through normal permitted controls.
  - Continue inspecting failures until all required jobs and same-code Electron E2E pass; do not promote COS/catalog or change credentials or protection rules.
docs:
  required: true
---

Run 34173221385 on aa687d2b reached both Windows storage contracts: DSH passed
70/71 and OpenClaw passed 98/99. The only failing workflow policy assertion
compared a literal multiline LF
string with a CRLF checkout. Actual Git patch cases, Channels and Cron tests
passed. This repair changes only the assertion's representation handling and
adds deterministic LF/CRLF coverage; it does not alter runtime behavior.
