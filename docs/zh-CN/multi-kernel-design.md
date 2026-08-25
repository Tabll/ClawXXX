# ClawX 多内核统一架构设计

> 状态：实现候选（M0–M15 已完成本地实现、契约与相关 Electron E2E；M16 的供应链/安全/文档实现已接入，真实五目标签名晋级与三平台 packaged 证据仍以 `TODO.md` 为准）；实现基线：ClawX 0.6.0、OpenClaw 2026.7.1-2+clawx.6、DeepSeek Harness 0.1.1-rc.2+clawx.8；最后更新：2026-08-24
>
> 实施清单：[TODO.md](../../TODO.md)
>
> Harness 参考：[multi-kernel-runtime.md](../../harness/reference/multi-kernel-runtime.md)

## 1. 摘要

### 1.1 当前落地状态

设计中的领域边界已映射到 `shared/{kernels,conversations,domains,data}`、`electron/{kernels,conversations,domains,data,scheduler,channels,security}` 和统一 Host API；Renderer、OpenClaw legacy adapter 与 DSH bridges 都不能直接拥有 canonical history。主包 `afterPack` 有硬闸门拒绝任何可选 runtime，Setup/Settings 已提供双内核安装、运行、修复、更新、回滚、卸载与无内核离线历史流程。

CI 供应链已覆盖两内核 × 五目标：冻结源码/lock/patch/overlay、许可证与再分发义务审计、独立 Node、macOS/Windows 可执行文件签名、macOS 公证、Linux ABI 证据、确定性 archive、Ed25519 descriptor/catalog、SPDX/CycloneDX、provenance、完整集合晋级、OSS/GitHub 双镜像和 Range 演练。每个真实制品还会走生产 Package Manager 的断点续传/验签/解包/激活/rescan/uninstall 链路；双内核构建会在同一 runner 并发 smoke 两份制品并注入单侧完整性故障。宿主 release 在打包前重跑完整门禁、三平台 Electron E2E 和线上分发演练。以上都是可执行门禁；只有 protected environment 的真实证书、密钥、公证、发布与 clean-machine 结果存在时，对应 release checkbox 才能完成。

统一数据层已实现 WAL/FTS/backup/restore/corruption/read-only/disk-full、owner-only SQLite/Blob、hard-delete Blob GC 和无 runtime 离线 CRUD。0.6.0 明确以 OS 全盘加密作为静态机密性边界，`node:sqlite` 数据库仍为明文；旧上游 history 不迁移、不扫描、不 fallback、不自动删除。安全、EOL、恢复与数据保留策略见同目录 policy 文档。

本设计把 ClawX 从 OpenClaw 专属桌面客户端重构为可同时托管多个 Agent Runtime 的桌面宿主，并满足以下硬性目标：

1. OpenClaw 不再随 ClawX 主安装包分发，首次使用或用户主动选择时下载。
2. DeepSeek Harness 成为第二个可选下载内核。
3. 两个内核完全复用当前 ClawX Renderer，不嵌入 DeepSeek Harness 官方 Web UI。
4. Chat、Providers/Models、Agents、Channels、Cron、Skills、Conversations、Usage、Diagnostics 在 ClawX 中使用同一组领域模型和页面。
5. OpenClaw 与 DeepSeek Harness 可以同时运行；用户切换页面或会话不会停止另一个内核中的任务。
6. 内核运行时由 CI 按平台和架构预制，允许 ClawX 在构建阶段对上游代码或发布包应用受审计补丁。
7. Renderer 不感知任何内核运输协议；Electron Main 继续拥有进程、协议、密钥、文件和恢复策略。
8. 所有内核共用同一个 ClawX Conversation Store：Conversation、Turn、Run、Tool、Usage、Channel Message、Cron Job/Run 等结构化记录统一存入本地 SQLite，不再由各内核分别持久化会话历史。

“完全同构”在本设计中的定义是：两个内核必须通过相同的 ClawX 领域契约、Host API、用户交互和验收测试；它不要求两个上游项目的内部配置文件、会话日志和插件 API 相同。任何内核无法原生提供的能力，都必须由 ClawX 宿主服务或受控的内核补丁补齐，不允许 Renderer 根据内核类型维护第二套业务逻辑。

## 2. 设计约束

### 2.1 改造前的 ClawX 约束（用于说明重构起点）

- Renderer 只能通过 `src/lib/host-api.ts` 和 `src/lib/api-client.ts` 调用后端。
- Electron Main 拥有 OpenClaw Gateway、ACP 子进程、生命周期、重试和传输选择。
- 改造前 Chat 的实时交互以 ACP 为主，但历史内容来自 OpenClaw JSONL/session store；Usage 扫描 JSONL，Cron history 则读取 Gateway/OpenClaw SQLite 或旧 JSONL fallback，事实来源并不统一。M2/M6/M7 已移除这些新数据路径，现行实现以 ClawX SQLite 为唯一权威。
- 改造前 Agents、Channels、Cron、Skills、Providers、Sessions 和 Usage 包含大量 OpenClaw 文件格式或 Gateway RPC 假设；现行 Renderer 与 canonical services 已改用共享领域契约，OpenClaw 假设被收敛到 adapter/driver 内。
- 当前 OpenClaw 构建运行时约 415 MB、约 3.3 万个文件，适合从主安装包拆出。
- 现有扩展系统的 Main context 直接暴露 `GatewayManager`，不能作为多内核基础抽象。

### 2.2 DeepSeek Harness 约束

- DeepSeek Harness 仍处于 developer preview，上游明确不承诺预发布兼容性。
- 官方 ACP 是 automation-only，缺少 ClawX 所需的完整历史、配置选择、标题、计划、工具展示和交互能力。
- 官方 SDK JSON-RPC 当前没有完整的 cancel、session close 和稳定版本协商。
- DeepSeek Harness 的会话事件、Agent Preset、Skills、Schedule 和 Credentials 模型与 OpenClaw 不同。
- 因此必须提供 ClawX 维护的 DeepSeek Harness Bridge/ACP 补丁，不能只替换进程启动命令。

