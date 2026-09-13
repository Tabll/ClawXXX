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
- 初次宿主回归 273 文件 / 2509 项 passed；首轮 CI 环境修复后全量重跑为 2512 passed，2 文件 / 6 项既有条件跳过。typecheck、lint（0 errors / 7 existing warnings）、comms replay/compare、Harness CI（19 tests）、task validate/dry-run 与 diff 检查通过。跳过项不是已通过的签名制品证据。
- 本机 12 项聚焦 Electron 回归通过：已有 schema 19 Agent DB 的真实 Node/子进程及两代 Gateway，共享 SQLite 的 OpenClaw → DSH → OpenClaw 会话，Agents / Channels / Cron / Skills / kernel catalog。未跑完整三平台 Electron suite，也未新增用户此前暂缓的安装状态 E2E。
- 将新增 native 闭包、平台门禁与 Windows temp 补丁回归前置到 CI 源码下载之前，单 worker 控制此小组的并行压力；既有运行时测试 deadline、完整矩阵和失败日志保留策略不变。

本地候选验证不是五平台签名制品验收。此前 `+clawx.13` 的 CI / 公证 / COS 成功记录只证明旧包；不会复用为 `+clawx.14` 的证据。提交推送后必须显式 dispatch `kernel-runtime-build.yml` 的 all 矩阵，push 本身不会触发此 workflow。生产推广仍须同 SHA 三平台 E2E、完整单/双内核制品验收及原有正常环境审批；Windows 暂不启用 Authenticode。此任务不手动改写线上 catalog，也不删除旧 COS 对象。

## 首次远端构建记录

