# ClawX 系统架构

本文档是 README「系统架构」一节的详细说明。

## ClawX 0.6 多内核权威架构

ClawX 现在是可选、独立版本内核的宿主。OpenClaw 已从主安装包移除；OpenClaw 与 DeepSeek Harness 都从 CI 预制的签名运行时安装，并可同时运行。现有 Renderer 完全共用，只认识 ClawX canonical 领域契约，不认识任何上游 session/config 协议。

```text
React Renderer
  -> typed Host API / Host events
Electron Main 领域服务
  -> ClawXDataService utility process -> 单一 SQLite + content-addressed Blobs
  -> ConversationRouter / Scheduler / Channel Orchestrator / Credential Broker
  -> KernelPackageManager + SupervisorRegistry
       -> OpenClawDriver -> 下载的 OpenClaw runtime
       -> DeepSeekHarnessDriver -> 下载的 DSH runtime host
       -> 未来 KernelDriver
```

SQLite 是全部新 Conversation、Cron、Channel、Usage、Agent/Provider/Skill 状态与 runtime operation 的唯一 durable authority。Runtime 不打开数据库，也不拥有第二份 transcript/scheduler history。ACP 与 DSH bridges 只承担实时执行；DataService 只接受带 conversation/run/kernel/generation/sequence 的事件。同一 Conversation 只可在 turn 边界改变下一次执行内核，目标内核只收到经过 visibility/redaction/budget 规则编译的 portable context。

Package 安装是事务化的：Main 校验签名且有期限的 catalog/descriptor，使用有界流与断点续传下载，在拒绝链接/路径穿越的 staging 中解压，执行 artifact/platform/storage self-test 后原子激活。每个内核都有独立 supervisor、目录、port/stdio bridge、operation queue、health 和 rollback slot；停止、崩溃、修复或更新一个不得替换另一个。

本文后续 OpenClaw Gateway/config 内容只描述 `OpenClawDriver` adapter，不再是全局宿主架构。DSH 通过受补丁保护的 ACP/control/persistence bridge 使用同一 Host API/领域层。参见[完整多内核设计](multi-kernel-design.md)、[运行时安全/支持策略](runtime-security-support.md)与[数据安全/保留策略](data-security-retention.md)。

ClawX 采用 **Main-owned 多进程 + Host API 统一接入架构**。Renderer 只调用统一客户端抽象；DataService utility process、runtime 选择、协议 adapter 与进程生命周期全部由 Electron Main 管理。

OpenClaw 配置交付是 Electron Main 管理的一种 adapter projection。可选 Gateway 运行时，ClawX 通过 `config.get`/`config.set` 投影状态；停止或启动中时，只更新可替换的 managed JSON5 配置而不启动进程。Provider、Agent、Channel、绑定、Skill 与模型意图的权威记录仍在 SQLite。普通投影变更不替换进程，完整重启只用于代理等启动环境变化或用户显式操作。心跳恢复只作用于 ClawX 持有的 OpenClaw supervisor，不会重启其它内核。认证元数据提交后，secret 仍在 OS 凭据存储，OpenClaw 只收到受限的 `secrets.reload` 通知。

执行 OpenClaw 时，Main 持有 ACP stdio bridge，只向它提供已准入的 Conversation snapshot、run identity、受限凭据与 workspace grant；bridge 不从 runtime 加载 UI history。受保护恢复若中断已接收 run，补丁运行时会为替代进程/run 发出显式 lineage；ConversationRouter 只接受 kernel、generation、run 与递增 event sequence 全部匹配的事件。OpenClaw 仍实现 models、skills、diagnostics 等 runtime projection，但 durable ownership 始终属于 ClawX 领域服务。

### 实时 Adapter 语义与 Canonical History

ACP 只对已准入 OpenClaw run 发出的实时执行语义负责；DSH bridge 具有同样角色。Main 把 text、reasoning、tool、permission、plan、usage、image 与 resource 规范化为 `KernelEventEnvelopeV1`，ConversationRouter 校验身份后经 DataService 写入。任何 transport 都不得向 UI 提供 Conversation catalog/history、Cron history 或 Usage history。

SQLite Conversation records 是唯一历史来源。打开或刷新 Conversation 时，Main 将 canonical turns、content blocks、runs、tool calls、permissions、usage 与 timestamps 投影到现有 Chat timeline，不调用 runtime `session/load`，不读取 JSONL，也不扫描 runtime 目录。Canonical record 缺失就保持缺失，不能用 transcript、Gateway 或 native history fallback 重建。为旧调用者保留的兼容 API 名称也只是同一 Conversation repository 的 facade，不是第二份存储。

