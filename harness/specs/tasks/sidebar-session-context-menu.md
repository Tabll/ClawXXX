---
id: sidebar-session-context-menu
title: Sidebar conversation history actions
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Let users act on sidebar conversation history through context actions, header search, and the More menu without bypassing the Main-owned host API boundary.
touchedAreas:
  - harness/specs/tasks/sidebar-session-context-menu.md
  - src/components/layout/Sidebar.tsx
  - src/components/settings/ProvidersSettings.tsx
  - src/stores/chat.ts
  - src/stores/chat/session-actions.ts
  - src/lib/host-api.ts
  - shared/chat/types.ts
  - shared/host-api/contract.ts
  - electron/services/sessions-api.ts
  - shared/i18n/locales/*/common.json
  - shared/i18n/locales/*/chat.json
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - tests/unit/chat-session-actions.test.ts
  - tests/unit/chat-store-session-label-fetch.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/e2e/chat-new-session-date.spec.ts
expectedUserBehavior:
  - Right-clicking a visible sidebar conversation opens a localized context menu.
  - The context menu offers Pin to top for unpinned conversations and Unpin for pinned conversations.
  - Pinned conversations move into a Pinned bucket above date buckets and remain visible regardless of activity date.
  - Unpinned conversations return to the normal date buckets.
  - The context menu offers Rename and reuses the existing inline rename input, save, cancel, Enter, Escape, and blur behavior.
  - Pin state is persisted to the conversation's sessions.json metadata through the typed Main sessions service.
  - The sidebar header exposes a localized search button that opens a conversation search dialog.
  - Typing a keyword filters conversation history by visible title, stored title/display name, agent, or session key.
  - Clicking a search result switches to that conversation and returns to the chat route.
  - The sidebar header exposes a localized More settings button with a Batch operation option.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
requiredTests:
  - tests/unit/chat-session-actions.test.ts
  - tests/unit/host-services.test.ts
  - tests/e2e/chat-new-session-date.spec.ts
acceptance:
  - Renderer code continues to call `src/lib/host-api.ts`; no new direct `window.electron.ipcRenderer.invoke(...)` or direct Gateway HTTP calls are added.
  - Main validates agent ids parsed from session keys before writing sessions.json.
  - The existing session rename action remains the only rename implementation used by Sidebar.
  - Pin metadata supports both array-shaped and object-keyed sessions.json entries.
  - Local store state updates immediately after a successful pin/unpin so the sidebar reorders without requiring a Gateway refresh.
  - Search reads the already loaded sidebar session list and does not add renderer-side direct Gateway HTTP or IPC calls.
  - The Batch operation entry is present in the More settings menu for the initial batch-workflow affordance.
docs:
  required: true
---

Use this task spec for sidebar conversation history controls, including the
context menu, search dialog, and header More menu, while keeping session
metadata writes in the typed Electron Main host service.
