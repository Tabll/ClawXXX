# ClawX Architecture

This document provides the detailed version of the Architecture section in the README.

## ClawX 0.6 multi-kernel authority

ClawX is now a host for optional, independently versioned kernels. OpenClaw is no longer part of the base installer; OpenClaw and DeepSeek Harness are installed from signed CI-built runtime artifacts and may run concurrently. The existing Renderer is shared in full: it knows canonical ClawX domain contracts, never an upstream session/config protocol.

```text
React Renderer
  -> typed Host API / Host events
Electron Main domain services
  -> ClawXDataService utility process -> one SQLite + content-addressed Blobs
  -> ConversationRouter / Scheduler / Channel Orchestrator / Credential Broker
  -> KernelPackageManager + SupervisorRegistry
       -> OpenClawDriver -> downloaded OpenClaw runtime
       -> DeepSeekHarnessDriver -> downloaded DSH runtime host
       -> future KernelDriver implementations
```

SQLite is the only durable authority for all new Conversation, Cron, Channel, Usage, Agent/Provider/Skill state and runtime operations. A runtime never opens the database and never owns a second transcript or scheduler history. ACP and the DSH bridges are live execution transports; every event is scoped by conversation, run, kernel, generation and sequence before DataService accepts it. One Conversation may change its next execution kernel only at a turn boundary, and only portable, visibility-filtered context is compiled for the target kernel.

Package installation is transactional: the Main process verifies the signed, expiring catalog and descriptor, streams a bounded archive with resume, extracts into staging without links/traversal, runs artifact/platform/storage self-tests, and atomically activates a version. Each kernel has an independent supervisor, directory, port/stdio bridge, operation queue, health state and rollback slot. Stopping, crashing, repairing or updating one cannot replace the other.

The OpenClaw-specific Gateway/configuration material later in this document describes the `OpenClawDriver` adapter, not a global host architecture. DeepSeek Harness uses the same Host API/domain layer through its patched ACP/control/persistence bridges. See the [full multi-kernel design](../zh-CN/multi-kernel-design.md), [runtime security/support policy](runtime-security-support.md), and [data security/retention policy](data-security-retention.md).

ClawX uses a **Main-owned multi-process architecture with a unified Host API layer**. The renderer calls one client abstraction; Electron Main owns the DataService utility process, runtime selection, protocol adapters and process lifecycles.

OpenClaw configuration delivery is an adapter projection managed by Electron Main. When the optional Gateway is running, ClawX applies projected state through `config.get`/`config.set`; while it is stopped or starting, the coordinator updates its replaceable managed JSON5 configuration without starting it. Canonical provider, agent, channel, binding, skill and model intent remains in SQLite. Ordinary projection changes do not replace the process; full restarts are reserved for launch-environment changes such as proxy settings and explicit user actions. Heartbeat recovery is scoped to the owned OpenClaw supervisor and cannot restart another kernel. After authentication metadata is committed, secrets remain in the OS credential store and OpenClaw receives a scoped `secrets.reload` notification.

For OpenClaw execution, Main owns an ACP stdio bridge and gives it only the admitted Conversation snapshot, run identity, scoped credentials and workspace grants. The bridge never loads UI history from the runtime. If guarded recovery interrupts an accepted run, the patched runtime emits explicit lineage for the replacement process/run; ConversationRouter accepts only matching kernel, generation, run and monotonic event sequence. OpenClaw still implements projected runtime capabilities such as models, skills and diagnostics, but their durable ownership stays in ClawX domain services.

### Live Adapter Semantics and Canonical History

ACP is authoritative only for the live execution semantics emitted by an admitted OpenClaw run. The DSH bridges have the same role. Main normalizes text, reasoning, tool, permission, plan, usage, image and resource events into `KernelEventEnvelopeV1`; ConversationRouter then validates identity and writes them through DataService. Neither transport may provide Conversation catalog/history, Cron history or Usage history to the UI.

SQLite Conversation records are the sole history source. Opening or reloading a Conversation projects canonical turns, content blocks, runs, tool calls, permissions, usage and timestamps into the existing Chat timeline without invoking runtime `session/load`, reading JSONL or scanning a runtime directory. Missing canonical records remain missing; no transcript, Gateway or native-history fallback reconstructs them. Compatibility API names that remain for older callers are facades over the same Conversation repository, not another store.

