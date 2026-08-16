---
id: fix-acp-dev-node-runtime
title: Keep ACP on the ClawX-supported Node runtime in development
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent a user-installed Node version from stopping first-message ACP session creation after an OpenClaw upgrade.
touchedAreas:
  - harness/specs/tasks/fix-acp-dev-node-runtime.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - electron/utils/openclaw-cli.ts
  - tests/unit/openclaw-cli.test.ts
expectedUserBehavior:
  - Clicking New Chat and sending the first message creates and opens the new conversation in development builds.
  - Chat startup and first send do not depend on whichever Node executable happens to appear first on the developer shell PATH.
  - Packaged macOS and Windows keep using their existing ClawX-owned embedded runtimes.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - acp-chat-state-and-history
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-cli.test.ts
  - pnpm exec playwright test tests/e2e/chat-new-session-date.spec.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - A development Electron Main process launches embedded OpenClaw ACP with the Electron executable and `ELECTRON_RUN_AS_NODE=1`.
  - The selected development ACP runtime is the same ClawX-pinned Node family used by Electron utility processes, even when PATH contains an unsupported newer Node.
  - Non-Electron tooling may still use a real Node executable from PATH.
  - Packaged macOS Helper and packaged Windows bundled-node selection remain unchanged.
  - Focused unit and Electron E2E tests, typecheck, communication replay, and communication compare pass.
docs:
  required: false
---

## Failure Evidence

After the OpenClaw baseline upgrade, a development build launched ACP through the first `node` executable on PATH. On a machine with Node `v25.8.1`, OpenClaw rejected startup because the pinned runtime requires Node `>=25.9.0` in the Node 25 line (or its supported Node 22/24 ranges). The ACP child exited before `session/new`, so the first prompt could not publish or open a new conversation.

## Scope

- Make development Electron launches use Electron's pinned Node runtime for the ACP child.
- Preserve a PATH-based Node fallback for non-Electron callers and existing packaged runtime selection.
- Record the runtime-ownership invariant in the ACP Harness rule and cover it with a focused unit regression.

## Out Of Scope

- Relaxing or patching OpenClaw's Node version requirement.
- Installing, upgrading, or modifying the user's system Node installation.
- Changing Renderer session selection or sidebar reconciliation.
