# ClawX 0.5.8 upstream migration

Upstream: `ValueCell-ai/ClawX@24a24b7797349266b25807a188593a90b67e91f5`
(v0.5.8, released 2026-09-18). Integration baseline: `bf190dab`.
Task: `harness/specs/tasks/port-upstream-clawx-0-5-8.md`.

Keep OpenClaw 2026.9.4, DeepSeek Harness 0.1.5-rc.2, Electron 43.4.0,
ACP SDK 1.4.0, Main-owned SQLite/Blob, secure credential staging and the
GitHub-only immutable signed runtime delivery contract. The upstream 47-commit
range begins after `7f8e50ab`; a wholesale merge is not this implementation.

## Batches

| Batch | Scope | Status |
|---|---|---|
| 1 | Provider protocol correctness; zoom; conversation drafts/selection; scroll; small provider/channel copy fixes | Implemented and validated |
| 2 | Model defaults/metadata, scoped Astra compatibility and Provider cleanup | Implemented and validated |
| 3 | Main-owned speech-to-text and microphone permission recovery with secure credential input | Implemented and validated |
| 4 | Canonical diagnostics export, generated media and plan/compaction presentation | Implemented and validated |
| 5 | Channel validation, WeCom and official DingTalk/DWS migration | Feishu/WeCom implemented; official DingTalk and per-account DWS authorization implemented in batch 5b |
| 6 | Canonical subagent lineage/status and opt-in Computer Use; optional TokenDance | Not implemented; separate architecture/capability batches |

Each batch records actual checks below. Upstream release-number-only changes,
removed experimental Realtime Talk, obsolete request-timeout injection and
native-history/usage scanning are not ported. Existing custom branding and
appearance controls remain authoritative. Older OpenClaw compaction/stream
patches require reproduction against 2026.9.4 before any semantic backport.

## Evidence

Batch 1 (2026-09-19, commit `27d1d1f3`):

- Three regression tests first reproduced missing Anthropic/Google projection and
  the silent missing-protocol return. All now pass with explicit provider protocols
  and a visible error for unresolved protocols.
- 93 focused unit tests pass across provider sync, provider links, composer,
  canonical deletion, scrolling and zoom.
- Typecheck, build, lint (0 errors; 7 existing Fast Refresh warnings), task spec
  validation/dry-run, harness CI (19 tests), comms replay/compare and diff whitespace
  validation pass.
- Electron: 4 passed (live catalog state, isolated draft/caret, small-scroll escape,
  keyboard zoom); 1 Windows minimize/restore test skipped on macOS.
  The initial sandboxed Electron launch failed with SIGABRT/EPERM; the same
  isolated fixtures passed after running Electron outside the sandbox.
- Drafts include text, attachments, target agent, skill and selection. Late staging
  results retain their Conversation owner; canonical deletion invalidates stale
  callbacks, while failed deletion retains drafts. Drafts are memory-only.

Batch 2 (2026-09-19, commit `423c8d17`):

- 10 upstream regression tests reproduced Astra/default-model/auth-reference and
  official model validation gaps before implementation.
- 220 unit/contract tests pass (7 files), including both kernel Provider projections,
  explicit capability/context preservation, scoped Astra migration, complete-list
  availability checks and partial-page/relay non-rejection.
- 10 Electron provider lifecycle/developer-mode tests pass, including new defaults,
  preservation of an existing Kimi model, secure credential handles, deletion across
  restart and explicit model capabilities.
- Typecheck, build, lint (same 7 existing warnings), task validate/dry-run,
  comms replay/compare and diff validation pass.
- Kept current-kernel compaction policy and custom/OAuth context ceilings. No
  upstream transcript/usage readers were introduced. Third-party account/model
  availability remains subject to actual credentials and provider service state.

Batch 3 (2026-09-19, commit `49dd80b0`):

