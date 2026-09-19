---
id: upstream-multi-kernel-porting
title: Preserve canonical authority while porting upstream features
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - multi-kernel-runtime
---

Pin the upstream commit and record a disposition for every reviewed change.
Port independent behavior in bounded batches; never overwrite newer host/kernel
dependencies, local branding, signed artifact identities or release workflows
with an upstream snapshot.

Conversation identity, lineage, content, attachments, usage, Provider and Channel
state remain Main-owned canonical data. Runtime events are live execution inputs,
not alternate historical databases. Do not bring back transcript scans to enable
upstream UI, reports, generated attachments or usage charts.

Provider and other service credentials use preload-owned secure inputs and
one-use Main staging handles. Do not copy upstream React API-key state or raw
secret Host API payloads. New native capabilities remain explicit opt-ins and
must honor kernel capabilities, permissions and immutable distribution contracts.

Draft and UI state is keyed by canonical Conversation, not a runtime session or
kernel. Cleanup, background completions and navigation must not write to a newly
selected Conversation. Visible flows need four locales and Electron coverage.

Record focused verification per batch and validate the selected communication
and harness profiles before review. A clean patch application, mocked E2E or
local platform pass is not evidence of a signed cross-platform installation.

Speech-to-text is a host service, independent of the selected execution kernel.
Accept only bounded mono PCM WAV input in Main; use the configured endpoint and
Main-owned secret snapshot. Credential handles are single-use, configuration
failures restore the previous key, endpoint changes cannot silently reuse it,
and provider response bodies must not cross into Renderer errors. Keep deadlines
active through response-body reads and release capture resources on all failures.
The UI remains developer-gated. Cancellation/navigation invalidates recording
and transcription callbacks before they can upload or modify another draft.

Issue-report export reads canonical Conversation IDs through DataService and
kernel diagnostics through the host. Empty selection is supported; missing
Conversations are reported explicitly. Never copy runtime configs/transcripts or
attachment bytes into reports. Redact credential fields, omit private/secret
blocks and reasoning, bound report memory/strings, and write exclusively to a
Main-chosen local destination. The UI discloses selected-content privacy limits.

Plan identity is canonical Run-scoped. Restore elapsed time from canonical Run
timestamps, including live runs after Renderer reload. Compaction lifecycle
projects native live events onto the owning canonical run and event ledger;
ignore foreign sessions/replayed sequence numbers and remove observers on stop.
Do not copy legacy compaction reserve policy into newer kernel runtimes.

Generated files are imported from explicit current-run live references only.
Resolve local workspace/media paths, reject remote fetches and realpath escapes,
bound file counts/bytes, and read before transient-session cleanup. Main commits
output Blobs and metadata before returning references to the Renderer. Resolve
previews through Conversation-scoped attachment grants; late completions cannot
modify a different Conversation. Historical views use canonical Blobs only.

Feishu/Lark validation runs in Main before account/credential persistence for
both kernels. Detect the official API domain, reject invalid/equal credentials,
require a new secret when App ID changes, and return localized codes rather
than provider response bodies. Failed validation does not consume staging handles
or start an owner. Plugin fixes belong to newly versioned signed artifacts;
WeCom's implicit account fallback is permitted only for exactly one account.
