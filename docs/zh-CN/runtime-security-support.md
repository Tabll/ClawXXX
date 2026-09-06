# 内核运行时安全、支持与 EOL 策略

自 ClawX 0.6.0 起生效，适用于独立下载的 OpenClaw 与 DeepSeek Harness 运行时。CI 能构建不等于已经公开发布；只有受保护发布环境保留了下述全部证据，制品才可进入生产目录。

## 支持矩阵

| 宿主 | 架构 | 运行时基线 | 状态 |
| --- | --- | --- | --- |
| macOS 13.5+ | arm64、x64 | Hardened Runtime、Developer ID 签名、Apple 公证 | 必须 |
| Windows 10 / Server 2016+ | x64 | Ed25519 制品签名；Authenticode 暂缓 | 必须 |
| Ubuntu 24.04 或兼容 glibc 发行版 | x64、arm64 | glibc >= 2.39、kernel >= 6.8、sandbox smoke | 必须 |
| Linux musl/Alpine | — | 不满足 glibc 运行时契约 | 不支持 |
| Windows arm64 | — | 无首发运行时制品 | 延期 |
| Linux arm64 RPM | arm64 | tar.zst 与 deb 仍支持 | 延期 |

主程序可能可以在更宽的系统范围离线浏览数据，但可选内核的安装与启动只支持上表。每个内核必须同时产出 Darwin arm64/x64、Windows x64、Linux arm64/x64 五个目标。

## 发布与供应链闸门

1. Source manifest 固定上游 commit 或 npm integrity、lockfile、补丁序列、overlay manifest、Node 分发包和可复现时间戳。
2. 受保护 CI 构建逐平台 payload；终端用户机器绝不执行 npm/pnpm 安装内核。
3. 精确 payload 必须通过领域契约、无原生 history 扫描、许可证审计、平台签名检查，并生成 SPDX、CycloneDX 与 provenance。
4. macOS 所有 Mach-O 叶子优先签名，完整 closure 的公证结果必须为 `Accepted`；Windows 明确选择 `artifact-signature-only` 时暂缓 Authenticode，并在哈希绑定的平台报告记录 `authenticode: false`、`status: deferred`，否则必须验证 Authenticode；Linux 固化并复验 ABI/支持基线。签名失败不能自动转入暂缓模式。
5. Ed25519 artifact key 签不可变 descriptor；独立 Ed25519 catalog key 签单调递增且有期限的生产 catalog。晋级不会重建已批准制品。
6. 两内核、五目标完整集合通过校验后，先把不可变制品发布到腾讯 COS 和 GitHub，最后发布签名 catalog。
7. 发布后演练要求两个入口提供完全相同的签名 catalog、正确条件缓存及两个独立支持 Range 的制品主机；失败即停止晋级。

每个制品包含源码/补丁身份、archive SHA-256、storage authority、测试/许可证/平台安全报告哈希、SBOM 与 provenance。宿主在激活前拒绝过期、撤销、降级、不兼容、非 HTTPS、超预算、路径穿越、符号链接或签名错误的输入。

## 签名密钥轮换与撤销 Runbook

Artifact、catalog 私钥和离线 rollback 私钥只存在于受保护 CI 环境或批准的离线签名系统；不得提交代码库、放入制品、写入日志或复制进用户目录。主安装包中的公钥信任根由受保护 secret 生成。

常规轮换：

1. 离线生成新 Ed25519 密钥并分配新的 production key ID。
2. 先发布同时包含旧、新公钥的宿主版本；每个根必须声明 purpose、`notBefore`、`notAfter`。
3. 至少重叠一个受支持宿主版本，并保证所有尚在有效期的 catalog/artifact 都能被受支持宿主中的非撤销根验证。
4. 新 descriptor/catalog 改用新私钥；生产分发演练通过后停用旧私钥。
5. 只有旧验证窗口结束后才让旧根过期；有效 metadata 或受支持 rollback 仍依赖时不得删除根。

