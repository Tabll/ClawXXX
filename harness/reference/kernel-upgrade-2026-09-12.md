# 双内核升级：2026-09-12

## 冻结范围

本次为源码与可下载运行时升级，不迁移用户对话、不替换本机已安装目录，也不跳过受保护发布。Conversation / Cron / Agents / Channels / Skills / Usage 继续由 ClawX Data Service 的同一 SQLite 管理。保留此前开发模式运行时选择、安装后驱动注册、原生 Node 子进程、Agent schema ownership 与本地验签修复。

| 内核 | 上游身份 | 新制品身份 |
| --- | --- | --- |
| OpenClaw | `v2026.9.4` / commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107` | `2026.9.4+clawx.14` |
| DeepSeek Harness | `dsh-v0.1.5-rc.2` / commit `fb2c4b9e698e30edb738bca4cf0618587db7d203` | `0.1.5-rc.2+clawx.14` |

DSH 是 release candidate，不是稳定版。OpenClaw 同步冻结 Discord/WhatsApp 2026.9.4；其他渠道依赖不随意浮动。Node 保留 24.20.0 / ABI 137，根 pnpm 10.33.4、DSH pnpm 11.7.0。npm SRI、tag object、commit/tree、锁文件、补丁、overlay 和 runtime descriptor 的摘要见 `kernels/*/source.json`；不使用 latest/HEAD 作为构建输入。

官方依据：[OpenClaw 9.4](https://github.com/openclaw/openclaw/releases/tag/v2026.9.4)、[9.3 破坏性变更](https://github.com/openclaw/openclaw/releases/tag/v2026.9.3)、[DSH rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)、[V3 协议](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.5-rc.2/packages/session/session-format-v2-to-v3/README.zh.md)。

## OpenClaw 补丁处置

新版发布物内部大量模块改成带 hash 的 `.mjs`，同名薄包装和实际实现可并存。每个旧补丁均按语义定位，最终使用完整精确 patch；不通过模糊匹配、offset 或关闭校验绕过升级。

- 存储 fence：Agent schema 仍为 19；保留 Agent/state 历史表的 TEMP shadow。凭据和上游 schema 由各自 authority 管理，Main 不抢占 user_version；不启用原生 Cron/自动回复/持久化 ACP replay。
- ACP：保留每 Run 的 incognito hydration、session deletion、取消及断线终止。新版产物裁掉了内存 ledger 实现，需补回此前审查过的有界内存实现（session/event/bytes 上限全部保留），不能仅留下函数调用或改回 SQLite ledger。
- Usage：适配新的 `recordModelUsage(pending, message)` 调用位置，保留上游 best-effort callback；只转交真实 provider usage，成本只接受 provider-billed。不扫描原生历史做用量回填。
- Channels：尊重新版 `state.allowInboundHandlers` 和 takeover 准入判断。受管入站缺少可信 before_dispatch hook 或规范确认时 fail closed。七个实际渠道的安装元数据/导出加载和真实拒绝路径必须验收。
- Plugin registry：保留物理路径归一化、manifest hash 和稳定 owner 顺序；更新真实 registry probe 的精确模块与导出别名，避免旧别名指向另一个函数。
- 兼容 SDK、Cron 工具 schema、postinstall inventory、PTY 与 browser hint 全部重基；`.mjs` 扫描范围显式更新。Skills 仍由 ClawX 统一投影，不因上游 Workshop 改动迁移用户目录。readonly-config 不盲目开启，避免阻断 Main 配置投影。
- Discord DAVE 依赖已扁平到 plugin 自身 node_modules；精确冻结五目标 `.node` 路径，拒绝相邻未审查二进制，不扩大为任意 native wildcard。

`patches/openclaw@2026.9.2.patch` 保留作历史，不再参与当前安装。

## DeepSeek Harness V3

- 继续显式、等待完成的服务组合，不挂载上游 Desktop/Web/CLI app profile。已有 `ctx.agents.create` 路径仍有效，不依赖移除的 `ctx.agent`/Inbox 构造。
- persona 拆分为 prefix/suffix，通过导出的 `PERSONA_PREFIX_SECTION` 在精确 Agent scope 设置。模型请求的系统提示位于 `messages` 的 system role，不再读取移除的 `GenerateOptions.system`。
- 只有 `isAppendSurfaceEvent` 的 assistant/message、tool/result 可进入用户可见结算或计费。V3 的 replace 是模型上下文变换，不是新回复；不能抹掉用户已看到的文本，也不能将有新 seq 的复制事件再次计费。system/message 永远不投影成回复。
- failed attempt 仍可有可计费 usage；使用该 attempt 最终快照，不累加 live usage。现有 run/event 去重命名空间保持稳定，不因格式升级改写历史键。
- 可选 SessionHandle seam 返回 `{events, eventState:'detached'}`；RPC 读取先克隆/验证，不虚称 shared-frozen。内部预备协议升到 `clawx.dsh-session-store/v3`，生产仍不挂载第二套 native persistence。canonical Conversation Store 和 checkpoint v1 不变。
- 新显式 Host TypeScript 图必须登记 8 个 ClawX 项目的 references/source aliases，不能靠旧隐式聚合，也不通过扩大全局 include 混合 client/host Context。新增精确 `0003-clawx-host-build-graph.patch`。
- 原生模块改为 `@deepseek-ai/node-addon-system`：macOS POSIX flock；Linux static Landlock + glibc flock，移除 musl flock 和其他架构；Windows 仍走原有 Koffi/ACL 路径。CI 调用 `pnpm --dir native/system run build:native`，根 `build:native-system` 的 host-only 快捷方式会漏掉 Landlock，不能使用。
- 新增 `dsh-util-values` 生产 peer；锁补丁仅增加 ClawX importer，不改变上游 packages/snapshots。原 Windows ambient-temp 限制补丁精确保留。

## 验证与发布界限

本地证据保存在被忽略的 `temp/kernel-upgrade-20260912.sKfqWZ/`，不会把临时凭据、用户数据库、node_modules、运行时大包或私钥提交到 Git。

- 干净源码严格应用：OpenClaw 25 个目标；DSH 三份 patch，涉及 5 个上游文件，再物化独立 overlay。均不得有 offset/fuzz。
- OpenClaw 实际隔离 payload：真实 Gateway/ACP、工具及 process polling、权限、取消、重启、7 Channels、拒绝入站、无原生历史检查通过；registry 路径/归属/持久化回读检查通过。
- DSH：完整 Host 编译、13 个文件 / 70 项 overlay 与真实本机 sandbox 回归通过；包括 V3 replacement 去重、失败重试、并行 Run、persona、SessionHandle 冷恢复和无第二套历史。
- DSH 实际独立生产部署闭包启动 2219 ms、RSS 111738880 bytes；实际工具读写、只读拒绝、sandbox/ask 策略、孤立权限请求拒绝、正常退出与无原生历史检查通过。此 payload 尚未签名/封装，不能冒充公证制品。
- 两个实际 macOS arm64 payload 的精确 native 审计通过。许可证审计分别覆盖 OpenClaw 626 个包、DSH 107 个包；保留既有 reciprocal obligations。Discord/WhatsApp 9.4 的 MIT 继承只新增精确版本，不扩大例外范围。
- 最终宿主回归 273 文件 / 2509 项 passed，2 文件 / 6 项既有条件跳过；typecheck、lint（0 errors / 7 existing warnings）、comms replay/compare、Harness CI（19 tests）、task validate/dry-run 与 diff 检查通过。跳过项不是已通过的签名制品证据。
- 本机 12 项聚焦 Electron 回归通过：已有 schema 19 Agent DB 的真实 Node/子进程及两代 Gateway，共享 SQLite 的 OpenClaw → DSH → OpenClaw 会话，Agents / Channels / Cron / Skills / kernel catalog。未跑完整三平台 Electron suite，也未新增用户此前暂缓的安装状态 E2E。
- 将新增 native 闭包、平台门禁与 Windows temp 补丁回归前置到 CI 源码下载之前，单 worker 控制此小组的并行压力；既有运行时测试 deadline、完整矩阵和失败日志保留策略不变。

本地候选验证不是五平台签名制品验收。此前 `+clawx.13` 的 CI / 公证 / COS 成功记录只证明旧包；不会复用为 `+clawx.14` 的证据。提交推送后必须显式 dispatch `kernel-runtime-build.yml` 的 all 矩阵，push 本身不会触发此 workflow。生产推广仍须同 SHA 三平台 E2E、完整单/双内核制品验收及原有正常环境审批；Windows 暂不启用 Authenticode。此任务不手动改写线上 catalog，也不删除旧 COS 对象。

## 主要剩余风险

DSH 仍为 RC；真实 Provider、长上下文、消息平台账号及非本机架构须继续验收。两个内核的上游 schema/插件启动路径都可能产生跨平台特有故障，macOS 本地通过不能替代 Windows/Linux 或 Apple 公证。继续保留严格签名、版本化包名、catalog-last 推广和发布成功后的安全旧包清理，不降低权限或平台闸门。
