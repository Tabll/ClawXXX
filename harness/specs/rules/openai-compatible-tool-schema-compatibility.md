---
id: openai-compatible-tool-schema-compatibility
title: OpenAI-Compatible Tool Schema Compatibility
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
requiredProfiles:
  - fast
  - comms
---

Tool JSON Schemas exposed through the bundled OpenClaw runtime must remain
acceptable to supported OpenAI-compatible providers. String `pattern` values
that reach LM Studio must be explicitly anchored with `^` and `$`, and must
not depend on regex shorthand escapes such as `\\s` or `\\S` that its schema
converter can emit as invalid llama.cpp GBNF. Avoid ECMAScript-only constructs
such as the empty negated class `[^]` when the generated GBNF cannot parse them.

When anchoring a search-style pattern, preserve its original validation
semantics. A rule such as `\\S`, which means that the string contains at least
one non-whitespace character, must not be narrowed to `^\\S+$` if surrounding
or embedded whitespace was previously accepted. Use an explicit Unicode
whitespace character class when necessary so both JSON Schema conversion and
the generated grammar preserve that behavior.

Large finite Schema bounds must also be checked against provider grammar
limits. Do not expose bounds such as `maxLength: 65536` when they expand into a
GBNF repetition that llama.cpp rejects; retain runtime validation separately or
omit the provider-facing upper bound while preserving required minimums.

Compatibility fixes for the pinned OpenClaw package must live in the registered
pnpm patch, include a regression test against the installed bundle, and keep
the patch hash in `pnpm-lock.yaml` synchronized.
