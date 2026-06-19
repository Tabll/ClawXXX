---
id: chat-active-run-queue-steer
title: Queue chat follow-ups during active runs and allow steering queued messages
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Match OpenClaw Control UI active-run composer behavior by keeping follow-up messages in a local queue while a run is active, then allowing the user to steer a queued message into the active run through the existing Main-owned Gateway RPC boundary.
touchedAreas:
  - harness/specs/tasks/chat-active-run-queue-steer.md
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/styles/globals.css
  - shared/i18n/locales/*/chat.json
expectedUserBehavior:
  - The composer keeps its normal visual state while a run is active.
  - Submitting text while a run is active adds a visible queued follow-up card instead of resetting the active stream.
  - Up to five queued follow-ups are shown; extra submissions are rejected with a localized toast.
  - Deleting a queued follow-up removes it before it is sent.
  - Clicking the queued item's steer action sends that message to the active run through `chat.send`.
  - When the active run settles, queued follow-ups drain through the existing `sendMessage` path.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
requiredTests:
  - pnpm run typecheck:web
  - pnpm run build:vite
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Renderer uses `hostApi`/Gateway RPC and does not add direct IPC or direct Gateway HTTP fetches.
  - Active-run steering does not mutate the store's current streaming lifecycle.
  - Follow-up queue cards are localized and capped at five visible items.
docs:
  required: false
---

Use this task spec for the Chat composer active-run queue and steer interaction.
