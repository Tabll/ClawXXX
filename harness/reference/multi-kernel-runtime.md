# Multi-Kernel Runtime Reference

Status: release candidate. M0–M15 have local implementation, contract, full Electron E2E, performance, communication-replay, and Harness coverage. M16's protected five-target signing/notarization/promotion runs, production mirror drill, and legal release approval remain open. This reference does not assert that multi-kernel support is already publicly shipped.

OpenClaw production bridge update (2026-09-06): source/dev pins now select
`2026.9.2+clawx.7`. Canonical typed history hydrates a new incognito session per
Run; ACP replay and transient delivery/approval state stay in memory, and native
durable history writes are fenced without deleting old data. Actual Gateway/ACP
and packaged-payload probes replace host-only evidence for this boundary.
Versioned Agents/config projection and seven Channel plugins are adapted. See
TODO M19 and `harness/reference/openclaw-2026.9.2-upgrade.md` for exact evidence
and pending real-provider/five-platform/publication gates. Installed runtimes
are not modified by changing these source pins.

## Scope

ClawX has been refactored from an OpenClaw-specific desktop client into a host for optional OpenClaw and DeepSeek Harness runtimes. Both runtimes use the same ClawX Renderer, can be installed independently, and can run concurrently. The 0.6.0 base-installer candidate no longer contains OpenClaw bytes; public distribution of that candidate remains blocked until the optional-runtime release gates pass.

The durable boundary is:

```text
Renderer
  -> host-api / api-client
    -> Main-owned canonical services
      -> ClawXDataService -> one SQLite database + blob store
      -> kernel-scoped chat data plane (ACP)
      -> kernel-scoped control plane (KernelDriver)
        -> OpenClaw or DeepSeek Harness runtime
```

Upstream protocols are adapter details. Renderer stores and pages consume only canonical ClawX contracts. Upstream durable conversation, cron, channel-message, and usage persistence must be disabled or replaced; it must not become a second adapter-owned source.

## Identity and routing invariants

- Every runtime installation has a stable `KernelId`; the initial built-in definitions are `openclaw` and `deepseek-harness`.
- `ConversationId` is kernel-independent. Every execution has a `RunId` and immutable kernel, agent, model, and runtime-generation snapshot; each persisted turn/block retains run provenance.
- Native identifiers are not globally unique. Agent, runtime-context, request, generation, permission, event, and usage identities are scoped by `KernelId` and `RunId`.
- Main validates the conversation, run, kernel, generation, event sequence, and request tuple on every asynchronous result before persistence or Renderer delivery.
- UI kernel selection affects only the next admitted run and never retargets in-flight work.
- Legacy unscoped session identities and history are not migrated or used as read fallbacks.
- Event envelopes carry an ordering or generation token so late events from a stopped, restarted, or switched runtime are rejected.
- One linear conversation permits one active run at a time. Parallel comparison requires explicit branches.

## Process and lifecycle invariants

- `KernelSupervisorRegistry` owns one independent supervisor per installed and active runtime.
- Installing, starting, stopping, restarting, updating, or crashing one runtime must not stop, overwrite, or retarget the other.
- App quit explicitly asks every owned supervisor to stop in parallel, bounds the aggregate shutdown wait, and force-terminates each owned process tree after the deadline.
- A runtime update is installed into a new immutable version directory. Active processes keep using their resolved version until the controlled restart boundary.
- Runtime states distinguish at least not-installed, downloading, verifying, installed, starting, ready, degraded, crash-loop, stopping, stopped, updating, rollback-available, incompatible, and failed.
- Recovery, health checks, ports, process groups, logs, locks, and retry budgets are kernel-scoped.
- Every launch attempt receives a new generation. Ready identity and artifact version must match the owned child; stale generation events are discarded.
- A live artifact version is immutable and reported as in-use to the package manager. It cannot be activated over, removed, or overwritten before the owning generation stops.
- Auto-start is a map keyed by kernel ID. The legacy `gatewayAutoStart` key is only a compatibility input during migration and is not the lifecycle authority for future kernels.

## Data plane and control plane

