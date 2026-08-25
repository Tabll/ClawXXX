---
id: acp-chat-state-and-history
title: Canonical Chat State And History Authority
type: ai-coding-rule
appliesTo:
  - acp-chat-experience
  - acp-file-activity
  - gateway-backend-communication
  - multi-kernel-runtime
---

The SQLite DataService Conversation API is the sole durable Chat-history authority. Main owns kernel selection, context compilation, run admission, routing, cancellation, permission delivery, event sequencing, and terminal commit through `ConversationRouter`. Renderer loads `conversations.get`, projects canonical turns/runs/events into its in-memory timeline, and never reads runtime sessions, ACP replay, transcript files, or Gateway history as a fallback.

Every user turn and immutable routing snapshot MUST commit before runtime dispatch. Live events MUST carry exact Conversation, turn, run, kernel, generation, and monotonically increasing event identity. Duplicate or stale events are ignored. Terminal assistant blocks, usage, checkpoint, and run outcome MUST commit atomically before Main publishes the terminal catalog lifecycle event. Persistence failure MUST stop admission instead of allowing an unrecorded runtime-only conversation.

An optional kernel adapter MAY use ACP, stdio JSONL, or another native protocol internally, but native session IDs and replay are implementation details. Adapters translate native events into the shared kernel envelope; they do not choose durable IDs, workspace, Agent, provider, or model. OpenClaw-specific recovery lineage is accepted only when it matches the pending canonical run and generation. DeepSeek Harness and future kernels follow the identical router contract.

Renderer MAY retain a bounded live timeline snapshot across navigation so an acknowledged prompt stream is not dropped, but that state is memory-only and is reconciled with the next canonical read. Permission requests are interactive only for the active canonical run. No second ACP ledger, reduced-history database, runtime transcript cache, or per-kernel Conversation store is allowed.

Structured resources, attachments, image-generation results, tool calls, reasoning visibility, and diagnostics MUST enter history as canonical content blocks or run events. Kernel-specific compatibility data MAY be translated before commit under `acp-compatibility-content-safety`; it cannot reconstruct ordinary history after the fact.
