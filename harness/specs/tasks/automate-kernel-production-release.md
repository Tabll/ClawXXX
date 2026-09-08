---
id: automate-kernel-production-release
title: Automatically publish verified kernel runtimes and safely retire old packages
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Connect complete same-source CI acceptance to protected immutable COS/GitHub publication, latest-only signed catalogs and evidence-bound retirement.
touchedAreas:
  - .github/workflows/kernel-runtime-promote.yml
  - kernels/release-policy.json
  - scripts/kernel-runtime/**
  - scripts/tencent-cos.mjs
  - tests/unit/kernel-*-release*.test.ts
  - tests/unit/kernel-release-*.test.ts
  - tests/fixtures/kernels/release-fixture.mjs
  - tests/unit/kernel-catalog-promotion.test.ts
  - tests/unit/kernel-distribution-drill.test.ts
  - tests/unit/kernel-distribution-security.test.ts
  - tests/unit/tencent-cos-publisher.test.ts
  - tests/unit/kernel-runtime-build.test.ts
  - tests/unit/kernel-source-manifests.test.ts
  - harness/specs/tasks/automate-kernel-production-release.md
  - harness/specs/rules/kernel-runtime-distribution.md
  - harness/specs/scenarios/multi-kernel-runtime.md
  - harness/reference/kernel-automatic-release.md
  - docs/zh-CN/multi-kernel-design.md
  - docs/zh-CN/architecture/kernel-runtime-supply-chain.md
  - docs/zh-CN/operations/kernel-runtime-release-runbook.md
  - docs/*/runtime-security-support.md
  - docs/*/development.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - TODO.md
expectedUserBehavior:
  - Complete runtime and same-source Electron E2E success automatically queues the existing protected production environment.
  - The App receives only the latest complete platform set through its unchanged signed catalog and immutable versioned URLs.
  - Retired packages are removed only after verified publication and their old signed catalog validity plus download grace; installed runtimes and canonical data remain untouched.
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
  - Bind trusted repository, workflow path, main branch, source SHA, current runtime source hashes, run attempt, complete build/single/dual jobs and same-source three-platform E2E; reject partial, failed, expired, stale or forked candidates.
  - Keep production reviewer rules and Windows artifact-signature-only policy; bootstrap remains an explicit protected manual input.
  - Separate reviewed publishing-tool commit from artifact source commit; never rebuild, resign descriptors, modify kernel bytes or weaken package verification during promotion.
  - Publish the complete immutable versioned asset set to both configured mirrors before switching a monotonic signed catalog; reject identity reuse, downgrade, mirror forks and changed retry intent.
  - Persist immutable signed release records before catalog writes; interrupted publication and cleanup resume idempotently with exact recorded bytes.
  - Use latest-per-kernel/platform/architecture catalogs without treating ordinary retirement as security revocation; required targets come from the shared matrix and enabled kernels from release policy.
  - Gate deletion on exact matching live catalogs and all-target strict Range/ETag checks, verified signed retirement records, expiry plus grace and object identity; never list-delete a whole bucket or runtime prefix.
  - Preserve small release records and cleanup receipts. Scheduled maintenance uses the same protected environment for due cleanup and bounded metadata renewal, never an approval bypass.
  - Exercise bootstrap, duplicate/out-of-order events, missing/failed E2E, partial upload/catalog switch, concurrent stale plans, renewal, current-object protection and interrupted cleanup with deterministic failure-injection tests.
docs:
  required: true
---

The user approved automatic publication, versioned object names, overwriting
the signed catalog pointer and safe removal of old packages. The previous
assessment and exact staging evidence remain in
`harness/reference/windows-runtime-ci-repair.md`. The release design and
validation results for this change belong in
`harness/reference/kernel-automatic-release.md`.

This changes CI distribution, not Renderer/Main behavior or canonical SQLite.
Existing production approval, artifact/catalog key separation and offline-only
rollback keys remain intact. First production bootstrap is not inferred from
an HTTP error other than explicit absence at both reviewed mirrors.