参考资料：

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
- [DeepSeek Harness SDK Protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [DeepSeek Harness Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)

### 2.3 可行性结论与主要风险

**结论：可行，而且统一 SQLite 比“每个内核保留自己的历史，再由 UI 聚合”更适合未来继续增加内核；但这是一次宿主架构与内核持久化层重构。** OpenClaw 当前 SessionManager 深度依赖 JSONL 树、`sessions.json`、文件锁、compaction/branch 和 transcript scan，需要 ClawX 运行时补丁提供新的 Conversation Store adapter。其当前代码已经出现面向 SQLite backend 的 storage-sized operation 边界，降低了长期改造风险，但不能据此跳过真实 spike。DSH 则需要 ClawX SQLite persistence provider，并关闭原生 JSONL durable persistence。

本设计不迁移旧对话或旧 Cron history。切换版本后从新的 ClawX SQLite 开始记录；旧 OpenClaw/DSH 文件不导入、不扫描、也不主动删除。该取舍显著降低数据映射和双写迁移风险，但不会降低新存储正确性、备份或崩溃恢复要求。

方案比较：

| 方案 | 初期成本 | 长期一致性/扩展性 | 结论 |
| --- | --- | --- | --- |
| 每个内核保存自己的历史，ClawX 聚合读取 | 低 | 每新增内核都增加 parser、删除/搜索/Usage/Cron 分支，无法可靠跨内核续接 | 拒绝 |
| Runtime 原生历史 + ClawX SQLite 长期双写 | 中 | crash 时容易一边成功一边失败，删除/rename/compaction 难以原子化 | 只允许短期开发调试，不得发布 |
| 所有内核直接打开同一个 SQLite | 中 | SQLite WAL 可并发，但没有表级权限；第三方内核可破坏整库，schema/事务 owner 不清晰 | 拒绝 |
| Main-owned DataService 独占 SQLite，内核走 context/event RPC | 高 | 单权威、可测试、可审计，未来内核只实现协议；故障模式可以 fail closed | 采用 |

| 风险 | 等级 | 触发后果 | 设计控制/闸门 |
| --- | --- | --- | --- |
| OpenClaw JSONL 依赖面较大 | 高 | compaction、branch、memory search 或 resume 仍偷偷写原生 transcript | patch storage interface；M0 必须证明执行/重启/压缩后无第二份 durable history |
| DSH 上游协议仍在快速变化 | 高 | bridge/persistence provider 持续破坏、cancel 或 resume 不可靠 | 固定 commit/version、ClawX patch revision、golden replay；M0 Store/ACP Go/No-Go |
| DSH 官方 ACP 能力不完整 | 高 | 当前 Chat UI 无法完整复用 | CI 内置 rich ACP bridge；mandatory capability 缺失不得进入 ready |
| Channels 上游能力不对称 | 高 | DSH 无法达到当前 Channels 页面语义 | Channel Orchestrator/Relay 上移到 ClawX；同账号单 owner |
| Cron 双权威 | 高 | 同一任务重复执行或重复投递 | ClawXScheduler 与 SQLite 成为唯一权威；运行时原生 scheduler 禁用 |
| 运行时供应链/补丁被篡改 | 高 | 下载即代码执行 | 可复现 CI、签名 catalog/artifact、SBOM、隔离 promotion、客户端强验证 |
| 统一 DB 成为共享故障域 | 高 | DB 锁死/损坏会同时阻止两个内核接受新消息 | 独立 DataService、单 writer、WAL、备份、integrity check、fail-closed 和恢复演练 |
| 跨内核上下文语义不完全相同 | 中 | 切换内核后隐藏状态、工具状态或 reasoning 无法等价延续 | 只编译 portable context；每个 turn 记录执行内核；不承诺迁移隐藏 runtime state |
| 双内核资源竞争 | 中 | 高 RSS/CPU、定时任务挤占交互任务 | per-kernel 与全局并发预算、事件驱动状态、性能 release gate |
| 完全同构范围持续扩大 | 高 | 页面同名但行为不一致、交付失控 | Kernel Contract v1、共享 contract suites、逐能力 release gate；不以隐藏功能冒充同构 |

若 M0 无法证明 OpenClaw 和 DSH 都能从 ClawX SQLite 重建上下文、完成 prompt/cancel/compaction/resume，并且不产生第二份 durable transcript，则严格的统一存储目标不可达，不得退化为长期双写后仍宣称“统一历史”。

## 3. 核心架构决策

### D1：ClawX 领域契约是 UI 的唯一后端模型

Renderer 只认识 `ConversationId`、`RunId`、`KernelId`、`AgentSummary`、`ChannelAccount`、`CronJob`、`SkillSummary` 等 ClawX 类型。Conversation identity 独立于 kernel；OpenClaw 和 DeepSeek Harness 的原生 session/event 类型只允许存在于各自 Main adapter 内。

禁止：

- 在页面中使用 `if (kernelId === 'deepseek-harness')` 切换业务行为。
- 把 OpenClaw Gateway 原始响应或 DeepSeek SessionEvent 直接存入通用 Zustand store。
- 让 Renderer 选择 ACP、WebSocket、HTTP、stdio 或文件读取路径。

允许：

- UI 展示内核徽标、内核版本和由能力契约明确声明的兼容性说明。
- 内核专属诊断信息通过通用 diagnostics envelope 展示。

### D2：SQLite 是历史权威，ACP 是实时执行数据面，管理能力使用统一控制面

多内核协议分成三个平面：

1. **Conversation Store Plane**：Main-owned `ClawXDataService` 独占 SQLite，承载历史查询、context snapshot、Conversation/Turn/Run/Event 持久化、Cron 和 Channel 记录。
2. **Chat Execution Plane**：ACP/bridge 承载 prompt、cancel、权限和实时 timeline updates。它是执行事件输入，不是历史事实来源。
3. **Kernel Control Plane**：Main 内的 `KernelDriver` 领域接口，承载 lifecycle、agents、providers、skills 和 diagnostics；不同 driver 可使用不同原生协议。

OpenClaw：

- Chat：使用补丁后的 OpenClaw ACP，但 UI history 不再调用内核 `session/load`。
- Persistence：运行时补丁把 SessionManager/session metadata/compaction/branch 接到 ClawX Conversation Store adapter；原生 JSONL 仅可作为进程级临时缓存且不得成为重启来源。
- Control：继续使用 Gateway WebSocket/RPC 与受控配置协调器。

DeepSeek Harness：

- Chat：CI 运行时内置 `@clawx/dsh-acp-bridge`，补齐 ClawX 要求的 ACP 实时能力。
- Persistence：内置 `@clawx/dsh-clawx-persistence`，从 Conversation Store 读取 context snapshot 并把规范化事件写回；关闭 DSH 原生 durable JSONL persistence。
- Control：CI 运行时内置 `@clawx/dsh-control-bridge`，通过版本化 NDJSON JSON-RPC 提供管理能力和事件。
- 两个逻辑 bridge 由同一个长生命周期 `@clawx/dsh-runtime-host` 承载。它是 DSH live process state 的唯一协调者，持有 live Agent handles 和 per-run leases；私有 DSH home 只允许保存非历史配置与可删除缓存，ACP、Control、Persistence 不得成为互相竞争的 durable-history daemon。

### D3：两个内核是独立并发实例，不存在全局 Gateway 状态

`GatewayManager` 不会直接扩展为支持多个协议，而是被包装为 `OpenClawKernelDriver`。新的 `KernelSupervisorRegistry` 以 `kernelId` 为键维护独立实例：

```text
KernelSupervisorRegistry
├── openclaw
│   ├── OpenClaw Gateway process
│   ├── Gateway WebSocket
│   └── OpenClaw ACP process
└── deepseek-harness
    └── ClawX DSH runtime host process（单一 live-state 协调进程）
        ├── ClawX control endpoint
        ├── ClawX ACP endpoint/profile
        └── live Agent handles / conversation run leases
```

每个实例独立拥有：

- lifecycle state、PID/process tree、端口和锁。
- readiness、health、restart governor 和恢复预算。
- protocol generation、request IDs 和 pending requests。
- 日志、诊断、版本和能力协商结果。
- 正在运行的 prompts、permission waiters 和 run access grants。

UI 中的 `selectedKernelId` 只是下一次执行选择，不能控制另一个内核是否运行。Conversation Store 在同一会话中允许不同 turn 使用不同内核；每个 run 固定其 kernel/agent/model snapshot，切换选择不能重定向已经开始的 run。

### D4：Channels 是 ClawX 编排能力，内核只拥有消息执行

为了让同一 Channels 页面、账号、绑定和状态模型同时服务两个内核，Channel Account 和 Binding 的权威状态上移到 ClawX。

```text
External Channel
      │
      ▼
ClawX Channel Orchestrator
      │ resolves (kernelId, agentId, conversation policy)
      ├──────────────► OpenClaw Channel Adapter ─► OpenClaw Agent
      └──────────────► ClawX Relay Adapter ─────► DeepSeek Agent
```

M12 已实现的首版：

- OpenClaw connector 由 native adapter 投影 canonical 配置，并通过带 bearer 认证、仅 loopback 可访问的 handoff 插件交换标准化消息和状态；插件不拥有历史。
- DeepSeek Harness 通过 Main-owned ClawX Channel Relay 接收和发送消息，不要求 DSH 加载 OpenClaw 插件；Relay 覆盖当前 UI 的 Telegram、Discord、WhatsApp、微信、钉钉、飞书、企业微信和 QQ Bot 八类 connector。
- 每个外部账号在同一时间只能有一个连接 owner，避免两个内核同时消费同一 Telegram/WhatsApp/飞书账号。
- Binding 必须包含 `kernelId` 和 `agentId`。
- Account、Binding、owner lease、message mapping、delivery attempt 全部写入统一 SQLite；凭据只进 OS 安全存储，附件只进 canonical Blob Store 并通过短期 grant 授权。
- 迁移只导入账号/配置/绑定元数据（包括 disabled 账号），不导入历史消息、Conversation 或 Cron；WhatsApp auth bundle 经过大小/路径/Base64 校验并原子投影。
- adapter capability catalog 可单调扩展账号兼容内核集合，未来内核无需修改 SQLite schema。

两类 adapter 使用同一 contract test suite；所有可复用 Relay connector 生命周期均由 Channel Orchestrator 管理，OpenClaw native connector 作为受控投影保留。

### D5：Cron 是 ClawX 宿主调度能力

OpenClaw Cron 和 DeepSeek Schedule 语义差异过大，不能互相模拟。新的 `ClawXScheduler` 成为唯一新建任务的权威：

```ts
type CronJob = {
  id: string;
  kernelId: KernelId;
  agentId: string;
  name: string;
  schedule: CanonicalSchedule;
  prompt: string;
  enabled: boolean;
  delivery: CanonicalDelivery;
  concurrencyPolicy: 'skip' | 'queue-one' | 'parallel';
};
```

- Scheduler 到期后调用目标 `KernelDriver.runScheduledTurn()`。
- 渠道投递调用统一 Channel Orchestrator。
- `cron_jobs`、due admission、`cron_runs`、run output、delivery attempts 全部写入 ClawX SQLite。
- OpenClaw Cron 和 DSH Schedule 在 ClawX-managed runtime 中禁用，不能成为第二调度器或第二 run-history store。
- 不导入旧 OpenClaw jobs/runs 或 DSH schedules；切换后只显示 ClawXScheduler 新建的数据。

### D6：CI 预制不可变运行时，客户端不执行包管理安装

客户端只下载 ClawX CI 生成并签名的运行时归档。运行时构建输入包括：

- 上游精确版本、源码提交或 npm integrity。
- 冻结 lockfile。
- 有序补丁 series。
- ClawX bridge packages。
- 每个 artifact 的固定平台 Node runtime。首版 OpenClaw 与 DeepSeek Harness 都自带经 CI 验证的 Node，不依赖系统 PATH 或 Electron 内嵌 Node；未来只有在独立签名的共享 runtime layer 具备相同兼容与回滚保证后才允许去重。
- prune/assembly 脚本。
- contract tests、SBOM 和第三方许可证。

用户机器不得执行 `npm install`、`pnpm install`、任意 postinstall 或从不受信任源获取插件来完成内核安装。

### D7：运行时、统一结构化数据、Blob 与临时缓存四层分离

1. **Runtime artifacts**：版本化、只读、可删除和回滚。
2. **ClawX SQLite**：所有 canonical records 和 runtime checkpoints 的唯一 durable authority。
3. **Content-addressed Blob Store**：附件、图片和大型 tool artifacts；SQLite 保存 hash、大小、MIME、权限和引用，不把大二进制塞进主库。
4. **Kernel cache/temp**：可随时删除的编译上下文、socket、lock 和短期 runtime cache；不得用于重启恢复或历史展示。

OpenClaw/DSH 可以保留自己的非会话配置，但不得持久化第二份 Conversation、Cron、Usage 或 Channel message history。任何无法关闭或替换原生 durable history 的内核，都不满足 ClawX 多内核接入标准。

## 4. 目标组件

```text
┌─────────────────────────────────────────────────────────────────────┐
│ React Renderer                                                      │
│ Chat | Models | Agents | Channels | Cron | Skills | Usage | Settings│
└───────────────────────────────┬─────────────────────────────────────┘
                                │ typed Host API, explicit conversation/run identities
┌───────────────────────────────▼─────────────────────────────────────┐
│ Electron Main                                                       │
│                                                                     │
│ KernelCatalog      KernelPackageManager     KernelSupervisorRegistry │
│ ConversationRouter CredentialBroker         KernelContextCompiler    │
│ ChannelOrchestrator                       ClawXScheduler              │
│                                                                     │
│ OpenClawKernelDriver                 DeepSeekHarnessKernelDriver      │
│ ├─ Gateway lifecycle/RPC             ├─ process/control bridge        │
│ ├─ ACP adapter                       ├─ patched rich ACP              │
│ └─ config/data translators           └─ DSH domain translators        │
└───────────┬───────┴──────────────────────────────┴──────────┬───────┘
            │                                                 │
     ClawXDataService                                  kernel runtimes
     ├─ single SQLite writer                           ├─ OpenClaw
     ├─ context/event RPC                              └─ DeepSeek Harness
     └─ content-addressed Blob Store
```

### 4.1 KernelCatalog

职责：

- 读取内置 catalog 和远端签名 release manifest。
- 合并 installed/available/compatible 状态。
- 不信任远端 display fields 作为代码或路径。
- 解析 app version、protocol、platform、arch、Node/Electron ABI 兼容性。

### 4.2 KernelPackageManager

职责：

- resolve、download、resume、verify、stage、extract、smoke-test、activate。
- 维护每内核至少一个 last-known-good 版本。
- 提供 install/update/repair/uninstall/rollback/offline-import。
- 只在内核完全停止时删除版本目录；Windows 锁文件使用 rename-to-trash + next-launch cleanup。

M4 的具体边界如下：

- Catalog cache、防回退最高 sequence、current/LKG、隔离原因和 activation history 都通过 DataService 存入统一 SQLite；不再维护可与数据库漂移的 `catalog-cache.json` 或 current symlink。
- 下载临时文件只允许位于 `kernels/downloads`，`.partial.meta` 是可丢弃的续传身份（artifact SHA/size/source/strong ETag），不是产品状态或历史权威。
- Main 的下载调用复用 Electron `net.fetch`，因此自动服从现有 `session.setProxy` 配置；主 CDN 失败后可按签名 descriptor 文件名尝试配置的中国区镜像 base URL，镜像不能改变 descriptor、SHA 或 ETag 续传规则。
- 解包对同一归档执行预扫描和落盘时复核，拒绝绝对路径、反斜杠、`..`、大小写/Unicode 碰撞、symlink、hardlink、设备/非普通项、setuid/setgid、重复项以及超出签名 file-count/size/tar-overhead 的 payload。
- 解包后再核对内部 artifact manifest、供应链文件 hash、runtime 逐文件 hash/size、entrypoint 和总预算；只有 smoke-test 成功的版本才能经同卷 rename 进入不可覆盖的 installs 目录。
- 激活指针是 SQLite 事务：版本记录必须为 `verified`，并使用 expected-current compare-and-swap 同时写 current/LKG 和 activation history。下载或 smoke 失败不改变旧 current。
- uninstall 只把不可变 runtime 原子改名到 trash 后删除；遇到 Windows 锁定则保留到下一次启动清理。Conversation/Cron/Channel/Usage/Blob/keychain 不在包管理器删除范围内。
- 离线导入先独立验证 descriptor Ed25519 签名、host/protocol/platform/arch/ABI、archive 大小/SHA 和 downgrade policy，再走同一 staging/smoke/activation 流程。

### 4.3 KernelSupervisorRegistry

核心接口：

```ts
type KernelId = 'openclaw' | 'deepseek-harness' | (string & {});

interface KernelSupervisorRegistry {
  list(): KernelRuntimeSnapshot[];
  start(kernelId: KernelId): Promise<KernelRuntimeSnapshot>;
  stop(kernelId: KernelId): Promise<void>;
  restart(kernelId: KernelId): Promise<KernelRuntimeSnapshot>;
  getDriver(kernelId: KernelId): KernelDriver;
  stopAllForQuit(deadlineMs: number): Promise<void>;
}

interface KernelDriver {
  readonly definition: KernelDefinition;
  readonly chat: KernelChatAdapter;
  readonly agents: KernelAgentsAdapter;
  readonly providers: KernelProvidersAdapter;
  readonly skills: KernelSkillsAdapter;
  readonly usage: KernelUsageAdapter;
  readonly diagnostics: KernelDiagnosticsAdapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): KernelRuntimeSnapshot;
}
```

M5 的落地边界如下：

- `KernelLaunchRegistry` 由 driver 在 artifact 验证并解析出不可变版本目录后注册启动解析器；Supervisor 不读取 current symlink、不临时搜索 PATH，也不执行包安装脚本。
- 每个 `kernelId` 独立维护 process、PID、generation、健康状态、日志 ring、crash window、指数退避和 restart budget。旧 generation 的 event/exit/diagnostic 在 registry 边界丢弃，不可污染新 generation。
- stdio runtime 在 POSIX 中作为独立 process group leader 启动，在 Windows 中使用参数化 `taskkill /PID /T /F`；正常 shutdown 后仍清理完整进程树，应用退出则并行、有界地停止所有 supervisor，并在 deadline 后强制终止。
- `ready.pid`、`ready.kernelId`、`ready.generation` 和 `ready.version` 必须匹配宿主拥有的 child 与选定 artifact；不匹配属于协议违规，立即终止该 generation。
- 连续 crash 超过 per-kernel budget 后只让该内核进入 `crash-loop`，生成结构化 rollback suggestion；另一个内核的 live prompt、PID、日志和重启预算不受影响。连续健康探测失败也只产生该内核的 degraded/rollback 建议。
- `KernelPackageManager` 使用 Supervisor 的 `isVersionInUse`/`isKernelBusy` 回调阻止删除、覆盖或切换正在执行的不可变版本；停止后才允许 uninstall/activate。
- Renderer 通过 typed `kernels` Host API 访问 list/status/start/stop/restart/health/logs/diagnostics/autoStart 和带完整 run identity 的执行操作，不直接持有进程或传输协议。
- `gatewayAutoStart` 通过 read-through 兼容迁移为 `kernelAutoStartPolicies`；Main 启动和退出改由通用 `RuntimeLifecycleCoordinator` 驱动。旧 Gateway 只是在 M6 完成 OpenClaw Driver 前的过渡 participant，不再是应用生命周期的唯一硬编码入口。

### 4.4 ClawXDataService 与统一 SQLite

新增 `<userData>/state/clawx.sqlite`。首选 Electron 43 当前 Node 24 的 `node:sqlite`，开启 foreign keys、WAL、busy timeout 和显式 schema version。M2 冻结前必须验证 packaged Electron 可用性、FTS5、WAL checkpoint、`VACUUM INTO`/一致性备份和三个平台的恢复行为；如验证失败，可替换 SQLite driver，但不得改变 Conversation Store 契约。Secrets 不进入 SQLite。

`ClawXDataService` 是 Main-owned utility process/service，并且是数据库文件的唯一 owner：

- Electron Main、kernel bridge、Channel connector 和 Scheduler 都通过版本化 RPC 调用它。
- kernel process 永远拿不到 SQLite path，不能直接执行 SQL，也不能修改其他 kernel 的记录。
- 所有 mutation 带 `operationId` 或稳定 idempotency key；DataService 负责事务、约束和事件顺序。
- Renderer 仍只通过 Host API 访问，不能连接 DataService socket。
- 如果未来把 Scheduler 移到 background service，数据库 owner 随服务迁移，仍保持单 owner。

核心表建议：

```text
conversations
conversation_members / conversation_bindings
turns
content_blocks
runs
run_events
tool_calls
permissions
usage_entries
runtime_contexts / runtime_checkpoints
attachments / blob_refs
channel_accounts / channel_bindings / channel_messages / delivery_attempts
cron_jobs / cron_admissions / cron_runs
agents / agent_projections
providers / provider_projections
skills / skill_projections
kernel_installations / kernel_activation_history
operations / schema_migrations
```

关键约束：

- `conversations.id` 不含 kernel；`runs.kernel_id`、`agent_id`、`model_ref` 固定一次执行使用的 runtime snapshot。
- `(conversation_id, ordinal)`、`(run_id, event_seq)`、`(job_id, scheduled_for)` 和外部 channel message id 使用唯一约束防止重放重复。
- Turn/Block 是 UI 历史；Run/Event 是执行审计和崩溃恢复；runtime checkpoint 是可选 opaque state，必须声明 kernel/codec/schema version；大型 checkpoint 使用 Blob ref，不进入 SQLite BLOB。
- 只有 runtime 明确提供且产品/Provider policy 允许持久化的 displayable reasoning/thought 才可保存；默认标记 `context_visibility = private`，不能自动送入另一个内核的模型上下文。
- 大文件不存 BLOB；Blob Store 以 SHA-256 寻址，SQLite 维护引用计数、权限和生命周期。
- 所有删除、重命名、pin、title、usage、Cron run 和 Channel delivery 都通过同一事务域/operation journal。

### 4.4.1 流式写入和提交语义

1. 用户发送前，事务先创建 user turn、run、kernel snapshot 和 workspace/attachment refs；提交成功后才 dispatch 到内核。
2. 实时 delta 立即发给 UI，同时按时间/字节阈值批量写 `run_events`，禁止每个 token 单独事务。
3. tool start/result、permission request/decision 和 usage 使用稳定 event id 幂等落库。
4. completion 事务把 assistant turn/content blocks、run terminal status、usage 和 conversation timestamp 一次提交；UI 只在该事务成功后显示 durable-complete。
5. DataService 不可用时停止接受新 prompt/Cron/channel admission；正在执行的 run 尝试 cancel，并把最后已提交状态标记为 `interrupted`，禁止继续产生无法持久化的隐形对话。

### 4.4.2 跨内核上下文编译

同一 Conversation 可以按 turn 切换内核，但“共享历史”不等于迁移上一个内核的隐藏进程状态。`KernelContextCompiler` 从 SQLite 生成目标内核可消费的 portable context：

- 包含用户/助手可见文本、允许传递的 tool result、附件引用、workspace facts、canonical summary。
- 排除 private reasoning、secret、被撤销附件、内核专属控制事件和不安全的大型 tool payload。
- 按目标模型 context window 做 deterministic selection/truncation；需要 summary 时创建带生成 kernel/model、输入范围和 schema version 的 canonical summary artifact，禁止在每次 hydrate 时静默生成不同摘要。
- driver 可保存 opaque checkpoint 到同一 SQLite，但目标不同内核时必须回退 portable context，不能读取其他内核 checkpoint。
- 默认每个 Conversation 同时只允许一个 active run，避免线性 UI 出现并发 ordinal 冲突；跨 Conversation 仍可完全并行。未来比较模式应使用显式 branch，不复用同一线性尾部。

### 4.5 ExtensionHost 与插件边界

现有 Extension context 不再直接暴露单例 `GatewayManager`。扩展分为两类：

- **ClawX Host Extension**：贡献页面、Channel connector、表单或宿主服务，通过 kernel-scoped capability API 调用目标 driver。
- **Kernel Plugin/Skill**：部署到某个 runtime，由对应 driver 管理，必须声明 `supportedKernels`、版本范围和权限。

现有 OpenClaw 扩展先由 `OpenClawLegacyExtensionAdapter` 兼容；新扩展不得持有原始 Gateway/DSH transport、runtime path 或其他内核的 native state。Channel connector 即使来自扩展，也由 Channel Orchestrator 统一授予账号 owner lease。

## 5. 身份和路由模型

### 5.1 Conversation identity 与执行 identity

```ts
type ConversationId = string;
type RunId = string;

type ConversationRun = {
  id: RunId;
  conversationId: ConversationId;
  kernelId: KernelId;
  agentId: string;
  modelRef?: string;
  parentTurnId?: string;
};

type RuntimeContextBinding = {
  conversationId: ConversationId;
  kernelId: KernelId;
  nativeSessionId?: string;
  checkpointCodec?: string;
  checkpointVersion?: number;
  hydratedThroughTurnId?: string;
};
```

- Conversation CRUD/history 只需要 `conversationId`；执行、agent、channel binding、Cron target 和 runtime context 操作必须显式携带 `kernelId`。
- 同一 Conversation 的不同 runs 可以使用 OpenClaw、DSH 或未来内核，历史按 canonical ordinal 统一展示，每个 assistant/tool block 保留其 run/kernel provenance。
- 禁止根据当前页面选择隐式推断目标内核后执行写操作。
- 旧 `agent:<id>:<session>` 和 native session id 不迁移、不出现在新 Host API；只允许 driver 在一次 runtime binding 内部使用。

### 5.2 ConversationRouter

ConversationRouter 负责：

- 先向 DataService admission 一个 run，再把固定的 run/kernel snapshot 路由到正确的 ACP/bridge connection。
- 为每个内核维护独立 generation。
- 在多个内核同时流式输出时投递带 `conversationId`、`runId`、`kernelId` 和 generation 的 host events。
- 把已验证的事件交给 DataService 持久化，并保留非当前 Conversation 的有界 live snapshot。
- 禁止一个内核的 notification 更新其他 run；禁止 selection change 重定向 in-flight run。

显式比较/分支使用独立 `ConversationId`，并在 `conversations.parent_conversation_id` 与
`branched_from_turn_id` 中保存谱系。分支点之前的 Turn/Run/Event/Usage 以只读谱系视图继承，
不复制数据库行、不重复统计 Usage；分支点之后的 admission 使用新 Conversation 的独立
single-active-run lease。Context Compiler 会按同一谱系截断到分支点后再拼接分支自身历史，
因此未来增加比较 UI 或更多内核时不需要放宽线性 Conversation 的并发约束。

### 5.3 进程所有权

每个 runtime snapshot 必须标明：

- `owned`：ClawX 创建，可自动恢复和停止。
- `external`：用户显式连接，只允许重连 transport，默认不得停止外部进程。

第一版下载内核只实现 `owned`；接口保留 external 模式，但不纳入首次交付。

## 6. Chat 同构设计

### 6.1 统一 Conversation 写路径

Renderer history、Chat sidebar、Usage、Cron run detail 和 Channel session 全部查询 ClawX SQLite，不再扫描 runtime 目录或调用 native `session/load` 获取 UI 历史。

正常 prompt 流程：

```text
Renderer submit
  -> Host API
  -> ConversationRouter.admitRun (SQLite transaction)
  -> KernelContextCompiler (SQLite snapshot)
  -> target KernelDriver/ACP
  -> normalized runtime events
  -> DataService batched persist + Renderer live events
  -> terminal transaction
```

切换内核只影响下一次 admitted run。已存在 Conversation 无需复制或“迁移”历史；目标 driver 根据 canonical snapshot 创建 transient/native context。内核停止或卸载后，SQLite 历史仍可完整打开、搜索、重命名、删除和导出，只是不能继续执行该内核的新 run。

Renderer 通过 `conversations.branch` 显式创建比较分支；直接对已有 active run 的同一
Conversation 再次 submit 会在 DataService admission 阶段失败，不能由 Renderer 或 driver
绕过。历史投影包含每个 assistant turn 的 kernel/version/agent/run provenance，实时事件则
必须同时匹配 conversationId、runId、kernelId、generation 与 eventSeq。

### 6.2 ClawX ACP/Bridge 必需能力

两个内核必须通过同一 suite 验证：

- `initialize`
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/set_config_option`
- `session/request_permission`
- text、thought/reasoning、tool call/status/result、plan、resource、image、usage、title/config updates
- 明确的 prompt completion stop reason
- run identity、event sequence 和 prompt 并发规则

运行时可以保留内部 `session/load` 用于 adapter 自测，但 UI history 不依赖它。无法映射为标准 ACP 的字段放入版本化 `_meta.clawx`，但 Renderer 不直接读取任意 `_meta`；Main 先验证和投影到共享 timeline/store contract。

### 6.3 DeepSeek Harness ACP 与 Persistence 补丁

CI 内核包需要提供：

- `@clawx/dsh-clawx-persistence`：从 DataService 获取 canonical context/checkpoint，禁止写 durable JSONL。
- `session/load`：如 bridge 内部需要，只从 canonical snapshot 投影，不能扫描 DSH home。
- 真正的 `session/cancel`：调用 live Agent handle，而不是只杀进程。
- permission requests：把 DSH approval/ask-user 映射到 ACP。
- reasoning、assistant chunks、tool calls/results、plans 和 usage updates。
- model/preset/permission mode config options。
- title 和 session metadata updates。
- resource/image/attachment 映射。
- 冷 Conversation resume、per-run lease、checkpoint codec 和错误恢复。

DeepSeek SessionEvent 是实时输入，不是持久化事实来源。`dsh-runtime-host` 必须把事件规范化后提交 DataService；其 private home 只允许配置和可删除 cache。进程重启后只从 ClawX SQLite 恢复。

M8 的冻结实现采用上游 commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，制品版本为
`0.1.1-rc.2+clawx.8`。CI 只允许应用严格有序 patch series（lock/project
importer 与 Windows sandbox 临时目录权限同构修复）和逐文件 SHA-256
overlay；生产 deploy 只有一个长生命周期
`@clawx/dsh-runtime-host`，不会包含 DSH Web、settings-file、JSONL session
或 SQLite session backend。

运行时行为如下：

- 一个进程独占 DSH home writer lock；每个 `RunId` 有一个 live Agent lease，
  terminal/cancel/crash 时均释放。
- `session.new` 只验证 Conversation/Turn/Run identity，不创建 durable native
  session；`session.prompt` 从 Main 提供的 canonical snapshot、附件和兼容
  checkpoint 创建 transient Agent。
- 冷恢复重新 hydrate portable history；opaque
  `deepseek-harness-agent` checkpoint 只有 kernel/codec/schema provenance 一致时
  才可使用，不能替代 SQLite history。
- Rich bridge 串行投影 text、private reasoning、tool start/status/result、plan、
  usage、title/session metadata、permission/ask-user 和 image output，确保
  `eventSeq` 等于可观察顺序，terminal 等待此前事件与附件读取完成。
- 运行时只呈现 DSH native tools，不挂载 Code Mode 或第二套 Web UI；stdout
  只允许 `clawx.kernel-stdio/v1`，脱敏结构化诊断只写 stderr。
- initialize 在 ready 前绑定 kernel/version/generation/protocol 与已验证制品的
  file-manifest digest；缺少 mandatory capability 或 bridge identity 不匹配时
  fail closed。

`@clawx/dsh-clawx-persistence` 已实现为上游 `SessionPersistence` 的兼容接缝，
只接受已认证、已限定 kernel/generation/conversation/run scope 的 DataService
client，本身不能打开 SQLite 或 JSONL。v1 生产 prompt 路径使用更窄的
canonical context/event RPC，因此根本不挂载 DSH native session catalog；两条
路径都只允许 ClawX DataService 成为持久化权威。

五目标运行时矩阵（macOS arm64/x64、Windows x64、Linux arm64/x64）在源码
测试后，还会从签名制品解压并启动真实 Host，执行 CI-only
`runtime.selfTest`：验证 OS sandbox workspace-write、read-only kernel denial、
native read/write tools 往返，以及 approval/ask-user fail-closed 接线；Windows
还同时验证 ACL shell 与文件工具均不能写 ambient `%TEMP%`，而 shell 私有的
per-session temp capability 不作为模型可见目录暴露。普通 App 启动不设置开关，
该自检 RPC 默认禁用。

### 6.4 OpenClaw ACP 与 Session Store 补丁

- `AcpChatService` 重构为 kernel-scoped connection manager。
- 为 OpenClaw SessionManager、session metadata、compaction、branch/fork、reset、memory-search transcript source 提供 `@clawx/openclaw-conversation-store` adapter。
- ClawX-managed mode 禁止 `sessions.json`、session JSONL、trajectory JSONL 和 OpenClaw cron history 成为 durable output；必要临时文件放入 run-scoped temp 并在 crash recovery 清理。
- OpenClaw media、file-activity 和 timing 由实时事件/统一 store records 提供，不再通过 transcript supplement 推断。
- 通用 ACP reducer 不再导入 `openclaw-*` helper。
- CI patch regression 必须扫描 runtime data dir，证明 new/prompt/cancel/compact/restart/cron/channel 后没有第二份 durable history。

### 6.5 未来内核接入门槛

第三个及后续内核不需要新增 History/Cron/Usage 数据库或 Renderer 页面，只需实现以下 execution-side contract：

- `KernelExecutionAdapter`：prompt、cancel、permission、health 和 terminal state。
- `KernelEventNormalizer`：把流式文本、工具、资源、usage 和错误转换为 canonical run events。
- `KernelContextAdapter`：把 portable canonical context 编译为目标 runtime 输入。
- 可选 `KernelCheckpointCodec`：opaque checkpoint 只能由同 kernel/compatible codec 读取。
- `NoNativeDurableHistory`：能关闭/替换原生 Conversation/Cron/Channel/Usage persistence，并通过 clean-directory test。

不能满足最后一项的内核只能作为 stateless one-shot tool 使用，不能作为 ClawX Conversation Kernel 发布。

## 7. Providers 与 Models 同构

### 7.1 权威模型

ClawX 保存统一 Provider Account metadata 和 OS Keychain secret reference：

```ts
type ProviderAccount = {
  id: string;
  type: string;
  displayName: string;
  protocol: string;
  baseUrl?: string;
  models: ModelDescriptor[];
  secretRef?: string;
};

type KernelProviderProjection = {
  kernelId: KernelId;
  accountId: string;
  nativeProviderId?: string;
  state: 'pending' | 'applying' | 'ready' | 'partial' | 'failed' | 'unsupported';
  desiredVersion: number;
  appliedVersion?: number;
  error?: { code: string; message: string; retryable: boolean };
  updatedAt: string;
};
```

### 7.2 密钥策略

- Secrets 的事实来源是 OS Keychain。
- OpenClaw adapter 继续按其安全存储和 `secrets.reload` 契约投影。
- DeepSeek 运行时内置 `@clawx/dsh-credential-provider`，通过受认证的 Main bridge 按 opaque reference 获取请求所需密钥。
- Secret 不放入命令行、release manifest、日志、SQLite 或 Renderer。
- Bridge 断开或 kernel identity 不匹配时 fail closed。
- Provider 更新必须独立返回每个 kernel projection 结果，不允许一个内核失败回滚另一个已经成功使用的 keychain metadata。

M9 的落地实现还要求：Renderer 只持有凭据是否已填写和一次性 `credential-stage://` 句柄；OpenClaw 与 DSH 默认账号/模型分别记录；Main 按 kernel/generation/PID/artifact/account/purpose 逐次授权，进程断开或 generation 替换立即撤销；Models 页面同时显示 ready/partial/failed/unsupported 以及可重试错误。当前 DSH 累积补丁制品版本为 `0.1.1-rc.2+clawx.8`，冻结 lockfile 同时包含只读、request-scoped 的 `@clawx/dsh-credential-provider`、Agent/Preset 支持和保留 unknown Usage 字段的 live SessionEvent 投影。

## 8. Agents 同构

统一 UI 暴露：

- id/name/default
- workspace
- model account/model reference
- persona/instructions
- channel bindings
- Conversation entry
- kernel identity/status

OpenClaw adapter：投影到 OpenClaw `agents.list/defaults`、workspace/agentDir 和 bindings。

DeepSeek adapter：

- 使用 DSH Agent Preset 作为执行 composition。
- `@clawx/dsh-agent-catalog` 保存 ClawX agent metadata，并将 agentId 映射到 preset、workspace、model 和 persona overlay。
- 创建 run 时由 bridge 选择对应 preset，禁止在 in-flight run 中静默改变已经冻结的执行 composition。
- `dsh-runtime-host` 是 live Agent handle 的唯一 owner；同一 Conversation 的 prompt、cancel、resume 通过 per-run lease 串行化。
- Agent 删除只删除 ClawX metadata 和安全可确认的 projection；统一 Conversation 默认保留，并把历史 run 的 agent snapshot 标记为 deleted reference。

M10 的实现把 `agents`、`agent_projections` 和 `agent_kernel_defaults` 放入同一份
canonical SQLite。`agents.id` 是与内核无关的稳定身份；每个内核的 native id、版本、
ready/pending/failed/unsupported 状态和错误只存在 projection 中。同名 Agent 因而不会被
拆成两份 UI 记录，默认 Agent 也必须由 `(kernelId, agentId)` 决定，不再读取全局
`defaultAgentId`。

首次切换到 canonical store 时，仅在 OpenClaw 可用且 canonical Agent 表为空时导入
OpenClaw agents/workspace/model/default；bindings 通过 OpenClaw projection 的 native id
兼容读取，不能重新成为 Agent 事实来源。之后创建、修改、删除都先提交 canonical 版本，
再由幂等 reconciler 分别投影。离线删除保留带 native id 的 deletion tombstone，待对应内核
恢复 ready 后重放；只有原生删除被确认后才清除 projection。

每个 run 在 admission 事务中保存不可变 `AgentRunSnapshot`，至少包含 canonical agent id/
version、displayName、workspace、persona、preset、model 和目标内核 native id。更新或删除
Agent 不回写历史 snapshot；UI 对已删除引用显示快照名称和明确的 deleted-reference 状态，
删除确认也明确说明 Conversation 与 run provenance 会保留。DSH 的
`@clawx/dsh-agent-catalog` 校验 `file:` workspace 并接收 canonical projection；ACP bridge
在创建 live handle 前挂载上游 Agent Preset，再叠加 persona/model，缺少指定 preset 时
显式失败，禁止悄悄降级。

## 9. Skills 同构

统一 Skills 页面展示 `KernelScope`：OpenClaw、DeepSeek Harness 或 Both。Skill 的 UI 身份、
版本、来源、安装/启用意图、兼容性与逐内核 projection 都是 ClawX canonical 数据；OpenClaw
目录、ClawHub 结果和 DSH `ctx.skills` 都不是第二份 metadata 权威。

```ts
type CanonicalSkill = {
  id: string;
  slug: string;
  revision: number;
  source: { kind: 'bundled' | 'marketplace' | 'local'; locator: string; digestSha256?: string };
  installedForKernels: KernelId[];
  enabledForKernels: KernelId[];
  compatibility: Array<{
    kernelId: KernelId;
    compatible: boolean;
    mode: 'native' | 'converted' | 'patched' | 'unsupported';
    reason?: string;
  }>;
  projections: Array<{
    kernelId: KernelId;
    state: 'pending' | 'applying' | 'ready' | 'partial' | 'failed' | 'unsupported';
    desiredRevision: number;
    appliedRevision?: number;
    error?: { code: string; message: string; retryable: boolean };
  }>;
};
```

- `ClawXDataService` 保存 canonical metadata、单调 `revision`、desired state、projection 与软删除
  tombstone；不可变 package 内容按 SHA-256 存入 Main-owned package store。首次升级只在 canonical
  catalog 为空时幂等扫描已安装 OpenClaw Skills，之后目录变化仅作为 projection 输入。
- OpenClaw adapter 继续复用现有 Skills/ClawHub 获取和配置能力，但下载完成后必须先导入 canonical
  package，再以原子物理复制投影到 OpenClaw managed skill root。
- DSH adapter 把转换后的 instruction body 通过 control bridge 注册到 `ctx.skills`；DSH runtime host
  只扫描 `<managed-data-root>/skills`，设置 `includeDefaultRoots: false`、
  `watchFollowSymlinks: false`，catalog 只保存进程内注册句柄，不持久化第二份 metadata。
- install/uninstall/update/enable/disable 先提交 canonical desired state，再分别 reconcile 目标内核。
  `Both` 返回逐内核结果；一个成功、一个失败保留 ready/failed 或 partial 状态并显示可重试诊断，
  不回滚已成功内核，也不伪报全部成功。离线删除保留 tombstone，内核 ready 后重放。
- OpenClaw 与 DSH 的 source root、package root 和 projection root 必须独立，禁止相同、嵌套、根目录
  软链接、package 软链接或跨 root 资源引用。投影使用临时目录加原子 rename；只删除带 ClawX owner
  marker 的目录，已有非托管目录即使失败也不得覆盖或删除。
- 首发 bundled matrix：`skill-creator` 在 OpenClaw 原生、在 DSH 去 frontmatter 后转换注册；
  `pdf`、`xlsx`、`docx`、`pptx` 因依赖尚未进入 DSH artifact 的辅助文档运行时而明确标记
  unsupported。未知 instruction-only Skill 可转换；含辅助文件且无法保持资源边界的 Skill 必须明确
  不兼容，不能静默丢文件。

## 10. Channels 同构

### 10.1 Canonical Channel Contract

必须统一：

- catalog/form schema
- credential validation
- account CRUD
- QR/OAuth/login lifecycle
- runtime status/diagnostics
- targets discovery
- agent binding
- inbound conversation policy
- outbound delivery

绑定键：

```ts
type ChannelBinding = {
  channelType: string;
  accountId: string;
  kernelId: KernelId;
  agentId: string;
};
```

### 10.2 并发规则

- 一个外部账号只能由一个 `connectionOwner` 持有。
- 同一个内核可拥有多个账号；两个内核可同时拥有不同账号。
- Conversation 与 channel binding 解耦；重新绑定不会移动或分裂既有统一历史，只影响后续 inbound run 的目标内核/agent。
- 切换 binding 时先停止旧 inbound admission，再提交 canonical binding，最后启动新 owner；失败则回滚。
- `channel_messages` 使用 `(channelType, accountId, externalConversationId, externalMessageId)` 幂等入库，并映射到一个 canonical `conversationId`；kernel identity 只记录在实际执行的 run 上。

### 10.3 DeepSeek Channel Relay

Relay 将 inbound 消息标准化后调用 `KernelChatAdapter`，收集最终回复和允许的流式进度，再调用 connector 发送。它必须实现：

- 幂等 message admission。
- per-conversation serialization。
- attachment staging/access grants。
- permission mode policy（默认不得在无人值守渠道自动批准提权）。
- delivery retry 和 dead-letter diagnostics。
- 不把 Connector token 传给内核或模型。

### 10.4 M12 落地不变量

- UI 的同一账号编辑表单显式选择 kernel 与 agent，Renderer 不选择 transport，也不直连 connector/Gateway。
- `(accountId, externalConversationId, externalMessageId, direction)` 在 SQLite 中唯一；重复 webhook/轮询事件返回既有 canonical message，不会创建第二个 Run。
- 同一外部 Conversation 的 inbound admission 串行；不同账号可由两个内核并发处理。
- outbound 的每次尝试、退避、成功或 dead-letter 都是 canonical delivery 记录；connector 本地缓存不是恢复权威。
- 无人值守 Channel run 使用 fail-closed 权限策略；附件须先完成 Blob staging 和 run grant，失败时 Conversation admission 原子回滚。
- 删除或卸载任一内核不删除 Channel message、Conversation、delivery、Blob 或凭据；缺失 adapter 只影响后续激活。

## 11. Cron 同构

Canonical schedule 支持：

- `at`
- `every`
- 标准五段 cron + IANA timezone
- enable/disable
- manual trigger
- run history
- overlap/concurrency policy
- channel delivery 或仅保留 session result

Scheduler 必须：

- 单应用实例内只有一个 leader。
- 调度器运行于 Electron Main：关闭窗口但应用/托盘仍存活时继续工作；用户显式退出后不承诺执行，重新启动时按 job 的 misfire policy 补偿。完全退出后仍持续调度需要独立 background service，不纳入首版。
- 关机前持久化 admission，重启后按 misfire policy 恢复。
- 每次 due admission 先以唯一 `(jobId, scheduledFor)` 事务写入 `cron_admissions`，再创建固定 kernelId/agentId/model/conversation target snapshot 的 canonical run。
- `cron_runs` 引用同一 `runs`/`conversations`，执行输出就是普通 Conversation turns；Cron 页面、Chat 页面和 Usage 页面不维护三份结果。
- Job 明确 Conversation policy：`reuse`、`new-per-run` 或 `new-per-day`，默认 `new-per-run`，避免无限上下文膨胀。
- 对已卸载或不兼容内核标记 blocked，而不是改投另一内核。
- 允许 OpenClaw 与 DSH jobs 同时执行，但受全局和 per-kernel concurrency budget 限制。

## 12. Usage 与 Dashboard 同构

每个 driver 输出统一 usage entries：

```ts
type CanonicalUsageEntry = {
  kernelId: KernelId;
  conversationId: ConversationId;
  runId: RunId;
  agentId?: string;
  modelRef?: string;
  timestamp: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
  source: 'runtime-event' | 'provider-response';
};
```

- 缺失字段保持 unknown，不允许用 `0` 伪装。
- OpenClaw/DSH adapter 在 live run 中规范化 usage，由 DataService 与 terminal run transaction 一起写入；不再扫描任何 transcript。
- Provider 重试或多次模型调用可写多条 usage entry，每条带稳定 event id，Dashboard 按 run 聚合但保留调用 provenance。
- Dashboard 可按 kernel/agent/model/time 筛选，并明确成本口径。

## 13. 运行时发行与补丁流水线

### 13.1 仓库布局

计划新增：

```text
kernels/
  catalog.schema.json
  node-runtime.json
  openclaw/
    source.json
    lock.json
    runtime.json
    overlay.manifest.json
    overlay/*
    patches/series
  deepseek-harness/
    source.json
    lock.json
    runtime.json
    overlay.manifest.json
    patches/series
    patches/*.patch
    overlay/packages/*
    patch-regression/*
  trust/*
scripts/kernel-runtime/
  build-runtime.mjs
  prepare-source.mjs
  download-node-runtime.mjs
  runtime-artifact-smoke.mjs
```

`lock.json` 固定实际 lockfile 的位置、package manager 和内容 hash：OpenClaw 复用本仓库受冻结的 `pnpm-lock.yaml`；DSH 先验证上游 lock hash，再严格应用已记录的 workspace importer patch，并验证 patch 后 hash。这样避免复制数百 KB lockfile，同时仍保证构建输入不可漂移。

补丁版本格式：

```text
openclaw/2026.7.1-2+clawx.1
deepseek-harness/0.1.1-rc.2+clawx.1
```

上游版本不变但补丁、bridge 或组装内容变化时必须增加 `clawx.N`，禁止覆盖已发布 artifact。

### 13.2 CI 步骤

1. 读取 `source.json` 并下载精确上游源码/npm tarball。
2. 验证 commit、npm integrity 或归档 SHA-256。
3. 使用冻结 lockfile 安装构建依赖。
4. `git apply --check` 后按 `series` 严格应用补丁；禁止 fuzz。
5. 构建 OpenClaw 或 DeepSeek Harness 与 bridge packages。
6. 运行上游 focused tests、ClawX protocol/storage contract tests、跨内核 context rehydration 和“无第二份 durable history”patch regression tests。
7. 按 platform/arch 物化依赖和原生 payload。
8. 为两个内核加入各自固定的 Node runtime，并验证 Node version/ABI。
9. 删除 dev/test/source junk，但使用 allowlist 验证运行必需文件。
10. 生成 THIRD_PARTY_NOTICES、CycloneDX/SPDX SBOM 和构建元数据。
11. 生成 deterministic `tar.zst` 和 SHA-256。
12. 对 artifact descriptor 签名并上传 staging。
13. 在干净 VM 上执行 install/start/chat/control smoke。
14. promotion job 先将执行仓库/Release tag 与 descriptor URL 绑定到已评审镜像，再从所有生产 HTTPS 镜像解析、验签并比对精确 N−1 catalog，将 descriptor 加入单调递增的签名 release manifest；sequence 1 必须显式 bootstrap 且确认所有镜像均无 catalog。跨云部分写入只允许复用精确、可信且与请求/制品集合一致的已签 N 做幂等修复；构建 job 无权直接更新 production catalog。

### 13.3 Artifact Manifest

```json
{
  "schemaVersion": 1,
  "kernelId": "deepseek-harness",
  "kernelVersion": "0.1.1-rc.2",
  "patchRevision": 1,
  "artifactVersion": "0.1.1-rc.2+clawx.1",
  "platform": "darwin",
  "arch": "arm64",
  "minHostVersion": "0.6.0",
  "maxHostVersion": "0.6.x",
  "chatProtocol": { "name": "acp", "min": 1, "max": 1 },
  "controlProtocol": { "name": "clawx-kernel", "min": 1, "max": 1 },
  "conversationStoreProtocol": { "name": "clawx-conversation-store", "min": 1, "max": 1 },
  "nodeVersion": "24.x.y",
  "nodeModuleAbi": 0,
  "url": "https://...",
  "compressedSize": 0,
  "unpackedSize": 0,
  "fileCount": 0,
  "sha256": "...",
  "signature": "...",
  "catalogSequence": 1,
  "publishedAt": "2026-08-23T00:00:00Z",
  "expiresAt": "2026-09-22T00:00:00Z",
  "entrypoints": {},
  "sbom": "sbom.spdx.json",
  "notices": "THIRD_PARTY_NOTICES.md"
}
```

## 14. 下载、安装、更新与回滚

### 14.1 状态机

```text
not-installed
  -> resolving
  -> downloading
  -> verifying
  -> staging
  -> smoke-testing
  -> installed
  -> starting
  -> running
```

任一阶段失败进入带 reason 的 `error`，但 last-known-good 版本保持可启动。

### 14.2 安装安全

- HTTPS 之外还必须校验 pinned public key 签名和 SHA-256。
- Catalog envelope 必须包含单调递增 sequence、签发/过期时间和 key id；客户端持久化最高已接受 sequence，在线更新默认拒绝 rollback/freeze metadata。紧急降级必须使用单独的受签名 rollback authorization。
- Production promotion 不信任人工指定的 previous catalog：N>1 正常路径必须从所有配置镜像取得签名有效、内容完全一致的 N−1；N=1 需要受保护 bootstrap 并证明镜像均不存在 catalog。部分发布重试只接受可信 N/N−1（首次 N/absent），且 N、请求与 staging 集合必须精确吻合；同 sequence 分叉失败关闭。执行仓库/tag 和 descriptor URL 必须属于 distribution allowlist；新 catalog 在签发时和过期前一刻都必须连同全部 retained artifacts/keys 验证通过。
- Signing key rotation 使用旧/新 key 交叉签名或内置的下一代信任根；artifact signing、catalog promotion 和 CDN 写权限相互分离。
- 支持 Range 续传；恢复前验证 partial file identity/ETag。
- 解压拒绝绝对路径、`..`、越界 symlink/hardlink、设备文件和超出 manifest 的 file count/size。
- staging 与 final 必须在同一卷，激活使用原子 rename/pointer replace。
- 安装前检查至少 `unpackedSize + staging reserve + rollback reserve`。
- 首次启动 smoke 失败时自动 quarantine artifact。

### 14.3 运行时更新

- ClawX app update 与 kernel update 独立。
- 运行中的版本不可原地覆盖。
- 下载和验证可后台进行，激活必须等待该 kernel 无活跃 prompt/job/channel connection，或由用户确认受控重启。
- 两个内核的更新互不阻塞；更新 OpenClaw 不停止 DSH。
- downgrade 必须通过 protocol/checkpoint compatibility policy；不兼容 opaque checkpoint 可丢弃并从 portable canonical context 重建，但不得降级或改写主 SQLite schema。

### 14.4 卸载

- 默认只删除 runtime artifact。
- 统一 Conversation、Cron、Channel、Usage 和 Blob refs 独立于 runtime，卸载任一内核后继续保留并可浏览。
- 删除统一用户数据需要独立入口、二次确认和逐类选择，禁止把“卸载内核”等同于“删除对话/定时任务/密钥”。

## 15. 文件与数据布局

```text
<userData>/
  kernels/
    downloads/                 # <archive-sha>.tar.zst 与可丢弃的 .partial/.partial.meta
    staging/                   # 同卷、可在崩溃恢复时清理
    quarantine/                # smoke/integrity 失败版本
    trash/                     # Windows 锁文件的 next-launch cleanup
    openclaw/installs/<artifactVersion>/
    deepseek-harness/installs/<artifactVersion>/
  kernel-config/
    openclaw/
    deepseek-harness/
  kernel-cache/
    openclaw/
    deepseek-harness/
  state/
    clawx.sqlite               # 含 catalog trust/cache、install/current/LKG/history
    backups/
  blobs/
    sha256/<prefix>/<digest>
  logs/
    app/
    kernels/openclaw/
    kernels/deepseek-harness/
```

- Managed OpenClaw/DSH 只使用 ClawX 私有 config/cache roots；session/Cron history 路径被禁用或指向 run-scoped temp。
- 旧 `~/.openclaw`、外部 DSH home 和旧 Cron/history 文件不迁移、不扫描、不删除，也不作为新 ClawX 的 history fallback。
- 第一版不允许 managed runtime 连接会自行持久化 session 的 external home；未来 external kernel 只有实现 Conversation Store protocol 后才可接入。
- Blob Store 不是第二份 history：它只保存不可直接查询的大型内容，所有归属、顺序、权限和引用都在 SQLite。

## 16. Host API 和事件变更

新增顶级模块：

```text
kernels.*       catalog/install/update/repair/start/stop/status/logs
conversations.* list/get/create/rename/pin/delete/export/history/search
conversationRuns.* admit/cancel/status/events/context
agents.*        所有 payload/result kernel-scoped
providers.*     canonical account + per-kernel projections
chat.*          conversation-scoped submit + kernel-scoped execution
channels.*      canonical account/binding/orchestrator
cron.*          SQLite-backed ClawX scheduler/jobs/runs
skills.*        per-kernel state
usage.*         canonical entries/filter
diagnostics.*   per-kernel snapshots
```

接口切换规则：

- `gateway.*` 只作为 OpenClaw driver 内部兼容 facade，Renderer 最终不得调用。
- Host run event envelope 必须包含 `conversationId`、`runId`、`kernelId`、`runtimeGeneration` 和 `eventSeq`。
- History query/result 不需要目标 kernel；新的执行 payload 必须明确 kernel/agent/model snapshot。
- 不提供旧 session key/history 的兼容读取路径；旧 payload 不迁移。通用 UI 一次性切换到 Conversation API。

## 17. Renderer 设计

### 17.1 全局体验

- Setup 首先显示 Kernel Catalog；两个内核均可跳过或分别安装。
- TitleBar/Sidebar 显示每个内核独立的 running/degraded/update 状态。
- 用户可以启动/停止任一内核；停止 OpenClaw 不影响 DSH。
- Chat sidebar 直接查询统一 Conversation catalog；可按最近执行内核、参与过的内核、agent 或来源筛选，每个 turn/run 显示 provenance badge。
- 未安装任何内核时仍可完整打开、搜索、重命名、导出和删除历史；只有发送下一条消息时才要求选择并安装目标内核。
- Conversation 顶部的 kernel selector 只决定下一次 run；切换后历史不复制、不清空，并插入清晰的 runtime boundary marker。

### 17.2 页面同构

- Models：统一账号列表，显示每内核 projection 状态。
- Agents：按内核分组或筛选，表单字段一致。
- Channels：账号绑定选择 kernel + agent。
- Cron：每个 job 明确目标 kernel + agent。
- Skills：每个 skill 显示 OpenClaw/DSH 双状态。
- Usage：支持 kernel 比较和总览。
- Settings：内核安装、更新通道、数据路径、日志和诊断均独立。

所有新增文案进入 en/zh/ja/ru locale；所有新状态和交互必须有 Electron E2E。

## 18. 故障与恢复

### 18.1 单内核故障

- 一个内核 crash 只更新自己的 runtime state，并把受影响 runs 标记为 interrupted；已经提交的 Conversation history 不受影响。
- 另一个内核、Channel Orchestrator 和 Scheduler 继续运行。
- 自动恢复预算按 kernel 隔离。
- 连续 crash 达到阈值后进入 `crash-loop`，需要用户操作或版本 rollback。

### 18.2 Bridge 协议故障

- initialize 必须协商 protocol version、kernel identity、artifact version 和 capabilities digest。
- 响应 kernelId/artifactVersion 与 launch expectation 不一致时立即停止并 quarantine。
- 未知 notification 被记录但不投影；缺失 mandatory capability 阻止 runtime 进入 ready。
- stdout 必须 protocol-pure，诊断只写 stderr/日志文件。

### 18.3 Canonical projection 失败

- 写操作产生 operation id。
- canonical store 记录 desired state 和 projection status。
- 各 kernel adapter 幂等 apply。
- partial failure 对用户可见并可 retry/reconcile，不执行跨内核破坏性 rollback。

### 18.4 DataService/SQLite 故障

- DataService crash、`SQLITE_BUSY` 超时、disk full、I/O error 或 failed integrity check 是全局 persistence fault；所有新 prompt、Cron 和 Channel admission fail closed。
- Main 重启 DataService 后执行 WAL recovery、`quick_check`/必要时 `integrity_check`，再把未终结 runs 统一标记 interrupted。
- 不能通过切换到 runtime 原生 transcript 绕过故障，否则会重新产生双权威。
- 自动备份必须是 WAL-aware 的一致性 snapshot；恢复到旧快照后使用 monotonic operation/event ids 拒绝 bridge 重放已超出快照的未知事件。
- 数据库不可恢复时进入只读恢复界面，允许选择已验证备份或导出可读记录；不得自动新建空库覆盖损坏文件。

## 19. 安全模型

- Runtime manifest 使用应用内 pinned public key 验签；签名 key 与 artifact hosting 分离。
- CI 使用最小权限 OIDC、不可变 provenance 和 promotion approval。
- Patch series、上游版本、lockfile、SBOM 和测试结果进入 artifact provenance。
- DSH 自带 Node，不依赖系统 PATH；OpenClaw/DSH child env 使用 allowlist/scrubbed env。
- Renderer 永远不能获得 runtime path、SQLite path、API key、channel token 或任意 bridge/DataService socket。
- Kernel process 通过 per-launch nonce、process identity 和 capability scope 访问 DataService RPC；它看不到数据库文件，也不能执行任意 SQL。
- Credential Broker 对每次 secret request 验证 kernel process identity、account reference 和用途。
- SQLite 与 backup 目录使用 owner-only 权限；Conversation 内容属于敏感本地数据。首版依赖 OS volume encryption，SQLCipher 等应用级加密必须作为独立兼容/性能决策，不能宣称 `node:sqlite` 自带加密。
- Channel Relay 的无人值守会话默认拒绝危险权限；不能因为来自“已登录渠道”而自动允许系统访问。
- macOS 内核包中的 Node/native helper 必须签名并满足公证策略；不得修改已签名 `.app`。
- Windows 使用签名 artifact、显式 process tree/job object 和路径限定清理；禁止按通用进程名全局 kill。

## 20. 性能与资源预算

- 并行运行两个内核时分别记录 RSS/CPU/startup latency。
- 默认允许两个 runtime 同时 running，但限制全局并行 agent turns 和 scheduled runs。
- 非当前内核 UI 不进行高频轮询，使用 Main events。
- DataService 在 utility process 中执行 SQL，避免同步 `node:sqlite` 阻塞 Electron Main；history 使用 keyset pagination，FTS5 搜索，禁止全库 JSON decode。
- live delta 按 250–500ms 或大小阈值批量写入；tool/permission/terminal 事件立即写，禁止每 token 一事务。
- Renderer 只保留 active/recent Conversation 的有界 timeline；冷历史从 SQLite 分页读取，不依赖 runtime replay。
- 建立 DB size、WAL size/checkpoint latency、写入 p95、history query p95、FTS index 和 backup duration budget。
- Kernel download/extraction 不得阻塞 Main event loop；哈希和解压放入 utility process/worker。
- CI 对 base installer、每个 compressed runtime、unpacked runtime 建立 size budget。

## 21. 测试策略

### 21.1 共享 Contract Tests

以下 suite 必须对 OpenClawDriver 和 DeepSeekHarnessDriver 重复运行：

- lifecycle/readiness/restart/quit
- ACP/bridge prompt/cancel/permission/config/events
- canonical context hydrate/resume/compact and cross-kernel continuation
- no durable native transcript/Cron/Usage/Channel history after restart
- agents CRUD/model/workspace
- provider projection/secret reload
- skills list/install/update/enable/disable
- usage normalization and SQLite persistence
- diagnostics redaction
- conversation/run identity isolation

以下 Conversation Store suite 只对 DataService 运行一次，但所有 driver 必须使用：

- schema/foreign keys/unique idempotency constraints
- prompt-before-dispatch admission and terminal atomic commit
- batched stream crash recovery and interrupted-run repair
- concurrent kernels writing different conversations
- same-conversation single-active-run lease
- context visibility/redaction/truncation and opaque checkpoint isolation
- WAL checkpoint、disk full、corruption、backup/restore、read-only recovery
- FTS/pagination/delete cascade/blob reference counting

### 21.2 Channels/Cron Tests

- 同时运行两个内核并分别绑定不同账号。
- 同账号 owner 竞争和原子 rebind。
- inbound idempotency、attachments、permission denial、delivery retry。
- 两个内核 job 同时到期、overlap policy、重启 misfire、内核缺失/更新中。
- 所有 job/admission/run/delivery 都只存在于 ClawX SQLite，runtime native scheduler/history 目录保持为空。
- `(jobId, scheduledFor)` 重放不会创建第二次 canonical run。

### 21.3 Package Manager/CI Tests

- checksum/signature mismatch
- truncated/resumed download
- malicious archive paths/symlinks/size expansion
- disk full/cancel/crash during activation
- rollback/repair/uninstall preserve data
- incompatible app/runtime/protocol/ABI
- macOS arm64/x64、Windows x64、Linux x64/arm64 clean-machine smoke
- 每个真实制品通过生产 Package Manager 的截断/Range 续传、验签、安全解包、控制桥、激活、rescan 与卸载链路
- 同机安装两份真实制品、并发控制桥、单侧 integrity failure/repair、另一内核持续健康及统一 SQLite 数据保留

### 21.4 E2E

- 无内核首次启动。
- 单独安装任一内核。
- 两个内核同时运行和同时流式输出。
- 统一 Conversation catalog、跨内核继续同一 Conversation 与导航持续流。
- 停止/卸载内核后仍可完整浏览统一历史。
- OpenClaw 和 DSH runtime dirs 在 prompt/compact/restart/Cron/Channel 后没有 durable transcript/run-history 文件。
- Models/Agents/Channels/Cron/Skills 的双内核 CRUD。
- 一个内核 crash/update/stop 时另一个不受影响。
- 应用退出时两个 process tree 均完成有界清理。

通信改动必须运行 `pnpm run comms:replay` 和 `pnpm run comms:compare`。

## 22. 分阶段迁移

### Phase 0：规格和可行性闸门

- 冻结 ClawX Kernel Contract v1。
- 冻结 Conversation Store schema/RPC/context portability v1。
- 用 OpenClaw patch spike 证明 SessionManager/compaction/branch/resume 可由 ClawX SQLite 驱动，且不产生 durable JSONL。
- 用 DSH persistence/ACP spike 证明从 SQLite hydrate、tool/permission/cancel/resume 可实现，且不产生 durable JSONL。
- 用 CI artifact 证明三个主平台可启动。
- 证明两个 runtime 同时运行、退出无残留。

### Phase 1：统一数据与 Kernel 基础设施

- ClawXDataService、SQLite schema、Conversation API、Blob Store、Context Compiler。
- Canonical identity、KernelCatalog、PackageManager、SupervisorRegistry。
- fake kernels 和 package security tests。
- UI 无内核状态与安装管理。

### Phase 2：OpenClaw 可选化

- OpenClawDriver 包装现有 Gateway/ACP。
- 接入 OpenClaw Conversation Store adapter，禁用 JSONL/native Cron durable persistence。
- 从 electron-builder/afterPack/installer 移除内置 runtime。
- 首次下载、CLI 和插件路径调整；不发现或导入旧 history。
- 新建 Conversation 的 OpenClaw 功能零回归。

### Phase 3：并行 Kernel Chat

- conversation/run-scoped Host API/events/store ingestion。
- 通用 ACP connection manager 和 ConversationRouter。
- DeepSeek rich ACP + ClawX persistence provider。
- 统一 Conversation catalog、跨内核 context compiler 与后台持续流。

### Phase 4：Providers、Agents、Skills、Usage

- Canonical metadata、Credential Broker 和 driver projections。
- DeepSeek control bridge。
- 页面和 contract tests 完全同构。

当前 M14 落地由 `UsageAdapterRegistry` 把 OpenClaw 最终 provider response 与 DSH
`SessionEvent` token meter 规范化为逐调用记录；`(run_id, event_key)` 唯一键吸收 provider
retry 和重复投递，terminal fallback 仅在该 run 尚无 Usage 时写入。Dashboard 只查询
SQLite `usage_entries`，支持全部/OpenClaw/DSH 过滤；未知 Token/费用保持 NULL/unknown，
美元之外的费用不换算且只在调用明细展示。Diagnostics snapshot 把运行中 generation
绑定到精确 runtime-version manifest，报告 artifact、patch revision、protocol、PID、health
和 capabilities；每个内核使用独立日志目录，内存、磁盘与导出共用同一脱敏器。

### Phase 5：Channels 与 Cron

- Channel Orchestrator/Relay。
- ClawXScheduler、统一 SQLite jobs/admissions/runs/delivery；禁用 native schedulers。
- 多内核并行投递和调度。

当前 M13 落地使用 SQLite 可续租 leader lease 和单一 earliest-due timer；每个
due time 先以唯一 `(job_id, scheduled_for)` 原子提交 admission/Cron run，再由
Conversation Router 在内核 dispatch 前提交普通 canonical run。misfire 支持
`skip`/`run-once`/有界 `catch-up`，overlap 支持 `skip`/串行 `queue`/`replace`；
Conversation 支持 `reuse`/默认 `new-per-run`/按 schedule timezone 的
`new-per-day`。定时结果走 Channel Orchestrator 的同一 outbound/retry/dead-letter
流水线。OpenClaw/DSH managed 环境禁用 native scheduler/history，旧 Cron/Schedule
文件不扫描、不导入；重启或重复重放同一 due time 不会产生第二个 run 或投递。

### Phase 6：发布与稳定化

- 完整平台 CI、签名、公证、CDN/镜像、离线导入、SBOM。
- crash/update/rollback/repair chaos tests。
- 文档、i18n、E2E 和 release support policy。

## 23. 发布闸门

只有同时满足以下条件才能称为“完全同构多内核”：

1. ClawX 主安装包不含 OpenClaw 或 DeepSeek Harness runtime。
2. 两个运行时均来自可复现、签名、按平台预制的 artifact。
3. 两个内核可以同时 ready，且一个内核的 stop/crash/update 不影响另一个。
4. 当前 ClawX Chat UI 从同一 SQLite 对两个内核展示历史、流式输出、reasoning、tools、plans、permissions、attachments 和 usage。
5. Models、Agents、Channels、Cron、Skills 页面不包含内核分叉业务逻辑。
6. Conversation identity 独立于 kernel；每个 run 使用显式 kernel identity、event sequence 和幂等 admission。
7. Channel account 不会被两个 owner 重复消费；Cron admission 不会重复执行。
8. Secrets 不进入 Renderer、日志、SQLite、命令行或 runtime manifest。
9. Runtime update 可独立回滚，卸载默认保留用户数据。
10. 两个 driver 通过同一 contract suites，并完成全部目标平台 packaged E2E/smoke。
11. OpenClaw/DSH runtime data dirs 不包含第二份 durable Conversation、Cron、Usage 或 Channel message history。
12. 同一 Conversation 可在 turn 边界切换内核；目标内核只接收经过 visibility/redaction/budget 规则编译的 portable context。

## 24. 明确不采用的方案

- 不嵌入 DeepSeek Harness 官方 Web UI作为第二套界面。
- 不让 Renderer 直接调用 DSH `/api` 或 OpenClaw Gateway。
- 不把官方 DSH automation ACP 当作功能完整的 Chat adapter。
- 不在最终用户机器执行 npm/pnpm 安装内核。
- 不把 `~/.openclaw` 与 `$DSH_HOME` 会话/Skills 目录直接软链接。
- 不长期双写 ClawX SQLite 与 runtime JSONL/SQLite，也不在读取时聚合多套历史。
- 不允许内核直接打开 `clawx.sqlite` 或执行任意 SQL；必须通过 DataService contract。
- 不把附件、大型图片或 tool artifacts 直接塞进 SQLite BLOB。
- 不使用一个全局 `gatewayStatus` 表示两个 runtime。
- 不因为一个 projection 失败而删除另一个内核已成功保存的用户状态。
- 不把 OpenClaw Cron 强行映射为 DSH Schedule，或反过来。

## 25. 明确不做历史迁移

- 不导入现有 OpenClaw `sessions.json`、session/trajectory JSONL、Cron jobs/runs 或 Usage transcript。
- 不导入现有 DSH SessionPersistence、Schedule 或外部 DSH home。
- 不为旧 session key 提供静默 fallback；统一 Conversation UI 从 cutover 后的新 SQLite 数据开始。
- 旧文件保持原样且不主动删除，避免设计任务扩大为破坏性清理。未来如需导入，应作为独立、显式、可回滚的离线工具设计，不能重新引入运行时双读/双写。
