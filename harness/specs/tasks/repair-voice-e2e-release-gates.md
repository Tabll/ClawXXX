---
id: repair-voice-e2e-release-gates
title: Repair isolated voice E2E fixtures for signed release acceptance
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Remove host OS dependencies from synthetic voice tests while preserving real Main credential staging, encrypted persistence, ASR requests and production release gates.
touchedAreas:
  - tests/e2e/voice-dictation.spec.ts
  - harness/**
  - package.json
  - pnpm-lock.yaml
expectedUserBehavior:
  - Voice capture continues to honor actual microphone denial and insecure credential storage outside isolated E2E fixtures.
  - Signed runtime and installer publication requires the existing complete same-source CI evidence.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - e2e-parallel-isolation
  - kernel-runtime-distribution
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm exec vitest run tests/unit/asr-api.test.ts tests/unit/microphone-access.test.ts tests/unit/use-voice-dictation.test.tsx tests/unit/e2e-parallel-policy.test.ts
  - pnpm exec playwright test tests/e2e/voice-dictation.spec.ts --project=parallel
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Synthetic capture controls the corresponding native microphone status within its isolated Electron process, with denial and explicit retry scenarios still covered.
  - The real Main ASR test first rejects basic_text, then encrypts and transcribes using its per-process AES fixture with consistent storage-backend metadata.
  - No production permission, keychain, signature, E2E matrix or publication check is disabled or skipped.
  - Already pushed version tags remain unchanged; any new release candidate uses a fresh version.
docs:
  required: true
---

Continuation of `port-upstream-clawx-0-5-8`. See
`harness/reference/upstream-clawx-0.5.8-migration.md` for frozen upstream inputs,
and `harness/reference/github-only-kernel-distribution.md` for production rules.
Build #30 passed all 25 runtime jobs on source `9f34ecbc`; its same-source Linux
and Windows Electron E2E failed in synthetic voice fixtures. Existing macOS E2E
and host release validation passed. A fixture correction is new source and must
collect fresh same-source acceptance before production publication.
