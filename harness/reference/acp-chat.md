# Canonical Chat Architecture And Timeline

Status: current architecture reference, reviewed 2026-08-24.

Related scenario: `acp-chat-experience`

Related rules: `acp-chat-state-and-history`, `unified-conversation-storage`, `attachment-access-safety`, `renderer-main-boundary`

The `Acp*` names retained in some Renderer components describe the established timeline UI, not a persistence or backend boundary.

## Ownership And Flow

Electron Main owns `ConversationRouter`, kernel supervisors/drivers, context compilation, permission routing, cancellation, event sequencing, DataService calls, and attachment grants. Renderer owns only interaction state and projection of canonical records into the timeline.

```text
Chat UI -> typed Host API -> ConversationRouter -> SQLite admission
         -> selected kernel driver -> kernel event envelope
         -> SQLite event/terminal commit -> typed Host event -> Renderer timeline
History  -> conversations.get -> canonical projection -> Renderer timeline
```

OpenClaw may use ACP internally and DeepSeek Harness may use stdio JSONL, but both are hidden behind the same driver contract. Renderer does not call Gateway Chat, ACP replay, runtime session lists, transcript files, or a kernel loopback endpoint.

## Identity And Durability

Every run has exact `conversationId`, `turnId`, `runId`, `kernelId`, generation, Agent snapshot, workspace URI, and optional provider/model snapshot. These are assigned before dispatch and cannot be replaced by a native runtime ID. The router enforces one active run per Conversation while allowing different Conversations to run concurrently on different kernels.

User blocks and routing commit before runtime dispatch. Events use monotonic `eventSeq` with duplicate/conflict rejection. Terminal assistant blocks, outcome, checkpoint, and usage commit atomically. A terminal UI/catalog event is emitted only after commit. DataService startup marks unfinished runs `interrupted` before accepting work.

## History And Live Projection

`hostApi.conversations.get()` is the only history read. `projectConversationHistory()` converts canonical turns, blocks, runs, and events to the existing `AcpTimelineSnapshot`. It does not read a runtime or scan a transcript. History remains browseable with no kernel installed.

For a live run, generation-scoped kernel events reduce through the same timeline semantics. Renderer may retain a bounded memory snapshot while the user visits another route or Conversation; it is discarded/reconciled when the run settles or canonical history reloads. It is never a second ledger.

Assistant final events carry the complete canonical block array. Delta events append one block/chunk. Tool, reasoning, plan, permission, diagnostic, resource, and usage events keep their typed kind and cannot be inferred from prose.

## Timeline And Presentation

The conceptual timeline items remain message segments, thoughts, tool calls, permissions, and plans. First-seen event order is stable; a process item closes the current assistant text segment and later text creates a new segment. Optimistic user content is allowed only for the admitted run and coalesces with the canonical/live echo.

Display grouping is derived at render time: a user item starts a user group, and following non-user items form one assistant turn until the next user item. Copy includes assistant prose and excludes tool output. UI-only card expansion, scrolling, composer drafts, selected artifacts, and lightboxes stay outside canonical history.

The question directory is derived from visible canonical user turns, keeps duplicates separate, caps the UI list, and never changes Conversation width or persistence.

## Attachments And Generated Media

Canonical `resource-link`, image, and Blob-backed blocks are the preferred and durable representation. Main resolves every local reference through an exact Conversation/run/generation grant and revalidates preview/open/reveal operations; references are not bearer capabilities. Remote links are restricted to HTTP/HTTPS and open only after user action.

Kernel adapters may translate explicit structured media facts or strict whole-line media directives during the owning live run. Accepted data is committed as canonical blocks with source kernel/visibility. Runtime transcript scanning after the run is forbidden. See `harness/reference/acp-generated-media-and-diagnostics.md`.

## Cancellation And Permissions

Cancel targets the exact active run and generation. Permissions are interactive only for that run and are delivered back through Main to its owning driver. Navigation cannot redirect either operation to the newly visible Conversation. A stopped/uninstalled selected kernel disables new admission but never hides history.

## Validation Anchors

Primary anchors are `electron/conversations/conversation-router.ts`, `electron/services/chat-api.ts`, `src/stores/acp-chat-session.ts`, `src/lib/conversations/acp-projection.ts`, and `src/pages/Chat/**`.

Coverage includes `tests/contract/kernels/conversation-router.test.ts`, `tests/contract/kernels/kernel-driver-contract.test.ts`, `tests/unit/conversation-history-projection.test.ts`, `tests/unit/acp-chat-store.test.ts`, `tests/e2e/chat-acp-inline-timeline.spec.ts`, `tests/e2e/chat-acp-process-timeline.spec.ts`, and `tests/e2e/chat-acp-attachments.spec.ts`.