An unfinished response continues streaming when another Conversation or page is opened. Its live snapshot remains isolated by Conversation/run/kernel/generation; terminal commit writes the final assistant turn and associated records atomically. Returning before completion resumes the in-memory stream, while returning after completion reloads the same durable SQLite projection.

Assistant turn duration comes from canonical run admission and terminal timestamps. Attachments, generated images and file activity are persisted as canonical content blocks and structured run events. Standard ACP/DSH resources and images are normalized at the adapter boundary during live execution; historical rendering never parses `MEDIA:` text or a native transcript. User images render as thumbnails, other resources as attachment cards, and all local-file actions are revalidated by Electron Main against the exact Conversation/run workspace grant.

Existing local file references, including paths outside the active workspace, are revalidated in Electron Main for the exact session and generation before every preview or open. Previewable local attachments produced by the AI, including `.docx` and `.pptx` files within the 20 MB inline-preview limit, keep their primary read-only in-app preview action and provide a secondary menu for opening with compatible applications or revealing the file in Finder, File Explorer, or the system file manager. For local HTML attachments, that menu starts with an action that opens the file in the right-side Preview tab.

The same Office limitations apply here: `.doc` and `.ppt` remain system-open formats, DOCX pagination may differ from Microsoft Word, and PPTX animations, transitions, and media playback are unsupported. Compatible-application discovery is available only on macOS and Windows and silently degrades to reveal-only behavior on Linux or when discovery fails. Other local files, including Office files larger than 20 MB, open in the system application after a user click. User-selected folder attachments remain available after send and open in the system file manager; ClawX does not read or preview their contents. Remote HTTP and HTTPS attachments open externally after a user click. Bare or inline prose paths without canonical media facts are not treated as attachments.

Generated image previews are displayed only from trusted structured runtime events that were accepted into the canonical run. Task-correlated final replies preserve their original user-facing completion text, including text-only failures. ClawX loads previews through Main-owned media handling rather than arbitrary Renderer filesystem access.

### ACP File Activity Semantics

- File activity is projected from successful, completed OpenClaw `write`, `edit`, and `apply_patch` calls. Tool recognition follows the official OpenClaw Chat UI; filtering to completed calls is specific to ClawX.
- Created and modified activity rows use the same file-card shell and **Open with** menu as previewable assistant attachments while retaining their status and optional `+/-` summary. For HTML files, the first menu item opens the file in the right-side **Preview** tab. Deleted rows keep only the **Changes** action. Every application-list, selected-application, and reveal request is independently revalidated in Electron Main from the workspace root and relative path. Tool-derived paths never become attachments or expose canonical native paths to the renderer.
- A `write` is shown as the tool declares it: a creation with an all-added diff, even if the path may already exist.
- **Changes** is a chronological, session-level record of tool-declared activity. It is not Git output or a verified diff against a source baseline.
- For each file, Changes renders at most one diff editor per assistant turn. Sequential fragments are composed when safe; independent fragments share one concatenated editor without claiming a complete-file baseline.
- Side effects made by shell commands, scripts, users, or IDEs are not detected.
- Canonical Conversation projection restores recorded file activity. If its structured records are absent, ClawX does not infer activity from prose, the filesystem or runtime history.

```
┌──────────────────────────────────────────────────────────────────┐
│                        ClawX Desktop App                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Electron Main Process                         │  │
│  │  • Window and application lifecycle management              │  │
│  │  • Gateway process supervision                              │  │
│  │  • System integration (tray, notifications, keychain)       │  │
│  │  • Auto-update orchestration                                │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ IPC (authoritative control plane)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              React Renderer Process                               │
│  • Modern component-based UI (React 19)                           │
│  • State management with Zustand                                  │
│  • Unified host-api/api-client calls                              │
│  • Markdown assistant replies, literal user input                 │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ Typed IPC requests
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                Main Host Services and Gateway Manager             │
│  • host:invoke typed service dispatcher                            │
│  • Settings, files, sessions, skills, providers, diagnostics      │
│  • Main-owned Gateway WebSocket and process supervision            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ Main-owned WebSocket
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                              │
│  • AI agent runtime and orchestration                              │
│  • Message channel management                                     │
│  • Skill/plugin execution environment                             │
│  • Provider abstraction layer                                     │
└──────────────────────────────────────────────────────────────────┘
```

