# ClawX Kernel Contract v1

状态：冻结（2026-08-23）

适用对象：OpenClaw、DeepSeek Harness，以及未来所有第三方或第一方 ClawX 内核

规范版本：`clawx.kernel/v1`

## 1. 设计目标

Kernel Contract 把“ClawX 产品能力”与“内核原生协议”分开。Renderer、Channels、Cron、Agents、Skills、Usage 和 Conversation history 只依赖本契约，不依赖 OpenClaw Gateway、DeepSeek Harness Cordis、ACP 扩展字段或任何原生存储格式。

本契约的首要不变量：

1. Conversation 是 ClawX 实体，不归属于某个内核。
2. Run 是一次不可变的执行路由快照，必须记录实际内核、内核版本、generation、agent、provider 和 model。
3. ClawX SQLite 是所有 Conversation/Cron/Channel-message/Usage 记录的唯一 durable authority。
4. 内核只能通过版本化、鉴权、作用域受限的 RPC 获得 context snapshot 并提交事件，不能获得数据库路径或执行任意 SQL。
5. 内核原生 transcript、scheduler history 或 message history 只能是进程级可删除缓存，不能用于重启恢复或 UI history fallback。

## 2. 身份模型

所有 ID 是不透明、不可复用的 UTF-8 字符串。ClawX 生成的 durable ID 使用 UUIDv7；内核原生 ID 只能放在 scoped mapping 中。

```text
ConversationId                         kernel-independent
  └─ TurnId                            ordered within Conversation
      └─ RunId                         one execution attempt
          ├─ KernelId                  driver/catalog identity
          ├─ KernelGeneration          one live process generation
          ├─ NativeRunId?              scoped by KernelId + generation
          └─ EventSeq                  strictly increasing within RunId
```

规则：

- `(runId, eventSeq)` 是规范事件唯一键；`nativeEventId` 只能作为同一 Run 内的去重辅助键。
- `NativeSessionId`、`NativeAgentId` 等必须与 `kernelId` 一起存储，禁止成为跨内核主键。
- 同一线性 Conversation 同时最多一个 active Run；并行比较必须创建显式 branch。
- Run 一旦 admission 提交，`kernelId`、runtime version、generation、agent、provider、model 和 context compiler version 不得修改。

## 3. 生命周期

每个内核实例独立执行以下状态机：

```text
not-installed -> installed -> starting -> ready -> stopping -> stopped
                      |          |          |
                      v          v          v
                  incompatible  degraded   failed
```

必需操作：

- `install`、`verify`、`activate`、`rollback`、`repair`、`uninstall`
- `start`、`stop`、`restart`、`health`、`diagnostics`
- 对同一 desired state 的重复操作必须幂等。
- 每次成功 start 都产生新的 monotonic `KernelGeneration`。
- generation 改变后，旧进程的 response/event/permission waiter 必须被拒绝。
- 一个内核失败、更新或卸载不能停止另一个内核，也不能影响离线 Conversation 查询。

## 4. Chat Execution Plane

### 4.1 Admission

ClawX 必须先在一个事务中提交：

- user Turn 与 portable content blocks；
- immutable Run routing snapshot；
- single-active-run lease；
- attachment grants；
- operation/idempotency identity。

事务成功后才允许 dispatch。SQLite 不可写时 fail closed，禁止让内核继续生成一份未记录历史。

### 4.2 Context

内核收到 `KernelContextSnapshotV1`，不得自行读取另一个内核或旧 native transcript。Snapshot 包含：

- 有序 portable user/assistant/tool blocks；
- 当前 workspace、system instructions 和有效 attachment grants；
- token budget、truncation/summary provenance；
- conversation/run/kernel/compiler schema versions。

不得跨内核传递：

- private reasoning/hidden chain-of-thought；
- credential value、environment secret 或 keychain material；
- 已撤销或不属于该 Run 的附件；
- 另一内核的 opaque checkpoint；
- 未经 canonical normalizer 验证的原始协议 payload。

