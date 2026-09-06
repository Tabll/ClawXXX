# DeepSeek Harness 0.1.3-alpha.1 compatibility contract

Reviewed 2026-09-06. Local implementation candidate; not a published artifact.

## Immutable inputs

- Upstream release: [dsh-v0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1).
- Commit: `d347e703908d0406b7a7ef80e3a0e594d86b2215`.
- ClawX artifact: `0.1.3-alpha.1+clawx.11`; old `.10` artifacts and their CI/notarization evidence are not reused.
- `source.json`, `lock.json`, patch series, runtime descriptor and overlay manifest pin exact bytes. The raw upstream lock is checked before patches; the prepared lock is checked after strict patch application. No fuzzy patching or end-user builds.
- Upstream requires Node `^22.19.0 || >=24.0.0`; the runtime remains official SHA-256-verified Node 24.15.0. The build workspace uses upstream pnpm 11.7.0 and TypeScript 6.0.3.

## Breaking boundaries and adaptations

| Boundary | ClawX adaptation |
| --- | --- |
| Removed `dsh-agent-spine-demo` | Await explicit services in `clawx-runtime-host/src/composition.ts`, including `sessionProjections` before AgentLoop. No upstream app profile, Web UI, settings file, local credentials or scheduler. |
| Explicit launch/proxy setup | Capture the process launch environment, install the HTTP proxy dispatcher, dispose it and the managed home lock on shutdown or startup failure. Never load an ambient user `.env`. |
| Removed durable `assistant/chunk` | Project live `agent/assistant-stream` frames. Scope revision deduplication to the exact live Agent/run; native delivery IDs include the native session and attempt. |
| v2 `assistant/message` and `assistant/attempt` | Committed messages own portable answer text. Failed/retried attempts clear transient text back to the committed prefix, including an explicit empty snapshot. Interrupted visible text is preserved only when DSH commits it. |
| Usage settlement | Only message/attempt settlements produce Usage. A failed attempt uses its last reported usage snapshot, not their sum. `(run_id, dsh-usage-v2-<session-seq>)` is the stable identity; replay and terminal fallback do not add charges. Missing cache/total/cost fields stay unknown. Sink failure prevents a successful terminal run. |
| Removed `Session.events` | Use `snapshotEvents()` and the v2 typed vocabulary. Never reconstruct usage by scanning native history. |
| Removed persistence coordinator/backend API | The optional RPC seam implements SessionHandle create/open/read/append/flush/close, live event routing, retained failed batches, teardown rollback, and server-side writer fencing. Upstream backend contracts plus independent-client/cancellation/close/resume tests guard it. |
| Windows roots test/source changes | Rebase the workspace-only Windows temp policy while preserving upstream native realpath canonicalization and test cleanup. Do not grant the caller's ambient `%TEMP%`. |

## Storage and protocol compatibility

Main's existing SQLite DataService remains the only business authority for Conversations, turns, run events, Usage, Agents, Skills, Channels and Cron. Blobs remain managed attachment data, not a second history database. Both kernels keep the same UI and can run simultaneously; no native-history migration is needed or attempted.

The production prompt path still creates a transient native Agent per canonical Run and disposes it at settlement. The optional `clawx.dsh-session-store/v2` compatibility provider is **not mounted** and no native-session RPC server is added. A future mount must implement authenticated capability fencing, typed errors, current-format validation and idempotent reconciliation of uncertain RPC commits on the host; the test memory client is not a production server.

ClawX stdio, Conversation Store and opaque checkpoint protocols remain v1. The checkpoint contains identity/hash metadata, not a v1 DSH event log, so upstream format v2 does not require a checkpoint migration. Cross-kernel continuation still uses canonical portable context, never another kernel's native checkpoint.

`assistant.final` with an explicit empty string replaces the current answer; an attachment-only final does not erase text. SQLite router contracts and Electron E2E protect this distinction. Reasoning remains private and is not promoted into cross-kernel context.

## Verification and release boundary

Local evidence on 2026-09-06:

- Clean strict patch preparation and frozen install succeeded; prepared lock and all 61 overlay files match their recorded digests.
- Complete upstream host compilation/bundling succeeded, including with official Node 24.15.0. The focused source suite passed 69 tests across 13 files with real macOS sandbox probes enabled.
- Production deployment excludes native history backends. The final unsigned local tar round-trip passed native allowlist checks and launched under Node 24.15.0 with all 11 registered tools, workspace-write/read-only enforcement, real write/read round-trip and approval/question checks. Shutdown left no native durable history. Kernel + minimal Node payload: 2,743 regular files / 162,572,917 bytes. This is not a signed release artifact or its archive budget report.
- Machine-readable license metadata audit passed for 106 production packages, retaining the libvips obligation; it is not legal approval.
- Host: 2,141 unit/contract tests passed, six existing conditional tests skipped; focused task gates passed 27 tests. Typecheck passed; lint had zero errors and seven pre-existing React refresh warnings. Comms replay/compare and Harness CI/task validate/dry-run passed.
- Four Electron timeline E2E tests passed with isolated profiles, including empty-snapshot retry replacement. These UI fixtures do not call a real provider.

Use the task spec `harness/specs/tasks/upgrade-deepseek-harness-0-1-3-alpha-1.md` and TODO M18. Local checks include strict preparation from a clean upstream checkout, frozen dependency install, complete host build, overlay contracts, macOS sandbox self-test, production dependency deployment, unsigned local tar round-trip with the pinned Node runtime, storage-path scan, host regression/type/lint/comms/Harness and Electron timeline tests.

A local unsigned payload probe is not the signed-artifact installation gate. Five-target CI, native Linux/Windows enforcement, macOS Developer ID/notarization, clean-machine signed installation, COS/GitHub publication and online Range verification require new evidence for `.11`. Do not mark those complete based on older artifacts or local tests. No provider API request is made by the deterministic smoke tests.

The upstream release explicitly warns of a performance regression, particularly session loading. ClawX's canonical hydration avoids native history loading, but this does not prove the absence of long-context/provider latency regressions. Keep the last verified artifact available and require representative real-provider/long-context acceptance before public promotion. Do not expose arbitrary upstream builds as user-installable kernels.
