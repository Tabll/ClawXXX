---
id: acp-compatibility-content-safety
title: Kernel Compatibility Content Safety
type: ai-coding-rule
appliesTo:
  - acp-chat-experience
  - gateway-backend-communication
  - multi-kernel-runtime
---

Canonical content blocks and kernel event envelopes are authoritative. A kernel adapter may translate structured native evidence into canonical blocks/events only before or during the owning run's durable commit. Translation MUST retain source kernel, run, generation, visibility, and reason-coded diagnostics; unsupported or ambiguous evidence is skipped.

Approved compatibility inputs are structured native tool/resource events, canonical assistant media facts, and explicit whole-line media directives emitted by the active adapter. Accept only documented local path, `file:`, execution-workspace-relative, HTTP, and HTTPS forms. Reject unknown schemes, wrapped or inline prose paths, incidental tool paths, malformed facts, and unrelated assistant prose. Main attachment authorization remains mandatory even for syntactically valid references.

Compatibility logic MUST NOT scan runtime transcripts to reconstruct ordinary user/assistant messages, thoughts, tools, plans, permissions, file activity, titles, usage, or a parallel Chat history. Deduplication is scoped to canonical run/event identity. Native structured resource content wins over an equivalent translated reference, and unavailable evidence cannot block a later canonical event from the same live run.