- Developer-gated ASR uses the common composer and Main Host API independently of
  kernel choice. Speech is inserted at the cursor, with permission recovery and
  cancellation/navigation guards; no retired Realtime Talk was restored.
- Config uses nonsecret electron-store fields and the existing encrypted secret
  store with one-use preload handles. Endpoint changes cannot reuse old keys,
  failed config writes restore keys, WAV size/format is validated, and provider
  error bodies never reach the Renderer. Timeouts cover body reads, and failed
  audio-graph initialization releases capture resources.
- Full unit/contract suite: 284 files / 2,738 tests passed, 2 files / 6 tests skipped.
- Electron: 5 voice tests passed, including the production staging vault, secret
  envelope persistence and Main ASR request to an isolated local HTTP fixture;
  developer gating and 2 canonical chat/draft tests also passed.
- The first upstream E2E fixture lacked ready canonical kernel/workspace state;
  it was adapted to the multi-kernel fixture. A native keychain call stalled the
  real-service test; its OS cipher was replaced by a process-local AES test cipher.
  Native keychain behavior and microphone capture are not claimed by that test.
- Typecheck, production build, lint (0 errors, same 7 baseline warnings), task
  validation/dry-run, harness CI (19 tests), comms replay/compare and plist syntax
  validation pass. Added the missing macOS audio-input entitlement; the installed
  development Electron is ad-hoc signed, not a signed release artifact.

Batch 4a (2026-09-19, commit `e4317b2f`):

- Reports export selected Conversations through DataService, plus shared kernel
  diagnostics and redacted log tails. Zero selected Conversations works; deleted
  selections are disclosed. Private/secret blocks, reasoning and attachment bytes
  are omitted. The local ZIP is exclusively created in Main; size/string limits
  and the remaining privacy limits are recorded in its manifest and UI.
- Real SQLite export tests cover both OpenClaw and DSH, missing selections,
  credentials, failed persistence and retry. Native runtime histories/configs are
  not accessed by the exporter.
- Running timers restore from canonical timestamps, and plans are Run-scoped.
  Current OpenClaw 2026.9.4 compaction events are normalized in Main and routed
  only to the owning live Run, persisted and replayed by the canonical ledger.
  Skipped compaction is distinct from failure; no old reserve/compaction patches.
- Full unit/contract suite: 286 files / 2,747 tests passed; 2 files / 6 tests skipped.
  Electron: 12 passed (canonical timeline, plan/compaction replay, local ZIP).
  Typecheck, build, lint (same 7 existing warnings), comms replay/compare and task
  validation pass. Event fixtures do not claim a paid-provider compaction run.

Batch 4b (2026-09-19, commit `a53b2e2a`):

- OpenClaw imports explicit live MEDIA directives, ACP resource references and
  successful internal message-tool delivery evidence before transient cleanup.
  Imports are limited to workspace/managed-media realpaths, 32 files, 32 MiB per
  file and 64 MiB per run. Remote fetches, fenced examples, symlink escapes,
  changed files and nonregular files are rejected.
- Main commits output Blobs before returning Conversation-scoped references;
  both kernel output interfaces use this path. The Renderer replaces only the
  current turn's transient links and cannot project a late result into another
  Conversation. Existing DSH runtime transport limits remain unchanged.
- Full unit/contract suite: 288 files / 2,756 tests passed; 2 files / 6 tests skipped.
  Contract tests verify durable reads and denial from another Conversation.
  Five Electron checks passed (inline images/preview, existing user images and
  canonical attachments, Markdown). The initial one-pixel image click was
  replaced with its accessible preview button; the targeted retry passed.
- Typecheck, production build, lint (same 7 baseline warnings), task validate/
  dry-run, harness CI and communication replay/compare passed. Real remote
  image-generation services and cross-platform native files remain untested.

Batch 5a (2026-09-19, commit `e260236d`):

- Feishu/Lark validation is shared across OpenClaw and Relay, with official-domain
  detection, a body-read deadline, redirect refusal and localized error codes.
  Main validates before consuming secure handles or persisting account state.
  App ID changes require a new secret; errors cannot echo service bodies.