ClawX SQLite is the sole history authority. Chat execution uses a ClawX-required ACP/bridge profile for both runtimes, including prompt streaming, timeline updates, tool activity, permission requests, cancellation, terminal state, usage, and bounded error details. Runtime events are normalized persistence inputs, not history authority. UI history, search, rename, pin, delete, export, usage, and cron-run detail query the Conversation Store without calling runtime `session/load`.

Non-chat management uses a typed `KernelDriver` control plane. It owns lifecycle, health, agents, provider/model projection, skills, diagnostics, and runtime-specific reconciliation. Conversation catalog and canonical usage are DataService-owned. Renderer never chooses stdio, WebSocket, HTTP, IPC, file access, or fallback order.

DeepSeek Harness must not be integrated by embedding its Web UI. Its official automation-only ACP is insufficient for the required interactive ClawX profile; a versioned ClawX bridge/patch must add the missing protocol behavior and contract tests.

DeepSeek ACP, persistence, and control services are logical endpoints of one long-lived ClawX DSH runtime host. That host owns live agent handles and serializes mutation through per-run leases. It restores only from DataService context/checkpoints and must not create durable DSH JSONL. Two independent bridge daemons must not race on one run.

### DeepSeek Harness v1 bridge profile

The outer ClawX protocol remains v1; the embedded DSH session format is v2.
See [the 0.1.3 upgrade contract](deepseek-harness-0.1.3-upgrade.md) for the
breaking API adaptations, local evidence and remaining publication gates.

