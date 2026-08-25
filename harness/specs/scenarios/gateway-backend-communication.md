---
id: gateway-backend-communication
title: Gateway Backend Communication
type: runtime-bridge
ownedPaths:
  - src/lib/api-client.ts
  - src/lib/host-api.ts
  - src/stores/gateway.ts
  - src/stores/chat.ts
  - src/stores/chat/**
  - src/stores/session-attention.ts
  - src/stores/chat/session-status.ts
  - src/stores/chat/session-catalog.ts
  - electron/main/ipc/**
  - electron/services/**
  - electron/gateway/**
  - electron/preload/**
  - electron/utils/**
  - patches/openclaw@2026.7.1-2.patch
  - tests/unit/session-attention.test.ts
  - tests/unit/session-status.test.ts
  - tests/unit/session-catalog.test.ts
  - tests/unit/gateway-events.test.ts
  - tests/unit/gateway-event-dispatch.test.ts
  - tests/unit/chat-session-management.test.ts
  - tests/unit/chat-store-session-label-fetch.test.ts
  - tests/unit/openclaw-lm-studio-tool-schema-patch.test.ts
  - tests/unit/session-label-hydration.test.ts
  - tests/e2e/chat-sidebar-session-attention.spec.ts
  - shared/web-browser.ts
  - electron/main/web-browser-policy.ts
  - electron/main/web-browser-session.ts
  - electron/services/web-browser-api.ts
  - tests/unit/web-browser-url.test.ts
  - tests/unit/web-browser-policy.test.ts
  - tests/unit/web-browser-session.test.ts
  - tests/unit/web-browser-api.test.ts
requiredProfiles:
  - fast
  - comms
conditionalProfiles:
  e2e:
    when:
      - user-visible gateway status changes
      - user-visible chat send/receive behavior changes
      - channels/agents/settings UI depends on new backend response shape
      - Web Browser guest, navigation, session, permission, or data policy changes
requiredRules:
  - openclaw-config-delivery
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - gateway-readiness-policy
  - gateway-heartbeat-safety
  - channel-plugin-migration-guards
  - capability-owner-resolution
  - active-config-guards
  - provider-default-invariant
  - provider-model-metadata-preservation
  - provider-model-selection-authority
  - sidebar-session-attention-authority
  - web-browser-security-and-lifecycle
  - e2e-parallel-isolation
  - comms-regression
  - openai-compatible-tool-schema-compatibility
  - kernel-runtime-distribution
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
  - docs-sync
forbiddenPatterns:
  - window.electron.ipcRenderer.invoke in src/pages/**
  - window.electron.ipcRenderer.invoke in src/components/**
  - fetch('http://127.0.0.1:18789 in src/**
  - fetch("http://127.0.0.1:18789 in src/**
  - fetch('http://localhost:18789 in src/**
  - fetch("http://localhost:18789 in src/**
  - new WebSocket('ws://127.0.0.1:18789 in src/**
  - new WebSocket("ws://127.0.0.1:18789 in src/**
  - new WebSocket('ws://localhost:18789 in src/**
  - new WebSocket("ws://localhost:18789 in src/**
---

Gateway backend communication covers all ClawX paths that move data between the visual desktop UI and OpenClaw runtime/backend services.

The proposed multi-kernel evolution keeps this scenario authoritative for every Renderer/Main/Host API/runtime communication path. Conversation/run identity, runtime package lifecycle, concurrent-driver isolation, the single DataService/SQLite authority, and cross-kernel canonical projections are additionally governed by `harness/reference/multi-kernel-runtime.md`; introducing a second runtime must not create a Renderer-owned transport or persistence path or weaken the existing communication boundary.

Coordinator-owned OpenClaw config mutations and their `config.get`/`config.set` transaction contract are documented in `harness/reference/openclaw-config-delivery.md`.

Allowed flow:
Renderer page/component -> `src/lib/host-api.ts` or `src/lib/api-client.ts` -> Electron Main typed host service or IPC handler -> Main-owned OpenClaw Gateway WebSocket -> runtime result -> store/UI.

Renderer code must not own transport selection, direct IPC channels, direct Gateway HTTP calls, retry policy, or protocol fallback.

Renderer code must not create direct Gateway WebSocket connections. Gateway frame diagnostics must be emitted by Main-process Gateway logging.

The bundled OpenClaw tool catalog must remain valid for supported OpenAI-compatible runtimes. In particular, JSON Schema string patterns sent to LM Studio must be explicitly anchored, avoid constructs that produce invalid llama.cpp GBNF, retain their original validation semantics, and avoid finite bounds that expand beyond llama.cpp's grammar repetition limit; durable compatibility fixes belong in the registered pnpm patch and require installed-bundle regression coverage.

Typed generic Gateway RPC requests are validated by `electron/services/gateway-api.ts` and delegated to `GatewayManager.rpc` only for allowlisted OpenClaw-specific capabilities. Chat history and delivery do not use that path: the Renderer selects a kernel through the typed Host API, `ConversationRouter` owns admission/send/cancel, and the DataService Conversation API is the sole UI history authority. ACP/runtime history is neither a durable source nor a fallback.

Channel/plugin migration behavior is also part of this scenario when ClawX rewrites OpenClaw config before Gateway launch. Upgrades must preserve single-owner channel registration for migrated plugin-backed channels such as Feishu/Lark.

ClawX's prelaunch config sanitizer also owns desktop tool policy. It must keep `web_search` in both the agent-level and Gateway-level deny lists without replacing existing deny entries or disabling managed browser automation and `web_fetch`. It must also deny the agent-facing `gateway`, `nodes`, `create_goal`, `get_goal`, and `update_goal` tools at both layers while preserving application-owned Gateway RPCs. Messaging, session orchestration, and agent discovery tools remain available unless another explicit policy denies them.

Scheduled tasks are canonical SQLite entities owned by the Main scheduler. Each trigger records an execution claim and routes through `ConversationRouter` into the selected kernel, so prompt, result, usage, retry, and terminal state live in the same Conversation/run tables as interactive work. Runtime cron lists, run-log files, and transcript recovery are never history authority.

The local HTML Preview privileged bridge is also Main-owned: Renderer may load a validated local HTML file or open that current file externally through the typed Host API. The guest is an implementation detail of the existing `preview` tab; there is no `web-browser` artifact tab or general address navigation. The durable guest contract is `harness/reference/web-browser.md`.

Canonical Conversation lifecycle events, attention transitions, and DataService restart recovery are documented in `harness/reference/sidebar-session-attention.md`. Electron test-process isolation and global-resource scheduling are documented in `harness/reference/e2e-parallelism.md`.

Gateway WebSocket heartbeat misses are diagnostic availability signals only and must never directly interrupt the socket or process. A pong, any incoming Gateway frame, or a successful Gateway RPC is trusted liveness evidence and resets the 180 seconds silence deadline. After one uninterrupted deadline, Main runs exactly one 5000ms `system-presence` verification. A successful probe records liveness and cancels recovery. A failed probe may request guarded restart only for a ClawX-owned process; for an externally managed Gateway, Main may reconnect its own transport and expose unavailable diagnostics but never stop, shut down, or restart the Gateway automatically. This path does not track chat, tool, cron, or other workloads. Process exit, ordinary socket close, code 1012, and explicit user restart retain their separate lifecycle behavior.