- 代码提交：[`298c4ae152c1e2b816d05b8834738dcab346dbfc`](https://github.com/Tabll/ClawXXX/commit/298c4ae152c1e2b816d05b8834738dcab346dbfc)，已推送至 `Tabll/ClawXXX/main`。
- [Build signed kernel runtimes #22](https://github.com/Tabll/ClawXXX/actions/runs/34682771896)：2026-09-12 16:14（UTC+8）显式 dispatch；`kernel=all`，两内核 × 五平台；COS staging prefix 与 `artifact-signature-only` 策略保持原值。
- [同 SHA Electron E2E](https://github.com/Tabll/ClawXXX/actions/runs/34682752346)：由上述 push 自动触发，覆盖 Linux/macOS/Windows。
- 16:16 使用正常 Review deployments → Approve and deploy 批准 `kernel-staging`；10 个 build job 随后开始执行，没有使用 Start all waiting jobs 旁路。
- 本记录创建时两条 workflow 仍在运行，公证、完整单/双内核安装、同 SHA E2E 以及受保护生产推广尚未验收。后续仅补充此记录的文档提交不改变 #22 绑定的代码 SHA，不重复启动整套内核矩阵。
- #22 的两个 Windows job 在前置 `kernel-platform-security` 测试发现旧断言使用 `split('/')`，把 Windows 的绝对路径误当 basename；Mach-O 检测本身正确，其他 40 项前置测试通过。修复为比较由 `path.join` 构造的精确绝对路径，并用 finally 清理 fixture；不关闭 Windows 门禁或修改生产扫描器。此测试修复需新提交和新一轮完整构建，#22 的失败不以重跑旧 SHA 冒充已修复。
- 同 SHA Linux E2E 的真实 Node fixture 仅传 DISPLAY、漏传 xvfb-run 的 XAUTHORITY，隔离 HOME 后无法认证 X server（147 passed，唯一失败为该真实启动测试）。将 OS 环境 allowlist 提取为纯函数，保留 DISPLAY＋XAUTHORITY，新增 Linux 认证路径、Windows 原生变量和空环境回归，同时验证不继承用户 home、provider secrets 或 Node/Electron 注入参数。不禁用 X 认证，不跳过真实 Gateway 回归。
- 上述两项环境修复后：53 focused 与 2512 全量宿主测试通过；本机真实 Electron 已有 DB 两代 Gateway 重跑通过（10.6 s），typecheck/lint/comms 与 task validate/dry-run 通过。Windows/Linux 真实结果必须由修复后新 SHA 的 CI 给出。

## #23：Windows Koffi 运行时闭包修复

- [`afa726dc` 的 #23 构建](https://github.com/Tabll/ClawXXX/actions/runs/34683254264) 已结束：9/10 build job 通过，仅 OpenClaw Windows 在真实 Gateway 启动时失败；4 个 macOS 构建均完成签名及 Accepted 公证。依赖全矩阵的单/双内核 clean-machine 验收被跳过，不能宣称本轮制品已完成验收。
- [同 SHA 三平台 Electron E2E #42](https://github.com/Tabll/ClawXXX/actions/runs/34683159764) 全部通过，证明此前 Windows 路径断言与 Linux XAUTHORITY 修复已获远端验证。[推广 #15](https://github.com/Tabll/ClawXXX/actions/runs/34684509999) 的只读准入结果为 `eligible:false`，publish job 被跳过；workflow 的绿色不代表新包已上传生产 COS。
- [Windows 失败 job](https://github.com/Tabll/ClawXXX/actions/runs/34683254264/job/103525637777) 的原始异常为 `Cannot find module './src/koffi/index.cjs'`，Node 24.20.0 / exit 1。旧 bundler 把 `node_modules/koffi/src` 当作源码垃圾整目录删除；冻结的 Koffi 3.1.6 根入口却依赖 `src/koffi/index.cjs`，后者还依赖 `src/koffi/src/static.cjs`。SQLite 外层附带的 cache/disk 建议不是本次缺模块的根因。
- 将现有清理函数无副作用提取到 `scripts/openclaw-bundle-cleanup.mjs`，正式 bundler 与测试调用同一实现。只撤销 Koffi `src` 的整目录删除，完整保留上游运行时树；其 vendor/doc、其他既有垃圾清理和精确目标原生裁剪保持不变，不引入源码构建或任意 native allowlist。
- 新回归复制当前锁定的真实 Koffi 和本机 native 包，经过正式清理及平台裁剪后，通过新的独立 Node 探针加载 CJS/ESM、各调用一次系统进程 ID 函数。缺 CJS/ESM/嵌套 loader、缺 native、开发者 JS/native ancestor 回退必须失败；测试只改自己的临时目录。
- 五目标 OpenClaw CI 在独立 Node 下载后、公证签名前执行同一探针；真实签名制品解压后的 smoke 再执行并记录证据。原有完整 Gateway/ACP/7 Channels、规范存储、单/双内核安装和生产审批不减少，Windows 仍是 artifact-signature-only。
- 本次只是修复尚未发布的 `+clawx.14` 候选打包代码，冻结源码/补丁/Node 及制品版本不变；不覆盖已经发布的 immutable bytes。重新提交后必须 dispatch 新 SHA 的 all 矩阵，不能重跑 #23 旧代码来代替。
- 已复核 README 英/中/日/俄：现有候选版本、用户操作和升级文档入口仍准确。本次无 UI、用户流程或 API 变化，详细构建修复与验收状态记在本文，不新增用户此前暂缓的安装状态 E2E。
- 本轮本地结果：新增 9 项回归，59 项 focused 与全量 274 文件 / 2521 项通过，2 文件 / 6 项既有条件跳过；typecheck、lint（0 errors / 7 existing warnings）、来源摘要、comms replay/compare、Harness CI 19 项、task validate/dry-run 通过。新生成的隔离完整包位于被忽略的 `temp/kernel-koffi-fix-20260912.2hd679/`：Node 24.20.0 的 Koffi CJS/ESM/两次 native PID 调用、registry、完整 Gateway/ACP/工具/取消/两代重启/7 Channels/入站拒绝/无原生历史均通过；精确 native 审计及 626 包许可证审计通过。Gateway 首次在沙箱中被 loopback `listen EPERM` 拦截，获准在沙箱外以同一隔离数据重跑成功；未改动现有用户数据。这些 macOS arm64 本地结果仍不是 Windows、签名制品或远端完整矩阵已通过的证据。

## #24：Cron 同步与逐脚本语法校验修复（2026-09-13）

- [`8e33ab0c` 的完整构建 #24](https://github.com/Tabll/ClawXXX/actions/runs/34691870061) 于 2026-09-12 20:03（UTC+8）结束：8/10 build job 通过，DSH 五目标全部成功，OpenClaw 仅 Windows 和 macOS Intel 失败。依赖完整矩阵的单/双内核 clean-machine 验收被跳过；[同 SHA E2E #43](https://github.com/Tabll/ClawXXX/actions/runs/34691820989) 三平台全部通过。[推广 #17](https://github.com/Tabll/ClawXXX/actions/runs/34692637917) 的只读准入为 `eligible:false, candidate:null`，publish 被跳过，不代表新候选已上传生产 COS。
- [Windows job](https://github.com/Tabll/ClawXXX/actions/runs/34691870061/job/103548437424) 的 Koffi CJS/ESM/native PID、真实 registry/Gateway/ACP/7 Channels 和存储 fence 均已通过，证明上一轮 loader 修复有效。随后 canonical suite 143/144 项通过，失败项在两秒轮询后预期 `timed-out`、读到 `running`。原用例在 `prompts.push` 时就开始等，此时实际 Conversation 准入尚未结束；一秒业务 deadline、取消后的真实终态写入与同一段物理等待混在一起。日志不能证明取消丢失或生产调度器损坏，本机 macOS arm64 原测试也通过，不能声称复现了 Windows 性能故障。
- Cron 测试改为先创建保留真实两秒 watchdog 的事件观察器，再仅控制 `setTimeout/clearTimeout`；Date、规范 SQLite/FULL fsync 和 Router 实际准入继续真实执行。OpenClaw/DSH 各自断言 999 ms 无取消、1000 ms 取消准确的 conversation/turn/run/kernel/generation，收到真实终态写入通知后再读回，并关闭/重开数据库复核 `RUN_TIMEOUT`。手动取消拆成独立双内核测试，保留 `RUN_CANCELLED` 和重开验证。
- 新增双内核延迟终态 fixture：明确卡住 Router 的实际终态写入，推进业务时钟也不能提前把 Cron 写成终态；释放后必须真正写成 `timed-out`。这验证原轮询不能代替持久化完成，不靠放大 timeout 或降级为内存数据库。测试事件观察器捕获成对 timer API，新增回归证明 fake scheduler 时钟不会停掉真实 watchdog。清理释放自有 gate、等待全部工作完成，再关闭 SQLite 并删除准确的自有临时目录；任何清理失败仍使测试失败。
- [macOS Intel job](https://github.com/Tabll/ClawXXX/actions/runs/34691870061/job/103548437503) 在一个包含 23 次顺序 Node 启动的测试中触发默认 5000 ms 上限（5011 ms），没有指出某个脚本 SyntaxError。现在从精确冻结补丁的实际目标清单生成 23 个独立 `node --check` 用例，名称携带实际文件；每个子进程有短于默认测试上限的 4000 ms kill deadline，保留 stdout/stderr、非空/去重与独立 postinstall inventory 断言。不提高默认 timeout、不跳过脚本。
- canonical CI 新增每内核 deadline/terminal-drain 的脱敏阶段 journal，与既有 `temp/reports/*.json*` 一起始终留存；LF/CRLF 两种 workflow 语义测试覆盖此接线。既有早期 closure JSON、Windows 单 file worker、其他平台并发、内部双内核并发、完整 native/签名/公证/单/双安装门禁原样保留。
- 本轮只有测试、日志接线及规则/证据变化，不改变生产调度逻辑、上游/Node/patch/overlay 冻结输入、`+clawx.14` 候选身份、已安装内核或用户数据库。已复核 README 英/中/日/俄：现有候选版本、用户行为和升级证据链接仍准确，无需修改用户操作说明；没有 UI 修改，也不新增此前暂缓的对应 E2E。远端完整验收仍由 `MK-2407` 跟踪。
- 本地验证：49 项初始聚焦、最终全量 274 文件 / 2550 项 passed，2 文件 / 6 项既有条件跳过；typecheck、lint（0 errors / 7 existing warnings）、source verify、comms replay/compare、Harness CI 19 项、task diff-aware validate/dry-run、`git diff --check` 均通过。任务 front matter 按仓库解析器支持的块列表编写。独立 Node 24.20.0 原生执行与 CI 相同的三文件 closure 组 34 项和十九文件 canonical 组 150 项全部通过；后者采用 Windows CI 的单 file worker 策略，但执行平台仍是本机 macOS arm64，不能冒充 Windows 验收。四份 scheduler journal 均有真实持久化后 `passed` 结束记录，JSON 报告保存在被忽略的 `temp/kernel-ci-timing-20260913.qFp2EX/`。推送后须以新 SHA 显式启动 all 矩阵，不能重跑 #24 的旧代码。

## 主要剩余风险

DSH 仍为 RC；真实 Provider、长上下文、消息平台账号及非本机架构须继续验收。两个内核的上游 schema/插件启动路径都可能产生跨平台特有故障，macOS 本地通过不能替代 Windows/Linux 或 Apple 公证。继续保留严格签名、版本化包名、catalog-last 推广和发布成功后的安全旧包清理，不降低权限或平台闸门。
