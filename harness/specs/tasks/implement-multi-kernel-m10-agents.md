---
id: implement-multi-kernel-m10-agents
title: Implement Canonical Multi-Kernel Agents
scenario: multi-kernel-runtime
taskType: runtime-bridge
intent: Store canonical agents with per-kernel projections, defaults and immutable run snapshots behind one Agents UI contract.
touchedAreas:
  - TODO.md
  - electron/services/agents-api.ts
  - electron/domains/agents/**
  - shared/domains/agents.ts
  - src/pages/Agents/**
  - tests/**agent**
expectedUserBehavior:
  - The same Agents page manages both kernels and deletion preserves historical provenance.
requiredProfiles: [fast, comms]
requiredRules:
  - kernel-capability-isomorphism
  - backend-communication-boundary
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/contract/domains/agents.test.ts
  - pnpm run typecheck
acceptance:
  - Same-name native agents cannot collide across kernels.
  - Every run freezes agent, workspace, model and kernel provenance.
docs:
  required: true
---

## Scope

M10 agent domain isomorphism.