- Existing canonical binding/owner activation remains authoritative. No extra
  connector or unconditional Gateway restart is introduced after saving.
- WeCom 2026.8.17 single-account fallback is pinned as a pnpm patch, and verified
  by running the actual plugin against one/multiple/explicit-account fixtures.
  OpenClaw artifact identity advances to 2026.9.4+clawx.16 with refreshed lock,
  runtime and overlay hashes; installed signed artifacts are not modified.
- 290 unit/contract files / 2,765 tests passed, 2 files / 6 tests skipped. Four
  Electron tests passed for credential refusal/retry and existing kernel routing.
  Typecheck, build, lint (same 7 baseline warnings), source/build contract tests,
  task validation/dry-run and comms replay/compare passed.
- Offline lock regeneration lacked cached registry metadata; the read-only
  online resolution changed only the expected seven lockfile lines. Frozen
  installation used one cached package and disabled lifecycle scripts.
- Actual Feishu accounts, WeCom calendar access and signed cross-platform
  artifact publication require external/platform validation.

Final review batch (2026-09-19):

- Automatic session-title fallbacks now remove Unix/Windows cwd envelopes without
  changing explicit labels. Replacing an unsent local session also revokes its
  draft generation, so a late staging/voice callback cannot resurrect it.
- Generated-file import rejects nonregular files before opening and uses
  nonblocking reads on POSIX to avoid a file-to-FIFO replacement hanging a Run.
  The real named-pipe regression passes alongside path/size/symlink tests.
- Full unit/contract suite after title changes: 2,767 passed, 6 skipped. The final
  targeted import/title/draft run passed 27 tests. Four Electron checks passed
  for titles, new local sessions and independent drafts. The Windows-title
  fixture initially normalized LF only; it now uses the shared title helper,
  and the corrected targeted Electron test passes.

## Remaining integration boundaries

This is a validated first implementation wave, not a complete migration of every
upstream feature. The remaining work is documented in
`harness/reference/upstream-clawx-0.5.8-next-batches.md`.

No native-account, microphone, signed package, Windows lifecycle or remote release
validation has been claimed.


## Commit disposition ledger

The following records the disposition of all 47 reviewed commits. Items without
an explicit implemented status remain planned or intentionally excluded as stated;
this table does not claim completion of later batches.

