# Sidebar Conversation Attention

Status: current architecture reference, reviewed 2026-08-24.

Related scenarios: `gateway-backend-communication`, `chat-workspace-and-navigation`, `multi-kernel-runtime`

Related rule: `sidebar-session-attention-authority`

## Authority

The SQLite Conversation catalog is the sole durable authority for sidebar rows and run state. `ClawXDataStore.listConversations()` derives `hasActiveRun` from canonical `runs` rows whose status is `admitted`, `running`, or `cancelling`. Runtime session lists, transcript files, ACP replay, Renderer `sending` state, and Gateway lifecycle notifications never create, delete, title, or mark a Conversation busy.

`ConversationRouter` owns every kernel run. After admission it emits a Main-internal `started` lifecycle event; after the terminal SQLite commit it emits `terminal`. Main projects both onto the typed `conversations:catalog-changed` Host event with exact `conversationId`, `kernelId`, `hasActiveRun`, and `updatedAt`. The subscription is mounted in `App`, so completion is observed while Chat is unmounted.

This is kernel-neutral. OpenClaw, DeepSeek Harness, and future kernels use the same event and the same SQLite row. An OpenClaw `sessions.changed` or `sessions.list` message is legacy runtime metadata and cannot update the catalog.

## Catalog Loading And Event Reconciliation

`useChatStore.loadSessions()` reads `hostApi.conversations.list({ limit: 100 })`; pagination and search remain DataService-owned. A successful page replaces durable rows while preserving only unsent Renderer-local placeholders. Selection falls back deterministically to an existing canonical row or a new local Conversation key.

For `conversations:catalog-changed`:

1. A known exact `conversationId` is patched with kernel participation, active state, status, and activity time.
2. A previously unseen ID forces a canonical list reload instead of fabricating a partial row.
3. Terminal state is emitted only after the durable terminal commit, so the Renderer never outruns SQLite.
4. App restart marks unfinished DataService runs `interrupted` before serving the catalog. A stale runtime cannot resurrect them.

There are no Gateway epochs, runtime list timestamps, event/list replay buffers, or runtime label hydration in the canonical path.

## Attention State

`src/stores/session-attention.ts` stores exact-key `{ observedBusy, unread }` presentation records. Its versioned persistence key remains `clawx.session-attention`; messages, tool state, titles, runtime IDs, and route state are never stored there.

The transition table is normative:

| Previous attention | Canonical projection | Visible Chat Conversation | Result |
| --- | --- | --- | --- |
| Any | Busy | Any | Set `observedBusy=true`; retain unread. |
| Observed busy | Idle | Same exact ID | Clear busy and unread. |
| Observed busy | Idle | Different ID or Chat unmounted | Clear busy and set unread. |
| No observed busy | Idle | Any | Do not invent unread. |
| Any | Unknown | Any | Preserve attention. |

The row presentation order is `busy > unread > timeago`. Activity timestamps never infer completion. An entirely unobserved offline run therefore does not manufacture unread state. If ClawX observed a run as busy and restarts before completion, DataService interruption recovery provides the durable idle transition needed to resolve it.

## Read Semantics

The visibly mounted Chat Conversation is read authority. Chat calls `setVisibleSession(id)` while mounted and clears it on unmount. Sidebar activation marks the exact ID read before navigation. Merely retaining `currentSessionKey` on Settings, Channels, or another route does not acknowledge completion.

Exact canonical deletion removes the row, attention, title cache, and activity metadata. Same-ID recreation starts with fresh attention. Missing rows in a filtered or paginated response do not prove deletion; explicit local deletion or a full canonical reload owns removal.

## Concurrency And Kernel Isolation

Two kernels may run concurrently only in different Conversations; the router enforces one active run per Conversation. Each lifecycle event carries its `kernelId`, and `kernelIds` records all participating kernels without changing Conversation identity. A global Gateway status change cannot clear, reload, or retitle a Conversation.

## Rejected Alternatives

- Runtime `sessions.list` / `sessions.changed`: OpenClaw-specific, unavailable when uninstalled, and incompatible with shared history.
- ACP replay or transcript scanning: not durable authority and cannot cover every kernel.
- Renderer-local `sending`: misses cron, channel, and externally initiated Main-owned runs.
- `updatedAt` inference: rename and metadata writes would create false unread completions.
- A second per-kernel catalog: splits identity and violates unified storage.
- A Renderer-owned socket or transport switch: violates the Main-owned communication boundary.

## Validation Anchors

Primary anchors are `electron/conversations/conversation-router.ts`, `electron/data/clawx-data-store.ts`, `electron/main/index.ts`, `shared/host-events/contract.ts`, `src/App.tsx`, `src/stores/chat.ts`, `src/stores/session-attention.ts`, and `src/components/layout/Sidebar.tsx`.

Focused coverage is in `tests/contract/kernels/conversation-router.test.ts`, `tests/unit/chat-session-management.test.ts`, `tests/unit/host-events.test.ts`, `tests/unit/session-attention.test.ts`, and `tests/e2e/chat-sidebar-session-attention.spec.ts`.