紧急撤销：

1. 冻结 catalog 晋级并保留日志与证据。
2. 给泄漏公钥设置 `revokedAt`，在 catalog revocations 中列出受影响 descriptor 身份，并用未受影响的 catalog 或离线 rollback key 签名。
3. 向两个镜像发布更高 sequence、短期限的恢复 catalog；不得复用 sequence 或覆盖不可变制品。
4. 如果已无未受影响在线 key，发布宿主 trust-store 更新；此前客户端保持 fail closed。
5. 从受审源码重建并提升 patch/artifact version；不得把受污染字节改名或重签冒充新版本。
6. 在发行说明与事故记录中写明范围、受影响版本、替代版本和用户动作。

Rollback key 不参与日常发布，只离线保存并具有 `rollback` purpose；它只能授权明确的应急 catalog/rollback 路径，不能绕过宿主兼容、撤销、digest、平台签名或 storage-authority 检查。

## 平台签名与应用更新

受保护 macOS 发布 CI 对 ClawX app 执行严格 `codesign`、Gatekeeper assessment 和 stapled ticket 校验。独立 Node 运行时只有确需 JIT/unsigned executable memory 的二进制获得专用 entitlements，普通 payload 不继承。

可选内核的工具/插件是独立 Mach-O，并非 `.app`：逐个使用 `codesign --verify --strict --check-notarization -R=notarized` 强制验证。它们不能附加 app staple ticket，此检查需要在线获取 Apple 票据；不能对裸 Node 工具套用 `.app` 的 `spctl --type execute`，也不能把它描述为宿主 App 已通过完整 Gatekeeper 测试。参见 [Apple 测试指引](https://developer.apple.com/forums/thread/130560)。

受保护 Windows CI 在 electron-builder 打包阶段签名，而不是只重签 NSIS 外壳，从而覆盖安装后的程序与安装器并启用 electron-updater 发布者校验。Packaged smoke 覆盖安装、带进程树/文件锁的更新、签名、卸载和用户数据保留；alpha、beta、stable 使用同一闸门。

## 兼容、更新、回滚与 EOL

- 通过 `minHostVersion`/`maxHostVersion`、协议版本、bridge identity、平台、架构和 mandatory capabilities 强制兼容。
- OpenClaw 与 DSH 独立版本化；更新一个不得停止、替换或回滚另一个。
- Package Manager 保留当前与上一个验证版本；激活原子化，健康检查失败回滚，Repair 重新验证或下载不可变字节。
- Catalog 条目未过期/撤销且宿主线仍受支持时，该运行时受支持。宿主支持期内至少保留当前及前一个兼容版本用于回滚。
- 安全撤销可立即 EOL；普通 EOL 在未来 catalog 移除前通过发行说明预告。Catalog 移除不会删除已安装字节或 canonical 用户数据。
- DSH 上游仍为 prerelease；ClawX 只支持 descriptor 指定的精确补丁版，不支持任意上游 build。

## 许可证发布批准

自动许可证审计是工程闸门，不是法律意见。OpenClaw 公开晋级还必须完成记录的全部 GPL/LGPL 对应源码、可替换/重链接和 MPL 覆盖源码义务；`libsignal` 是强制法务发布检查点。无许可证的 QQ 二维码连接器不随运行时分发，AppID/AppSecret 手动配置仍可用。

## 证据归属

`kernel-runtime-build.yml` 生成逐目标证据，把每个真实制品送入生产 Package Manager 安装链路，并在独立 job 验证同机双制品并发与故障隔离；`kernel-runtime-promote.yml` 校验并发布完整集合。`release.yml` 在打包前重跑完整 unit/contract/type/lint/chaos/comms/Harness、三平台 Electron E2E 与线上双镜像 Range 演练，`win-build-test.yml` 保留聚焦的签名安装器验证。受保护环境审批、签名/公证日志、catalog sequence、制品 hash、分发演练和法务批准都需随 release 保留；本机测试不能替代这些记录。
