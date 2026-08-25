---
id: implement-multi-kernel-m11-skills
title: Implement Canonical Multi-Kernel Skills
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Manage canonical skill metadata, compatibility, isolated projections and partial multi-kernel operations through one Skills UI.
touchedAreas:
  - TODO.md
  - electron/services/skills-api.ts
  - electron/domains/skills/**
  - shared/domains/skills.ts
  - src/pages/Skills/**
  - tests/**skill**
expectedUserBehavior:
  - Both-target operations report each kernel result and never fake total success.
requiredProfiles: [fast, comms]
requiredRules:
  - kernel-capability-isomorphism
  - backend-communication-boundary
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/contract/domains/skills.test.ts
  - pnpm run typecheck
acceptance:
  - Runtime skill roots are isolated and cannot be cross-linked.
  - Compatibility diagnostics and retry are canonical.
docs:
  required: true
---

## Scope

M11 skill domain isomorphism.
