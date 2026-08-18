---
id: fix-lm-studio-tool-schema-patterns
title: Keep OpenClaw tool schemas compatible with LM Studio
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Allow OpenAI-compatible LM Studio models to receive the full OpenClaw tool catalog without rejecting or generating invalid grammar from Cron JSON Schema patterns before inference starts.
touchedAreas:
  - patches/openclaw@2026.7.1-2.patch
  - pnpm-lock.yaml
  - tests/unit/openclaw-lm-studio-tool-schema-patch.test.ts
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/rules/openai-compatible-tool-schema-compatibility.md
  - harness/specs/tasks/fix-lm-studio-tool-schema-patterns.md
expectedUserBehavior:
  - A user can send a normal chat turn through an authenticated LM Studio OpenAI-compatible provider while the Cron tool remains available.
  - LM Studio no longer rejects the request with `Pattern must start with '^' and end with '$'` before model inference.
  - LM Studio no longer fails llama.cpp grammar initialization because a converted tool pattern contains unsupported `\\s` or `\\S` GBNF escapes.
  - LM Studio no longer receives a Cron trigger string bound that expands into the unsupported `char{1,65536}` GBNF repetition.
  - Cron declaration keys and display names still require at least one non-whitespace character and continue to accept surrounding or embedded whitespace.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-lm-studio-tool-schema-patch.test.ts
  - tests/unit/openclaw-restart-recovery-patch.test.ts
acceptance:
  - The pinned OpenClaw patch anchors every affected Cron non-blank string pattern, avoids GBNF-incompatible regex constructs, and preserves the original search-style non-whitespace semantics.
  - Cron trigger scripts retain a non-empty constraint without publishing the 65,536-character Schema bound that exceeds llama.cpp's grammar repetition limit.
  - The installed OpenClaw Cron tool schema contains no bare `\\S` pattern that LM Studio rejects.
  - The fix is durable through `pnpm install` and does not rely on an untracked edit under node_modules.
  - The existing OpenClaw patch remains a valid unified diff whose lockfile hash matches the patched dependency declaration.
  - Communication regression replay and comparison pass.
docs:
  required: false
---

Use this task spec when changing the pinned OpenClaw tool schemas for strict
OpenAI-compatible runtimes such as LM Studio.
