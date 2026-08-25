---
id: acp-chat-experience
title: ACP Chat Experience
type: user-visible-flow
ownedPaths:
  - shared/acp-chat/**
  - shared/host-api/contract.ts
  - shared/file-preview/**
  - electron/services/acp-chat-service.ts
  - electron/services/acp-session-access-registry.ts
  - electron/services/acp-trace.ts
  - electron/services/attachment-access.ts
  - electron/services/attachment-open-with.ts
  - electron/services/files-api.ts
  - electron/main/index.ts
  - resources/scripts/attachment-open-with.ps1
  - src/lib/acp/**
  - src/lib/file-preview-client.ts
  - src/lib/file-preview-capabilities.ts
  - src/lib/generated-files.ts
  - src/components/file-preview/**
  - src/stores/acp-chat-session.ts
  - src/pages/Chat/**
  - tests/unit/acp-*.test.ts
  - tests/unit/acp-*.test.tsx
  - tests/unit/attachment-open-with.test.ts
  - tests/unit/attachment-open-with-native.test.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
  - tests/e2e/chat-acp-attachments.spec.ts
  - tests/e2e/chat-run-state-events.spec.ts
  - tests/e2e/chat-streamdown-rendering.spec.ts
  - tests/e2e/chat-code-block-wrap.spec.ts
  - tests/e2e/chat-latex-rendering.spec.ts
  - tests/e2e/chat-assistant-markdown-plain.spec.ts
  - tests/e2e/chat-table-header-light.spec.ts
  - tests/e2e/hardware-acceleration.spec.ts
  - tests/e2e/renderer-performance.spec.ts
requiredProfiles:
  - fast
  - comms
conditionalProfiles:
  e2e:
    - ACP timeline presentation changes
    - Chat Markdown rendering, syntax highlighting, or animation changes
    - send, cancel, permission, media, or history behavior changes
requiredRules:
  - renderer-main-boundary
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - attachment-access-safety
  - diagnostics-trace-safety
  - session-workspace-authority
  - tool-derived-file-safety
  - office-preview-safety
  - ui-i18n-design-tokens
  - markdown-rendering-safety-and-performance
  - electron-rendering-performance
  - comms-regression
  - docs-sync
---

Canonical Chat covers Conversation history, prompt admission, per-turn kernel selection, cancel, permission, live event reduction, assistant-turn presentation, standard attachments, bounded adapter media compatibility, and Chat diagnostics. The legacy `Acp*` component/store names describe the timeline UI; they do not make ACP a persistence boundary. The attachment flow includes scoped preview, system open, selected-application open, reveal actions, and built-in Preview for eligible local HTML. Authorized DOCX/PPTX attachments within the Office limit use scoped Preview; remote, legacy, and over-limit files retain scoped system/external-open behavior. User-selected directories remain system-open-only targets.

Main owns `ConversationRouter`, kernel drivers, DataService commits, workspace grants, and Conversation/run/generation-scoped attachment authorization. Renderer owns only the in-memory projection, attachment presentation, and display grouping. `conversations.get` is authoritative for historical turns and content; runtime replay/transcripts are never fallback history. Canonical structured content is preferred over adapter compatibility, and incidental tool paths never enter the attachment pipeline.

The durable architecture, exceptions, access boundary, file-activity separation, Office preview behavior, Markdown rendering, Electron rendering performance policy, and validation anchors are documented in `harness/reference/acp-chat.md`, `harness/reference/acp-generated-media-and-diagnostics.md`, `harness/reference/acp-attachment-access-control.md`, `harness/reference/openclaw-file-activity.md`, `harness/reference/office-document-preview.md`, `harness/reference/markdown-rendering.md`, and `harness/reference/electron-rendering-performance.md`.
