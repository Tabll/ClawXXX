---
id: fix-kernel-runtime-ci-staging-and-lark-load
title: Repair cross-volume runtime staging and bounded native Lark load checks
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the two build failures observed in run 34035636685 without weakening frozen input verification, real Channel compatibility checks, or release gates.
touchedAreas:
  - scripts/kernel-runtime/download-npm-source.mjs
  - scripts/kernel-runtime/download-node-runtime.mjs
  - tests/unit/kernel-runtime-downloads.test.ts
  - tests/unit/openclaw-channel-package-patches.test.ts
  - tests/fixtures/kernels/runtime-download-loader.mjs
  - .github/workflows/kernel-runtime-build.yml
  - harness/specs/tasks/fix-kernel-runtime-ci-staging-and-lark-load.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/multi-kernel-runtime.md
  - TODO.md
expectedUserBehavior:
  - Both optional kernels can be built when Windows system temp and the repository checkout are on different volumes.
  - Downloads remain verified before atomic promotion and never replace an existing destination or leave partial runtime directories after failure.
  - The real patched Lark CommonJS entry and both repaired import.meta sites remain mandatory checks on every OpenClaw build target.
  - No shared UI, runtime protocol, canonical SQLite, installed runtime, signing policy or production catalog changes.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-runtime-downloads.test.ts tests/unit/openclaw-channel-package-patches.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run harness:ci
  - pnpm run comms:replay
  - pnpm run comms:compare
  - git diff --check
acceptance:
  - CLI-level offline fixtures reproduce EXDEV with the old staging behavior on any host, then pass with same-volume sibling staging for npm sources and Node ZIP runtimes.
  - Digest failure, failed download, unsafe npm entries, package identity mismatch and pre-existing destinations fail closed with cleanup and no destination replacement.
  - Native Lark loading runs asynchronously in a fresh Node process with a finite kill timeout and a larger per-test deadline; test-runner module caches cannot supply the plugin.
  - The native register export assertion and both CommonJS syntax checks remain enabled, with no global timeout increase, retry or skip.
  - Five-target build workflows include the staging regression tests before expensive build and signing work.
  - Local evidence is recorded separately from the failed remote run; no automatic commit, push, rerun, environment approval or publication is implied by this repair.
docs:
  required: false
  reason: Reviewed README.md, README.zh-CN.md and README.ja-JP.md; this repair changes only CI staging and test isolation, not user-facing install flows, UI or runtime interfaces. Builder constraints and evidence are updated in the runtime reference, rule, scenario and TODO.
---

Follow `harness/reference/multi-kernel-runtime.md` and the
`kernel-runtime-distribution` rule. Run 34035636685 built five of ten artifacts:
both Windows jobs failed at cross-volume rename, while three OpenClaw jobs
passed their real Gateway/ACP probes but exceeded the 5-second Lark load test
budget. macOS signing/notarization success does not make the failed build or
skipped clean-machine jobs successful.

The baseline on local Node 24.15.0 loaded the actual Lark entry in about 2.2
seconds. This is not evidence that a cold CI runner must fit the default
5-second unit-test timeout. Keep the real import, isolate its module graph and
bound it as a cold-start process probe; do not mock its dependencies or remove
the compatibility assertions.

Local repair validation on Node 24.15.0 passed: 12 download CLI regressions,
28 focused tests, 81 tests in the union of both CI storage suites, and 2180
host tests with 6 existing conditional cases pending. Typecheck, lint (7
existing warnings), source identities, comms and Harness checks passed. See
TODO MK-1913 through MK-1917 for the failed remote run and the separately
pending push/rebuild/clean-machine gates. This is not Windows runner or
production publication evidence.
