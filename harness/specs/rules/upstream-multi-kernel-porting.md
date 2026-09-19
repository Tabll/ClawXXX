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