The frozen DSH base is commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`
(`0.1.3-alpha.1`), currently patched by ClawX as `0.1.3-alpha.1+clawx.11`. CI applies
an ordered strict patch series (workspace lock/importers and Windows sandbox
temp parity) plus a byte-manifested overlay. The production deploy
has one `@clawx/dsh-runtime-host` entrypoint and excludes the DSH Web UI,
settings-file, JSONL-session and SQLite-session packages.

Patch revision 10 makes the CI-only sandbox write probe report a fixed child
exit code and an exact target-path-bound `EPERM`/`EACCES`/`EROFS` marker. The
parent also verifies the denied file is absent. Localized error strings,
missing paths, full disks and unrelated process failures are not denial proof.

The host owns one DSH-home writer lock and a map of live per-run Agent leases.
`session.new` creates no durable native session. `session.prompt` validates the
complete Conversation/Turn/Run identity, hydrates a transient Agent from the
Main-supplied canonical snapshot and attachments, and disposes it at terminal
settlement. Cold continuation repeats that process and may pass an opaque
`deepseek-harness-agent` checkpoint only when its kernel, codec and schema
provenance match. DSH SessionEvents are normalized into ordered ClawX runtime
events; they never become a second catalog.

Live `agent/assistant-stream` frames project text and private reasoning. Durable
`assistant/message`/`assistant/attempt` settlements project provider usage once
per request; failed attempts replace the visible answer with the committed
prefix (even empty). Durable compact streams are never replayed as live text.
The rich bridge also projects assistant text, private reasoning visibility, tool
start/result/status, plan, title/session metadata, usage, output images,
permissions and ask-user questions. Event delivery is serialized so `eventSeq`
is also observable order, and terminal delivery waits for prior events and
attachment reads. Cancellation addresses the exact live lease and does not kill
the whole runtime. Configuration changes are run-scoped.

`@clawx/dsh-clawx-persistence` is the tested upstream `SessionPersistence`
compatibility seam using v2 `SessionHandle`: it requires an authenticated host client and
never opens SQLite or files. The v1 production prompt path uses the narrower
canonical context/event RPC directly and therefore does not mount a native DSH
session catalog at all. Both paths preserve the same authority rule: only
ClawX DataService may persist history.

The runtime presents DSH native tools; Code Mode and DSH Web are not composed.
Its stdout accepts/emits only `clawx.kernel-stdio/v1`; redacted structured
diagnostics use stderr. Initialize binds kernel/version/generation/protocol and
the verified artifact file-manifest digest before ready. Missing mandatory
capabilities or a mismatched bridge identity fail startup.

The build matrix runs source and extracted-artifact self-tests on macOS arm64
and x64, Windows x64, and Linux arm64 and x64. The CI-only RPC performs a real
workspace-write process, proves read-only denial, executes native read/write
tools and verifies approval/ask-user fail-closed wiring. On Windows it also
proves both the ACL-confined shell and model-facing file tool reject an explicit
write to ambient `%TEMP%`; the shell's private per-session temp capability is
not exposed as a model-visible root. It is disabled unless the launch
environment explicitly opts in.

OpenClaw requires a reviewed Conversation Store patch covering SessionManager, session metadata, compaction, branch/fork, reset, transcript memory/search inputs, and related lifecycle operations. Managed mode must not create durable `sessions.json`, session/trajectory JSONL, native cron history, or transcript-derived usage files. Failure to replace any mandatory durable path is a release blocker.

## Capability authority matrix

| Domain | ClawX authority | OpenClaw projection | DeepSeek Harness projection |
| --- | --- | --- | --- |
| Conversation/history | DataService + SQLite | Store adapter/context compiler | Store provider/context compiler |
| Chat execution | ConversationRouter + ACP events | Patched OpenClaw ACP | ClawX rich ACP bridge |
| Providers/models | Canonical metadata + keychain references | Config/Gateway adapter | Credential/provider bridge |
| Agents | Canonical agent records | Native agent config | Presets plus bridge metadata |
| Skills | Canonical inventory and desired state | OpenClaw skill/plugin adapter | DSH skill adapter |
| Channels | Host orchestration + SQLite accounts/messages/delivery | Native connector execution adapter | ClawX relay execution adapter |
| Cron | Host scheduler + SQLite jobs/admissions/runs | OpenClaw execution adapter; native scheduler disabled | DSH execution adapter; native schedule disabled |
| Usage | SQLite normalized usage events with run provenance | Live runtime/provider events | Live bridge/session events |
| Diagnostics | Main-owned envelope | Gateway/ACP/process facts | Bridge/ACP/process facts |

## Canonical Agents

Agent identity is kernel-independent. `agents` owns the canonical display name,
workspace URI, persona, optional preset, optional model reference, supported
kernels, monotonic version and soft-deletion state. `agent_projections` owns each
kernel's native id, desired/applied versions and reconciliation status;
`agent_kernel_defaults` owns defaults by kernel. There is no global default
agent after canonical migration.

OpenClaw is imported only when the canonical catalog is empty and the optional
runtime is available. Subsequent OpenClaw config/workspace/binding changes are
projections, not a second source of truth. DeepSeek Harness receives the same
canonical record through `@clawx/dsh-agent-catalog`; its ACP bridge mounts a
declared upstream Agent Preset before applying persona and model overlays and
fails explicitly if that preset is unavailable.

Run admission persists an immutable `AgentRunSnapshot` containing the agent
version and resolved kernel/native-id/workspace/persona/preset/model
composition. Updating or soft-deleting an Agent never rewrites existing run
snapshots or Conversations. Native deletion is a reconciled tombstone: an
offline kernel retains the native id and retries after the next ready
generation, and the projection is removed only after native deletion succeeds.

## Canonical Skills

Skill identity and desired state are kernel-independent. `skills` owns the slug,
display metadata, source kind and immutable package digest, monotonic revision,
desired installed/enabled kernel sets, compatibility decisions and soft-delete
tombstone. Each kernel projection records desired/applied revisions, native
identity, ready/pending/partial/failed/unsupported state and a retryable,
user-visible diagnostic. A Both-target operation returns both kernel results and
never rolls a ready projection back merely because its sibling failed.

Main imports every accepted package into a SHA-256-addressed immutable package
store before projection. OpenClaw and DeepSeek Harness receive independent,
atomic physical copies; their source and projection roots may not be equal,
nested, symlinked, or contain symlink package entries. Reconciliation only
replaces or removes a directory bearing the matching ClawX ownership marker, so
an unowned user directory survives collisions and failed operations.

OpenClaw retains its native Skills/config and ClawHub acquisition adapter, but
canonical state remains authoritative. DeepSeek Harness receives converted
instruction bodies through the process-local `@clawx/dsh-skill-catalog` and
`ctx.skills`. Its runtime filesystem provider scans only
`<managed-data-root>/skills`, disables default roots and refuses to follow
symlinks. It does not persist a second Skill catalog.

The reviewed bundled compatibility matrix converts the instruction-only
`skill-creator` package for DSH. `pdf`, `xlsx`, `docx`, and `pptx` remain
explicitly unsupported there until their auxiliary document runtimes are part
of the signed artifact. Unknown instruction-only packages may be converted;
packages with auxiliary files fail closed with a concrete incompatibility
reason instead of dropping resources or crossing a kernel boundary.

Channels and Cron are deliberately host-owned because simultaneous runtimes need a single account, target, schedule, retry, and delivery authority. Native channel-message history, cron storage, and schedulers are not compatibility sources. Dual persistence, dual scheduling, or dual inbound ownership is forbidden.

### Canonical Channels

Channel accounts, target bindings, external-message identity, Conversation
mapping, delivery attempts and owner leases are canonical SQLite records.
Connector credentials remain in OS-protected storage behind opaque references;
attachments enter the content-addressed Blob store and are exposed to a run
only through scoped grants. A connector or kernel never owns Channel history.

Every external account has at most one live owner lease. Different accounts can
be owned concurrently by OpenClaw and DeepSeek Harness, while an atomic rebind
stops old admission, commits the new `(kernelId, agentId)` binding and activates
the new owner, rolling back on failure. Compatibility is extended from the
registered adapter catalog, so a future adapter can join without a database
schema change.

The OpenClaw adapter projects canonical account state into its disposable
native config and uses an authenticated loopback handoff plugin for normalized
inbound/outbound identity and status. The DeepSeek Harness adapter uses the
Main-owned Relay and the complete eight-connector UI matrix: Telegram, Discord,
WhatsApp, WeChat, DingTalk, Feishu, WeCom and QQ Bot. Relay admission is
idempotent and per-conversation serialized; unattended permission escalation
is denied, delivery retries are recorded, and terminal failures become visible
dead letters. Neither adapter writes connector-native message history.

Legacy cutover imports account/config/binding metadata only, including disabled
accounts. It deliberately does not import old messages, Conversations or Cron
history. WhatsApp auth is captured into a bounded, deterministic bundle in
protected storage and projected atomically when its adapter owns the account.

The first scheduler runs in Electron Main. It continues while the app remains alive after window close, but explicit application quit stops scheduling; restart applies the declared misfire policy. Always-on scheduling after app quit requires a separately designed background service and is not an implicit first-release promise.

### Canonical scheduler

`ClawXScheduler` is the only scheduler for managed runtimes. It holds a
renewable SQLite leader lease, arms one earliest-due timer and admits each due
instant with a unique `(job_id, scheduled_for)` transaction before asking the
Conversation Router to create and dispatch the canonical run. OpenClaw Cron
RPC mutations fail closed, and both managed launch environments disable native
schedulers and native run-history persistence.

Jobs persist an immutable execution snapshot containing kernel, agent, prompt,
Conversation policy, delivery target and timeout. Misfires use `skip`,
`run-once` or bounded `catch-up`; overlaps use `skip`, serialized `queue` or
`replace`. Conversation targets use `reuse`, `new-per-run` (the default) or a
schedule-timezone-aware `new-per-day`. A missing or updating kernel produces a
canonical diagnostic and is never silently rerouted.

Scheduled results are ordinary Conversation turns. Optional delivery is
admitted into the Channel Orchestrator's canonical outbound record, retry and
dead-letter pipeline, and the Cron run links that message. Jobs, admissions,
Cron runs, Conversation runs, messages and delivery attempts therefore remain
in the same ClawX SQLite authority. Legacy OpenClaw Cron/DSH Schedule files are
neither scanned nor imported, and replaying a due instant cannot create a
second canonical run or delivery.

## Unified durable state

State is separated into four layers:

1. Immutable runtime packages under `<userData>/kernels/<kernel>/<version>/`.
2. One canonical SQLite database at `<userData>/state/clawx.sqlite`, owned exclusively by `ClawXDataService`.
3. A content-addressed blob store for attachments and large artifacts; all ownership, ordering, authorization, and references live in SQLite.
4. Kernel config and disposable cache/temp roots. Caches are never history or restart authority.

The database stores conversations, turns, content blocks, runs, run events, tool calls, permissions, usage, runtime checkpoints, channel messages/delivery, cron jobs/admissions/runs, agents, providers, skills, projections, installations, and operations. Secrets remain in the OS keychain; SQLite stores opaque credential references only.

No kernel, bridge, Renderer, or ordinary Main service receives the SQLite path or arbitrary SQL capability. They use versioned DataService RPC with per-launch authentication and scoped operations. The exact SQLite driver is an implementation gate: packaged Electron availability, FTS5, WAL, backup, recovery, performance, and cross-platform behavior must be proven before freezing it.

Prompt admission persists the user turn and immutable run snapshot before dispatch. Stream deltas are batched; tool, permission, and terminal facts are idempotent. The final assistant turn, usage, and run state commit atomically. DataService failure stops new prompt, cron, and channel admission rather than falling back to native history.

One conversation may use different kernels on different turns. `KernelContextCompiler` sends only portable, authorized, budgeted history. Private reasoning, secrets, revoked attachments, and another kernel's opaque checkpoints do not cross the boundary. Opaque checkpoints may be stored in SQLite with kernel/codec/schema provenance but are never treated as portable history.

## CI runtime artifacts and patches

Concrete v1 implementation details, strict patch-base rules, key separation and reproducibility controls are recorded in `docs/zh-CN/architecture/kernel-runtime-supply-chain.md`.

- End-user machines never run `npm install`, package compilation, or source patching to install a kernel.
- CI pins upstream version or commit and source integrity, applies reviewed repository patches, installs from a frozen lockfile, builds, prunes, audits, and runs smoke/contract tests.
- Windows checkouts preserve LF bytes for all frozen inputs. Build-time lock verification uses the prepared hash after strict patches; pre-patch verification still requires the upstream hash. Linux DSH builds compile the pinned static-musl Landlock launcher per architecture before sandbox tests and deploy that binary with the runtime.
- DSH deployment derives its closure from the shared lockfile with workspace injection and disabled lifecycle scripts, then explicitly restores the pinned node-pty spawn-helper executable bit. Legacy hoisted deploy is prohibited because it re-resolves dependency versions. Generated deploy lockfiles/settings and absolute builder-path metadata are removed; the root package manifest is restored from the reviewed workspace. Koffi, sharp/libvips, builtin loader, PTY/ConPTY, and Linux Landlock native files are target-pruned and checked against narrow allowlists.
- Windows optional-runtime CI supports the explicitly selected `artifact-signature-only` policy while Authenticode is deferred. Hash-bound platform metadata records the deferral truthfully; the descriptor/catalog signatures, archive integrity, safe extraction, sandbox, and storage checks stay mandatory. The default verifier still requires Authenticode if no verified deferral report is supplied, and signature failures do not trigger fallback. macOS signing and Apple acceptance remain mandatory.
- Artifacts are split by kernel, OS, and architecture. A universal app does not imply a universal runtime artifact.
- Each archive contains a signed manifest with kernel ID, upstream version/commit, ClawX patch revision, platform, architecture, protocol versions, capability contract version, minimum app version, size, file integrity, build provenance, licenses, and entrypoints. Catalog metadata additionally carries a monotonic sequence, issue/expiry times, and signing-key identity so clients can reject rollback or frozen metadata.
- The manifest declares Conversation Store protocol and checkpoint codecs. CI runs clean-directory tests proving managed prompt, cancel, compact, restart, cron, and channel flows do not create native durable history.
- Runtime versions use an immutable upstream-plus-patch identity such as the current DSH `0.1.3-alpha.1+clawx.11`.
- The app verifies manifest signature, archive digest, unpacked file integrity, platform/architecture, compatibility, and entrypoint allowlists before activation.
- Artifact signing, catalog promotion, and hosting credentials are separated. Key rotation and any emergency downgrade use explicit signed authorization rather than lowering the stored sequence implicitly.
- Catalog promotion binds the executing GitHub repository/release tag and every descriptor URL to the reviewed distribution mirrors, then extends only the exact signed N-1 catalog returned identically by all configured HTTPS mirrors. Sequence 1 is an explicit protected bootstrap that first proves every mirror is absent. A retry may idempotently repair only an exact trusted N/N-1 partial publication with matching request and staged artifacts; same-sequence forks fail closed. Promotion verifies the new catalog, retained artifacts, and signing keys at issue time and immediately before catalog expiry.
- Activation uses staging plus atomic rename; the previous verified version stays available for rollback. Failed downloads and extractions are resumable or discardable without corrupting the active version.
- Catalog trust/cache state and runtime current/LKG pointers are SQLite records owned by DataService. `.partial.meta` is disposable transfer identity only, and never a second authoritative installation store.
- Client extraction rejects traversal, path collisions, links, devices, privilege bits and signed-budget bombs, then verifies the internal artifact identity and every runtime file before smoke and activation.
- Every clean-machine target sends the actual signed descriptor/archive through the production package manager, including an injected interrupted transfer and exact Range/If-Range resume, signature verification, safe extraction, control-bridge smoke, atomic activation, rescan, uninstall, and canonical SQLite preservation.
- When both kernels are built, a separate five-target job installs both actual artifacts into one package manager and SQLite, starts their control bridges concurrently, injects and repairs one artifact integrity failure while the other stays healthy, and then independently uninstalls both. This control-plane evidence does not claim a paid model conversation occurred in CI.
- Runtime signing, notarization, antivirus, license, and third-party notice requirements are part of the release gate, not post-release work.
- Windows `@img/sharp-win32-x64@0.35.3` combines the sharp addon and libvips DLLs in one package. Its frozen npm archive declares `Apache-2.0 AND LGPL-3.0-or-later`; audit records retain that exact expression and a package-scoped bundled-library obligation. This is metadata coverage, not completed source-offer or legal approval evidence.
- A host release reruns the complete unit/contract/type/lint/chaos/comms/Harness gates, Electron E2E on macOS/Windows/Linux, and a live two-catalog/two-artifact-host Range drill before packaging can proceed.

## Compatibility and projection rules

- Both drivers execute the same lifecycle and domain contract suites.
- Capability fields describe observable limitations and degraded state; they do not authorize a second Renderer implementation.
- Missing mandatory behavior is implemented in Main, the bridge, or a reviewed patch. It cannot be hidden behind a disabled control while still claiming complete isomorphism.
- Partial projections retain native provenance and surface reconciliation errors. They never silently report success after only canonical state changed.
- Provider metadata, model inventory, opaque keychain references, desired versions and per-kernel defaults are canonical SQLite state. Each adapter reconciles independently and records ready/partial/failed state without cross-kernel rollback.
- Provider secrets never enter Renderer state or a runtime manifest. A preload-owned closed-shadow field stages one-time handles for Main; runtime resolution is authorized again by exact kernel/generation/PID/artifact identity, account, projection and purpose. Disconnect or generation replacement revokes access.
- OpenClaw projection preserves its auth SQLite/config plus `secrets.reload` delivery contract. DeepSeek Harness uses the patched, request-scoped `@clawx/dsh-credential-provider`; it does not cache a global API-key environment variable.
- Destructive operations follow explicit authority and confirmation rules and update canonical state through an idempotent operation journal.
- A future kernel is eligible only when it can hydrate from canonical context, submit normalized idempotent events, isolate opaque checkpoints, and disable or replace native durable conversation/cron/channel/usage history.

## Migration and removal gates

The source and local package candidate have stopped bundling OpenClaw. That candidate may be promoted as a public base installer only after all of the following are true:

1. Fresh install can download, verify, activate, start, and use OpenClaw on every supported platform.
2. Offline first launch explains the requirement and can resume or retry without losing user state.
3. Existing conversation and cron history is explicitly not migrated; legacy files remain untouched and are never a runtime fallback.
4. Rollback and last-known-good recovery work after a bad runtime update.
5. OpenClaw-only behavior remains regression-tested before DeepSeek Harness is enabled.
6. Dual-runtime concurrency, identity isolation, and app-quit cleanup pass E2E.
7. Conversation, Usage, Channels, and Cron use one SQLite authority; native runtime history directories remain empty in managed mode.
8. Both runtimes pass the same mandatory Chat and management contract gates.
9. Cross-kernel continuation, DataService crash recovery, backup/restore, corruption handling, and offline history after runtime uninstall pass packaged E2E.

DeepSeek Harness remains opt-in and may be labeled preview until its upstream stability and ClawX patch maintenance costs meet the release criteria. Preview labeling does not relax security, routing, or state-integrity rules.
