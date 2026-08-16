---
id: token-usage-analysis-v0.5.4-migration
title: Port session-level token usage analysis onto v0.5.4
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Replace the lightweight Models usage list with local transcript-backed session analysis while preserving v0.5.4 provider, Gateway, and host API ownership.
touchedAreas:
  - harness/specs/tasks/token-usage-analysis-v0.5.4-migration.md
  - electron/utils/token-usage-core.ts
  - electron/utils/token-usage.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/*/settings.json
  - src/components/settings/TokenUsageSettings.tsx
  - src/lib/usage-history.ts
  - src/pages/Models/index.tsx
  - src/pages/Models/usage-history.ts
  - tests/unit/models-page.test.tsx
  - tests/unit/models-usage-history.test.ts
  - tests/unit/token-usage-scan.test.ts
  - tests/unit/token-usage.test.ts
  - tests/e2e/token-usage.spec.ts
expectedUserBehavior:
  - Models shows token and cost totals, rolling windows, model/provider/agent/day grouping, search, export, and session-level details.
  - Session details aggregate all structured assistant and tool-result usage records for one agent and session without combining another agent's identical session id.
  - Context weight, message counts, tool usage, runtime metadata, and content are displayed when sessions.json and transcript data provide them.
  - Normal, deleted, and reset transcript variants remain valid history sources until the conversation is hard-deleted.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - ui-i18n-design-tokens
requiredTests:
  - tests/unit/token-usage.test.ts
  - tests/unit/token-usage-scan.test.ts
  - tests/unit/models-usage-history.test.ts
  - tests/unit/models-page.test.tsx
  - tests/e2e/token-usage.spec.ts
acceptance:
  - Usage is parsed only from structured transcript records and never scraped from console logs.
  - Scanning covers configured agents and runtime agent directories present on disk.
  - Provider cost breakdowns and sessions.json metadata are optional and cannot suppress otherwise valid usage records.
  - Renderer obtains usage through typed hostApi usage methods and does not access transcript files directly.
  - Unit and E2E coverage verifies zero-token records, internal-record filtering, session aggregation, context details, and rolling time windows.
docs:
  required: true
---

## Migration boundary

The v0.5.4 Models route, provider controls, and Gateway lifecycle remain
upstream-owned. This task replaces only the token-usage presentation and its
local transcript parser, and removes the now-duplicated page-local aggregation
helper.
