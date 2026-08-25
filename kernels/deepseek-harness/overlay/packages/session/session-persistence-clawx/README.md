# @clawx/dsh-clawx-persistence

ClawX-owned DeepSeek Harness persistence provider. It composes the upstream `PersistenceCoordinator` with a narrow RPC client whose server is the single ClawX DataService. The package never opens SQLite and never writes JSONL.

The runtime host supplies an authenticated client already scoped to one `kernelId`, process generation, Conversation and Run. Every request is validated again by the DataService before it reaches the canonical database.

This package is injected into the frozen DSH source tree by the ClawX CI runtime build. It is not published as a standalone end-user package.

## Model Experience

This storage adapter adds no direct model-facing text. It persists and restores the exact DSH event form required by the runtime while ClawX independently normalizes user-visible Conversation blocks.

## Known Limitations and Deferred Work

The first protocol version uses complete immutable event values. Transport-level compression and incremental checkpoint compaction may be introduced under a negotiated minor protocol version without changing the DSH persistence seam.
