---
id: kernel-capability-isomorphism
title: Kernel Capability Isomorphism
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - multi-kernel-runtime
requiredProfiles:
  - fast
  - comms
---

OpenClaw and DeepSeek Harness must project into the same canonical ClawX contracts for Chat, providers/models, agents, channels, cron, skills, conversations, usage, and diagnostics. Both drivers run the same mandatory execution and Conversation Store contract suites and the existing Renderer remains shared.

Upstream-specific protocol and storage types stay inside Main-owned drivers or bridges. Renderer business logic must not branch on kernel type. Capability metadata may explain a degraded projection but cannot silently remove mandatory behavior while the feature is described as fully isomorphic.

When an upstream runtime lacks a mandatory capability, implement it in a versioned ClawX host service, bridge, or reviewed runtime patch. Do not embed an upstream Web UI, expose a second settings surface, or bypass canonical state. Projection failures retain provenance, expose reconciliation state, and never report success when native state was not applied.

Conversation history, Channels, Cron, and Usage have one ClawX host/SQLite authority across kernels. Adapters may execute work in native runtimes, but dual durable history, dual inbound ownership, dual scheduling, and ambiguous delivery are forbidden.

Skill metadata and desired state are canonical. Package projection must use independent physical roots and must reject root or package symlinks; a shared or cross-linked OpenClaw/DeepSeek skill tree is not an implementation shortcut. Multi-target mutations expose partial success and explicit compatibility reasons, and must not overwrite or delete an unowned native skill directory.
