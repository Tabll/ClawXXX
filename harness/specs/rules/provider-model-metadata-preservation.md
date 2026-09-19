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

Reasoning and image-input choices made in Models are explicit user-owned
metadata. They must flow through the typed provider-account APIs, override
automatic inference for the selected provider/model pair, and be mirrored to
the matching per-agent `models.json` row.

Custom-provider model rows (`models.providers.custom-*`) must carry an explicit
`contextWindow`: new rows receive a deterministic model-family default, and
existing rows missing both `contextWindow` and `contextTokens` may be
backfilled with that default. Rows that already declare either field are
user-owned and must never be modified, and non-`custom-` provider entries are
never backfilled.

Built-in provider saves must deliver a concrete protocol and model row even when
no bundled catalog row exists. Registry and inferred metadata fill gaps; existing
same-model context/input/reasoning fields outrank those defaults, and explicitly
edited canonical modelCapabilities outrank both. New-account model defaults do
not rewrite existing canonical accounts or per-kernel selections.

For Astra under custom-* providers using openai-completions, seed the supported
low reasoning effort in agents.defaults.models[provider/model].params.extra_body
only when no effort is configured. Migrate the exact legacy extra_body value
none to low, preserving other explicit efforts and unrelated parameters. Never
apply this compatibility rule to another protocol, provider family or model.

Provider deletion must also remove default/per-Agent model-catalog entries and
stale auth order/lastGood/usageStats references. Retain explicit empty protected
model maps in config.set; omission would preserve deleted entries. These are
runtime projection cleanup operations, not canonical token-usage history reads.

Official model listings can reject an unavailable model only when the response
is authoritative and complete. Relays, malformed/empty lists and pagination must
not turn absence on one page into a false negative.
