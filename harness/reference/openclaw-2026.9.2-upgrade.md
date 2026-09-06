# OpenClaw 2026.9.2：生产桥接修复与版本切换

更新：2026-09-06。仓库开发依赖、补丁、源码描述符和 CI 运行时定义已切换为 **2026.9.2+clawx.7**。这不是已发布声明：用户已安装的不可变运行时和在线 catalog 未被修改，签名、公证、五平台 clean-machine 与发布演练仍须通过。

任务：harness/specs/tasks/upgrade-openclaw-2026-9-2.md；逐项状态：TODO M19。本文件是架构参考，不可作为 Harness task 运行。

## 冻结输入

| 输入 | 身份 |
| --- | --- |
| 官方稳定版 | [v2026.9.2](https://github.com/openclaw/openclaw/releases/tag/v2026.9.2)，发布于 2026-09-05T20:00:07Z；审查时 npm latest 一致 |
| commit | 3928bad9badfcb6c7d140530435e806fb8092190 |
| 已验证签名 tag object | 87d32a44ab9744903d36a33b399c26cfc2b078d6 |
| npm | openclaw@2026.9.2 |
| SHA-512 | sha512-M6C7UsnX815nv26qBJFYGe6aGzv+ftZLRzV6S9oRXUtXg2Yn67eVntpssT94kgkquKVSeUxerUg0j1ONp4WYQg== |
| runtime | 2026.9.2+clawx.7，patch revision 7 |
| Node | 冻结 24.15.0；上游要求 >=22.22.3 <23 或 >=24.15.0 <25 或 >=25.9.0；本机系统 Node 25.8.1 不满足 |
| ACP SDK | @agentclientprotocol/sdk@1.4.0，含实际 session/close 客户端方法 |

最终 patch/lock/runtime/overlay 字节摘要由 kernels/openclaw/source.json 和 lock.json 记录；kernel:sources:verify 必须通过。July patch 保留作为审查档案，不再注册进 pnpm 或 patch series。此前未提交的 DSH 0.1.3-alpha.1+clawx.11 与许可证工作保留。

## 1. 接到生产 ACP/Gateway 的存储边界

原先的真实 ACP 探针在 July 和未修补 September 上均发现 acp_replay_sessions=1 / acp_replay_events=2。这是存量生产桥接缺口，不只是新版回归；之前绿色的 SDK adapter / host fixture 不能作为其修复证据。

现在生产路径是：

~~~text
ClawX SQLite canonical Conversation / Run
  → Context Compiler：有角色、turn、顺序和可见性的 portable blocks
  → Main OpenClaw ACP adapter：每个 Run 创建全新临时 session
  → session/new(_meta.clawx) → Gateway incognito session
  → clawx.session.hydrate：校验身份后注入历史，且只能注入一次
  → session/prompt：只发送本轮 user 内容与授权附件
  → live answer / tool / approval / usage → ClawX SQLite
  → session/close → sessions.delete：释放原生内存状态
~~~

- session key 绑定 agent 与 SHA-256([conversationId, runId, generation])；原生会话不能跨 Run 复用。native session/load / replay 不作恢复入口。
- _meta.clawx 使用 clawx.openclaw-session/v1，校验协议、身份、incognito 与原生 session ID；禁止重复当前 turn、重复 hydrate、重复 turn position、私有/秘密/撤销内容和不便携的跨内核内容。
- prior user/assistant 保留角色；孤立或跨内核 tool call/result 仅为历史文本，不重放成可执行工具。历史附件仅有授权引用，不读取原生附件路径。
- ACP replay ledger 改为内存；Gateway 使用真正的 incognito Agent/SessionManager。SDK spike 的 OpenClawConversationStore 保留为兼容性测试，不再声称它就是生产连接。
- 原生 SQLite 历史表在连接上安装 TEMP trigger，阻止 INSERT/UPDATE/DELETE；不改旧记录、持久 schema、配置或凭据。传输回执、组件句柄与审批状态使用带原始 PK/CHECK 的空 TEMP 表，temp_store=MEMORY，不从旧表复制正文。
- 原生 Cron 启动、任务写入、主动运行、自动日程校正，以及心跳、dreaming、自主跨 agent/session 执行被限制。共享 UI 的 Cron/Channels/Agents/Skills 仍由 ClawX canonical 服务管理，并非关闭这些功能。
- Main 移除运行后 purge 历史作为防线的用法，改为断言。不要删除 combined SQLite 伪造隔离，也不要读取其中历史恢复对话。
- Gateway 崩溃时当前 Run 明确失败/中断，不借 durable autorecovery 隐式续跑。下一 generation 从 canonical portable context 重建；分支由 canonical context 编译决定。
- OpenClaw 生产恢复输入是 canonical blocks，不使用原生 opaque checkpoint。运行内自动压缩仍在临时 manager 内；SDK checkpoint/branch/compact 合约测试与完整长上下文运行验收必须区分，后者仍列为发布前测试。

取消确认不等于完成：宿主等待 prompt 结束、最终 usage 和附件/会话清理后才发送 terminal。cleanup 失败不能报 completed；晚到事件因 Run/session/generation 映射失效而丢弃。

## 2. 配置与权限

electron/gateway/config-projection.ts 位于 Main-owned coordinator 边界，Renderer 和 canonical API 不分叉。

- 新版 agents.entries 投影成现有 host agents.list；defaults.systemAgent.agentId 对应默认 Agent。写回只使用修改后的 list，不能合并已删除的旧 entries。
- 保留 Provider、Channel account、凭据占位/引用、workspace 和未知字段；非法/重复 Agent ID、多个默认 Agent、空 roster、冲突格式均拒绝。
- CAS 冲突取新快照并重放纯 mutator；响应丢失按同一投影比较已落盘快照。回归覆盖并发更新后的 Provider/Channel 凭据不丢失。
- 新版显式 ownership=explicit、session visibility=self、禁用 agent-to-agent/swarm/elevated/native scheduler，保留原 deny 项。旧 tools.exec.security=deny / 新 mode=deny 均保留为 mode=deny，并加入独立 exec/process tool deny，防止新版 session permission 覆盖旧禁令；其余执行配置收敛到审批模式，本轮权限仍由 canonical run 控制。
- ACP 使用实际 sessions.create/patch 与 ClawX 扩展 clawx_model / clawx_permission_mode；default/ask/deny 对应 workspace/guarded/read-only，未知权限报错。
- 启动前校验已验证 payload 的 clawx.managedSessionProtocol 与 storage fence 版本。旧包须下载新制品，不在用户目录现打补丁，也不让旧内核先改写新版配置。

详见 harness/reference/openclaw-config-delivery.md。

## 3. Channels 兼容修复

| 插件 | 冻结版本与修复 |
| --- | --- |
| Discord | @openclaw/discord@2026.9.2；补齐 binding approval parser 的 SDK 兼容导出 |
| WhatsApp | @openclaw/whatsapp@2026.9.2；登录及 Relay 使用 baileys@7.0.0-rc14 的 ESM 加载，按实际 runtime 路径缓存 |
| QQ | @openclaw/qqbot@2026.7.1；保留 AppID/secret 路径，未分发未授权 QR 附加包 |
| 钉钉 | @soimy/dingtalk@3.6.10；补齐 text-runtime；managed namespace 消息/卡片缓存改为进程内，最多 1024 项 / 32 MiB，不读旧 JSON |
| 飞书/Lark | @larksuite/openclaw-lark@2026.7.16；修复发布包 CJS/ESM metadata、失效 entry、两处 CJS import.meta；补齐 legacy core/channel-runtime SDK |
| 企业微信 | @wecom/wecom-openclaw-plugin@2026.8.17；保留 Main-owned manifest/安装身份修复和经验证 peer link |
| 微信 | @tencent-weixin/openclaw-weixin@2.4.8；补齐 channel-runtime SDK，固定精确版本 |

mirror 的身份包含源路径、版本、源 package metadata mtime 和 active runtime revision。即使 npm version 相同，patch realization/runtime revision 改变也重建镜像；开发模式不能因旧副本存在而跳过新 node_modules。

入站必须先经 canonical admission。before_dispatch 的 message ID/media snapshot 是当前消息权威；缓存按消息隔离，不能从同一 conversation/sender 的其他并发消息借附件。仅 HTTP 202 返回 clawxCanonicalAccepted；拒绝、缺桥接或缺钩子均失败，不回退到原生模型。重复消息由宿主 SQLite admission/delivery identity 去重，不把 connector TEMP receipt 当永久权威。

真实测试执行了 7 个插件注册和 lazy outbound 模块加载、共享 dispatch 成功/拒绝路径；**没有登录真实外部账号，也没有发送外部消息**。实际账号 QR/媒体/平台网络行为仍需发布前验收。

## 4. 旧 14-target 补丁的语义处置

| July 目标组 | September 处置与证据 |
| --- | --- |
| acp-cli-* usage/tool replay、订阅和 grace | 重基至 server-zrB9dRww.js，订阅 sessions.messages 并接收 agent/session.tool。managed 不重放 transcript，UI timeline 由 canonical SQLite 重建。fresh one-shot Run 替代 accepted-prompt/native-replay grace；真实 prompt/tool/cancel/crash 测试覆盖。 |
| agent-* / agent-events-* / main-session-restart-recovery-* | managed durable restart lineage 经测试替换为中断当前 Run、新 generation canonical hydrate，不覆盖新版非 managed recovery。真实 SIGKILL/restart 验证角色和恰好一次历史。 |
| agent-tools-* / bash-tools-* / exec-approval-* | 使用上游已实现的 session/run/tool identity；实际编译 approval builder VM 测试和真实 guarded exec/tool timeline 覆盖，不再用旧参数覆盖 trusted owner。 |
| exec-approvals-*.d.ts / schema-*.js / schema-*.d.ts | 旧 lineage 类型补丁随 managed recovery 替换退役，采用新版真实 request/schema，临时审批表保留原约束；native approval replay 不是 ClawX 授权来源。 |
| server-chat-* | 重基 clawx_usage 到 ACP 流；费用只接受 provider-billed，不将配置估值/SDK 默认零费用当实际扣费；event key 绑定 Run/attempt/sequence。 |
| session-lifecycle-state-* / store-* | durable owner/replay 扩展由 per-Run incognito、单次 hydrate/prompt、真实 close/delete、宿主 generation fencing 替代；回归覆盖排队、取消、晚到事件、清理失败。 |
| cron-tool-* / 相关 schema | 重定位非空字符串 grammar-safe 正则与 repetition bound，保留语义测试；不启用 native scheduler。 |

打包补丁也重定位了 PTY windowsHide 与 Windows 禁用 PTY 的入口，保留新版终端名/环境准备逻辑；找不到精确语义锚点必须报错。新增 dist 文件加入 postinstall-inventory.json，避免首次启动被上游生命周期清理器移除。

## 5. 制品与验收

- 干净官方 npm patch base 的严格 patch series / overlay 准备通过，不允许 fuzz/offset。独立 Node 24 和实际打包 payload 执行 Gateway/ACP/loopback Provider probe。
- 新 native families/ABI 已进入精确 allowlist；裁剪递归覆盖嵌套 node_modules、TUI/Bare prebuilds、fs-safe/CUA/UniFFI/企业微信 CLI，排除非目标平台/CPU和 Linux musl。macOS arm64 本地闭包已验证；其他平台须由对应 runner 实测。
- 许可证元数据审计保留复合 AND 声明，新增 UniFFI/CUA MPL 源码义务。机器审计不是法务批准，不能绕开既有发布门禁。
- CI 在签名/归档前启动真实 payload probe；clean-machine 在解包后重跑，并在首次执行后重验 sealed 文件清单。仅 --version/control ready 不足以证明真实执行。
- 已测真实路径：历史角色、模型配置、scoped tool approval、工具结果、cancel、强制进程中断、新 generation hydrate、7 个 Channel 模块、成功/拒绝 admission、provider usage 与无 native history。Provider 是本机可控 fixture，不是真实付费 Provider。
- host 单元/契约、typecheck、lint、comms、共享 UI E2E、Harness 和最终摘要结果见 TODO M19；生成的本地报告位于忽略的 temp/reports/。

可复现命令：

~~~sh
pnpm run kernel:sources:verify
node scripts/kernel-runtime/download-npm-source.mjs --kernel openclaw --destination temp/kernel-source
node scripts/kernel-runtime/prepare-source.mjs --kernel openclaw --checkout temp/kernel-source
pnpm exec zx scripts/bundle-openclaw.mjs
pnpm exec zx scripts/bundle-openclaw-plugins.mjs
node scripts/kernel-runtime/materialize-overlay.mjs --kernel openclaw --payload build/openclaw
node scripts/kernel-runtime/materialize-openclaw-plugins.mjs --payload build/openclaw
node scripts/kernel-runtime/probe-openclaw-managed-runtime.mjs \
  --package-dir build/openclaw --node /absolute/verified-node-24/bin/node \
  --plugins-root build/openclaw/clawx-plugins --report temp/reports/openclaw-managed-runtime.json
~~~

构建命令本身也须使用满足上游要求的 Node；不能重复对已应用 patch 的目录 prepare。

仍未执行：五目标真实制品与双内核 clean-machine、真实 Provider 长上下文/自动压缩与异常重试、真实 Channels 登录/收发、macOS 签名公证、COS/GitHub 发布与 Range 演练。本轮没有提交/推送，也未改写用户正在使用的内核或历史。
