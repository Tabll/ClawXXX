# @clawx/dsh-clawx-persistence

ClawX-owned DeepSeek Harness v2 `SessionHandle` compatibility provider. It uses a narrow authenticated RPC client, never opens SQLite, and never writes JSONL. The removed upstream coordinator is not used.

This is an optional, contract-tested seam, not a second production store. The production host does not mount this provider: it hydrates transient Agents from canonical context and writes normalized events through the existing Main API. No native-session RPC server or migration is introduced by this upgrade.

A future mount must supply a server scoped to the authenticated kernel/generation with atomic single-writer acquire, capability-fenced reads/appends/flush/release, current-format event validation, typed errors and reconciliation of uncertain RPC outcomes. Retried acquisition and identical append batches must not duplicate ownership or events. A client-only mutex cannot satisfy this contract. Release drains materialized writes even after failure and is idempotent.

This package is injected into the frozen DSH source tree by the ClawX CI runtime build. It is not published as a standalone end-user package.

## Model Experience

This storage adapter adds no direct model-facing text. It persists and restores the exact DSH event form required by the runtime while ClawX independently normalizes user-visible Conversation blocks.

## Known Limitations and Deferred Work

The internal protocol is `clawx.dsh-session-store/v2`; it is separate from the unchanged canonical Conversation Store v1 and opaque checkpoint v1. Handles serialize accepted operations, route live Session events, retain failed live batches, drain on checkpoint/close, reject stale owners and closed handles, and roll back late acquisitions after cancellation or teardown. Tests exercise the upstream handle contract, cross-client writer exclusion and cold Agent resume. Compression and a production native-session transport remain out of scope.
