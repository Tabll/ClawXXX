---
id: session-workspace-authority
title: Conversation Workspace Authority
type: ai-coding-rule
appliesTo:
  - chat-workspace-and-navigation
  - acp-file-activity
  - gateway-backend-communication
  - multi-kernel-runtime
---

Canonical `Conversation.workspaceUri` is authoritative for a bound Conversation. Global workspace selection applies only to a new local placeholder. Main validates the workspace before run admission, captures it in the immutable Agent/routing snapshot, and uses the same value for context compilation, relative attachment resolution, sidebar grouping, workspace browsing, and file activity. Runtime-reported `cwd` is diagnostic metadata and MUST NOT replace the canonical URI.

Missing paths surface a localized unavailable state instead of repeatedly selecting a kernel or silently changing roots. Custom workspace names are display-only aliases keyed by canonical path. They never alter identity, attachment grants, run snapshots, or grouping.

First send passes the local Conversation ID, selected kernel, Agent, workspace, and raw prompt to `ConversationRouter`. Only successful admission clears `createdLocally` and exposes the row. The canonical title is seeded from the raw user prompt; runtime bridge names, heartbeat metadata, transcript summaries, working-directory envelopes, and UUID/date fallbacks MUST NOT retitle it. Explicit rename uses `conversations.rename`.

Targeted `@agent` sends use the target canonical Agent workspace snapshot and share one Conversation/run admission identity with navigation. Reactive loading cannot supersede the admitted delivery.

Attachment resolve/read/preview/open requests are validated by Main against an exact Conversation/run/generation workspace grant. Requests cannot provide or replace the execution workspace, and prior references are not bearer capabilities. Run or generation replacement revokes the prior grant.

Unavailable-workspace group deletion uses canonical `conversations.delete({ hard: true })`. Successful SQLite rows and Blob references disappear transactionally; failed deletions remain visible. Runtime transcript deletion is at most best-effort adapter cleanup and never determines canonical success.
