---
id: port-upstream-clawx-0-5-8
title: Port upstream ClawX 0.5.8 into the canonical multi-kernel host
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the reviewed upstream fixes and features in independently validated batches while retaining the canonical multi-kernel storage, credential, lifecycle and artifact contracts.
touchedAreas:
  - .github/workflows/**
  - electron/**
  - shared/**
  - src/**
  - tests/**
  - harness/**
  - docs/**
  - resources/**
  - scripts/**
  - kernels/**
  - patches/**
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - electron-builder*.yml
  - entitlements*.plist
  - README*.md
  - TODO.md
expectedUserBehavior:
  - OpenClaw and DeepSeek Harness continue to share one Conversation, Provider, Agent, Channel, Cron, Skill and Usage authority.
  - Provider saves project usable protocols and model capabilities independently to each selected kernel and surface partial failures.
  - Draft text and selection belong to the canonical Conversation, and reading previous messages is not interrupted by incoming output.
  - Upstream features use the existing Host API, secure credential staging, canonical events and signed runtime distribution.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - upstream-multi-kernel-porting
  - multi-kernel-isolation-and-routing
  - unified-conversation-storage
  - provider-model-metadata-preservation
  - provider-model-selection-authority
  - renderer-main-boundary
  - backend-communication-boundary
  - kernel-runtime-distribution
  - ui-i18n-design-tokens
  - e2e-parallel-isolation
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Every reviewed upstream commit has a recorded disposition and each implemented batch records focused unit, contract and Electron E2E evidence.
  - Missing provider protocols fail visibly rather than being marked as successfully projected; explicit user metadata is retained.
  - Conversation drafts, attachments, selection and async callbacks cannot cross conversation boundaries or survive deletion as another conversation's state.
  - Existing canonical history, usage idempotency, credentials, per-kernel routing and active peers remain intact.
  - No native transcript scanning, second persistence authority, dependency downgrade or end-user package installation is introduced.
  - New UI flows have four-locale coverage and matching Electron E2E; native permission and signed-artifact claims require actual platform evidence.
  - Official DingTalk preserves canonical account IDs, bindings and policy while DWS authorizations and subprocess credentials remain isolated by account and owner generation.
  - Child-agent runs persist independent canonical lineage, content, usage and terminal status without treating a child as a history branch or reading native transcripts.
  - Computer Use is an explicit revocable capability and TokenDance authorization remains Main-owned; both respect the selected kernel and existing credential authority.
  - Packaging upgrades are checked with a local unsigned assembly and retain protected signing and immutable-runtime release gates.
docs:
  required: true
---

The upstream input is the reviewed immutable release commit
`24a24b7797349266b25807a188593a90b67e91f5`, not a moving branch.
The integration baseline is `bf190dab` (GitHub-only signed runtime distribution).
This task also follows `harness/specs/scenarios/multi-kernel-runtime.md` and
`harness/reference/upstream-clawx-0.5.8-migration.md`.

Do not replay the upstream monolithic merge or old OpenClaw generated-dist
patches. Port behavior against the current implementation and its real test
contracts. User state and installed artifacts are not test fixtures. Record
platform or external-account validation gaps without presenting them as passed.

Continuation authorized on 2026-09-19: finish the remaining implementation batches,
including the previously optional Computer Use and TokenDance integrations. Keep
the existing seven commits and commit each validated continuation batch. Publishing
signed artifacts and authenticating real third-party accounts are separate external
operations; code and fixture validation must not claim those operations occurred.
