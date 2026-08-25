# 多内核 M0 Go/No-Go 记录

日期：2026-08-23

结论：**GO（进入实现阶段，M3 发布运行时仍受供应链与三平台预算门槛约束）**

## 已验证事实

1. OpenClaw 的 managed Conversation Store 使用内存态 `SessionManager`，可以从 ClawX SQLite checkpoint hydrate，并覆盖 prompt、cancel、compact、branch、checkpoint 和进程重启。专用 runtime root 扫描未出现 session、trajectory JSONL 或 `sessions.json`。
2. DeepSeek Harness 的 `SessionPersistence` 是公开、完整的持久化接缝。`@clawx/dsh-session-persistence` 仅调用 ClawX RPC client；上游 12 项 persistence contract、真实 AgentLoop 冷恢复、运行时模型切换、usage、rich ACP tool/reasoning 事件均已通过。
3. DSH 官方 ACP prompt 生命周期覆盖 live cancel 和 permission fail-closed；取消运行不会杀死 runtime。
4. 单一 `ClawXDataService` 在 WAL/FULL/foreign-key 模式下序列化两个受认证 kernel client 的交错写入，验证 stable event 去重、身份拒绝、重启、backup/restore 和 `SQLITE_FULL` fail-closed。
5. 同一个 Conversation 已验证 OpenClaw → DSH → OpenClaw 的 turn-boundary 上下文编译。portable block 可续接；private、secret、revoked 和 other-kernel block 均被统计并排除。
6. 两个独立 stdio process 可同时 ready 和 prompt；`kernelId + generation + conversationId + turnId + runId + eventSeq` 在 host 入口逐帧校验。取消一个 live run 后两个 process 仍可继续响应。

## 不允许退化的实现条件

- SQLite/Blob Store 是新数据的唯一 durable authority；不得引入 JSONL 双写、runtime history fallback 或旧 history 扫描。
- stdout 必须保持协议纯净；诊断只走 stderr/structured logs。
- prompt admission 必须先 durable commit，terminal UI 必须在 terminal transaction 成功后才显示完成。
- runtime checkpoint 必须按 kernel/codec/schema 隔离；portable context 不能包含 private/secret/other-kernel 数据。
- DSH runtime host 必须是单个长生命周期 writer；OpenClaw 与 DSH 进程、generation、重启预算和安装版本必须独立。
- 最终用户安装/更新不得运行 npm、pnpm 或 postinstall。

## M0 证据

- `tests/contract/kernels/openclaw-conversation-store.test.ts`
- `tests/contract/kernels/data-service-spike.test.ts`
- `tests/contract/kernels/concurrent-runtime-spike.test.ts`
- `kernels/deepseek-harness/overlay/packages/session/session-persistence-clawx/tests/`
- `kernels/deepseek-harness/overlay/packages/acp/clawx-rich-events/tests/`
- `docs/zh-CN/architecture/m0-runtime-baseline.json`
- `.github/workflows/multi-kernel-runtime-smoke.yml`
- `docs/zh-CN/architecture/m6-base-package-ab.json`（OpenClaw 拆包后的 A/B 输入树测量与发布测量闸门）

## 仍由后续里程碑关闭的风险

- M3 必须以独立 Node 24、native allowlist、SBOM、签名和 deterministic tar.zst 重新测量最终 runtime closure；M0 的 source/candidate 数字不可用作发布声明。
- 三平台 workflow 已建立；artifact promotion 只有在 macOS、Windows、Linux 的 packaged smoke 全绿后才允许进入 production catalog。
- DeepSeek Harness 当前为 rc 版本；每次 pin 变更都必须重跑 upstream contract、patch regression 和 protocol golden replay。
- Electron `node:sqlite` 的 packaged FTS5/WAL 能力仍需 M2/M3 的真实安装包矩阵继续验证。

若任一后续验证发现无法关闭 native durable history、无法从 canonical context/checkpoint 恢复、或无法稳定提交事件，本结论自动降级为 **NO-GO**，不得用 fallback 绕过。