切换 Conversation 或页面不会停止未完成回复；live snapshot 按 Conversation/run/kernel/generation 隔离，terminal commit 原子写入最终 assistant turn 及关联记录。完成前返回会继续内存流，完成后返回则重新投影同一 SQLite durable history。

Assistant 整轮耗时来自 canonical run admission 与 terminal timestamp。附件、生成图片和文件活动保存为 canonical content blocks 与结构化 run events。标准 ACP/DSH resource/image 只在实时 adapter 边界被规范化；历史渲染不会解析 `MEDIA:` 文本或 native transcript。用户图片显示缩略图，其它 resource 显示附件卡；每次本地文件操作仍由 Electron Main 按精确 Conversation/run workspace grant 重新验证。

现有本地文件引用（包括当前 workspace 外的已授权路径）在每次预览或打开前都会重新验证。AI 生成且可预览的本地附件（包括不超过 20 MB 的 `.docx` 和 `.pptx`）提供只读应用内预览及通过兼容应用打开/在系统文件管理器中显示的菜单；本地 HTML 可在右侧 Preview 打开。`.doc`、`.ppt`、超过 20 MB 的 Office 文件及用户选择的目录交给系统应用；远程 HTTP/HTTPS 附件只在用户点击后外部打开。没有 canonical resource 佐证的文本路径不视为附件。

生成图只从已被 canonical run 接受的可信结构化 runtime event 显示；与任务关联的最终回复保留原始用户可见文本，包括纯文本失败说明。预览通过 Electron Main 的 host media 处理加载，Renderer 不会任意访问文件系统。

### ACP 文件活动语义

- 文件活动由成功且已完成的 OpenClaw `write`、`edit` 和 `apply_patch` 调用投影而来。工具识别方式与 OpenClaw 官方 Chat UI 保持一致；仅接收已完成调用的筛选规则是 ClawX 特有的。
- 已创建和已修改的活动行与可预览的 assistant 附件共用同一种文件卡片外壳和**打开方式**菜单，同时保留状态文字及可用的 `+/-` 统计。对于 HTML 文件，菜单第一项会在右侧**预览**中打开文件；已删除的活动行只保留 **Changes** 操作。应用列表、指定应用打开和显示文件位置都会由 Electron Main 根据 workspace 根目录与相对路径分别重新验证；工具路径不会因此变成附件，Renderer 也不会获得规范化系统路径。
- `write` 按工具声明的语义显示：视为创建，并展示为全部新增的差异，即使该路径可能已经存在。
- **Changes** 是按时间顺序记录工具声明活动的会话级记录，不是 Git 输出，也不是相对于已验证源码基线的差异。
- 对每个文件，Changes 在每轮助手回复中最多展示一个 diff 编辑器。可安全串联的片段会合并，独立片段会拼接到同一个编辑器中，但不会被描述为基于完整文件基线的差异。
- Shell 命令、脚本、用户或 IDE 产生的副作用不会被检测。
- Canonical Conversation 投影恢复已记录的文件活动；结构化记录缺失时，不从文本、文件系统或 runtime history 推断。

```
┌───────────────────────────────────────────────────────────────────┐
│                        ClawX 桌面应用                              │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Electron 主进程                                 │  │
│  │  • 窗口与应用生命周期管理                                       │  │
│  │  • 网关进程监控                                               │  │
│  │  • 系统集成（托盘、通知、密钥链）                                │  │
│  │  • 自动更新编排                                               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              │ IPC (权威控制面)                     │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              React 渲染进程                                  │  │
│  │  • 现代组件化 UI（React 19）                                  │  │
│  │  • Zustand 状态管理                                          │  │
│  │  • 统一 host-api/api-client 调用                             │  │
│  │  • 回复使用 Markdown，用户输入按原文显示                         │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ 类型化 IPC 请求
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                  主进程 Host Services 与 Gateway Manager          │
│                                                                 │
│  • host:invoke 类型化服务分发                                      │
│  • 设置、文件、会话、技能、供应商、诊断服务                           │
│  • 主进程持有 Gateway WebSocket 并负责进程监控                       │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ 主进程持有 WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw 网关                                │
│                                                                 │
│  • AI 智能体运行时与编排                                           │
│  • 消息频道管理                                                   │
│  • 技能/插件执行环境                                               │
│  • 供应商抽象层                                                   │
└─────────────────────────────────────────────────────────────────┘
```
### 设计原则

