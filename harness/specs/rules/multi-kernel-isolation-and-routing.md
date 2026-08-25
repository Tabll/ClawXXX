---
id: multi-kernel-isolation-and-routing
title: Multi-Kernel Isolation and Routing
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - multi-kernel-runtime
requiredProfiles:
  - comms
---

Conversation identity is kernel-independent. Every execution operation, asynchronous request, event, generation, permission, runtime context, and native entity identity is explicitly scoped by conversation, run, and kernel as applicable. Native identifiers alone are never globally authoritative.

Main owns routing and validates conversation, run, kernel, request, generation, and event sequence before persistence or forwarding. Renderer kernel selection affects only the next admitted run and must not retarget in-flight work. Late events from stopped or restarted processes must be rejected by generation or ordering guards.

Each kernel has independent process, health, retry, port, log, lock, data-directory, and recovery state. Starting, stopping, updating, crashing, or uninstalling one kernel must not mutate or terminate the other. App quit performs bounded cleanup for every ClawX-owned supervisor.

Concurrent-kernel fixtures must include colliding native IDs, simultaneous prompts in different conversations, and turn-boundary kernel switches in one conversation. Contract and E2E coverage must prove that output, permissions, cancellation, canonical history, Channels, Cron, Agents, Skills, and diagnostics remain attached to the intended run while portable context never exposes another kernel's private checkpoint.
