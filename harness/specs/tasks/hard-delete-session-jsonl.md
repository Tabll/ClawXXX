---
id: hard-delete-session-jsonl
title: Historical: hard-delete OpenClaw session JSONL
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Historical record of the pre-DataService deletion contract; it must not guide current Conversation persistence.
touchedAreas:
  - harness/specs/tasks/hard-delete-session-jsonl.md
  - harness/specs/rules/unified-conversation-storage.md
  - electron/services/conversations-api.ts
expectedUserBehavior:
  - This historical task does not define current user behavior.
requiredProfiles:
  - fast
requiredRules:
  - unified-conversation-storage
  - docs-sync
requiredTests:
  - tests/contract/data/blob-and-conversation-store.test.ts
  - tests/unit/chat-session-management.test.ts
acceptance:
  - Do not implement runtime JSONL deletion as the current Conversation contract; use canonical SQLite hard deletion and Blob reference cleanup.
docs:
  required: false
---

Historical task superseded by `design-unified-conversation-storage` and the M2/M7 implementation tasks. Runtime transcript files and `sessions.json` are no longer UI history, deletion, usage, or sidebar authority. Current deletion uses `conversations.delete({ hard: true })` against the SQLite DataService and removes canonical Blob references transactionally. Kernel adapters may perform best-effort cleanup of runtime-owned compatibility artefacts, but that cleanup cannot determine whether a Conversation exists or reintroduce per-kernel history storage.
