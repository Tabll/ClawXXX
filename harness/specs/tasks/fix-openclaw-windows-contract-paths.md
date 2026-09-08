---
id: fix-openclaw-windows-contract-paths
title: Use native absolute paths and encoded file URLs in OpenClaw Windows contracts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the five Windows post-artifact contract failures revealed by build 34178442166 without weakening production path validation or runtime acceptance.
touchedAreas:
  - tests/contract/kernels/openclaw-acp-adapter.test.ts
  - tests/contract/kernels/openclaw-driver.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-openclaw-windows-contract-paths.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/windows-runtime-ci-repair.md
  - TODO.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Windows workspaces use native absolute paths and valid file URLs, including spaces, Unicode and reserved URL characters.
  - OpenClaw cancellation, queued-run isolation, attachment cleanup, terminal events and installed-runtime boundaries retain the same assertions on every platform.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - backend-communication-boundary
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/contract/kernels/openclaw-acp-adapter.test.ts tests/contract/kernels/openclaw-driver.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run kernel:sources:verify
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Record that run 34178442166 passed all ten builds, all four macOS notarizations, all five dual-runtime tests and the Windows real single-artifact install, but failed five later host contracts; do not mislabel this as another installation timeout.
  - Replace POSIX-only workspace URLs with pathToFileURL on native absolute paths and compare exact installation paths, not normalized substring approximations.
  - Cover URI round trips, spaces, Unicode and reserved characters, actual adapter cwd values and unchanged rejection of malformed file URLs without mocking production conversion.
  - Exercise Windows runtime fixture executable layout and clean up only owned temporary test roots.
  - Run the repaired contracts before expensive builds as well as retaining their post-artifact gate, with default deadlines and no retries/skips.
  - Validate native Windows behavior and host suites; retain every original event, cancellation, usage, cleanup and data-isolation assertion.
  - Do not alter production adapters, archive verification, signing inputs, source versions, locks, timeouts or Windows security settings.
  - Review all README locales and record the precise staged versus production publication boundary.
  - Commit and push the repair, dispatch and normally approve a fresh both-kernel five-platform staging run, and continue until every required job passes.
  - Leave MK-1940 pending until complete remote acceptance; no COS/catalog publication, credentials or protection-rule changes.
docs:
  required: true
---

Windows job 101917111514 passed sealed Gateway/ACP, interruption/Range resume,
production install, rescan and uninstall in 454156 ms. The subsequent host
contracts failed because `file:///workspace` has no Windows drive and a driver
assertion hardcodes `/kernels/openclaw/`. The actual Windows dual contract passed
in 730583 ms; these previously repaired native gates must remain intact.
