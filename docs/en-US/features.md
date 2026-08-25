# ClawX Features

This document provides the detailed version of the Features section in the README.

### Optional Multi-Kernel Catalog

The base ClawX installer contains no AI kernel. On first use, install OpenClaw, DeepSeek Harness, both, or neither from the Kernel Catalog. Downloads are platform-specific, signed CI artifacts with progress, cancel/resume, repair, independent update/rollback, and diagnostics. Both kernels can remain active and stream work concurrently; a failure or update in one does not stop the other.

OpenClaw and DeepSeek Harness use the same Chat, Providers/Models, Agents, Channels, Cron, Skills, Usage and Diagnostics pages. “Both” operations preserve partial success instead of hiding a failed projection. A Conversation is independent of a kernel and can select another kernel for its next turn; the UI shows provenance while ClawX passes only portable, redacted history. No DeepSeek Web UI is embedded.

All new history is stored once in ClawX's SQLite/Blob store. Kernel uninstall does not remove it, so conversations remain searchable, renameable, exportable and deletable offline. New Cron jobs and Channel messages use the same Conversation/Run records. Existing upstream histories are intentionally not migrated or used as fallback. See [data security and retention](data-security-retention.md).

### Zero Configuration Barrier

Complete the entire setup from installation to your first AI conversation through an intuitive graphical interface. No terminal commands, YAML files, or environment-variable hunting are required.

### Intelligent Chat Interface

Communicate with AI agents through a modern chat experience. ClawX supports multiple conversation contexts and message history, with assistant replies rendered as streaming Markdown with syntax-highlighted fenced code, CJK-aware parsing, GitHub-flavored tables, and KaTeX-powered LaTeX math (`$inline$`, `$$block$$`, `\(inline\)`, and `\[block\]`). User input remains literal text. The main composer also supports direct `@agent` routing for multi-agent setups. Fenced code preserves source line breaks, soft-wraps long lines, and provides a localized copy action after streaming completes.

Skills inserted from the composer appear as `/skill-name` cards. Click a card to open the preview sidebar and read that skill's `SKILL.md`.

When you target another agent with `@agent`, ClawX switches directly to that agent's own conversation context instead of relaying through the default agent. Agent workspaces stay separate by default, while stronger runtime isolation depends on OpenClaw sandbox settings.

The session sidebar is workspace-first: the default workspace stays at the top, other workspaces sort naturally, and each workspace can collapse or load more sessions. A session row shows a spinner while the AI is replying, a blue dot when an unseen reply finishes, and its relative activity time after the conversation is opened; hovering still reveals row actions. Imported workspaces can be renamed from their sidebar header. The custom name is reflected in the chat composer, while hovering the header still reveals the filesystem path.

When a valid workspace is selected, a new chat inherits it while remaining editable until the first send. Editable new or unbound chats expose a workspace chip in the composer. Its menu lists recent and known-session workspaces, lets you return to the default workspace, or choose another folder. If a saved workspace folder was moved or deleted, Chat pauses session creation and asks you to choose an existing folder instead of repeatedly retrying the missing path. Unavailable non-default groups are marked in the sidebar and can be removed after confirmation; this permanently deletes every session in that group. A session row is removed and navigation changes only after permanent deletion succeeds. Failed deletions leave the conversation and confirmation open for retry. Synthetic OpenClaw UUID-date fallback titles are treated as missing only when they match the session ID, then replaced with the conversation's first user prompt instead of being persisted as the session name.

Each agent can override its own `provider/model` runtime setting. Agents without overrides continue inheriting the global default model.

The Workspace and Preview tabs in Chat's right panel provide read-only previews for Markdown, `.docx`, and `.pptx` files. Markdown previews use the same syntax-highlighted, soft-wrapped, copyable fenced code, CJK-aware parsing, and KaTeX math support in static rendering mode. The Preview header can expand the selected file to the full ClawX viewport; use the same control or press Escape to return to the panel. Legacy `.doc` and `.ppt` files continue to open through the operating system instead of inline. DOCX pagination may differ from Microsoft Word, and PPTX previews do not support animations, transitions, or media playback. Office files larger than 20 MB are not previewed inline.

### Local HTML Preview

The Chat right panel contains Workspace, Preview, and Changes tabs. It no longer provides a general Web Browser, Home page, or address bar. Authorized local `.html` and `.htm` attachments, file activities, and Workspace files open in Preview by default. File actions let you choose the built-in Preview or a system application, and the Preview header can open the current HTML file in the system browser.

All links are non-clickable. Links rendered by ClawX appear as ordinary text, and links inside HTML Preview have their styling and pointer interaction removed. HTML Preview also blocks forms, script navigation, redirects, hash navigation, popups, downloads, network requests, and device permissions. It can render self-contained local HTML but cannot leave the selected document.