- **进程隔离**：AI 运行时在独立进程中运行，确保即使在高负载计算期间 UI 也能保持响应
- **前端调用单一入口**：渲染层统一走 host-api/api-client，不感知底层协议细节
- **主进程掌控传输策略**：ACP Chat stdio bridge 与 Gateway 传输都由 Electron Main 持有，渲染进程通过类型化 IPC 调用 Main
- **扩展 IPC 贡献点**：主进程扩展通过类型化 IPC 注册表贡献 host-api action，而不是挂载 HTTP route
- **优雅恢复**：内置重连、超时、退避逻辑，自动处理瞬时故障
- **安全存储**：API 密钥和敏感数据利用操作系统原生的安全存储机制
- **CORS 安全**：渲染进程不直接请求本地 Gateway 或 Host API HTTP 端点

### Gateway 存活恢复

Gateway 的存活状态由 Electron 主进程判断。WebSocket pong 是有价值的传输层证据。普通传输丢失时，主进程优先沿既有 Gateway WebSocket 重连路径恢复连接。ClawX 在三分钟没有可信存活信号后，先通过 `system-presence` 验证核心 RPC 路由，再决定是否替换其自身拥有的进程。

| 设计点 | 处置 | 目的 |
| --- | --- | --- |
| 将 pong、任意入站 Gateway 帧和成功 RPC 视为存活信号* | 刷新 `lastAliveAt` 并取消过期的 deadline 回调 | 当连接仍在承载真实流量时，大型 AI 操作（如 Skill 调用、工具调用）可能导致 pong 延迟；避免把这种延迟误判为 Gateway 已死亡 |
| 使用单一三分钟静默 deadline | 180 秒前只记录 heartbeat miss，不修改 socket 或进程 | 在限制自动恢复时间的同时避免仅因 pong 缺失而重启 |
| 在 deadline 到期时验证控制面 | 以 5 秒超时调用一次 `system-presence` RPC，从控制面而非纯 WebSocket 确认 Gateway 状态；成功则恢复正常监控 | 区分事件流暂时安静与无法提供核心读 RPC 的 Gateway |
| 只重启不可用的 ClawX 自管进程 | deadline probe 失败后请求受保护的 Gateway 重启路径 | 恢复真正无响应的本地子进程 |
| 绝不自动停止外部 Gateway | 优先仅替换或重连 ClawX 的 WebSocket，并报告不可用诊断 | 避免向 ClawX 不拥有的进程发出 shutdown |
| 保持权威生命周期路径独立 | 保留现有 WebSocket close 重连、code 1012 reload 恢复、进程退出恢复和手动重启 | 防止重复或竞争性的 stop/start 操作 |
| 不在此路径追踪活跃工作负载 | 无论 chat、tool 或 cron 是否活跃，均使用相同 deadline | 让存活恢复聚焦于防止虚假重启和进程所有权 |

> * 此存活信号设计参考了 [LobsterAI](https://github.com/netease-youdao/lobsterai)。

### 进程模型与 Gateway 排障

- ClawX 基于 Electron，**单个应用实例出现多个系统进程是正常现象**（main/renderer/zygote/utility）。
- 单实例保护同时使用 Electron 自带锁与本地进程文件锁回退机制，可在桌面会话总线异常时避免重复启动。
- 滚动升级期间若新旧版本混跑，单实例保护仍可能出现不对称行为。为保证稳定性，建议桌面客户端尽量统一升级到同一版本。
- 但 OpenClaw Gateway 监听应始终保持**单实例**：`127.0.0.1:18789` 只能有一个监听者。
- Gateway readiness 以 OpenClaw 的 `system-presence`、`health`、`status` 等核心信号为准；memory 或频道失败会显示为能力降级，而不是全局 Gateway 故障。
- 可用以下命令确认监听进程：
  - macOS/Linux：`lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows（PowerShell）：`Get-NetTCPConnection -LocalPort 18789 -State Listen`
- 点击窗口关闭按钮（`X`）默认只是最小化到托盘，并不会完全退出应用。请在托盘菜单中选择 **Quit ClawX** 执行完整退出。