### Design Principles

- **Process Isolation**: The AI runtime operates in a separate process, keeping the UI responsive even during heavy computation.
- **Single Entry for Frontend Calls**: Renderer requests go through `host-api` / `api-client`; protocol details are hidden behind a stable interface.
- **Main-Process Transport Ownership**: Electron Main owns the ACP Chat stdio bridge and Gateway transports; the renderer talks to Main over typed IPC.
- **Extension IPC Contributions**: Main-process extensions contribute host-api actions through the typed IPC registry instead of HTTP routes.
- **Graceful Recovery**: Built-in reconnect, timeout, and backoff logic handles transient failures automatically.
- **Secure Storage**: API keys and sensitive data use the operating system's native secure storage mechanisms.
- **CORS-Safe by Design**: The renderer does not call local Gateway or Host API HTTP endpoints directly.

### Gateway Liveness Recovery

Gateway liveness is decided in Electron Main. WebSocket pong frames are useful transport evidence. On ordinary transport loss, Main first follows its existing Gateway WebSocket reconnect path. ClawX uses a three-minute no-liveness deadline, then verifies the core RPC router with `system-presence` before replacing a process it owns.

| Design point | Handling | Purpose |
| --- | --- | --- |
| Treat pong, any incoming Gateway frame, and every successful RPC as liveness* | Refresh `lastAliveAt` and cancel a stale deadline callback | Large AI operations, such as skill or tool calls, can delay pongs while the connection is serving real traffic; avoid treating that delay as a dead Gateway |
| Use one three-minute silence deadline | Before 180 seconds, record missed pongs only; do not alter the socket or process | Bound automatic recovery while preventing pong-only restarts |
| Verify the control plane at the deadline | Call `system-presence` RPC once with a 5-second timeout to confirm Gateway state from the control plane rather than a pure WebSocket signal; success resumes normal monitoring | Distinguish a silent event stream from a Gateway that cannot serve a core read RPC |
| Restart only an unavailable ClawX-owned process | A failed deadline probe requests the guarded Gateway restart path | Recover a genuinely unresponsive local child process |
| Never automatically stop an external Gateway | Prefer replacing/reconnecting only ClawX's WebSocket and report unavailable diagnostics | Avoid issuing shutdown to a process ClawX does not own |
| Keep authoritative lifecycle paths separate | Preserve existing WebSocket-close reconnect, code-1012 reload recovery, process-exit recovery, and manual restart | Prevent duplicate or competing stop/start operations |
| Do not track active workloads in this path | Apply the same deadline regardless of chat, tool, or cron activity | Keep liveness recovery focused on false restart prevention and process ownership |

> * This liveness-evidence design was inspired by [LobsterAI](https://github.com/netease-youdao/lobsterai).

### Process Model and Gateway Troubleshooting

- ClawX is an Electron app, so **one app instance normally appears as multiple OS processes** (main/renderer/zygote/utility). This is expected.
- Single-instance protection uses Electron's lock plus a local process-file lock fallback, preventing duplicate app launches in environments where desktop IPC or the session bus is unstable.
- During rolling upgrades, mixed old and new app versions can still have asymmetric protection behavior. For best reliability, upgrade all desktop clients to the same version.
- The OpenClaw Gateway listener should still be **single-owner**: only one process should listen on `127.0.0.1:18789`.
- Gateway readiness is based on OpenClaw core signals such as `system-presence`, `health`, and `status`. Memory or channel failures are shown as capability degradation rather than global Gateway failure.
- To verify the active listener:
  - macOS/Linux: `lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows (PowerShell): `Get-NetTCPConnection -LocalPort 18789 -State Listen`
- Clicking the window close button (`X`) hides ClawX to the tray; it does not fully quit the app. Use **Quit ClawX** in the tray menu for a complete shutdown.
