---
id: provider-model-metadata-preservation
title: Provider Model Metadata Preservation
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
---

When ClawX rewrites an explicit `models.providers.*` entry, existing model rows
must be merged by exact model ID instead of reconstructed from only `id` and
`name`.

All fields on an existing matching row are user/runtime-owned metadata and must
survive provider save, update, default-switch, and reload flows unless a task
explicitly owns that field.

New model IDs may receive deterministic capability defaults, but metadata from a
different model ID must never be copied onto them.

When Settings > Models exposes provider model capability controls, user choices
for reasoning support and image-input support are explicit metadata ownership.
Those choices must be persisted through the typed host provider account APIs and
must override automatic inference for the configured provider/model pair.

Per-agent `models.json` synchronization must carry the same configured
capability fields for the matching model row so chat model catalogs and
reasoning controls observe the user's model configuration.
