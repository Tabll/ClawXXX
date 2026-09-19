# ClawX 0.5.8 continuation contracts

The continuation authorized on 2026-09-19 is implemented against immutable
upstream `24a24b7797349266b25807a188593a90b67e91f5`. The 47-commit disposition
ledger and first-wave evidence are in `upstream-clawx-0.5.8-migration.md`.
Task: `port-upstream-clawx-0-5-8`; scenarios: `gateway-backend-communication`
and `multi-kernel-runtime`; rule: `upstream-multi-kernel-porting`.

## Official DingTalk and DWS

Commit `d11991c9` pins `@dingtalk-real-ai/dingtalk-connector@0.8.25` and
`dingtalk-workspace-cli@1.0.30`. Canonical `dingtalk` / `default` identities,
account bindings and existing group policy survive strict-schema projection.
No process-global DWS client ID or arbitrary first-account fallback remains.
The CLI receives disposable per-operation HOME/config projections from encrypted
canonical Channel secrets. Authorizations are bound to account, credential
fingerprint and owner generation; stale UI cancellation requires its own nonce.
Delete, replacement, owner switch and shutdown cancel the owned process group.

`clawx_dingtalk` in both runtimes reaches Main's Run-scoped broker. List returns
only enabled accounts on the Run's kernel; an inbound Channel Run additionally
restricts it to that Channel account. Execute requires an explicit account and
canonical permission admission. Native auth/config/plugin commands and identity
flags are rejected. Channel Runs retain their existing deny policy; do not silently
weaken it to make a business tool call succeed. Payloads come from signed kernel
artifacts; old artifacts fail unavailable without falling back to host/global CLI.

## Canonical child conversations

`clawx_agent` admits independent Conversation/Turn/Run records and stores ancestry
in SQLite `run_lineage` (schema 14). `parentConversationId` keeps its existing
history-branch meaning. Children inherit the admitted Agent, workspace, Provider,
model, permission mode and Channel account. Model arguments cannot widen those
fields. Maximum depth is three and fan-out is eight per Run; rejected admission
removes an empty temporary conversation. Each child has ordinary canonical events,
attachments, terminal state and idempotent usage. Runtime checkpoints do not contain
Main capabilities.

A parent may complete before its children. Cancelling an active parent or deleting
its conversation cancels active descendants; independent child history remains.
Restart recovery interrupts unfinished Runs using the existing data authority and
retains lineage. Deleting the parent nulls only its lineage link. The UI reads
canonical children and exports, streams previews, restores timing/status, and opens
a child for permission decisions. Switching parent conversations remounts preview
state so asynchronous results cannot cross owners.

OpenClaw uses an independent ACP worker/access registry per admitted Run, avoiding
serialized parent/child deadlock. Native session spawn/send/history/list tools are
blocked in managed sessions. DSH host tools execute through the real ToolRuntime
and AgentLoop, with private grants bound to the active bridge session.

## Computer Use

`clawx_computer` exposes a reviewed desktop action catalogue through the same
Main-owned broker. Settings defaults to off and selects at most one kernel. CUA
0.25.0 is available on macOS 13+ (x64/arm64) and Windows x64. Linux is explicitly
unavailable for this driver release. Development can run `pnpm run cua:prepare`;
end-user installations receive the driver and native SDK inside signed immutable
runtime artifacts. Exact archive, root lockfile and license hashes bind the build;
native architecture and path allowlists are checked before signing. Windows PE
subsystem adaptation prevents the upstream console window without changing other
executable fields. SDK and daemon files never enter the base installer.

Main alone owns native sessions, policy and daemon lifecycle. The model receives
neither socket path nor capability token. Each desktop action requires canonical
permission approval; denied Runs cannot execute it. Disable/switch, kernel
generation change, missing payload, permission revocation and app exit stop the
owned host and reject stale work. Failed stops cannot restore an opt-in on restart.
The driver starts lazily, uses the application bundle identity, and disables its
telemetry. OpenClaw's separate `cua-computer` extension is disabled in managed
configuration. No model path may write screenshots or read clipboard image/file
paths outside canonical storage; clipboard text remains available.

Screenshots are bounded canonical Blobs and model image content, including DSH's
normal attachment projection. Interpreting screenshots requires an image-capable
selected model. No native screenshot/history directory becomes a second authority.
OS permission prompts are reachable only through the explicit Settings action.

## TokenDance

Commit `bc8d24c3` ports the Chinese picker, upstream endpoints/model/header defaults,
secure API-key input and cancellable browser authorization. Main binds a one-use
loopback callback to random state and S256 PKCE. Abort/deadline covers the full
exchange and body read; stale completions and rolled-back persistence cannot
recreate a deleted or replaced account. Credentials use canonical Provider and
SecretStore authority. OpenClaw runs TokenDance's OpenAI-compatible models; DSH's
existing DeepSeek-only provider capability stays explicitly unsupported.

## Release tooling and evidence boundary

`electron-builder` is pinned to 26.16.0. A local unsigned macOS arm64 app was
assembled with signing, notarization and publication disabled. The afterPack
isolation gate passed and inspection of all 4,624 ASAR entries found no OpenClaw,
DSH, CUA or DWS optional runtime packages. Protected release workflows and the
GitHub-only signed runtime distribution gates remain authoritative.

Code verification includes real OpenClaw Gateway/ACP host-tool execution with a
loopback model, real DSH AgentLoop tool execution and full DSH host compilation,
canonical SQLite and broker contracts, four-locale Electron UI, CUA native SDK
import/architecture/digest checks and an unsigned app assembly. Real desktop
permission grants/actions, real third-party OAuth/Channel accounts, Windows
lifecycle, cross-platform signing/notarization and remote artifact publication
remain external acceptance; none is represented as locally passed.
