# ClawX Multi-Kernel Implementation TODO

> 对应设计：[docs/zh-CN/multi-kernel-design.md](docs/zh-CN/multi-kernel-design.md)
>
> 状态：M19 已修复 OpenClaw 生产存储桥接、配置及 Channels，并切换本地源码/依赖为 2026.9.2+clawx.7；真实 Gateway/ACP 与 macOS arm64 payload 已有验证记录。受保护五目标签名、公证、真实账号/长上下文、生产镜像演练及法务批准仍是发布门禁，不以本机结果代替
>
> 最近完整本地证据（2026-09-01）：Vitest 243 files / 241 passed / 2 skipped、2116 tests passed / 6 skipped（其中制品依赖项只在真实 CI 制品存在时执行）；Electron E2E 既有证据 151 passed / 3 platform skips；multi-kernel chaos 既有证据 28/28；DSH `0.1.2-alpha.2` 干净精确上游树完成严格 patch/overlay 重放、冻结安装、完整 host build、12 files / 43 focused tests，并在真实 macOS `sandbox-exec` 下通过 3/3 runtime self-tests；typecheck、lint、comms 与本任务 Harness 全绿
>
> 远端证据核对（2026-09-06）：实现分支为 `Tabll/ClawXXX` 的 `main`；`kernel-staging` 与 `kernel-production` 均启用 `Tabll` required reviewer 和 selected refs，staging 仅允许 `main`，production 仅允许 `main` 与 `v*`。签名、公证凭据已分别配置到两个环境。旧 DSH 输入运行 `33412268471` 已取消；升级 commit `d68414b4` 的 [运行 `33971358333`](https://github.com/Tabll/ClawXXX/actions/runs/33971358333) 已审批并真实执行五目标构建。两种 macOS 的签名与公证步骤均成功（写报告脚本要求 Apple `Accepted`），随后因 prepared lockfile 校验阶段错误而终止，尚无可发布制品；Linux 缺原生 Landlock 构建，Windows 遇到 CRLF 哈希差异。首次失败没有保留公证报告，后续构建已增加失败时报告归档，仍须取得制品、提交 ID、干净机器校验及生产分发证据；不将步骤成功误记为发布完成。
>
> 目标：OpenClaw 与 DeepSeek Harness 可选下载、共享 ClawX UI、能力同构、同时运行，并以单一 SQLite 统一保存 Conversation、Cron、Channel 与 Usage 记录

> 第二轮真实证据（2026-09-06）：[运行 `34005793546`](https://github.com/Tabll/ClawXXX/actions/runs/34005793546) 的 macOS arm64/x64 build 均成功并生成 `.9` runtime；Apple `Accepted` 提交 ID 分别为 `5d2a32bc-4453-4669-b710-602795c04565` / `79531195-6ed4-4e55-9a09-13d7d512bc77`，报告 ZIP 已对照 GitHub SHA-256 核验。本机 arm64 真实制品通过 7 个 Mach-O 的严格签名及在线 notarized requirement、控制桥、完整 sandbox/工具 self-test，RSS 约 49 MiB、ready 1009 ms，无 native durable history；这不是完整 CI/宿主 Gatekeeper/生产分发完成。Linux/Windows 修复继续使用新身份 `.10`，不发布失败集合。

## 使用约定

- `[ ]` 未开始，`[-]` 进行中，`[x]` 完成，`[!]` 阻塞。
- 每个实施 PR 必须引用或新增 `harness/specs/tasks/` 下的任务规格。
- 涉及 Renderer/Main/ACP/Gateway/Bridge 的 PR 必须引用 `gateway-backend-communication`，并运行 comms profile。
- 任一阶段不得通过临时 DeepSeek Web UI、Renderer 内核分支或最终用户机器 npm install 绕过设计边界。
- 不迁移旧对话/Cron history；旧 runtime 文件不导入、不扫描、不删除。新功能不得用长期双写或 history fallback 绕过统一 SQLite。
- “完成”以阶段 Acceptance 为准，不以代码合并或 happy-path 演示为准。

## M0：设计冻结与技术闸门

- [x] `MK-0001` 评审并批准 `ClawX Kernel Contract v1` 的身份、生命周期、Chat 和控制面边界。
- [x] `MK-0002` 冻结首发平台矩阵：macOS arm64/x64、Windows x64、Linux x64/arm64；确认 RPM arm64 是否延期。
- [x] `MK-0003` 冻结首发 OpenClaw 与 DeepSeek Harness 上游精确版本/commit/integrity。
- [x] `MK-0004` 建立上游许可证、再分发、补丁和 THIRD_PARTY_NOTICES 审核记录。
- [x] `MK-0005` 完成 OpenClaw Conversation Store SDK spike：new/prompt/cancel/compact/branch/restart 从 SQLite hydrate/persist，且不产生 durable session/trajectory JSONL。（仅 SDK/adapter 证据，不代表真实生产 ACP/Gateway；生产接入缺口见 M19。）
- [x] `MK-0006` 完成 DSH rich ACP + ClawX persistence spike：tool、permission、cancel、resume、config、usage 从 SQLite hydrate/persist，且不产生 durable JSONL。
- [x] `MK-0007` 完成两个内核同时运行和同时 prompt 的 process/stdio spike。
- [x] `MK-0008` 测量 base app、OpenClaw artifact、DSH artifact 的 compressed/unpacked/file-count/startup/RSS 基线。
- [x] `MK-0009` 记录 Go/No-Go：任一内核无法关闭原生 durable history、无法从 canonical context 恢复或无法稳定提交事件时不得进入实现阶段。
- [x] `MK-0010` 完成单一 DataService/SQLite 双内核并发写、崩溃恢复、disk-full 和 backup/restore spike。
- [x] `MK-0011` 冻结“同一 Conversation 切换内核”的 portable context、private reasoning、tool result 和 attachment 可见性规则。

### M0 Acceptance

- [x] DSH spike 使用当前 ClawX ACP timeline 渲染完整真实回合，不依赖官方 Web UI。
- [x] cancel 真正中断 DSH live agent，而不是杀掉整个 runtime。
- [-] OpenClaw 与 DSH 都能在进程重启后只从 ClawX SQLite 恢复，并通过真实进程/制品检查证明没有第二份 durable history。（2026-09-06 重新打开 OpenClaw 验收：当前 July 与 September 候选的真实 ACP session/new 都写入原生 replay SQLite；SDK/宿主目录 fixture 不足以证明生产路径。）
- [x] 两个 runtime 同时运行时 conversation/run/event/request identity 不串线。
- [x] 同一 Conversation 可在 turn 边界从 OpenClaw 切到 DSH，再切回 OpenClaw；private/secret blocks 不进入错误内核上下文。
- [-] 三个主平台至少完成一轮 CI artifact 启动验证。（五目标 clean-machine workflow 已绑定真实制品入口、生产 Package Manager 完整安装链路、双真实制品并发/故障隔离、runtime-dir scan、共享 UI E2E 与 comms；等待受保护 runner 首轮结果）

## M1：任务规格、领域契约与测试骨架

- [x] `MK-0101` 新增每个里程碑的 Harness task spec，并引用本设计和 reference。
- [x] `MK-0102` 在 `shared/` 定义独立于 kernel 的 `ConversationId`/`TurnId`/`RunId`，以及 kernel-scoped entity/runtime binding identity。
- [x] `MK-0103` 定义 `KernelDefinition`、`KernelDriver`、`KernelCapabilities`、runtime snapshot。
- [x] `MK-0104` 定义 conversation/run-scoped Host API 与包含 conversationId/runId/kernelId/generation/eventSeq 的 event envelope。
- [x] `MK-0105` 定义 Agents/Providers/Skills/Usage canonical contracts。
- [x] `MK-0106` 定义 Channels canonical account/form/status/target/binding contracts。
- [x] `MK-0107` 定义 Cron canonical schedule/delivery/run contracts。
- [x] `MK-0108` 编写 driver contract test kit 和 fake OpenClaw/DSH drivers。
- [x] `MK-0109` 编写 protocol/store replay fixtures，包含两个内核同名 native IDs、重复 event IDs 和交错 writes。
- [x] `MK-0110` 定义 `ConversationStoreProtocol`、`KernelContextCompiler`、portable block visibility 与 checkpoint codec contract。
- [x] `MK-0111` 定义 ExtensionHost kernel capability API、`supportedKernels` 和 legacy OpenClaw extension 兼容边界。
- [x] `MK-0112` 定义不导入旧 session/Cron history、且不允许 runtime history fallback 的 cutover contract tests。

### M1 Acceptance

- [x] Renderer 共享类型中不存在 OpenClaw/DSH 原始协议类型。
- [x] 所有执行写契约显式携带 conversation/run/kernel identity；纯 Conversation CRUD 不错误绑定到某个 kernel。
- [x] 两个 fake drivers 通过同一 lifecycle/domain contract suites。
- [x] fake drivers 只能通过 fake DataService 写历史，直接 native persistence 会使测试失败。

## M2：ClawXDataService、统一 SQLite 与 Blob Store

- [-] `MK-0201` 验证 packaged Electron 43 的 `node:sqlite`、FTS5、WAL checkpoint 和一致性 snapshot 三平台可用性；引入 `<userData>/state/clawx.sqlite`。（本机 Electron 43 已通过，等待远端三平台 matrix 首轮执行）
- [x] `MK-0202` 实现 Main-owned DataService utility process、版本化 RPC、single-owner lifecycle 和 crash restart。
- [x] `MK-0203` 实现 owner-only DB/backup/blob 权限、foreign keys、WAL、busy timeout、schema version。
- [x] `MK-0204` 创建 conversations/turns/content_blocks/runs/run_events/tool_calls/permissions/usage tables。
- [x] `MK-0205` 创建 runtime_contexts/checkpoints，强制 kernel/codec/schema version 隔离。
- [x] `MK-0206` 创建 channel accounts/bindings/messages/delivery attempts tables 和 external message unique constraints。
- [x] `MK-0207` 创建 cron jobs/admissions/runs tables 和 `(jobId, scheduledFor)` unique admission。
- [x] `MK-0208` 创建 agents/providers/skills/kernel installations/projections/operations/schema migrations tables。
- [x] `MK-0209` 实现 prompt-before-dispatch admission transaction 和 terminal run atomic commit。
- [x] `MK-0210` 实现流式 delta batching、tool/permission immediate commits、stable event id 去重和 interrupted-run recovery。
- [x] `MK-0211` 实现 Conversation history keyset pagination、FTS5 search、rename/pin/delete/export。
- [x] `MK-0212` 实现 content-addressed Blob Store、hash verification、refs、GC、attachment access policy；禁止大 BLOB 进入 SQLite。
- [x] `MK-0213` 实现 KernelContextCompiler：visibility/redaction/budget/truncation/summary/version provenance。
- [x] `MK-0214` 实现同一 Conversation single-active-run lease，并为未来 branch/compare 预留 parentTurnId。
- [x] `MK-0215` 实现 WAL-aware backup、restore、quick/integrity check、read-only recovery 和 corrupt DB quarantine。
- [x] `MK-0216` 实现 operation id、desired state、projection status 和幂等 reconciliation。
- [x] `MK-0217` 确认 secrets 只存 keychain reference，不进入 SQLite、backup 或 Blob Store。
- [x] `MK-0218` 添加 concurrent kernels、busy、disk full、kill -9、partial stream、schema mismatch、backup/restore 和 blob leak tests。

### M2 Acceptance

- [x] DataService 是唯一 SQL owner；Renderer、Main services 和 kernel processes 都不能直接打开 DB。
- [x] user turn/run admission 成功后才 dispatch；terminal UI 只在 final transaction 后显示 durable-complete。
- [x] 同一 Conversation 可以包含不同 kernel runs，顺序稳定，private context 不跨内核泄漏。
- [x] runtime 被卸载后 Conversation/Cron/Usage 仍可完整查询。
- [x] projection partial failure 可重试且不会删除另一个内核状态。
- [-] backup/restore、corruption recovery 和 disk-full fail-closed 在 macOS、Windows、Linux 通过测试。（本机通过，等待三平台 CI）

## M3：Kernel Catalog 与 CI 运行时构建

- [x] `MK-0301` 新增 `kernels/catalog.schema.json` 和严格解析器。
- [x] `MK-0302` 新增 `kernels/openclaw/source.json`、冻结 lockfile 和 patch series。
- [x] `MK-0303` 新增 `kernels/deepseek-harness/source.json`、冻结 lockfile 和 patch series。
- [x] `MK-0304` 把现有 `patches/openclaw@2026.7.1-2.patch` 纳入有序、可验证的 runtime patch pipeline。
- [x] `MK-0305` 创建 DSH bridge packages 和 patch regression test workspace。
- [x] `MK-0306` 实现严格 patch apply，禁止 fuzz/offset 和未记录的工作树修改。
- [x] `MK-0307` 实现 platform/arch dependency materialization 和 native payload allowlist。
- [x] `MK-0308` 为 OpenClaw 与 DSH 下载、固定、签名并验证各自独立的 Node 24 runtime。
- [x] `MK-0309` 生成 deterministic tar.zst、SHA-256、file manifest。
- [x] `MK-0310` 生成 SBOM、THIRD_PARTY_NOTICES 和 build provenance。
- [x] `MK-0311` 建立 artifact signing key、rotation 和 emergency revocation 设计。
- [x] `MK-0312` 建立 staging build 与 production catalog promotion 分权 workflow；绑定执行仓库/tag/descriptor URL，production sequence 1 需双镜像缺失证明与显式 bootstrap，后续正常晋级只接受双镜像一致且验签通过的精确 N−1 catalog，部分写入可安全幂等修复，并校验整个新 catalog 有效期。
- [x] `MK-0313` 建立干净 VM packaged runtime smoke matrix。
- [x] `MK-0314` 建立 artifact size/startup/RSS budget gate。
- [x] `MK-0315` 为 catalog 加入 sequence/expiry/key-id、防回滚状态和紧急 rollback authorization。
- [x] `MK-0316` 在 artifact manifest 声明 Conversation Store protocol/checkpoint codecs，并运行无 native durable history 目录扫描。

### M3 Acceptance

- [x] 同一 source/lock/patch 输入产生可复现 artifact 内容。
- [x] artifact version 包含 upstream version + `clawx.N` 且不可覆盖发布。
- [x] 每个 artifact 可追溯到 source、patch、lockfile、tests、SBOM 和签名。
- [x] 客户端安装路径完全不执行 npm/pnpm/postinstall。
- [-] 每个内核 artifact 的 storage contract test 证明只通过 DataService 持久化。（adapter/bridge 本地测试与扫描已通过；真实 artifact 的 managed roots scan、生产安装/卸载及双制品共用 SQLite 已接入五目标 matrix，等待受保护首轮结果）

## M4：KernelPackageManager

- [x] `MK-0401` 实现 catalog fetch/cache/signature verification 和离线 fallback。
- [x] `MK-0402` 实现 compatibility resolution：host/protocol/platform/arch/ABI。
- [x] `MK-0403` 实现下载进度、cancel、Range resume、ETag/partial identity。
- [x] `MK-0404` 接入现有 proxy 配置和中国区镜像/CDN fallback。
- [x] `MK-0405` 实现磁盘空间和 staging/rollback reserve 预检。
- [x] `MK-0406` 实现 archive traversal/symlink/hardlink/device/zip-bomb 防护。
- [x] `MK-0407` 实现 verify、atomic activate、last-known-good、rollback。
- [x] `MK-0408` 实现 smoke-test、quarantine、repair 和 integrity rescan。
- [x] `MK-0409` 实现 uninstall runtime/preserve data 和选择性数据删除确认。
- [x] `MK-0410` 实现 Windows locked runtime rename-to-trash/next-launch cleanup。
- [x] `MK-0411` 实现离线 artifact import 和签名验证。
- [x] `MK-0412` 添加断网、截断、篡改、磁盘满、取消、崩溃恢复和 downgrade tests。

### M4 Acceptance

- [x] 无内核安装时 ClawX 正常启动并能进入 Kernel Catalog。
- [x] 损坏/不兼容 artifact 永远不能成为 current。
- [x] 更新失败后 last-known-good 可立即恢复。
- [x] 卸载 runtime 不删除统一 Conversation、Cron、Channel、Usage、配置、Blob refs 或 keychain secrets。

## M5：并发 KernelSupervisorRegistry

- [x] `MK-0501` 新增 `electron/kernels/` 并实现 supervisor registry。
- [x] `MK-0502` 把 process ownership、generation、health、restart budget 按 kernel 隔离。
- [x] `MK-0503` 实现 start/stop/restart/status/logs/diagnostics Host API。
- [x] `MK-0504` 实现 app quit 时两个 process tree 的并行有界清理。
- [x] `MK-0505` 实现 crash-loop detection 和 per-kernel rollback suggestion。
- [x] `MK-0506` 实现运行中版本不可删除/不可覆盖保护。
- [x] `MK-0507` 实现两个内核同时 running、一个 restart 不影响另一个的 tests。
- [x] `MK-0508` 去除 Main startup 对单个全局 `gatewayManager` 的初始化假设。
- [x] `MK-0509` 把 `gatewayAutoStart` 迁移为 per-kernel autoStart policy。

### M5 Acceptance

- [x] 两个 runtime 同时 ready，状态、PID、日志和 generation 独立。
- [x] 一个 runtime crash/restart/stop 时另一个持续完成 live prompt。
- [x] 退出应用后无 ClawX-owned kernel child/grandchild 残留。

## M6：OpenClaw 可选运行时与 OpenClawKernelDriver

- [x] `MK-0601` 用 `OpenClawKernelDriver` 包装现有 GatewayManager/ACP/config services。
- [x] `MK-0602` 将 `getOpenClawDir/EntryPath` 改为安装记录注入，不读取固定 `process.resourcesPath/openclaw`。
- [x] `MK-0603` 从 `electron-builder.yml` 移除 `build/openclaw` extraResources。
- [x] `MK-0604` 从 `after-pack.cjs` 移除 packaged OpenClaw copy/prune，保留 runtime CI 等价验证。
- [x] `MK-0605` 修改 package/release scripts，使 base installer 不要求本地 OpenClaw bundle。
- [x] `MK-0606` 修改 macOS/Windows/Linux CLI wrapper 安装，未安装内核时不创建失效 CLI。
- [x] `MK-0607` 移除 installer 中按通用 `openclaw-gateway.exe` 全局 kill 的行为。
- [x] `MK-0608` 将 startup predeploy skills/plugins/context/doctor 置于 OpenClaw driver 生命周期内。
- [x] `MK-0609` 为 managed OpenClaw 使用独立 config/cache roots；旧 `~/.openclaw` history 不导入、不扫描、不删除。
- [-] `MK-0610` 对 packaged downloaded runtime 运行现有 OpenClaw focused/unit/E2E/comms suites。（clean-machine workflow 已对真实下载制品执行断点续传、验签、安全解包、控制桥 smoke、激活/rescan/uninstall、managed entrypoint，并在同一 job 运行 OpenClaw patch/driver/storage、共享 UI E2E 与 comms；等待受保护五目标首轮证据）
- [x] `MK-0611` A/B 测量并记录 base installer 体积变化。（macOS arm64 本地实际 0.6.0 DMG/ZIP 相对 0.5.4 分别下降 43.587%/47.443%，hash 与无 runtime payload 扫描已记录；签名发布确认仍归 M16）
- [x] `MK-0612` 用 `OpenClawLegacyExtensionAdapter` 替换扩展对单例 `GatewayManager` 的直接访问。
- [x] `MK-0613` 实现 `@clawx/openclaw-conversation-store`，覆盖 SessionManager、metadata、compaction、branch/fork、reset 和 memory search source。
- [x] `MK-0614` 在 managed mode 禁止 durable sessions.json/session/trajectory JSONL、native Cron history 和 transcript usage scan。
- [x] `MK-0615` 把现有 sessions-api、cron-api、token-usage 的 JSONL/Gateway history fallback 替换为 Conversation/Cron/Usage repositories。
- [x] `MK-0616` 添加 runtime-dir regression：prompt/cancel/compact/restart/Cron/Channel 后无第二份 durable history。

### M6 Acceptance

- [x] 主安装包不包含 OpenClaw runtime/node_modules/plugins payload。
- [-] 首次安装 OpenClaw 后所有新 Conversation/Agents/Channels/Cron/Skills/Usage 使用统一契约和 SQLite。（本地 package-manager/driver/domain/E2E 已通过；真实签名制品首次安装、卸载保留 SQLite 与双制品同库验证已接入五目标 CI，等待首轮证据）
- [-] OpenClaw 从 SQLite portable context 完成重建，且不读取旧 history。（M19 已接通生产 per-Run incognito hydrate、强制崩溃/新 generation 恢复；生产不使用原生 opaque checkpoint。SDK compact/branch 合约保留，五目标及真实 Provider 长上下文/自动压缩仍待验收。）
- [x] OpenClaw 未安装时不执行任何 OpenClaw 文件写入或 Gateway 启动副作用。

## M7：ConversationRouter、统一 Chat History 与跨内核续接

- [x] `MK-0701` 把 `AcpChatService` 重构为 per-kernel execution connection manager，并由 ConversationRouter 统一 admission/routing。
- [x] `MK-0702` 所有 prompt/cancel/permission/config payload 添加 conversationId/runId/kernelId/generation。
- [x] `MK-0703` Host events 添加 conversationId/runId/kernelId/runtimeGeneration/eventSeq。
- [x] `MK-0704` Zustand store 以 conversationId 展示统一 history，以 runId 隔离 live state。
- [x] `MK-0705` 历史加载、sidebar catalog、rename/pin/delete/search/export 全部改查 SQLite，不调用 runtime session/load。
- [x] `MK-0706` submit 前完成 user turn/run/attachments transaction，失败时不得 dispatch。
- [x] `MK-0707` 将 ACP/bridge events 规范化并批量写 run_events；terminal transaction 原子生成 assistant turn/usage/status。
- [x] `MK-0708` 打开另一 Conversation 或切换 kernel selector 时保留后台 run 流式接收。
- [x] `MK-0709` 实现同一 Conversation turn-boundary kernel switch 和 portable context rehydrate。
- [x] `MK-0710` 移除 OpenClaw transcript supplement/media/timing/file-activity history fallback，以统一事件/records 替代。
- [x] `MK-0711` 添加交错 updates、duplicate eventSeq、simultaneous permissions、cancel、DataService restart 和 selection race tests。
- [x] `MK-0712` 添加 same-conversation single-active-run lease；并行比较必须创建显式 branch。

### M7 Acceptance

- [x] 两个内核可同时 prompt、stream、cancel 和请求权限且不串线。
- [x] 页面导航不会停止后台内核 prompt。
- [x] SQLite 是唯一 history 权威；ACP/bridge 只是实时事件输入。
- [x] 同一 Conversation 可以依次由两个内核回复，并保留每个 turn/run 的 provenance。
- [x] 停止或卸载内核后仍可完整读取历史。

## M8：DeepSeek Harness Rich ACP 与 Control Bridge

- [x] `MK-0800` 实现单个长生命周期 `@clawx/dsh-runtime-host`，独占 DSH home writer lock 和 live Agent handles。
- [x] `MK-0801` 实现并打包 `@clawx/dsh-acp-bridge`。
- [x] `MK-0802` 实现 canonical context hydrate、session/new/prompt/cancel；内部 load 只能读取 DataService snapshot。
- [x] `MK-0803` 投影 text/reasoning/tool call/status/result/plan/usage/title。
- [x] `MK-0804` 实现 permissions、ask-user 和 permission mode config options。
- [x] `MK-0805` 实现 attachments/resources/images 和 workspace access contract。
- [x] `MK-0806` 实现冷 Conversation resume、per-run lease、checkpoint codec、process disposal 和 crash recovery。
- [x] `MK-0807` 实现并打包 `@clawx/dsh-control-bridge`。
- [x] `MK-0808` 实现 protocol initialize/version/capabilities/artifact identity negotiation。
- [x] `MK-0809` 实现 health、agents、providers、skills、usage、diagnostics RPC/events；Conversation catalog 不来自 DSH。
- [x] `MK-0810` stdout protocol-pure，所有诊断走 stderr/structured logs。
- [x] `MK-0811` 添加 DSH upstream-version patch regression 和 protocol golden replays。
- [-] `MK-0812` 完成 macOS/Windows/Linux sandbox/tool/permission smoke。（源码与签名制品 self-test 已接入五目标 matrix；2026-09-01 本机在系统沙箱外调用真实 macOS `sandbox-exec` 已通过 3/3，Windows 额外验证 ACL shell 与文件工具均拒绝 ambient `%TEMP%`，仍等待 Windows/Linux 与签名制品 matrix 首轮执行）
- [x] `MK-0813` 实现 `@clawx/dsh-clawx-persistence`，只通过 DataService context/event RPC 持久化并禁用 DSH durable JSONL。

### M8 Acceptance

- [x] DeepSeek Harness 完整使用当前 ClawX Chat/Timeline/Composer，不加载 DSH Web UI。
- [x] DSH 重启后从 ClawX SQLite 完整恢复 portable history/checkpoint，runtime home 无 durable transcript。
- [x] mandatory capability 缺失或 bridge identity 不匹配时 runtime 不进入 ready。

## M9：Providers、Models 与 CredentialBroker

- [x] `MK-0901` 把 provider account metadata 迁移到 canonical store，保留现有 keychain refs。
- [x] `MK-0902` 实现 per-kernel provider projection 状态和 reconciliation。
- [x] `MK-0903` OpenClaw adapter 保持 auth SQLite/config/secrets.reload 契约。
- [x] `MK-0904` 实现 DSH `@clawx/dsh-credential-provider`。
- [x] `MK-0905` 实现 Main CredentialBroker 的 process identity/account/purpose 授权。
- [x] `MK-0906` Models page 展示两个内核的支持、默认和错误状态。
- [x] `MK-0907` provider CRUD/validation/default/model picker 全部 kernel-scoped。
- [x] `MK-0908` 添加 secret redaction、bridge disconnect、partial projection tests。

### M9 Acceptance

- [x] 同一 Provider Account 可以安全投影到两个内核。
- [x] API key 不进入 Renderer、命令行、SQLite、日志或 runtime manifest。
- [x] 一个内核 projection 失败不阻止另一个使用已验证账号。

## M10：Agents 同构

- [x] `MK-1001` 实现 canonical agent index 和 per-kernel native mapping。
- [x] `MK-1002` OpenClaw agents/config/workspace/bindings 导入和 projection。
- [x] `MK-1003` 实现 DSH `@clawx/dsh-agent-catalog` 与 preset/persona/model/workspace mapping。
- [x] `MK-1004` Agents page CRUD 全部使用复合 agent identity。
- [x] `MK-1005` 默认 Agent 改为 per-kernel，不保留全局 defaultAgentId。
- [x] `MK-1006` Agent 删除保留历史 run agent snapshot，并实现 deleted-reference 展示/确认交互。
- [x] `MK-1007` 添加两个内核同名 agent、workspace、model change 和 deletion tests。

### M10 Acceptance

- [x] 两个内核使用同一 Agents 页面和表单完成 CRUD。
- [x] 新 run 始终使用目标 agent 固定的 kernel/preset/workspace/model snapshot。
- [x] 删除 agent 默认不删除统一 Conversation 或历史 run provenance。

## M11：Skills 同构

- [x] `MK-1101` 实现 canonical skill metadata 和 per-kernel states。
- [x] `MK-1102` OpenClaw Skills/ClawHub adapter 接入通用 contract。
- [x] `MK-1103` DSH bridge 接入 `ctx.skills`/filesystem provider。
- [x] `MK-1104` 实现 install/uninstall/update/enable/disable 到单内核或 Both。
- [x] `MK-1105` 实现 partial success、compatibility diagnostics 和 retry。
- [x] `MK-1106` 建立 ClawX bundled skills 的 OpenClaw/DSH 兼容矩阵。
- [x] `MK-1107` 为核心 Skills 提供转换/补丁或明确不兼容原因。
- [x] `MK-1108` 禁止 OpenClaw/DSH skill roots 直接软链接并添加 regression test。

### M11 Acceptance

- [x] 同一 Skills 页面显示、管理和诊断两个内核状态。
- [x] Both 操作允许 partial state，但不伪报全部成功。
- [x] Skill 资源引用不会越过目标内核的访问边界。

## M12：Channel Orchestrator 与 DeepSeek Relay

- [x] `MK-1201` 把 channel account metadata/secrets/bindings 写入统一 canonical ownership。
- [x] `MK-1202` 定义并实现 connection owner lease/lock。
- [x] `MK-1203` OpenClaw native channel adapter 投影配置、状态、targets 和 login events。
- [x] `MK-1204` 实现 ClawX Channel Relay connector runtime。
- [x] `MK-1205` 为 DSH 实现 inbound admission、Conversation routing 和 outbound delivery。
- [x] `MK-1206` 实现 channel attachment staging、Blob refs 和 per-run access grants。
- [x] `MK-1207` 默认拒绝无人值守 channel permission escalation。
- [x] `MK-1208` 实现 message idempotency、conversation serialization、retry/dead-letter。
- [x] `MK-1212` 把 inbound/outbound message identity、Conversation mapping、delivery attempts 全部写入 SQLite，禁止 connector 私有 message history。
- [x] `MK-1209` Channels page binding 添加 kernel + agent，并保持同一表单/状态模型。
- [x] `MK-1210` 实现原子 rebind 和失败回滚。
- [x] `MK-1211` 为所有支持 channel 编写两个 adapter 的 contract/E2E 矩阵。

### M12 Acceptance

- [x] OpenClaw 与 DSH 可同时连接不同 channel accounts。
- [x] 同一外部 account 永远只有一个 active owner。
- [x] 两个内核在当前 Channels UI 中具有相同 CRUD/login/status/binding/target/delivery 行为。
- [x] Channel 产生的对话与普通 Chat/Cron 使用同一 conversations/turns/runs，重复 external message 不产生重复 turn。

## M13：ClawXScheduler 与统一 Cron Store

- [x] `MK-1301` 实现 canonical schedule parser、timezone、validation。
- [x] `MK-1302` 实现 scheduler leader、timer queue、misfire 和 overlap policies。
- [x] `MK-1303` 实现 kernel-scoped scheduled turn executor。
- [x] `MK-1304` 实现 Channel Orchestrator delivery。
- [x] `MK-1305` 在 SQLite 实现 jobs/admissions/runs、manual trigger、cancel/timeout diagnostics。
- [x] `MK-1306` 实现 `(jobId, scheduledFor)` 幂等 due admission，先提交 canonical run 再 dispatch。
- [x] `MK-1307` 实现 `reuse`/`new-per-run`/`new-per-day` Conversation policy。
- [-] `MK-1308` 在 ClawX-managed OpenClaw/DSH 中禁用原生 schedulers 和 native run-history writes。（M19 已用真实 incognito/内存 ACP ledger、SQLite 写入栅栏与 Cron guard 修复 OpenClaw 本地执行路径，不再依赖无效 history 标记；五目标制品验收仍待完成。DSH 既有独立证据保留。）
- [x] `MK-1309` 明确不扫描或导入旧 OpenClaw Cron/DSH Schedule/history。
- [x] `MK-1310` Cron 页面添加 kernel/agent/concurrency fields，保持统一交互。
- [x] `MK-1311` 添加双内核同时到期、重启、更新中、内核缺失和 duplicate prevention tests。
- [x] `MK-1312` 固定首版生命周期语义：窗口关闭但应用存活时继续调度；显式退出后按 restart misfire policy 处理。

### M13 Acceptance

- [x] 所有新建 Cron jobs 由 ClawXScheduler 单一执行。
- [x] 所有 job/admission/run/delivery records 只存在于 ClawX SQLite，runtime history dirs 保持为空。
- [x] OpenClaw 与 DSH jobs 可同时运行并使用同一 UI、Conversation、run history 和 delivery contract。
- [x] 重启/重放同一 due time 不会生成第二个 canonical run。

## M14：Usage、Diagnostics 与 Dashboard

- [x] `MK-1401` 实现 canonical usage adapter contract。
- [x] `MK-1402` OpenClaw live provider/agent usage event adapter，移除 transcript scan。
- [x] `MK-1403` DSH live SessionEvent/token meter usage adapter。
- [x] `MK-1404` Dashboard 添加 All/OpenClaw/DSH filters 和成本口径标识。
- [x] `MK-1405` Diagnostics snapshot 按内核显示 artifact/protocol/process/health/capabilities。
- [x] `MK-1406` 日志目录和导出按 kernel 隔离并统一 redaction。
- [x] `MK-1407` 添加 unknown token/cost fields、duplicate event 和 timezone aggregation tests。
- [x] `MK-1408` Usage query 全部读取 SQLite usage_entries，并验证 provider retry/multi-call 不重复计费。

### M14 Acceptance

- [x] 两个内核的 Usage 在同一 Dashboard 展示且不会把缺失值当 0。
- [x] Dashboard 不扫描 OpenClaw/DSH transcript 或 runtime 目录。
- [x] diagnostics 可定位到精确 artifact、patch revision 和 runtime generation。

## M15：Renderer、Setup、i18n 与完整 E2E

- [x] `MK-1501` Setup 改为 Kernel Catalog，可分别安装/跳过两个内核。
- [x] `MK-1502` Sidebar/TitleBar 展示两个内核独立状态和更新。
- [x] `MK-1503` Chat Conversation catalog、过滤、provenance 徽标、attention、workspace 和 SQLite pagination/search。
- [x] `MK-1504` Settings 添加 kernel install/update/repair/rollback/uninstall/data/logs。
- [x] `MK-1505` 清除 Renderer 对 `gateway.*` 和全局 gateway status 的业务依赖。
- [x] `MK-1506` 所有文案补齐 en/zh/ja/ru locale parity。
- [x] `MK-1507` 所有状态使用 `globals.css` 设计 tokens。
- [x] `MK-1508` E2E：无内核、单内核、双内核并行、安装失败、更新回滚。
- [x] `MK-1509` E2E：双 Chat 流、permissions、Channels、Cron、Agents、Skills、Models、Usage。
- [x] `MK-1510` Renderer performance profile 覆盖两个内核同时 streaming。
- [x] `MK-1511` UI：Conversation 内切换下一次执行内核，显示 runtime boundary，但不复制/清空 history。
- [x] `MK-1512` UI：无内核或内核卸载后仍可打开、搜索、重命名、导出、删除 history。
- [x] `MK-1513` E2E：同一 Conversation OpenClaw→DSH→OpenClaw；private reasoning/secret/tool payload 不跨内核注入。

### M15 Acceptance

- [x] 页面/组件没有按 kernelId 分叉的后端业务逻辑。
- [x] 所有用户可见新流程有 Electron E2E 和四语言覆盖。
- [x] 两个内核同时运行时 Renderer 性能不低于批准预算。
- [x] UI history 只调用 Conversation API，不调用 runtime session catalog/load 或读取文件。

## M16：安全、发布与文档

- [x] `MK-1601` 完成 runtime signing key 管理、rotation、revocation runbook。
- [-] `MK-1602` 完成 macOS runtime executable 签名/公证验证。（运行 `34005793546` 已产出两架构制品与 `Accepted` 提交 ID，arm64 本机制品验证通过；独立 Mach-O 使用严格 `codesign --check-notarization -R=notarized`，不能套用 `.app` 的 spctl/staple；新 revision 的完整干净 CI 和宿主 App/DMG Gatekeeper/staple 仍待完成）
- [-] `MK-1603` 完成 Windows process tree、文件锁、签名和卸载验证。（遵循 2026-08-31 暂缓 Authenticode 的决定，runtime CI 显式提供 `artifact-signature-only` 模式并写入哈希绑定安全报告；Ed25519、archive hash、沙箱与安装卸载校验不放宽；仍等待 Windows packaged runner 结果，宿主安装包签名另行处理）
- [-] `MK-1604` 完成 Linux glibc/kernel/sandbox 支持矩阵。（glibc >= 2.39、kernel >= 6.8、x64/arm64 与 DSH sandbox self-test 已固化；等待两个 Linux runner 结果）
- [-] `MK-1605` 完成腾讯 COS/GitHub 镜像和断点续传运行演练。（COS 已固定 `aq-pub-1252262977/ap-shanghai/clawxxx`，官方 SDK、object-key 边界、SHA-256 metadata、immutable forbid-overwrite 与 catalog-last 已实现；双 catalog/双 artifact host、Range/If-Range、精确 N−1 双镜像连续晋级与重试演练已通过模拟测试，仍须生产 promotion 后取得在线证据）
- [-] `MK-1606` 完成 supply-chain/SBOM/license/security review。（deterministic artifact、SPDX/CycloneDX、provenance 与审计均已实现；本地 OpenClaw 587/DSH 97 个包审计通过；2026-08-31 决定暂缓许可证/法务，GPL/LGPL/MPL 履约地址和批准仍待发布负责人签字，不能据此完成正式发布门禁）
- [x] `MK-1607` 完成 crash/update/rollback/repair/disk-full/kill -9 chaos test。（本地 28/28）
- [x] `MK-1608` 更新 README.md、README.zh-CN.md、README.ja-JP.md。（同时更新 README.ru-RU.md）
- [x] `MK-1609` 更新 en-US/zh-CN/ja-JP/ru-RU architecture/features/development docs。
- [x] `MK-1610` 发布 support/compatibility/EOL policy、runtime release notes 和受保护 staging/promotion/部分发布恢复 runbook。
- [-] `MK-1611` 运行完整 typecheck/lint/unit/E2E/comms/harness CI/release validation。（本地完整证据已通过；release workflow 已将完整 unit/contract/type/lint/chaos/comms/Harness、三平台 Electron E2E 与线上分发演练设为打包硬前置，受保护五目标 CI/release 尚未运行）
- [x] `MK-1612` 完成 SQLite/Blob threat model、owner-only permissions、backup/restore、corruption/read-only recovery runbook。
- [x] `MK-1613` 决定并文档化 OS volume encryption 与未来 SQLCipher 的安全边界，不误称 node:sqlite 已加密。
- [x] `MK-1614` 发布数据保留/删除/export/backup policy，并明确旧 history 不迁移也不自动删除。

### M16 Release Gate

- [x] 主安装包不包含任何内核 runtime。（本地实际 DMG/ZIP、resources、ASAR 与 afterPack hard gate 已验证）
- [x] 两个内核通过同一 Chat/Agents/Providers/Channels/Cron/Skills/Usage contract suites。
- [-] 两个内核同时运行、同时任务、独立失败、独立更新全部通过 packaged E2E。（本地完整 E2E/contract 已通过；同机双真实签名制品并发控制桥、完整性故障/repair、独立卸载与 SQLite 保留已接入五目标 matrix，仍待受保护 CI 以及真实版本更新证据）
- [-] 所有 artifact 可验证、可追溯、可回滚，且默认卸载不删用户数据。（实现、确定性与本地/fixture 制品验证已通过；生产签名完整集合及 promotion 证据待取得）
- [x] 单一 SQLite 是 Conversation/Cron/Channel/Usage 唯一 durable authority；两个 runtime dirs 无第二份 durable history。（源码边界、adapter、runtime-dir、历史 cutover 与路径扫描 tests 已通过）
- [x] 同一 Conversation 跨内核续接、停止/卸载后离线浏览、backup/restore/corruption recovery 全部通过 E2E/chaos。
- [-] 安全、许可证、文档、i18n、性能和平台支持矩阵全部签字确认。（仓库内文档/i18n/性能已完成；平台签名、生产分发和法务签字待外部证据）

## M17：DeepSeek Harness `0.1.2-alpha.2` 维护升级

- [x] `MK-1701` 从官方 immutable tag `dsh-v0.1.2-alpha.2` 冻结 commit `0a53fb55bea101816fa226bb964ae2bed71c343b`、tree、lockfile 与 THIRD_PARTY_NOTICES 哈希。
- [x] `MK-1702` 将累积制品身份升级为 `0.1.2-alpha.2+clawx.9`，同步 source/runtime/lock/patch-regression/overlay manifest 与逐文件 SHA-256。
- [x] `MK-1703` 在全新 checkout 上以禁止 fuzz/offset 的严格模式重放 lock/project patch 与 Windows ambient-temp sandbox patch，并验证 prepared lockfile。
- [x] `MK-1704` 适配上游 ToolCallId、SessionProjection、BorrowedSessionSource、Loader base URL、AgentPresets、Todo rich-event 类型与新增依赖闭包。
- [x] `MK-1705` 适配作用域化 `user-questions/request`：孤儿问题只接受明确 fail-closed 原因，并新增 live Agent 提问—permission—answer 闭环测试，禁止用任意异常放宽自检。
- [x] `MK-1706` 在干净源码树完成 `pnpm install --frozen-lockfile`、`build:lib:host`、12 files / 43 focused tests 与真实 macOS sandbox self-test 3/3。
- [x] `MK-1707` 完成仓库 typecheck、lint（0 errors / 7 existing warnings）、241 files / 2116 tests、comms replay/compare 和本任务 Harness fast/comms profiles。
- [x] `MK-1708` 同步四语言 release notes、架构/reference、THIRD_PARTY_NOTICES 与本清单；README 四版本经复核无需改动功能描述。
- [-] `MK-1709` 从升级后的 `main` commit 重新执行受保护五目标 runtime build、macOS 公证、COS/GitHub 镜像上传、线上 Range/If-Range 演练与 production promotion；旧 DSH 输入运行禁止审批或晋级。
  - [x] 取消旧运行 `33412268471`，从升级 commit 启动并审批 `33971358333`；读取所有失败目标的真实日志。
  - [x] 修复跨平台 LF、upstream/prepared lock 校验、Linux 原生 Landlock 构建与 Windows 显式延后 Authenticode；失败时保留安全报告。
  - [x] 将会重解析依赖的 legacy hoisted deploy 改为 shared-lock deploy；本机验证锁定 Koffi `3.1.1`，显式执行已审计 spawn-helper 后处理，移除 builder 路径元数据并裁剪/精确白名单化原生包。
  - [x] 运行 `34005793546` 的两个 Linux 目标均通过原生 Landlock 沙箱 self-test、36 项上游/overlay tests 与 56 项宿主契约测试；制品校验发现 scoped Koffi 包同时携带 musl 文件，补齐 glibc-only 裁剪回归，禁止扩大支持矩阵来掩盖多余文件。
  - [x] Windows 真实 self-test 已证实只读写入被 `EPERM` 拒绝，但上游英文签名表漏判；将 CI-only 探针改为受控子进程错误码/退出码/精确目标路径加文件未生成校验，8 项正反例回归通过。因 overlay 字节变化将制品 revision 提升为 `0.1.2-alpha.2+clawx.10`，不复用 `.9` 身份。
  - [x] `.10` 新 checkout 严格 patch/overlay、冻结依赖、完整 host build、36 项 focused tests 及真实 macOS 沙箱自检通过；多入口打包保留根级哈希 JS chunks，避免新 helper 的共享输出被 package files 清单漏掉。
  - [x] `.10` 宿主回归：243 files / 2135 tests 通过（2 files / 6 tests 按既有平台条件跳过），source manifest、typecheck、lint、comms replay/compare 和任务 Harness 校验通过；新增严格公证票据校验的拒绝分支覆盖。
  - [x] 运行 `34007295656` 的两种 macOS（均含公证）和两种 Linux 构建通过；Windows 沙箱 self-test 通过，后续审计发现 sharp 合包的复合许可证漏识别。核验官方 `0.35.3` npm 包与冻结 SHA-512 后补齐精确 `AND` 表达式和独立履约记录；实包审计与 2137 项全量测试通过，不降级为仅 Apache，也不冒充法务批准。
    - `.10` 公证报告 ZIP 已按 GitHub artifact SHA-256 核验：arm64 `8cf9ffaa-acd3-4ba5-90db-1ae6734d70b0`、x64 `7913dfdf-979d-4f67-a054-3431f9df95f9` 均为 Apple `Accepted`；本轮 clean-machine matrix 因 Windows build 失败而跳过，不能记为通过。
  - [x] 上轮真实 macOS arm64 `.9` 制品通过生产 PackageManager 安装链路：注入中断后的 Range/If-Range 续传、签名、解包、控制桥、激活、重扫、卸载与 SQLite 保留全部通过（本机证据，不替代五平台 clean runner）。
  - [-] 修复提交推送后重新执行五目标 CI，取得全部制品、干净机器和线上分发证据；失败的旧构建不得晋级。2026-09-06 自动审批将 Windows 许可证元数据/履约记录修复判为超出此前“暂不处理法务”的授权，已拦截提交与推送；6 个相关文件仅保留在本地，远端仍为 `878f53c7`，需用户明确授权该最小修复后继续。COS 上传与线上 Range 演练尚未执行。

### M17 Acceptance

- [x] 已批准冻结的 DSH 上游版本、ClawX patch revision、所有 descriptor/hash 和文档身份完全一致；9 月 4 日新增的 `0.1.3-alpha.1` 有持久化破坏性变更及已知性能回退，不在构建中静默切换。
- [x] ClawX 统一 SQLite、并行多内核、凭据、Agent、Skill、权限、取消与 rich event 适配边界未退化。
- [x] 升级输入可由干净 checkout 严格复现并通过冻结安装、完整 host build、focused tests 与本机沙箱自检。
- [-] 五平台签名制品、Apple `Accepted`/staple/Gatekeeper、COS/GitHub 双镜像和线上断点续传证据待新 commit 的受保护 CI 完成。

## M18：DeepSeek Harness 0.1.3-alpha.1 破坏性接口升级

- [x] `MK-1801` 重新核验最新发布 `dsh-v0.1.3-alpha.1` 和完整提交 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，建立独立任务规格并保留旧版 CI/公证记录。
- [x] `MK-1802` 用 ClawX 自有、等待加载完成的服务组合替代已删除的 agent-spine-demo；接入代理启动/关闭与失败清理，不引入上游 UI、原生业务日志、调度器或凭据库。
- [x] `MK-1803` 适配 agent/assistant-stream 与 v2 settlement；覆盖成功、失败重试、取消（含 Agent 创建/附件准备竞态）、重复事件、并发 Run、最终回答和结算用量去重；投递失败不能报成功。
- [x] `MK-1804` 将可选 RPC 持久化接缝升级为 SessionHandle，验证跨客户端单写所有权、顺序、失败批次保留、flush、取消、关闭与冷 resume；生产路径仍不挂载原生 session store，业务历史只由 ClawX SQLite 管理。
- [x] `MK-1805` 重建冻结依赖/工程补丁和 Windows sandbox 补丁，更新 source/runtime/lock/61-file overlay 摘要与不可变身份 `0.1.3-alpha.1+clawx.11`；从干净 `d347e703` 严格准备和 frozen install 通过。
- [x] `MK-1806` 完成完整 host build（含固定 Node 24.15.0）、69 项 overlay/真实 macOS sandbox 测试，以及 production deploy、native allowlist、106 包许可证元数据审计、本地未签名 tar 打包/解包后的独立 Host 与存储边界检查。此项不包含签名制品/跨平台验收。
- [x] `MK-1807` 宿主 typecheck、lint（0 error / 7 既有 warning）、全量 2141 passed / 6 skipped、focused 27 passed、4 项 Electron 时间线 E2E、comms replay/compare、Harness CI、task validate/dry-run 与 diff check 通过；同步四语 README/release notes、设计与[升级契约](harness/reference/deepseek-harness-0.1.3-upgrade.md)。
- [ ] `MK-1808` 后续从审核后的提交执行五目标 CI、macOS 签名公证、clean-machine、COS/镜像发布和 Range 演练；本地升级不等于这些发布步骤已经完成。

上述本地升级证据日期为 2026-09-06；随后已通过 `ae066914` 提交并推送，首次双内核构建的结果及修复见 M19 CI 续验。未替换用户已安装内核。上游仍为 alpha 且公告存在性能回退，发布前还需代表性真实 Provider/长上下文验收。6 个未运行用例是既有条件性/真实制品闸门，不以本地 mock 或未签名包冒充通过。

## M19：OpenClaw 2026.9.2 兼容升级（本地源码已切换，远端发布未执行）

- [x] `MK-1901` 核验 GitHub/npm 最新稳定版 `2026.9.2`、完整 commit `3928bad9badfcb6c7d140530435e806fb8092190`、签名 tag 与 npm SHA-512；隔离下载/安装，不修改正式 pin、旧补丁或用户 runtime。
- [x] `MK-1902` 兼容 SessionManager 的 getSessionFile/getSessionTarget；未知持久化接口或非严格内存状态 fail closed；适配新 Agent 的隐藏取消标记断言。
- [x] `MK-1903` 新增显式版本的 candidate SDK 测试入口与真实 ACP/模拟 Gateway 存储探针；新版和旧版均复现 `acp_replay_sessions=1 / acp_replay_events=2`，该结果是阻断证据，不是通过项。
- [x] `MK-1904` 验证本轮有限的 guard/测试改动：宿主 2145 passed / 6 existing skipped，新版真实 SDK 7 passed；typecheck、lint（0 errors / 7 existing warnings）、source hash、comms replay/compare、Harness CI/task validate/dry-run、diff check 通过；同步四语 README、设计、规则及[升级审查](harness/reference/openclaw-2026.9.2-upgrade.md)。不以这些绿色检查宣称内核升级完成。
- [x] `MK-1905` 接通生产逐 Run incognito session + canonical typed-history hydrate；ACP replay/临时审批/传输状态仅内存，native SQLite 历史写入被阻止；真实 close/delete、取消后 terminal 排序和崩溃后新 generation 重建通过。不删除 combined SQLite，不把 SDK spike 当生产接入，不使用 native opaque checkpoint/历史恢复。
- [x] `MK-1906` 完成 agents.list ↔ keyed entries、默认 Agent、凭据/工作区保留与 CAS 重试投影；保留旧 exec 硬禁止，拒绝旧/不完整 managed 协议且不改写其配置；ACP provider/model/permission 使用真实 sessions.create/patch 和 ClawX 扩展。UI/宿主 canonical 合约保持统一。
- [x] `MK-1907` 完成旧 14-target patch 的逐组处置记录：usage/工具/订阅/Cron schema 重基，已上游实现的审批身份不重复覆盖，managed native replay/recovery/grace 由 per-Run hydrate + 明确中断替代；补丁严格准备和实际工具审批通过。新增文件纳入上游 postinstall inventory。
- [x] `MK-1908` 冻结 7 个 Channels 输入；修复 SDK 导出、Lark CJS metadata/import.meta、Baileys ESM、钉钉持久缓存和旧 plugin mirror；7 个真实 lazy outbound 模块加载及 canonical admission 成功/拒绝通过，补并发附件隔离与宿主投递合约回归。真实账号登录/收发不包含在本项，见 MK-1911。
- [x] `MK-1909` 显式限制 native session visibility/agent-to-agent/swarm/elevated、Cron、heartbeat、dreaming；保留 ClawX 统一服务。typed history/Run/generation 校验、scoped permission、排队取消与晚到事件回归通过。
- [x] `MK-1910` 更新 package/lock/patch/source/runtime/6-file overlay 和不可变身份 2026.9.2+clawx.7；干净官方 npm 严格准备、macOS arm64 payload、裁剪/import/native allowlist 和 622 包许可证元数据审计通过。新增五目标 native family/ABI 策略及嵌套裁剪回归；非本机平台/签名与归档预算实测仍属 MK-1912。
- [-] `MK-1911` 真实 Gateway/ACP + 可控本机 Provider 已通过多轮历史角色、工具/审批、模型/权限、取消、SIGKILL/新 generation 恢复、Channels admission 成功/拒绝、四次完整 usage 与无 native history；已接入 CI pre-seal 和 extracted-artifact 双重闸门。仍须真实 Provider 长上下文/自动压缩/异常重试、真实 Channel QR/媒体/收发及五目标 canonical Cron 端到端验收，不能用 SDK 或 UI mock 代替。
- [ ] `MK-1912` 从审核提交完成新的五目标 CI、双制品同库 clean-machine、macOS 签名公证、COS/GitHub 发布与线上 Range；不沿用旧制品证据或替换运行中的版本。

当前仓库 OpenClaw 为 `2026.9.2+clawx.7`，DSH 保持 `0.1.3-alpha.1+clawx.11`。源码升级已通过 `ae066914` 提交并推送至 `main`，首次双内核 CI 尚未全绿，见下方续验；没有替换已安装内核或发布生产 catalog。旧安装包在启动前必须通过 managed protocol 校验；开发模式使用新 root dependency，正式应用需下载新的已验证制品。详细架构、旧补丁处置及验证边界见[升级设计](harness/reference/openclaw-2026.9.2-upgrade.md)。

本地最终验证记录（2026-09-06）：

- 宿主 Vitest：252 个测试文件，**2167 passed / 0 failed / 6 existing pending**；6 个条件性/真实制品用例仍未执行。报告：`temp/openclaw-upgrade-vitest-final.json`。
- Electron E2E：**9 passed**，覆盖跨内核同一对话续聊、进程 timeline/失败重试及 Channels、Agents、Cron、Skills 共享 UI；这些是 UI fixture，不代替真实平台账号。
- 真实 macOS arm64 打包 payload：Gateway + ACP + 本机可控 Provider、固定 echo 审批/工具流、取消、SIGKILL 与新 generation hydrate、7 个 Channels 模块、canonical admission 接受/拒绝均通过；6 次 Provider 请求产生 4 个独立 usage 身份，不伪造缺失 cost，**无 native durable history**。报告：`temp/reports/openclaw-2026.9.2-payload-probe.json`。
- 干净官方 npm 严格 patch/overlay 准备、两内核冻结摘要、native allowlist/架构检查、622 包许可证元数据审计通过；本机裁剪后 payload 为 **40,412 个文件 / 644,888,037 bytes**（不含独立 Node/签名/归档开销，不是完整归档预算验收）。
- typecheck、lint（0 errors / 7 existing warnings）、Vite + Electron 构建、comms replay/compare、Harness CI、当前 diff-aware task validate/dry-run、`git diff --check` 通过。实际外部账号、长上下文和远端/签名制品项目继续按 MK-1911 / MK-1912 跟踪，未执行的不勾选。

### M19 CI 续验（2026-09-06）

- [x] `MK-1913` 定位 [首次双内核 CI 34035636685](https://github.com/Tabll/ClawXXX/actions/runs/34035636685)：10 个 build 中 5 成功 / 5 失败。DSH 四个非 Windows 目标及 OpenClaw Linux arm64 成功；两个 Windows 下载器因系统 temp 与 checkout 跨盘 `rename` 报 `EXDEV`；其余三个 OpenClaw 目标在真实 Gateway/ACP/Channels 探针通过后，因同一 Lark 加载单测超过默认 5 秒失败。macOS 两内核两架构均通过签名/公证步骤；失败的 OpenClaw macOS build 未产出最终归档。clean-machine 单/双内核验收被跳过，没有 COS 或生产 catalog 发布。[同提交 Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34035575245) 的三平台全部通过。
- [x] `MK-1914` 修复 npm 源码与 Node ZIP 下载器的同盘私有 sibling staging，保留完整性/身份校验后原子 rename 和 `finally` 清理。新增 12 项离线 CLI 回归，旧实现精确复现两处 `EXDEV`，修复后覆盖成功发布、坏摘要、下载失败、空/非空已有目录、npm 非法路径与包身份不符；回归在 CI 构建/签名前执行。
- [x] `MK-1915` Lark 真正 CommonJS entry 改在异步独立 Node 子进程加载并断言 `register`，60 秒超时强制终止、专用用例上限 75 秒；两个 `import.meta` 修复点独立做 CommonJS 语法断言。无全局 timeout 放宽、mock、retry、skip 或强行成功退出；原真实 packaged-runtime 探针保留。
- [x] `MK-1916` 本次修复的完整本地回归（Node 24.15.0）：focused **28 passed**；完整宿主 **253 files / 2180 passed / 0 failed / 6 existing pending**（`temp/kernel-ci-repair-vitest.json`）；两内核 CI storage suites 合集 **17 files / 81 passed**（`temp/kernel-ci-repair-storage-contracts.json`）。Lark 独立加载 focused 约 2.2 秒、完整并行套件约 3.7 秒。source hashes、typecheck、lint（0 errors / 7 existing warnings）、comms replay/compare、Harness CI、diff-aware task validate/dry-run、workflow YAML/前置测试顺序和 diff check 全部通过。检查了三语 README，UI/用户安装流程/运行时接口不变，无需翻译变更；约束和证据同步 reference/rule/scenario/task/TODO。Windows 真机、签名、公证和 clean-machine 仍须新 CI，不把本机模拟跨盘测试当远端通过。
- [ ] `MK-1917` 经审核提交/推送本次 CI 修复并重新执行十目标构建、单/双内核 clean-machine 验收；完成后再单独推进受保护生产发布与 Range。修复请求本身不等于重新构建、审批或生产发布已获执行/已通过。

## 每个实现 PR 的最低检查

- [x] 对应 Harness task spec 已创建并通过 `pnpm harness validate --spec ...`。
- [x] `pnpm run typecheck`
- [x] `pnpm run lint:check`（0 errors；7 existing Fast Refresh warnings）
- [x] 相关 focused unit tests
- [x] 所有用户可见变更的 Electron E2E（151 passed；3 platform skips）
- [x] 通信路径变更：`pnpm run comms:replay`
- [x] 通信路径变更：`pnpm run comms:compare`
- [x] `pnpm run harness:ci`
- [x] `git diff --check`
- [x] README/架构/四语言是否需要同步已明确记录