### Multi-Channel Management

Configure and monitor multiple AI channels simultaneously. Each channel operates independently, allowing you to run specialized agents for different tasks.

Each channel supports multiple accounts, per-account agent binding, and switching the channel default account directly from the Channels page.

For custom channel account IDs, ClawX enforces OpenClaw-compatible canonical IDs: `[a-z0-9_-]`, lowercase, a maximum of 64 characters, and starting with a letter or number. This prevents routing mismatches.

ClawX also bundles Tencent's official personal WeChat channel plugin, so you can link WeChat directly from the Channels page through an in-app QR flow.

### Cron-Based Automation

Schedule AI tasks to run automatically. Define triggers and set intervals so AI agents can work around the clock.

The Cron page lets you configure external delivery directly in the task form with separate sender-account and recipient-target selectors. For supported channels, recipient targets are discovered automatically from channel directories or known session history, so you no longer need to edit `jobs.json` by hand. The task message field supports inserting skills with the same inline `/skill` token syntax as the main chat composer, scoped to the selected agent, so scheduled prompts can trigger skills directly.

The schedule picker is split into **Recurring** and **Once** tabs. Recurring offers Hourly, Daily, Weekdays, Weekly, and Custom raw cron frequencies with inline time and weekday controls. Once runs the task a single time at a chosen date, with the weekday shown, and time. One-time tasks must be scheduled for a future moment and are retired by the Main-owned ClawXScheduler after their canonical completion is committed.

### Extensible Skill System

Extend your AI agents with pre-built skills. The integrated Skills page is local-first: it scans managed and workspace skill directories and lets you enable or disable skills without depending on the Gateway. Enterprise extensions may also expose an extension-provided marketplace.

ClawX pre-bundles full document-processing skills (`pdf`, `xlsx`, `docx`, `pptx`) as host skill packages. The canonical Skills catalog owns their desired state and projects independent physical copies to each compatible installed kernel. OpenClaw's managed copy is created only when OpenClaw is activated; no OpenClaw directory is written merely because the base app starts.

The same Skills page displays canonical packages, workspace sources and per-kernel projection state. OpenClaw-specific source discovery runs only when that optional runtime exists. Its runtime artifact exposes only the allowlisted bundled `skill-creator`; non-allowlisted upstream skills are removed while building the optional artifact, and stale managed projection entries are reconciled without changing DSH copies.

### Secure Provider Integration

Connect to multiple AI providers, including OpenAI, Anthropic, and Z.AI / GLM, with credentials stored securely in the native system keychain. OpenAI supports both API keys and browser OAuth for Codex subscriptions.

In Developer Mode, the dedicated Image Generation page supports an independent OpenAI-compatible image-generation endpoint with a Base URL, API key, and model name such as `gpt-image-2`. Image generation can therefore use a dedicated `/v1/images/generations` service while chat continues using the normal OpenAI provider.

For **Custom** providers used with OpenAI-compatible gateways, you can set a custom `User-Agent` in **Settings -> AI Providers -> Edit Provider** for compatibility-sensitive endpoints.

When you edit or switch providers, ClawX preserves existing per-model capability metadata such as `input: ["text", "image"]`. Newly selected Custom-provider models use OpenClaw onboarding-compatible image-input inference, with unknown models defaulting to text-only.

Custom-provider model rows also receive an explicit `contextWindow`, inferred from the model family, such as `gpt-5.x` -> 272k. Rows saved by older versions are backfilled on startup so OpenClaw can compact long sessions before they fail with "Context overflow" errors. When no compaction configuration exists, ClawX seeds `agents.defaults.compaction.mode = "safeguard"` and `reserveTokensFloor = 50000`; rows or configurations you authored yourself are never modified, except that a missing `reserveTokensFloor` may be backfilled.

Z.AI (CN / Global) maps to OpenClaw's built-in `zai` provider (`ZAI_API_KEY`). The default model is `glm-5.2`. Use the Code Plan preset for Coding Plan endpoints (`.../api/coding/paas/v4`) or the normal API endpoints (`.../api/paas/v4`). CN and Global are mutually exclusive because they share one OpenClaw runtime key.

When a compatible gateway rejects `/models` for non-authentication reasons, ClawX automatically falls back to a lightweight `/chat/completions` or `/responses` probe using the configured model during API-key validation.

### Adaptive Theming

Choose light mode, dark mode, or a system-synchronized theme. ClawX adapts to your preferences automatically.

### Startup Launch Control

In **Settings -> General**, enable **Launch at system startup** so ClawX starts automatically after login.

### Update Prompts

ClawX checks for new versions on startup. When an update is available, it shows an in-app prompt; downloading and installing happen only after you choose the action.
