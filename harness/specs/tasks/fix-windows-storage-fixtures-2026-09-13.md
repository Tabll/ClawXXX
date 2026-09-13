---
id: fix-windows-storage-fixtures-2026-09-13
title: Isolate real SQLite fixture bootstrap from runtime behavior contracts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the remaining Windows storage-contract failures from build 25, preserve native SQLite durability and dual-kernel semantics, then push and dispatch a new complete staging build.
touchedAreas:
  - tests/**
  - harness/**
  - TODO.md
  - .github/workflows/kernel-runtime-build.yml
requiredProfiles:
  - fast
  - comms
requiredRules:
  - kernel-runtime-distribution
  - unified-conversation-storage
  - backend-communication-boundary
  - comms-regression
  - docs-sync
expectedUserBehavior:
  - OpenClaw and DeepSeek Harness continue using the same Main-owned Conversation and Cron authority with unchanged production behavior.
  - CI verifies concurrent dispatch, exact persisted run identity, Channel delivery, checkpoint restoration and no native history without repeatedly compiling an empty schema inside each behavior deadline.
  - Fixture preparation never reads user databases or installed runtime data, and every test receives independent physical SQLite files.
requiredTests:
  - pnpm exec vitest run tests/unit/canonical-sqlite-fixture.test.ts tests/unit/kernel-runtime-build.test.ts tests/contract/domains/scheduler.test.ts tests/contract/kernels/openclaw-conversation-store.test.ts tests/contract/data/scheduler-schema-migration.test.ts tests/contract/data/channel-schema-migration.test.ts tests/contract/data/usage-schema-migration.test.ts
  - pnpm test
  - pnpm run kernel:sources:verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - git diff --check
acceptance:
  - Each affected suite creates a fresh pristine schema through the real production DataService in a separately bounded setup hook, closes it before copying, and never caches seeded business data or shares a writable database across tests.
  - Fixture copies are exclusive ordinary file copies with explicit fsync and hash validation; unsafe source state, existing destinations, mutation and use after disposal fail closed.
  - Regression tests prove fresh schema creation, WAL/FULL production connections, independent file identity, isolated Conversation/Cron state and persistence after reopening. Existing fresh-database and migration contracts remain unchanged.
  - Dual-kernel scheduling uses actual admission and post-write terminal observers, proves both runs active together before release, and verifies exact delivery identity and durable completion.
  - The full real OpenClaw hydrate/compact/branch/checkpoint/close/reopen/restore chain remains within one unchanged five-second behavior test; all existing assertions remain.
  - No production storage code, fsync policy, default or existing per-test timeout, skip, retry, native allowlist, signing gate or frozen runtime input is relaxed.
  - Always-uploaded evidence distinguishes fixture bootstrap from behavior phases, and the complete build is dispatched against the newly pushed main SHA through normal staging approval.
docs:
  required: true
---

Build #25 (`34740208842`, `979e70f4`) passed all eight non-Windows build jobs
and same-source three-platform E2E #44. Both Windows canonical suites failed
different existing compound tests at 5000 ms. The repaired deadline/drain
contracts and individually named executable checks passed on the runners.

OpenClaw's journal records 3490 ms before first admission, 4526 ms before close,
and all restored-history assertions by 5225 ms; its earlier identical closure
gate passed. DSH Windows timed out the simultaneous-kernel scheduler test,
which still polls an early request array and mixes schema construction with
two runs and delivery. Logs establish the exhausted deadline, not the specific
cause of host I/O latency or a production durability defect.

Keep native SQLite and all runtime assertions. Restrict the fixture optimization
to tests whose subject is behavior on an initialized database; schema and
fresh-database contracts must continue constructing their own databases. Record
evidence in `harness/reference/kernel-upgrade-2026-09-12.md`. Local results do not
replace Windows or signed-artifact acceptance.
