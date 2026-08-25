# Chat Workspace And Navigation

Status: current workspace reference, reviewed 2026-07-23.

Related scenario: `chat-workspace-and-navigation`

Related rules: `session-workspace-authority`, `sidebar-session-attention-authority`, `ui-i18n-design-tokens`, `office-preview-safety`, `web-browser-security-and-lifecycle`

Related tasks: `chat-workspace-context`, `sidebar-session-attention`, `office-document-preview`, `web-browser`

## Workspace Authority

The canonical Conversation `workspaceUri` is authoritative for a bound Conversation. The global workspace is only the default for a new Renderer-local placeholder. Resolution is:

1. `ConversationSummary.workspaceUri` from SQLite.
2. The selected global workspace for an unbound local Conversation.
3. The application default workspace when neither is set.

The same resolved workspace is passed to `ConversationRouter`, captured in the immutable run/Agent snapshot, and used by the composer, sidebar grouping, right-side browser, and attachment grants. A bound Conversation is read-only in the composer and is not moved when the global selection changes. Missing or unreadable paths show unavailable state instead of silently changing roots. A runtime-reported `cwd` may be diagnostic metadata but can never replace the canonical URI.

ClawX persists global/recent workspace selections and custom display labels through Main-owned settings APIs. On a new Conversation, the menu shows the default once, then deduplicated recent and known canonical paths, then the native folder picker. Custom labels never replace path identity. Targeted `@agent` sends use the canonical Agent workspace snapshot and create or select a Conversation through the same router boundary.

## First Send And Titles

First send submits the local Conversation ID, selected kernel, Agent, workspace, and raw prompt to `ConversationRouter`. Admission creates the canonical Conversation/turn/run atomically and derives the initial SQLite title from the user prompt. Only after acknowledgement does the Renderer clear `createdLocally` and allow the row into the sidebar.

Explicit rename writes `conversations.rename`. Runtime display names, ACP bridge identities, heartbeat metadata, transcript summaries, and UUID/date fallback labels never retitle a canonical Conversation. Context compilation may add kernel-specific working-directory instructions after persistence, but those envelopes are not title sources.

## Sidebar Navigation

Sessions are grouped by workspace, not by date bucket. The default workspace sorts first and other workspace labels use natural ordering. Within a group, activity sorts descending using:

1. Hydrated session last activity.
2. Summary `updatedAt`.
3. Timestamp parsed from the session key.
4. Zero.

Each group initially displays five sessions and loads five more at a time. Collapse and visible-count state are per workspace and in memory. Relative time and ordering use the same timestamp; actions replace the timestamp on hover or keyboard focus.

Non-default workspace headers expose a rename action on hover or keyboard focus. A custom name updates both the sidebar group and the composer workspace chip; the header and chip keep the full filesystem path in their title text.

Sidebar validates distinct non-default group paths through Main. A confirmed unavailable group shows a warning badge and destructive delete action; available, unresolved, and default groups do not. One confirmation hard-deletes the group's sessions sequentially across agents. Successful sessions disappear together, failed sessions remain for retry, and workspace recents/labels are removed only after the full group succeeds.

## Sidebar Session Attention

SQLite Conversation rows are the sole authority for sidebar run state. `ConversationRouter` emits post-admission and post-terminal `conversations:catalog-changed` events, and unknown IDs force `conversations.list` recovery. ACP replay, runtime session lists, transcript files, local sending state, and global Gateway events do not provide a second status source.

The trailing row content has strict `busy > unread > timeago` precedence. A canonical active run shows the localized busy indicator. An observed busy-to-idle transition shows unread until the Conversation is opened.

Read state follows visible Chat integration rather than the retained current-session key. Chat marks its session visible on mount and on each session-key change, clears visibility on unmount, and treats completion for that visible session as read. Routes such as Settings may retain the current key, but completion there remains unread. The sidebar click path also marks the session read synchronously before navigating to Chat.

The versioned attention store persists only exact-ID `observedBusy` and `unread`. DataService marks interrupted runs terminal before startup catalog reads. A run ClawX never observed cannot create unread state. Cron and channel-triggered work use the same canonical lifecycle as interactive work.

The complete projection, commit ordering, persistence, and restart recovery are documented in `harness/reference/sidebar-session-attention.md`.

## Workspace Browser And Local HTML Preview

The right panel tabs are Workspace, Preview, and Changes. Workspace keeps the store tab value `browser`; authorized local HTML opens in `preview`. The Workspace tree uses `react-arborist`, includes hidden files, uses relative path as node identity, and remains read-only: no edit, drag/drop, or multi-select. Agent and path tags replace the older `Workspace - agent` header. Home is compacted to `~`, the path's final segment remains visible, and the full value is available as a title.

File icons come only from trusted bundled assets. Selecting a file preserves the existing preview behavior and backend boundary.

Local HTML Preview uses one hardened Electron guest as an implementation detail. The HTML anchor marks the Preview body while the route-stable host mounted by `MainLayout` owns the guest. There is no browser tab, empty guest entry, Home page, or address bar. Stable selectors are `html-preview-anchor`, `html-preview-host`, and `html-preview-webview`. Its file-only security and inert-link contract is documented separately in `harness/reference/web-browser.md`.

## Office Document Preview

The Workspace and Preview surfaces support read-only `.docx` and `.pptx` files; legacy `.doc` and `.ppt` files remain system-open-only. Extension is authoritative, and compressed DOCX/PPTX input is limited to 20 MB before Renderer parsing. Scoped workspace and attachment references use only their authorized Host API read route and never fall back to a naked path. Workspace Browser intentionally retains its existing Host-validated absolute-path read flow.

DOCX generated content is isolated and its links are non-interactive. PPTX renders one slide at a time, and kept-mounted artifact surfaces conditionally mount it so the shared Electron Renderer has a single mounted PPTX viewer. Cleanup releases ClawX-owned resources and invokes public `destroy()` exactly once, while the reviewed dependency-owned retained-resource limitation remains accepted. Exact security and lifecycle requirements are in `harness/specs/rules/office-preview-safety.md`; dependency choices, rendering decisions, user-visible limitations, and future hardening are in `harness/reference/office-document-preview.md`.

## Question Navigation

The Chat question directory belongs to the active ACP timeline rather than workspace persistence. Its current behavior is documented in `harness/reference/acp-chat.md`.

## Validation Anchors

Key tests include `tests/unit/workspace-context.test.ts`, `tests/unit/session-title.test.ts`, `tests/unit/session-buckets.test.ts`, `tests/unit/sidebar-session-buckets.test.ts`, `tests/unit/use-new-chat-action.test.tsx`, `tests/unit/chat-store-session-label-fetch.test.ts`, `tests/unit/workspace-browser-body.test.tsx`, `tests/unit/office-file-viewers.test.tsx`, `tests/unit/chat-acp-page.test.tsx`, `tests/unit/artifact-panel-store.test.ts`, `tests/unit/artifact-panel.test.tsx`, `tests/unit/main-layout.test.tsx`, `tests/unit/web-browser-host.test.tsx`, `tests/e2e/chat-workspace-context.spec.ts`, `tests/e2e/chat-acp-attachments.spec.ts`, `tests/e2e/chat-file-changes.spec.ts`, and `tests/e2e/office-document-preview.spec.ts`.

This reference consolidates the former workspace sidebar, chat workspace context, sidebar workspace UI, and ACP working-directory title designs. The later flat activity-sorted sidebar supersedes the earlier recency buckets.