### 4.3 Event envelope

所有运行事件必须使用：

```ts
type KernelEventEnvelopeV1 = {
  protocol: 'clawx.kernel/v1';
  conversationId: string;
  turnId: string;
  runId: string;
  kernelId: string;
  generation: number;
  eventSeq: number;
  emittedAt: string;
  nativeEventId?: string;
  event: unknown;
};
```

事件种类至少覆盖 assistant delta/final、reasoning visibility marker、tool start/progress/result、permission request/resolution、usage、diagnostic、cancel acknowledged 和 terminal outcome。

DataService 必须拒绝身份不匹配、generation 过期、eventSeq 倒退、非法状态转换和跨 Run native ID 重放。重复 stable event 必须幂等。

### 4.4 Terminal commit

assistant final blocks、usage、tool terminal state、Run terminal state 和 lease release 在一个事务提交。只有提交成功后 UI 才显示 `durable-complete`。

### 4.5 Cancel 与权限

- Cancel 针对精确 `runId + kernelId + generation`；不得通过切换选中内核或直接杀整个 runtime 代替正常取消。
- 超时后允许 supervisor 逐级终止 run worker/process tree，但必须记录最终 outcome。
- Permission request 必须携带 Run 身份和稳定 request ID。
- unattended Channel/Cron 默认拒绝需要人工升级的权限。
- generation 变化、Run 终止或窗口退出时，所有 waiter 必须显式取消。

## 5. Control Plane

`KernelDriver` 必须通过 canonical adapters 提供：

- lifecycle/health/diagnostics；
- agents；
- providers/models；
- skills；
- usage event normalization；
- capability negotiation。

Channels 和 Cron 的 ownership 在 ClawX：连接账号、binding、scheduler、admission、delivery attempt 及历史写入都不能下放为内核权威。内核仅执行已经路由的消息或定时 Turn。

能力暂不支持时返回结构化 `unsupported`，不得伪造成功或让 Renderer 分支到原生协议。两个内核的 adapter 必须通过同一 contract test suite。

## 6. Persistence Protocol

Conversation Store RPC 具有独立于 Kernel Contract 的 minor version，但 major 不兼容必须阻止启动。最小操作：

- `context.compile`
- `run.admit`
- `event.appendBatch`
- `tool.commit`
- `permission.commit`
- `run.commitTerminal`
- `checkpoint.get/put`
- `run.cancelRequested`

每个 runtime artifact manifest 必须声明支持的 store protocol range 与 checkpoint codecs。内核卸载不删除 canonical data；checkpoint 只有相同 `kernelId + codec + schemaVersion` 才可恢复。

## 7. 运行时隔离与分发

- 每个内核是独立、只读、按版本安装的 CI artifact，包含固定 Node runtime 和审核补丁。
- 最终用户设备禁止执行 npm/pnpm install 或源码 patch。
- runtime artifact 必须有 SHA-256、文件 manifest、签名、SBOM、THIRD_PARTY_NOTICES 和 build provenance。
- OpenClaw 与 DSH 拥有独立 process tree、stdio/control transport、cache、lock、端口、restart budget 和 generation。
- runtime 目录扫描必须证明 prompt/cancel/compact/branch/restart/cron/channel 后没有 durable native history。

## 8. v1 兼容性

- `protocol: clawx.kernel/v1` 的必填字段、身份和安全语义不可在 v1 内弱化。
- 新的 event/capability 使用可忽略扩展字段；未知 terminal state、visibility 或 permission kind 必须 fail closed。
- 新内核接入至少实现 execution adapter、event normalizer、context adapter、capability manifest；如需私有恢复状态，还需 checkpoint codec。
- 任何必须保留 native durable history 才能工作、不能只从 canonical context 恢复、或不能稳定提交规范事件的内核，不符合 v1。
