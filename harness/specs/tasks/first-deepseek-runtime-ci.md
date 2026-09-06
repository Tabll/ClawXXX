---
id: first-deepseek-runtime-ci
title: Complete the first DeepSeek Harness runtime CI build
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Run the upgraded immutable DeepSeek Harness source through the protected five-target runtime pipeline and repair concrete build failures, honoring the decision to defer Windows Authenticode while retaining artifact signatures and all runtime isolation checks.
touchedAreas:
  - .gitattributes
  - eslint.config.mjs
  - .github/workflows/kernel-runtime-build.yml
  - scripts/kernel-runtime/**
  - kernels/deepseek-harness/**
  - tests/unit/kernel-*.test.ts
  - tests/unit/deepseek-*.test.ts
  - tests/fixtures/kernels/**
  - tests/contract/domains/diagnostics.test.ts
  - tests/unit/credential-broker.test.ts
  - tests/contract/kernels/**
  - harness/specs/tasks/first-deepseek-runtime-ci.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/reference/multi-kernel-runtime.md
  - README*.md
  - docs/**
  - TODO.md
expectedUserBehavior:
  - Optional runtimes are produced from the reviewed source and patch manifests using CI, with no local source compilation required for end users.
  - macOS runtimes must retain Developer ID signatures, hardened runtime, and accepted Apple notarization.
  - Windows runtime artifacts may explicitly defer Authenticode; their signed descriptor, archive digest, safe extraction, and isolation tests remain mandatory, and reports never claim unsigned PE files were code-signed.
  - Canonical SQLite data and both runtime adapters preserve their current storage and communication contracts.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/kernel-platform-security.test.ts tests/unit/kernel-runtime-build.test.ts
  - pnpm exec vitest run tests/unit/kernel-platform-verification.test.ts
  - pnpm exec vitest run tests/unit/kernel-source-manifests.test.ts tests/unit/kernel-deploy-materialization.test.ts
  - pnpm exec vitest run tests/unit/deepseek-sandbox-probe.test.ts tests/unit/deepseek-sandbox-temp-parity-patch.test.ts
  - pnpm run kernel:sources:verify
  - pnpm run typecheck:node
  - git diff --check
acceptance:
  - The old pre-upgrade waiting run is cancelled and the upgraded commit is built with an approved kernel-staging deployment.
  - Windows artifact-signature-only mode is explicit in CI inputs and recorded in hash-bound metadata; absent or invalid Authenticode results never silently select that mode.
  - Source tests, clean-machine verification, and publication evidence are reported according to actual results.
  - Frozen deployment preserves locked dependency versions, builds the native Linux launcher, removes non-target native files and generated builder metadata, and passes the exact native allowlist.
  - Sandbox write self-tests require a known filesystem denial code from the controlled child, a nonzero exit, and absence of the output file; unrelated startup or tool errors never count as a successful denial.
  - Remaining external requirements are recorded without marking incomplete notarization or publication successful.
docs:
  required: true
---

Continue the protected build of DeepSeek Harness `0.1.2-alpha.2+clawx.10`
from the reviewed upgrade. Use the signing/runtime policy in
`harness/reference/multi-kernel-runtime.md`. The explicit user decision on
2026-08-31 defers Windows code signing, but not the Ed25519 artifact/catalog
signatures or the sandbox, storage, and package-manager verification steps.
