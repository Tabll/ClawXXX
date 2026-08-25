---
id: unified-conversation-storage
title: Unified Conversation Storage
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - multi-kernel-runtime
requiredProfiles:
  - fast
  - comms
---

`ClawXDataService` and one local SQLite database are the sole durable authority for conversations, turns, content blocks, runs, runtime events, tools, permissions, usage, channel messages and delivery attempts, cron jobs, admissions, and runs.

The DataService is the only database-file owner and SQL executor. Renderer, Electron Main feature services, kernel processes, bridges, connectors, and schedulers use typed scoped APIs; they must not receive the SQLite path, open the database, or use native runtime history as a read fallback.

User turns and immutable run routing snapshots commit before runtime dispatch. Stream events use stable run/event identities and bounded batching. Terminal assistant content, usage, and run state commit atomically. Persistence failure stops new chat, cron, and channel admission rather than continuing with an unrecorded native transcript.

Conversation identity is independent of kernel. A later turn may choose another kernel, but context compilation sends only portable, authorized, redacted, and budgeted blocks. Private reasoning, secrets, revoked attachments, and kernel-specific opaque checkpoints do not cross kernels. One linear conversation has one active run; parallel work uses explicit branches.

Managed kernels must disable or replace durable native conversation, cron, channel-message, and usage persistence. Temporary files are disposable and never restart or UI authority. CI and packaged E2E must scan runtime directories after prompt, cancel, compact, restart, cron, and channel flows to prove there is no second durable history.

Legacy OpenClaw and DeepSeek history is not migrated, scanned, deleted, or silently used as fallback. Attachments and large artifacts may use a content-addressed blob store, but SQLite remains authoritative for their identity, order, ownership, authorization, and lifecycle.
