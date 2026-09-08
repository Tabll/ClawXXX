---
id: fix-openclaw-probe-background-exec
title: Verify the terminal result of background exec in the real OpenClaw probe
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Diagnose the Windows sealed-artifact tool execution failure in staging run 34174116971, repair the deterministic loopback provider without weakening runtime checks, and continue full staging acceptance.
touchedAreas:
  - scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs
  - scripts/kernel-runtime/lib/openclaw-probe-provider.mjs
  - tests/unit/openclaw-probe-lifecycle.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - harness/specs/tasks/fix-openclaw-probe-background-exec.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
expectedUserBehavior:
  - Real guarded tool approval verifies execution completion even if the native exec tool backgrounds a slow process.
  - Polling is confined to the owned test process and never authorizes arbitrary commands or writes native durable history.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-probe-lifecycle.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Reproduce the old assertion with deterministic background execution through the real Gateway and ACP before implementing the provider fix.
  - Distinguish backgrounded, running, terminal-success, terminal-failure and malformed native tool results; do not treat tool_call_update or a running process as success.
  - Only poll the session returned by the owned fixed exec command, with finite poll count and per-poll bounds inside unchanged overall deadlines.
  - Preserve exact command approval, actual output marker and exit checks, canonical history, cancellation, crash rehydration, Channel checks and no-native-history assertions.
  - Account for every known completed provider response and usage event, including process continuations, without introducing guessed billing or unbounded retries.
  - Add regression coverage to the existing CI-selected probe suite and rerun real runtime probes and all host checks before review.
  - Keep frozen source, payload versions, locks, signing inputs and workflow gates unchanged unless separate evidence establishes a production-runtime defect.
  - Commit and push the scoped repair, trigger new-SHA both-kernel five-target staging with normal approval, and continue until all required jobs succeed.
  - Do not promote COS or catalog, change credentials or protection rules, or misreport pending Windows dual-runtime acceptance.
docs:
  required: true
---

Run 34174116971 on 1f85184c passed all ten builds, four notarizations and
three-platform Electron E2E. Windows sealed OpenClaw smoke then failed at
the actual tool-output assertion. Approval succeeded, but the next model
request followed about ten seconds later, matching native exec's default
background threshold. The old loopback provider returns its final answer
after any tool response and does not handle process continuation. Establish
this cause through a real forced-background reproduction, not timing alone.
