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
| 3 | Main-owned speech-to-text and microphone permission recovery with secure credential input | Pending |
| 4 | Canonical diagnostics export, generated media and plan/compaction presentation | Pending |
| 5 | Channel validation, WeCom and official DingTalk/DWS migration | Pending |
| 6 | Canonical subagent lineage/status and opt-in Computer Use; optional TokenDance | Pending |

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

Batch 2 (2026-09-19):

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

No native-account, microphone, signed package, Windows lifecycle or remote release
validation has been claimed.


## Commit disposition ledger

The following records the disposition of all 47 reviewed commits. Items without
an explicit implemented status remain planned or intentionally excluded as stated;
this table does not claim completion of later batches.

| 日期 | 提交 / PR | 更新 | 评估 |
|---|---|---|---|
| 2026-08-24 | [9048cda0](https://github.com/ValueCell-ai/ClawX/commit/9048cda0) / [#1252](https://github.com/ValueCell-ai/ClawX/pull/1252) |  fix: keep ACP turn duration updating after session switch (#1252) | 运行耗时映射到 canonical Run，需适配 |
| 2026-08-24 | [c0ac5a9e](https://github.com/ValueCell-ai/ClawX/commit/c0ac5a9e) / [#1253](https://github.com/ValueCell-ai/ClawX/pull/1253) | fix: update compaction safety defaults (#1253) | 旧内核压缩策略，按 2026.9.4 重审 |
| 2026-08-25 | [e04ab51c](https://github.com/ValueCell-ai/ClawX/commit/e04ab51c) / [#1254](https://github.com/ValueCell-ai/ClawX/pull/1254) | fix: optimize context compaction strategy (less failed compactions, pause Gateway recovery) and prompt/bridge stability fixes (#1254) | 拆分上下文 UI 与旧内核补丁，避免整批移植 |
| 2026-08-25 | [9749068e](https://github.com/ValueCell-ai/ClawX/commit/9749068e) / [#1255](https://github.com/ValueCell-ai/ClawX/pull/1255) | feat: add issue report export from settings (#1255) | 复用报告 UI，改用 canonical export |
| 2026-08-25 | [bb77115e](https://github.com/ValueCell-ai/ClawX/commit/bb77115e) / [#1256](https://github.com/ValueCell-ai/ClawX/pull/1256) |  fix(chat): isolate unsent drafts per conversation (#1256) | Batch 1 implemented; includes attachment/callback isolation |
| 2026-08-25 | [9f5def22](https://github.com/ValueCell-ai/ClawX/commit/9f5def22) / [#1257](https://github.com/ValueCell-ai/ClawX/pull/1257) |  fix(chat): prevent auto-scroll while reading earlier messages (#1257) | Batch 1 implemented; canonical Electron fixture validated |
| 2026-08-25 | [1bd40cf8](https://github.com/ValueCell-ai/ClawX/commit/1bd40cf8) / [#1258](https://github.com/ValueCell-ai/ClawX/pull/1258) | fix(chat): update context limit and reserve tokens on model switch (#1258) | 保留显式模型能力，适配上下文显示 |
| 2026-08-26 | [29dd28a9](https://github.com/ValueCell-ai/ClawX/commit/29dd28a9) / [#1259](https://github.com/ValueCell-ai/ClawX/pull/1259) | fix: avoid unexpected compaction in mid-turn precheck (backport OpenClaw PR#117963) (#1259) | 先确认新内核是否已包含修复 |
| 2026-08-26 | [b27c31cf](https://github.com/ValueCell-ai/ClawX/commit/b27c31cf) / [#1260](https://github.com/ValueCell-ai/ClawX/pull/1260) | release 0.5.5 (#1260) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-08-26 | [6c53e66a](https://github.com/ValueCell-ai/ClawX/commit/6c53e66a) / [#1261](https://github.com/ValueCell-ai/ClawX/pull/1261) |  fix: clean up sessions after agent deletion (#1261) | 映射到 canonical Agent/Conversation 删除语义 |
| 2026-08-26 | [d2331330](https://github.com/ValueCell-ai/ClawX/commit/d2331330) / [#1248](https://github.com/ValueCell-ai/ClawX/pull/1248) | fix: restore broken star history chart in READMEs (#1248) | 可选文档改动，保留本地架构说明 |
| 2026-08-26 | [cd1fe0d3](https://github.com/ValueCell-ai/ClawX/commit/cd1fe0d3) / [#1262](https://github.com/ValueCell-ai/ClawX/pull/1262) | opt(chat): chat pannel style (#1262) | 可选展示层改动，保留当前设计 |
| 2026-08-26 | [43ce645a](https://github.com/ValueCell-ai/ClawX/commit/43ce645a) / [#1263](https://github.com/ValueCell-ai/ClawX/pull/1263) |  fix(chat): clean up working directory session titles (#1263) | 可复用标题清理函数，检查本地命名规则 |
| 2026-08-27 | [943405fd](https://github.com/ValueCell-ai/ClawX/commit/943405fd) / [#1265](https://github.com/ValueCell-ai/ClawX/pull/1265) | fix(chat): remove stale workspaces after agent deletion (#1265) | 适配 canonical 删除与 workspace 清理 |
| 2026-08-27 | [505e7fd3](https://github.com/ValueCell-ai/ClawX/commit/505e7fd3) / [#1267](https://github.com/ValueCell-ai/ClawX/pull/1267) |  fix(chat): preserve turn duration across gateway restarts (#1267) | 使用 canonical Run 持久时间，避免原生历史依赖 |
| 2026-08-28 | [6367b246](https://github.com/ValueCell-ai/ClawX/commit/6367b246) / [#1266](https://github.com/ValueCell-ai/ClawX/pull/1266) |  fix(chat): preserve cursor position when switching conversations (#1266) | Batch 1 implemented with selection restoration |
| 2026-08-28 | [eb4a0a86](https://github.com/ValueCell-ai/ClawX/commit/eb4a0a86) / [#1268](https://github.com/ValueCell-ai/ClawX/pull/1268) |  fix(compaction): default reserve to 50k without explicit context (#1268) | 重审新内核策略，不能全局硬套旧 50k 参数 |
| 2026-08-28 | [86989408](https://github.com/ValueCell-ai/ClawX/commit/86989408) / [#1269](https://github.com/ValueCell-ai/ClawX/pull/1269) | feat(settings): add Ollama provider documentation link (#1269) | Batch 1 implemented |
| 2026-08-28 | [2ab8610a](https://github.com/ValueCell-ai/ClawX/commit/2ab8610a) / [#1270](https://github.com/ValueCell-ai/ClawX/pull/1270) | fix(providers): stop injecting custom request timeouts (#1270) | 本地已无该超时注入函数，通常无需移植 |
| 2026-08-31 | [dc10a59d](https://github.com/ValueCell-ai/ClawX/commit/dc10a59d) / [#1272](https://github.com/ValueCell-ai/ClawX/pull/1272) | fix: last chunk loss, compaction failures and subagent delivery; add todo and compaction UI; experimental realtime talk (#1272) | 大范围混合提交，仅迁移仍适用的语义 |
| 2026-08-31 | [45b096d3](https://github.com/ValueCell-ai/ClawX/commit/45b096d3) / [#1273](https://github.com/ValueCell-ai/ClawX/pull/1273) | fix(chat): use placeholder title for new Windows sessions (#1273) | 可借鉴 Windows 初始标题处理 |
| 2026-09-01 | [e4536525](https://github.com/ValueCell-ai/ClawX/commit/e4536525) / [#1274](https://github.com/ValueCell-ai/ClawX/pull/1274) | feat: show subagent sessions in its parent (#1274) | 先补 canonical 父子关系，再接 UI |
| 2026-09-01 | [d0abd62e](https://github.com/ValueCell-ai/ClawX/commit/d0abd62e) / [#1277](https://github.com/ValueCell-ai/ClawX/pull/1277) | chore: remove unavailable Realtime Talk voice input feature. (#1277) | 历史 Realtime Talk 已撤回，不应重新引入 |
| 2026-09-03 | [e1b8b0c2](https://github.com/ValueCell-ai/ClawX/commit/e1b8b0c2) / [#1280](https://github.com/ValueCell-ai/ClawX/pull/1280) | refactor: subagent session's live streaming, timing and status (#1280) | 与 canonical 子代理状态/事件一起适配 |
| 2026-09-03 | [5cf4d111](https://github.com/ValueCell-ai/ClawX/commit/5cf4d111) / [#1281](https://github.com/ValueCell-ai/ClawX/pull/1281) | release 0.5.6 (#1281) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-09-07 | [d510c221](https://github.com/ValueCell-ai/ClawX/commit/d510c221) / [#1284](https://github.com/ValueCell-ai/ClawX/pull/1284) | fix: stabilize macOS release signing (#1284) | 打包工具单独升级，不覆盖当前签名发布流程 |
| 2026-09-07 | [1015e0d8](https://github.com/ValueCell-ai/ClawX/commit/1015e0d8) / [#1286](https://github.com/ValueCell-ai/ClawX/pull/1286) |  fix: support Astra custom providers and clean up deleted provider state (#1286) | Batch 2 implemented with final scoped low behavior and projection cleanup |
| 2026-09-07 | [a1db9fce](https://github.com/ValueCell-ai/ClawX/commit/a1db9fce) / [#1287](https://github.com/ValueCell-ai/ClawX/pull/1287) | chore: bump bundled channel plugins compatible with OpenClaw 2026.7.1-2 (#1287) | 逐项核对现有插件版本，不降级本地较新内核依赖 |
| 2026-09-07 | [f5bb8c02](https://github.com/ValueCell-ai/ClawX/commit/f5bb8c02) / [#1288](https://github.com/ValueCell-ai/ClawX/pull/1288) | fix: activate plugin channels after save and reject invalid Feishu credentials (#1288) | 凭据验证有价值；激活需接 Channel owner |
| 2026-09-08 | [6a938757](https://github.com/ValueCell-ai/ClawX/commit/6a938757) / [#1278](https://github.com/ValueCell-ai/ClawX/pull/1278) | refactor(settings): update developer mode description (#1278) | 低风险文案，但需符合本地开发者模式内容 |
| 2026-09-09 | [cc9fb719](https://github.com/ValueCell-ai/ClawX/commit/cc9fb719) / [#1289](https://github.com/ValueCell-ai/ClawX/pull/1289) | feat: support token dance (#1289) | 可选新 Provider，需接统一凭据与双内核投影 |
| 2026-09-10 | [1f2f50b3](https://github.com/ValueCell-ai/ClawX/commit/1f2f50b3) / [#1282](https://github.com/ValueCell-ai/ClawX/pull/1282) | feat: support speech-to-text (ASR) input and add model icons; fix ACP process management and refactor UI (#1282) | 拆分 ASR、图标/主题、ACP 退出三类改动 |
| 2026-09-10 | [f40e5dab](https://github.com/ValueCell-ai/ClawX/commit/f40e5dab) / [#1290](https://github.com/ValueCell-ai/ClawX/pull/1290) | fix: allow issue report export without conversations (#1290) | 随统一报告功能保留无会话导出能力 |
| 2026-09-11 | [607f33e0](https://github.com/ValueCell-ai/ClawX/commit/607f33e0) / [#1283](https://github.com/ValueCell-ai/ClawX/pull/1283) | feat: supports Computer Use feature experimentally (#1283) | 独立 Computer Use 项目，跨平台制品和权限适配 |
| 2026-09-11 | [e8ff1184](https://github.com/ValueCell-ai/ClawX/commit/e8ff1184) / [#1291](https://github.com/ValueCell-ai/ClawX/pull/1291) | fix: support WeCom calendar queries in single-account desktop sessions (#1291) | 值得移植；插件 patch 纳入签名内核构建 |
| 2026-09-11 | [33a1a1a7](https://github.com/ValueCell-ai/ClawX/commit/33a1a1a7) / [#1293](https://github.com/ValueCell-ai/ClawX/pull/1293) |  fix: recover OpenClaw-generated file (#1293) | 从结构化 live 事件导入附件，保留 Blob 权威 |
| 2026-09-14 | [5a735537](https://github.com/ValueCell-ai/ClawX/commit/5a735537) / [#1294](https://github.com/ValueCell-ai/ClawX/pull/1294) | fix: render generated images inline from MEDIA paths (#1294) | 复用行内图片显示，勿恢复 transcript 补全 |
| 2026-09-14 | [a0b2a804](https://github.com/ValueCell-ai/ClawX/commit/a0b2a804) / [#1296](https://github.com/ValueCell-ai/ClawX/pull/1296) | feat: gate voice input behind developer mode (#1296) | 随 ASR 移植开发者模式 gate |
| 2026-09-14 | [f7ff4b4d](https://github.com/ValueCell-ai/ClawX/commit/f7ff4b4d) / [#1297](https://github.com/ValueCell-ai/ClawX/pull/1297) | release  0.5.7 (#1297) | 上游发布号，不覆盖本地 0.6.0 |
| 2026-09-15 | [170b9899](https://github.com/ValueCell-ai/ClawX/commit/170b9899) / [#1292](https://github.com/ValueCell-ai/ClawX/pull/1292) | feat: upgrade DingTalk to official connector 0.8.25 (#1292) | 官方钉钉/DWS 独立迁移，保留单 owner |
| 2026-09-15 | [9445f018](https://github.com/ValueCell-ai/ClawX/commit/9445f018) / [#1299](https://github.com/ValueCell-ai/ClawX/pull/1299) | chore(i18n): drop OpenClaw 3.31 note from QQ Bot channel description (#1299) | Batch 1 implemented |
| 2026-09-15 | [16c543bb](https://github.com/ValueCell-ai/ClawX/commit/16c543bb) / [#1298](https://github.com/ValueCell-ai/ClawX/pull/1298) | fix: preserve window zoom after minimize (#1298) | Batch 1 implemented; Windows native test pending platform |
| 2026-09-16 | [b67561a3](https://github.com/ValueCell-ai/ClawX/commit/b67561a3) / [#1301](https://github.com/ValueCell-ai/ClawX/pull/1301) | refactor: guide users to microphone permission settings and add missing audio-input declaration in macOS entitlements plist (#1301) | 随 ASR 补权限与签名包录音验收 |
| 2026-09-16 | [d5473067](https://github.com/ValueCell-ai/ClawX/commit/d5473067) / [#1302](https://github.com/ValueCell-ai/ClawX/pull/1302) | Fix dws install (#1302) | 必须随官方钉钉/DWS 一起吸收 |
| 2026-09-16 | [01b418ec](https://github.com/ValueCell-ai/ClawX/commit/01b418ec) / [#1300](https://github.com/ValueCell-ai/ClawX/pull/1300) | feat: refresh provider defaults and catalog-free runtime config (#1300) | Batches 1–2 implemented; JSONL excluded |
| 2026-09-16 | [34ad624b](https://github.com/ValueCell-ai/ClawX/commit/34ad624b) / [#1303](https://github.com/ValueCell-ai/ClawX/pull/1303) | fix: migrate Astra reasoning effort from none to low (#1303) | Batch 2 implemented; other explicit efforts/protocols preserved |
| 2026-09-18 | [24a24b77](https://github.com/ValueCell-ai/ClawX/commit/24a24b77) / [#1304](https://github.com/ValueCell-ai/ClawX/pull/1304) | release 0.5.8 (#1304) | 发布 0.5.8；仅作为本次审查基准 |
