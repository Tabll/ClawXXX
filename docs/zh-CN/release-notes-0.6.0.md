# ClawX 0.6.0 多内核发行说明

状态：实现候选版本。是否公开发布仍取决于受保护 CI 的五目标运行时晋级和三平台签名安装包闸门。

## 主要变化

- OpenClaw 已从主安装包移出，改为首次使用或用户选择时下载。
- DeepSeek Harness `0.1.2-alpha.2+clawx.9` 成为第二个可选内核；两个内核可并行运行并独立更新、失败或回滚。
- 两个内核完全复用当前 Chat、Providers/Models、Agents、Channels、Cron、Skills、Usage 与 Diagnostics UI 和 canonical contracts。
- 单一 Main-owned SQLite/Blob 服务保存全部新 durable history；同一 Conversation 可在 turn 边界通过脱敏 portable context 切换内核续接。
- 运行时是可复现、可打补丁的 CI 制品，包含有期限签名 metadata、平台安全证据、SBOM、provenance、许可证报告、repair/rollback 与双镜像分发。
- 即使没有安装内核，历史仍可搜索、重命名、导出和删除。

## 有意的兼容性变化

- 0.6.0 从新的 canonical history store 开始。旧 OpenClaw/DSH Conversation 或 Cron 文件不迁移、不扫描、不删除、也不作为 fallback。
- 完整可选内核支持要求 macOS 13.5+、Windows 10 x64 或文档化 Linux 基线；本版不支持 Linux musl/Alpine 与 Windows arm64。
- 无许可证的 QQ 二维码登录依赖不再分发；请使用 AppID/AppSecret 手动配置。
- OpenClaw 与 DSH 版本固定；不支持安装任意上游 package/build。

## 安全与数据说明

SQLite 在 owner-only 用户目录内仍是明文；静态机密性请使用 OS 全盘加密。默认卸载保留 canonical 与旧用户数据。部署前请阅读[运行时安全/支持策略](runtime-security-support.md)与[数据安全/保留策略](data-security-retention.md)。

## 公开发布前必须具备的证据

- 两内核 × 五目标制品通过 clean-machine smoke 与 storage-contract scan；
- 保留 macOS 签名/公证以及 Windows Authenticode/安装/更新/卸载证据；
- 腾讯 COS/GitHub catalog 与 Range 断点续传演练通过；
- 完整 typecheck、lint、unit、Electron E2E、comms、Harness 通过；
- GPL/LGPL/MPL 源码义务与 `libsignal` 法务检查点获批准。
