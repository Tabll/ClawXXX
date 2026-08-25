# ClawX Multi-Kernel Implementation TODO

> 对应设计：[docs/zh-CN/multi-kernel-design.md](docs/zh-CN/multi-kernel-design.md)
>
> 状态：本地 release candidate 已完成 M0–M15 与 M16 可在仓库内完成的实现/验证；受保护五目标运行时签名、公证、生产镜像演练及许可证法务批准仍是公开发布阻断项，不以本机结果代替
>
> 最近完整本地证据（2026-08-24）：Vitest 241 files / 2105 passed / 6 skipped（其中 2 项只在真实 CI 制品存在时执行）；Electron E2E 151 passed / 3 platform skips；multi-kernel chaos 28/28；DSH 精确上游树 build + focused tests 4 files / 10 passed；typecheck、comms、Harness、release validation、base-package structural audit 与官方 actionlint 1.7.12 全绿
>
> 远端证据核对（2026-08-24）：`origin` 尚无 `codex/upgrade-v0.5.4` 分支；公开 Actions 仅登记旧 `main` 工作流，没有 `kernel-runtime-build/promote` 运行记录；仓库 Environments API 返回 `total_count: 0`，尚未创建 `kernel-staging` / `kernel-production`。因此以下 17 个受保护 CI/签名/公证/生产分发/法务项目继续保持 `[-]`
>
> 目标：OpenClaw 与 DeepSeek Harness 可选下载、共享 ClawX UI、能力同构、同时运行，并以单一 SQLite 统一保存 Conversation、Cron、Channel 与 Usage 记录

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
- [x] `MK-0005` 完成 OpenClaw Conversation Store spike：new/prompt/cancel/compact/branch/restart 全部从 SQLite hydrate/persist，且不产生 durable session/trajectory JSONL。
- [x] `MK-0006` 完成 DSH rich ACP + ClawX persistence spike：tool、permission、cancel、resume、config、usage 从 SQLite hydrate/persist，且不产生 durable JSONL。
- [x] `MK-0007` 完成两个内核同时运行和同时 prompt 的 process/stdio spike。
- [x] `MK-0008` 测量 base app、OpenClaw artifact、DSH artifact 的 compressed/unpacked/file-count/startup/RSS 基线。
- [x] `MK-0009` 记录 Go/No-Go：任一内核无法关闭原生 durable history、无法从 canonical context 恢复或无法稳定提交事件时不得进入实现阶段。
- [x] `MK-0010` 完成单一 DataService/SQLite 双内核并发写、崩溃恢复、disk-full 和 backup/restore spike。
- [x] `MK-0011` 冻结“同一 Conversation 切换内核”的 portable context、private reasoning、tool result 和 attachment 可见性规则。

### M0 Acceptance

- [x] DSH spike 使用当前 ClawX ACP timeline 渲染完整真实回合，不依赖官方 Web UI。
- [x] cancel 真正中断 DSH live agent，而不是杀掉整个 runtime。
- [x] OpenClaw 与 DSH 都能在进程重启后只从 ClawX SQLite 恢复，并通过 runtime-dir scan 证明没有第二份 durable history。
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
- [-] OpenClaw 从 SQLite portable context/checkpoint 完成 restart/resume/compaction，且不读取旧 history。（真实 OpenClaw adapter/运行目录 contract 已通过；五目标 clean-machine 结果待 CI）
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
- [-] `MK-0812` 完成 macOS/Windows/Linux sandbox/tool/permission smoke。（源码与签名制品 self-test 已接入五目标 matrix；Windows 额外验证 ACL shell 与文件工具均拒绝 ambient `%TEMP%`，本机受嵌套 sandbox 限制，等待远端 matrix 首轮执行）
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
- [x] `MK-1308` 在 ClawX-managed OpenClaw/DSH 中禁用原生 schedulers 和 native run-history writes。
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
- [-] `MK-1602` 完成 macOS runtime executable 签名/公证验证。（leaf-first Hardened Runtime、notary `Accepted`、制品与宿主校验均已编码；等待真实 Developer ID/Apple 公证日志）
- [-] `MK-1603` 完成 Windows process tree、文件锁、签名和卸载验证。（实现与 CI 门禁已完成；等待真实 Authenticode 证书和 Windows packaged runner 结果）
- [-] `MK-1604` 完成 Linux glibc/kernel/sandbox 支持矩阵。（glibc >= 2.39、kernel >= 6.8、x64/arm64 与 DSH sandbox self-test 已固化；等待两个 Linux runner 结果）
- [-] `MK-1605` 完成 CDN/OSS/GitHub 镜像和断点续传运行演练。（双 catalog/双 artifact host、Range/If-Range、精确 N−1 双镜像连续晋级与重试演练已实现并通过模拟测试；promotion 与宿主 release 均把线上演练设为硬门禁，仍须生产 promotion 后取得在线证据）
- [-] `MK-1606` 完成 supply-chain/SBOM/license/security review。（deterministic artifact、SPDX/CycloneDX、provenance 与审计均已实现；本地 OpenClaw 587/DSH 97 个包审计通过，但 GPL/LGPL/MPL 履约地址和法务批准仍待发布负责人签字）
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
