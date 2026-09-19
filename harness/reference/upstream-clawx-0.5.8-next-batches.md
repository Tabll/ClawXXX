# Remaining upstream 0.5.8 batches

This is an implementation continuation record, not a claim that these features
are supported. The validated first wave is recorded in
`upstream-clawx-0.5.8-migration.md`. All work continues to use
`gateway-backend-communication` and `multi-kernel-runtime`.

## Official DingTalk and DWS

Frozen upstream inputs: `@dingtalk-real-ai/dingtalk-connector@0.8.25` and
`dingtalk-workspace-cli@1.0.30` (upstream PRs 1292 and 1302).
The official connector source was downloaded to an isolated review directory;
the existing static SDK import audit reports no missing imported SDK exports
against OpenClaw 2026.9.4. This does not prove a working live connector.

The connector changes channel ID to `dingtalk-connector` and default account ID
to `__default__`. Migration must retain canonical `dingtalk` / `default`, existing
bindings, group policies and single-owner leases. Project old config into the new
schema without deleting the canonical original. Verify the complete compiled
entrypoint graph and before_dispatch handoff, then test rollback with two accounts
owned by different kernels. Keep the Relay connector independent.

The upstream DWS host code copies binaries into the user's OpenClaw tools folder,
uses one global authorization process/cache, and runs with the user's home.
These contracts cannot be copied into this host. The official connector's
`src/channel.ts` also writes `DWS_CLIENT_ID` into the shared process environment;
its `getDwsSpawnEnv` falls back to the first account. Neither is an acceptable
multi-account authority.

Next implementation must:

- Provision fixed-version DWS binaries in CI, validate native payloads and sign
  a new immutable artifact. Do not install npm packages on the user's computer.
- Resolve every authorization/status/cancel request through its canonical
  Channel account and owner; isolate concurrent logins and process cleanup.
- Use `DWS_CONFIG_DIR` (documented in the connector's global-reference.md) for
  disposable per-account projections. Keep durable credentials in the existing
  encrypted Channel secret store, including refresh and deletion semantics.
- Inject credentials only into the account-owned subprocess. Multiple accounts
  without explicit context must fail rather than choose the first or last.
- Test DWS authorization expiry/cancel/retry, account deletion, owner switches,
  restart recovery and immutable packaging before exposing the new UI.

Implemented in continuation batch 5b: downloaded and pinned DWS 1.0.30,
verified all supported native payloads, scoped account login/status/cancel/reset,
and replaced the connector. The native CLI was run for help only. No real
authorization or signed runtime publication occurred. Runtime agent tool access
remains the following integration step.

## Canonical subagent conversations

Upstream PRs 1274/1280 derive parent/child membership from ACP SessionInfo
`parentSessionId` / `spawnedBy` and native `agent:*:subagent:*` session IDs.
The local `ConversationSummary.parentConversationId` currently means a history
branch, and must not be repurposed to make an autonomous child inherit an
unrelated transcript. `ConversationStoreProtocolClient` does not currently
admit child Runs; OpenClaw's adapter also owns a serialized execution slot.

Before adding the upstream child-session UI:

- Specify independent child Conversation/Run admission, parent-run identity,
  kernel/generation ownership and cancellation semantics in Main.
- Capture child output, attachments, usage and terminal events into the canonical
  ledger; test children that outlive their parent and parent/child restart.
- Resolve same-kernel scheduling without deadlocking a parent waiting for a
  child. Do not restore a native-history reader to work around this.
- Project status/timing/history from canonical data and exercise nested children,
  simultaneous kernels, late/stale events, deletion and idempotent usage.

## Computer Use and TokenDance (continuation authorized)

Computer Use is a separate opt-in capability batch. OpenClaw 2026.9.4 already
ships the `cua-computer` extension and driver payload entries. Upstream ClawX
introduces a host-managed cua-driver 0.25.0 daemon and bundled skill. Reconcile
these implementations first; avoid two daemons or allowing one kernel to inherit
another kernel's desktop permissions. Verify permission denial/revocation,
process ownership, kill-on-disable and signed native binaries on each platform.

TokenDance is an optional Provider integration. Its browser callback/code
exchange must stay in Main, save through the canonical credential broker and
project the account/models to both kernels. Cover callback state/expiry/cancel,
redacted failures and credentials never entering React state.

## Release tooling

Upstream PR 1284 upgrades electron-builder 26.8.1 to 26.16.0. The current host
toolchain remains unchanged. Do this in a separate packaging batch with an actual
unsigned assembly check followed by protected signed/notarized release checks;
retain existing GitHub-only runtime distribution and release gates. The ASR
audio-input entitlement was added in the first wave, but signed-package native
microphone capture and OS keychain behavior remain unverified.
