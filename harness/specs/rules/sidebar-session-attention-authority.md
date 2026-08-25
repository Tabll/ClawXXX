---
id: sidebar-session-attention-authority
title: Sidebar Session Attention Authority
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - chat-workspace-and-navigation
---

Sidebar attention MUST derive only from canonical SQLite Conversation rows and Main-owned `conversations:catalog-changed` lifecycle events. Rows and attention MUST match by exact Conversation ID. Runtime session lists/events, ACP replay, transcript data, local sending state, and global Gateway lifecycle events MUST NOT create, delete, retitle, or override a Conversation row.

Conversation list/search/pagination MUST use the DataService Host API. A known lifecycle event MAY patch `hasActiveRun`, kernel participation, and activity time; an unknown ID MUST force canonical reload instead of inserting a partial row. Terminal events MUST be published only after the SQLite terminal commit. DataService startup MUST interrupt unfinished runs before catalog reads.

Unread MUST arise only from an observed exact-ID busy-to-idle transition, never from `updatedAt`; entering busy MUST retain any older unread bit, with presentation ordered `busy > unread > timeago`. Unknown state MUST preserve attention.

Only exact-key observed-busy and unread presentation state MAY persist. Visibility MUST remain memory-only. A conversation is read only while its Chat view is visibly mounted or when its sidebar row is activated; retaining `currentSessionKey` on another route is not read authority.

Global Gateway epochs MUST NOT reload or reconcile the Conversation catalog. Missing rows in filtered or paginated results MUST NOT prune attention. Exact canonical deletion MUST clear attention and metadata; same-ID recreation starts a new attention incarnation.

Algorithms, rationale, concurrency semantics, and validation anchors are defined in `harness/reference/sidebar-session-attention.md`.
