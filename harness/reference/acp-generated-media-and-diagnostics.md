# Canonical Generated Media And Diagnostics

Status: current compatibility reference, reviewed 2026-08-24.

Related scenario: `acp-chat-experience`

Related rules: `acp-chat-state-and-history`, `acp-compatibility-content-safety`, `attachment-access-safety`, `diagnostics-trace-safety`

## Preferred Path

Generated images and attachments are canonical content blocks. Binary data is stored once in the Blob store and referenced by hash; remote resources use validated HTTP/HTTPS resource links. The selected kernel driver emits the structured result during the owning run, and `ConversationRouter` commits it with the assistant turn or run event.

OpenClaw ACP, DeepSeek Harness stdio, and future native protocols are adapter details. Renderer consumes the same canonical block model and never performs runtime transcript retrieval to discover missing media.

## Bounded Adapter Compatibility

An adapter may translate structured native media fields, canonical assistant media facts, or an explicit whole-line media directive before terminal commit when the native protocol has no standard resource event. It must:

1. match the exact run and generation;
2. retain source kernel and a reason-coded diagnostic;
3. accept only absolute/authorized local paths, workspace-relative paths, `file:`, HTTP, or HTTPS references;
4. reject unknown schemes, fenced/inline prose, malformed quotes, incidental tool paths, and ambiguity;
5. resolve local data through Main attachment authorization; and
6. deduplicate by canonical block/blob/event identity.

Compatibility translation may recover only declared media/reference data and a task-correlated caption or failure message. It cannot reconstruct surrounding assistant prose, ordinary turns, tools, reasoning, plans, permissions, titles, timing, usage, or file activity. Runtime transcript JSONL and Gateway history are not permitted inputs.

When equivalent native structured content arrives, it wins. An unavailable compatibility candidate does not reserve identity or block a later valid event.

## Attachment Security

Every local resolve, thumbnail, preview, Open With, reveal, or system-open call is revalidated against the Conversation/run/generation grant. A previous resolve, blob hash, native message ID, or displayed path does not authorize a later operation. HTTP/HTTPS references are parsed and checked again before external open.

Diagnostics never contain message bodies, media bytes, raw attachment references, credentials, or full sensitive filesystem paths. Reason codes and bounded structural metadata are sufficient for projection debugging.

## Trace Channel

Main may retain a bounded memory-only trace ring for summarized driver lifecycle and projection decisions. Entries use monotonic sequence, ISO time, kernel/run identity, and sanitized reason metadata. Trace recording is best effort, untrusted Renderer input is sanitized, and trace failure cannot alter Chat behavior. The trace is not a history source and is never persisted as a transcript.

## Rejected Alternatives

- Post-run transcript scans or retries.
- Reconstructing media from arbitrary prose/bare paths.
- Renderer access to kernel media directories.
- Per-kernel media/history databases.
- Manufacturing a native protocol event from compatibility evidence.

## Validation Anchors

Key coverage includes `tests/unit/acp-image-generation-compat.test.ts`, `tests/unit/acp-media-attachments.test.ts`, `tests/unit/attachment-access.test.ts`, `tests/unit/acp-trace.test.ts`, `tests/contract/data/blob-and-conversation-store.test.ts`, and `tests/e2e/chat-acp-attachments.spec.ts`.