| 日期 | 提交 / PR | 更新 | 评估 |
|---|---|---|---|
| 2026-08-24 | [9048cda0](https://github.com/ValueCell-ai/ClawX/commit/9048cda0) / [#1252](https://github.com/ValueCell-ai/ClawX/pull/1252) |  fix: keep ACP turn duration updating after session switch (#1252) | Batch 4a implemented using canonical Run timestamps |
| 2026-08-24 | [c0ac5a9e](https://github.com/ValueCell-ai/ClawX/commit/c0ac5a9e) / [#1253](https://github.com/ValueCell-ai/ClawX/pull/1253) | fix: update compaction safety defaults (#1253) | Excluded old reserve policy; 2026.9.4 defaults and explicit canonical model capabilities retained |
| 2026-08-25 | [e04ab51c](https://github.com/ValueCell-ai/ClawX/commit/e04ab51c) / [#1254](https://github.com/ValueCell-ai/ClawX/pull/1254) | fix: optimize context compaction strategy (less failed compactions, pause Gateway recovery) and prompt/bridge stability fixes (#1254) | Progress UI ported in batch 4a; legacy 2026.7.1-2 process/compaction patches not replayed |
| 2026-08-25 | [9749068e](https://github.com/ValueCell-ai/ClawX/commit/9749068e) / [#1255](https://github.com/ValueCell-ai/ClawX/pull/1255) | feat: add issue report export from settings (#1255) | Batch 4a implemented from canonical DataService and multi-kernel diagnostics |
| 2026-08-25 | [bb77115e](https://github.com/ValueCell-ai/ClawX/commit/bb77115e) / [#1256](https://github.com/ValueCell-ai/ClawX/pull/1256) |  fix(chat): isolate unsent drafts per conversation (#1256) | Batch 1 implemented; includes attachment/callback isolation |
| 2026-08-25 | [9f5def22](https://github.com/ValueCell-ai/ClawX/commit/9f5def22) / [#1257](https://github.com/ValueCell-ai/ClawX/pull/1257) |  fix(chat): prevent auto-scroll while reading earlier messages (#1257) | Batch 1 implemented; canonical Electron fixture validated |
| 2026-08-25 | [1bd40cf8](https://github.com/ValueCell-ai/ClawX/commit/1bd40cf8) / [#1258](https://github.com/ValueCell-ai/ClawX/pull/1258) | fix(chat): update context limit and reserve tokens on model switch (#1258) | Explicit capabilities preserved in batch 2; current ACP configuration/usage owns context display |
| 2026-08-26 | [29dd28a9](https://github.com/ValueCell-ai/ClawX/commit/29dd28a9) / [#1259](https://github.com/ValueCell-ai/ClawX/pull/1259) | fix: avoid unexpected compaction in mid-turn precheck (backport OpenClaw PR#117963) (#1259) | No legacy dist patch applied to 2026.9.4; native policy behavior requires provider-backed reproduction before a backport |
| 2026-08-26 | [b27c31cf](https://github.com/ValueCell-ai/ClawX/commit/b27c31cf) / [#1260](https://github.com/ValueCell-ai/ClawX/pull/1260) | release 0.5.5 (#1260) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-08-26 | [6c53e66a](https://github.com/ValueCell-ai/ClawX/commit/6c53e66a) / [#1261](https://github.com/ValueCell-ai/ClawX/pull/1261) |  fix: clean up sessions after agent deletion (#1261) | Intentionally retains local preserveHistory deletion contract; no cascade deletion of shared Conversations |
| 2026-08-26 | [d2331330](https://github.com/ValueCell-ai/ClawX/commit/d2331330) / [#1248](https://github.com/ValueCell-ai/ClawX/pull/1248) | fix: restore broken star history chart in READMEs (#1248) | Excluded cosmetic README change; local architecture documentation retained |
| 2026-08-26 | [cd1fe0d3](https://github.com/ValueCell-ai/ClawX/commit/cd1fe0d3) / [#1262](https://github.com/ValueCell-ai/ClawX/pull/1262) | opt(chat): chat pannel style (#1262) | Excluded cosmetic layout changes; current local design retained |
| 2026-08-26 | [43ce645a](https://github.com/ValueCell-ai/ClawX/commit/43ce645a) / [#1263](https://github.com/ValueCell-ai/ClawX/pull/1263) |  fix(chat): clean up working directory session titles (#1263) | Final review batch implemented; explicit labels preserved and automatic cwd titles cleaned |
| 2026-08-27 | [943405fd](https://github.com/ValueCell-ai/ClawX/commit/943405fd) / [#1265](https://github.com/ValueCell-ai/ClawX/pull/1265) | fix(chat): remove stale workspaces after agent deletion (#1265) | Excluded destructive workspace/session cleanup: a workspace and Conversation can be shared across kernels/Agents |
| 2026-08-27 | [505e7fd3](https://github.com/ValueCell-ai/ClawX/commit/505e7fd3) / [#1267](https://github.com/ValueCell-ai/ClawX/pull/1267) |  fix(chat): preserve turn duration across gateway restarts (#1267) | Batch 4a implemented; no native-history timing reader |
| 2026-08-28 | [6367b246](https://github.com/ValueCell-ai/ClawX/commit/6367b246) / [#1266](https://github.com/ValueCell-ai/ClawX/pull/1266) |  fix(chat): preserve cursor position when switching conversations (#1266) | Batch 1 implemented with selection restoration |
| 2026-08-28 | [eb4a0a86](https://github.com/ValueCell-ai/ClawX/commit/eb4a0a86) / [#1268](https://github.com/ValueCell-ai/ClawX/pull/1268) |  fix(compaction): default reserve to 50k without explicit context (#1268) | Excluded unconditional legacy 50k reserve override; current runtime policy retained |
| 2026-08-28 | [86989408](https://github.com/ValueCell-ai/ClawX/commit/86989408) / [#1269](https://github.com/ValueCell-ai/ClawX/pull/1269) | feat(settings): add Ollama provider documentation link (#1269) | Batch 1 implemented |
| 2026-08-28 | [2ab8610a](https://github.com/ValueCell-ai/ClawX/commit/2ab8610a) / [#1270](https://github.com/ValueCell-ai/ClawX/pull/1270) | fix(providers): stop injecting custom request timeouts (#1270) | 本地已无该超时注入函数，通常无需移植 |
| 2026-08-31 | [dc10a59d](https://github.com/ValueCell-ai/ClawX/commit/dc10a59d) / [#1272](https://github.com/ValueCell-ai/ClawX/pull/1272) | fix: last chunk loss, compaction failures and subagent delivery; add todo and compaction UI; experimental realtime talk (#1272) | Plan/compaction UI ported in batch 4a; Realtime Talk excluded; old runtime/subagent patches held separately |
| 2026-08-31 | [45b096d3](https://github.com/ValueCell-ai/ClawX/commit/45b096d3) / [#1273](https://github.com/ValueCell-ai/ClawX/pull/1273) | fix(chat): use placeholder title for new Windows sessions (#1273) | Canonical new-session path already passes prefixCwd:false; current title contract retained |
| 2026-09-01 | [e4536525](https://github.com/ValueCell-ai/ClawX/commit/e4536525) / [#1274](https://github.com/ValueCell-ai/ClawX/pull/1274) | feat: show subagent sessions in its parent (#1274) | Not ported: requires canonical child-Run admission and lineage, not native session catalog reads |
| 2026-09-01 | [d0abd62e](https://github.com/ValueCell-ai/ClawX/commit/d0abd62e) / [#1277](https://github.com/ValueCell-ai/ClawX/pull/1277) | chore: remove unavailable Realtime Talk voice input feature. (#1277) | 历史 Realtime Talk 已撤回，不应重新引入 |
| 2026-09-03 | [e1b8b0c2](https://github.com/ValueCell-ai/ClawX/commit/e1b8b0c2) / [#1280](https://github.com/ValueCell-ai/ClawX/pull/1280) | refactor: subagent session's live streaming, timing and status (#1280) | Not ported: child streaming/lifecycle must join canonical lineage and usage ownership first |
| 2026-09-03 | [5cf4d111](https://github.com/ValueCell-ai/ClawX/commit/5cf4d111) / [#1281](https://github.com/ValueCell-ai/ClawX/pull/1281) | release 0.5.6 (#1281) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-09-07 | [d510c221](https://github.com/ValueCell-ai/ClawX/commit/d510c221) / [#1284](https://github.com/ValueCell-ai/ClawX/pull/1284) | fix: stabilize macOS release signing (#1284) | Not ported in this wave: electron-builder remains 26.8.1; 26.16.0 needs dedicated signed-package validation |
| 2026-09-07 | [1015e0d8](https://github.com/ValueCell-ai/ClawX/commit/1015e0d8) / [#1286](https://github.com/ValueCell-ai/ClawX/pull/1286) |  fix: support Astra custom providers and clean up deleted provider state (#1286) | Batch 2 implemented with final scoped low behavior and projection cleanup |
| 2026-09-07 | [a1db9fce](https://github.com/ValueCell-ai/ClawX/commit/a1db9fce) / [#1287](https://github.com/ValueCell-ai/ClawX/pull/1287) | chore: bump bundled channel plugins compatible with OpenClaw 2026.7.1-2 (#1287) | Current newer runtime/plugin pins retained; WeCom patch implemented, official DingTalk migration separate |
| 2026-09-07 | [f5bb8c02](https://github.com/ValueCell-ai/ClawX/commit/f5bb8c02) / [#1288](https://github.com/ValueCell-ai/ClawX/pull/1288) | fix: activate plugin channels after save and reject invalid Feishu credentials (#1288) | Batch 5a validation implemented in both adapters; existing canonical owner activation retained |
| 2026-09-08 | [6a938757](https://github.com/ValueCell-ai/ClawX/commit/6a938757) / [#1278](https://github.com/ValueCell-ai/ClawX/pull/1278) | refactor(settings): update developer mode description (#1278) | Local developer-mode contract retained; ASR description/gating updated in batch 3 |
| 2026-09-09 | [cc9fb719](https://github.com/ValueCell-ai/ClawX/commit/cc9fb719) / [#1289](https://github.com/ValueCell-ai/ClawX/pull/1289) | feat: support token dance (#1289) | Optional future Provider batch; browser authorization must feed the canonical credential broker and both projections |
| 2026-09-10 | [1f2f50b3](https://github.com/ValueCell-ai/ClawX/commit/1f2f50b3) / [#1282](https://github.com/ValueCell-ai/ClawX/pull/1282) | feat: support speech-to-text (ASR) input and add model icons; fix ACP process management and refactor UI (#1282) | Batch 3 ASR implemented; appearance and ACP lifecycle reviewed separately |
| 2026-09-10 | [f40e5dab](https://github.com/ValueCell-ai/ClawX/commit/f40e5dab) / [#1290](https://github.com/ValueCell-ai/ClawX/pull/1290) | fix: allow issue report export without conversations (#1290) | Batch 4a implemented and Electron-tested |
| 2026-09-11 | [607f33e0](https://github.com/ValueCell-ai/ClawX/commit/607f33e0) / [#1283](https://github.com/ValueCell-ai/ClawX/pull/1283) | feat: supports Computer Use feature experimentally (#1283) | Separate opt-in batch; current OpenClaw 2026.9.4 already includes cua-computer, so no parallel legacy daemon was added |
| 2026-09-11 | [e8ff1184](https://github.com/ValueCell-ai/ClawX/commit/e8ff1184) / [#1291](https://github.com/ValueCell-ai/ClawX/pull/1291) | fix: support WeCom calendar queries in single-account desktop sessions (#1291) | Batch 5a patch pinned in the lockfile; OpenClaw artifact revision 16 |
| 2026-09-11 | [33a1a1a7](https://github.com/ValueCell-ai/ClawX/commit/33a1a1a7) / [#1293](https://github.com/ValueCell-ai/ClawX/pull/1293) |  fix: recover OpenClaw-generated file (#1293) | Batch 4b implemented from live delivery evidence into canonical Blobs |
| 2026-09-14 | [5a735537](https://github.com/ValueCell-ai/ClawX/commit/5a735537) / [#1294](https://github.com/ValueCell-ai/ClawX/pull/1294) | fix: render generated images inline from MEDIA paths (#1294) | Batch 4b implemented with scoped import, inline preview and no transcript scans |
| 2026-09-14 | [a0b2a804](https://github.com/ValueCell-ai/ClawX/commit/a0b2a804) / [#1296](https://github.com/ValueCell-ai/ClawX/pull/1296) | feat: gate voice input behind developer mode (#1296) | Batch 3 implemented; hidden by default and direct voice-tab navigation gated |
| 2026-09-14 | [f7ff4b4d](https://github.com/ValueCell-ai/ClawX/commit/f7ff4b4d) / [#1297](https://github.com/ValueCell-ai/ClawX/pull/1297) | release  0.5.7 (#1297) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-09-15 | [170b9899](https://github.com/ValueCell-ai/ClawX/commit/170b9899) / [#1292](https://github.com/ValueCell-ai/ClawX/pull/1292) | feat: upgrade DingTalk to official connector 0.8.25 (#1292) | Batch 5b: official connector, stable IDs, isolated authorization and pinned runtime payload; signed release validation remains external |
| 2026-09-15 | [9445f018](https://github.com/ValueCell-ai/ClawX/commit/9445f018) / [#1299](https://github.com/ValueCell-ai/ClawX/pull/1299) | chore(i18n): drop OpenClaw 3.31 note from QQ Bot channel description (#1299) | Batch 1 implemented |
| 2026-09-15 | [16c543bb](https://github.com/ValueCell-ai/ClawX/commit/16c543bb) / [#1298](https://github.com/ValueCell-ai/ClawX/pull/1298) | fix: preserve window zoom after minimize (#1298) | Batch 1 implemented; Windows native test pending platform |
| 2026-09-16 | [b67561a3](https://github.com/ValueCell-ai/ClawX/commit/b67561a3) / [#1301](https://github.com/ValueCell-ai/ClawX/pull/1301) | refactor: guide users to microphone permission settings and add missing audio-input declaration in macOS entitlements plist (#1301) | Batch 3 permission recovery and entitlement implemented; signed-package capture pending |
| 2026-09-16 | [d5473067](https://github.com/ValueCell-ai/ClawX/commit/d5473067) / [#1302](https://github.com/ValueCell-ai/ClawX/pull/1302) | Fix dws install (#1302) | Batch 5b: DWS 1.0.30 CI materialization with pinned archive digests; no end-user npm installation |
| 2026-09-16 | [01b418ec](https://github.com/ValueCell-ai/ClawX/commit/01b418ec) / [#1300](https://github.com/ValueCell-ai/ClawX/pull/1300) | feat: refresh provider defaults and catalog-free runtime config (#1300) | Batches 1–2 implemented; JSONL excluded |
| 2026-09-16 | [34ad624b](https://github.com/ValueCell-ai/ClawX/commit/34ad624b) / [#1303](https://github.com/ValueCell-ai/ClawX/pull/1303) | fix: migrate Astra reasoning effort from none to low (#1303) | Batch 2 implemented; other explicit efforts/protocols preserved |
| 2026-09-18 | [24a24b77](https://github.com/ValueCell-ai/ClawX/commit/24a24b77) / [#1304](https://github.com/ValueCell-ai/ClawX/pull/1304) | release 0.5.8 (#1304) | 发布 0.5.8；仅作为本次审查基准 |

## Continuation batch 5b — official DingTalk and DWS account authorization

Official connector 0.8.25 replaces the community plugin; compatibility projects
stable channel/default IDs, card type and group policy without rewriting canonical
config. Full compiled plugin registration and multi-account resolution are tested.
DWS 1.0.30 runs only from the selected runtime artifact, with a separate ephemeral
HOME/config directory per operation and encrypted canonical auth bundles. Login
expiry, process cancellation, stale UI nonces, credential replacement and owner
generations are enforced in Main. No real DingTalk account was authenticated.

Runtime CI materializes digest-pinned native archives, license and notice files
for both kernels before validation/signing. OpenClaw revision 17 and DSH revision
16 require rebuilding and publishing through the existing release gates; installed
artifacts were not mutated. Agent tool invocation is tracked in the next batch.

Verification: full unit/contract run passed 2,779 tests with 6 skips; two stale
package/revision assertions were updated and their 7 focused tests then passed.
The DWS native archive/source/build checks pass 50 tests, including all five
supported target platforms. Electron account-isolation flow and its two required
exclusive prerequisites pass (3 tests). Typecheck, build, lint (only the existing
7 Fast Refresh warnings), task validate/dry-run, harness CI (19 tests), comms
replay/compare and diff whitespace validation pass. No live account or signed
cross-platform release is claimed.
