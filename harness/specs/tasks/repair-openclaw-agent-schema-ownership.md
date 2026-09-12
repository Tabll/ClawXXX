---
id: repair-openclaw-agent-schema-ownership
title: Preserve OpenClaw-owned Agent schema and repair the backed-up local database
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Back up the old Agent database, prove repair on isolated copies, then restore local startup without resetting user data.
touchedAreas:
  - electron/**
  - scripts/kernel-runtime/**
  - tests/**
  - harness/**
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - TODO.md
  - package.json
  - .gitignore
  - .github/workflows/electron-e2e.yml
expectedUserBehavior:
  - Auth synchronization never downgrades OpenClaw-owned schema metadata or resets native state.
  - The user's Agent database is backed up before repair and the repair is proven on an isolated copy before any live replacement.
  - The real Electron development app starts and restarts its OpenClaw Gateway successfully after repair.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - e2e-parallel-isolation
  - docs-sync
requiredTests:
  - pnpm test
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run test:e2e
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Stop relevant writers before snapshots and live repair; retain rollback material with restrictive permissions and exclude it from Git.
  - Compare database integrity, foreign keys, schema and row fingerprints without printing credentials or private conversation content.
  - Use the selected kernel's actual schema and migration rules, never blindly bump version numbers or discard incompatible tables.
  - Auth writes preserve schema ownership and existing credentials; malformed, unknown or newer schema cases fail safely.
  - Real Electron regression covers existing Agent state and auth synchronization across kernel restart, not only an empty Gateway.
  - Leave canonical Conversation, Cron, Agents, Skills and usage storage intact; do not enable native conversation-history fallback.
  - No commit, push, remote release or COS mutation is requested.
docs:
  required: true
---

Follow-up to fix-electron-kernel-node-launch. The standalone Node fix exposed
exit 78 and session_participants schema drift. Local auth synchronization writes
PRAGMA user_version = 1 and schema_meta.schema_version = 1 unconditionally.
Investigate whether this is true legacy schema or incorrectly downgraded markers
before choosing the smallest data-preserving repair. Prior-turn uncommitted
Node-launch changes are part of the tested worktree and must be preserved.

See harness/reference/electron-kernel-node-launch.md for the initial incident.
See harness/reference/openclaw-agent-schema-ownership.md for the repair contract
and backed-up local evidence.
