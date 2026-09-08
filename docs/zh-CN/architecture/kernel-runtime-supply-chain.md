# 内核运行时供应链与 Catalog v1

本文记录 M3 的可执行约束。它是 `multi-kernel-design.md` 第 13、14 节的实现说明，而不是客户端安装说明。

## 1. 冻结输入

每个内核的 `kernels/<kernel>/source.json` 同时固定：上游版本和 commit、补丁基线、`+clawx.N` 修订、lockfile 内容 hash、有序 patch series、overlay manifest、runtime contract 与 Node runtime manifest。任一输入变化都必须更新 hash；已经发布的 `artifactVersion + platform + arch` 永远不能覆盖。

OpenClaw 的上游 Git commit/tag 用于追溯，但其现有 ClawX 补丁修改 npm 发布包中的生成后 `dist/`，所以实际 patch base 是精确 npm tarball。构建器先校验 registry metadata 与固定 SHA-512 SRI，再安全解包、建立干净 Git index，然后执行 `git apply --check --index --whitespace=error-all --verbose`。输出中出现 `offset` 或 `fuzz` 即失败。2026-08-23 的 M3 闸门发现旧 patch 依赖 offset 且漏应用一项配置，现已从 pristine npm 包重新生成并证明可零偏移复现。

DeepSeek Harness 直接以固定 Git commit 为 patch base。ClawX 的 bridge/persistence overlay 只能包含在 `overlay.manifest.json` 中逐文件列出并校验的内容；其新增 workspace importer 由有序 lockfile patch 固定，Windows ambient `%TEMP%` 与私有 per-session temp 的权限边界由第二个源码 patch 收紧并在上游 roots 测试及真实制品 self-test 中验证。CI 在 patch 后再次校验最终 lockfile hash，并以 `--frozen-lockfile` 安装。

## 2. Node 与平台物化

两个内核的每个平台 artifact 都包含自己的最小 Node 24.15.0 目录，不依赖系统 Node、Electron Node 或另一个内核的安装。`kernels/node-runtime.json` 固定五个平台归档的官方 SHA-256 和 Node module ABI 137。CI 只保留 Node executable、LICENSE 与来源描述，探测 `process.versions.node/modules` 后才进入组装。

依赖在目标 OS/architecture runner 上物化。已审计脚本删除其它平台的 native packages/prebuilds，随后 artifact builder 扫描文件 magic 与 native 后缀；不在该内核、该目标 allowlist 中的 native payload 会使构建失败。客户端不运行 npm、pnpm、postinstall、node-gyp 或源代码 patch。

## 3. 可复现 artifact

`build-runtime.mjs` 将 runtime payload 与独立 Node 拷入隔离 staging，拒绝 symlink 和非普通文件，统一目录/文件 mode，并按路径排序生成：

- payload file manifest（逐文件 SHA-256、size、mode）；
- SPDX 2.3 与 CycloneDX 1.6 SBOM；
- runtime-specific THIRD_PARTY_NOTICES；
- test report 与无 native durable history storage report；
- SLSA/in-toto 风格 provenance；
- 内部 artifact manifest，声明 Conversation Store protocol、checkpoint codecs、entrypoints 与 storage authority。

所有时间取固定 `sourceDateEpoch`。tar header、路径顺序、owner/mode 和 Zstandard 参数固定；同一输入产生字节相同的 `tar.zst`。外部 descriptor 记录归档 SHA-256、压缩/解压大小、文件数、Node 来源、全部供应链 hash 与预算，然后用 Ed25519 artifact key 签名。

## 4. 签名、发布与回滚

三种私钥完全分离：

- artifact key 只存在于 `kernel-staging`，签单个平台 descriptor；
- catalog key 只存在于需要人工批准的 `kernel-production`，不会出现在 build job；
- rollback key 离线保存，只签精确的 `fromSequence -> toSequence + catalog digest + expiry` 授权。

正式 key bootstrap 使用 `pnpm kernel:keys`：脚本一次生成三对独立 Ed25519 key，把完整 recovery payload 以 scrypt（固定且受限的参数）派生密钥后用 AES-256-GCM 加密。输入/输出只能位于 Git 已忽略且 owner-only 的 `.clawx-secrets/`，不允许覆盖既有备份，也不允许从命令行参数接收口令。artifact 私钥只导出到 `kernel-staging`，catalog 私钥与三角色公钥 bundle 只导出到 `kernel-production`，rollback 私钥不导出到 GitHub。仓库目录中的加密文件只是 offline-ready 本机副本；只有把密文与恢复口令分别复制到不同离线介质后，才算完成灾备。

客户端严格解析 `catalog.schema.json`，验证 artifact 与 catalog 签名、key purpose/validity/revocation、issue/expiry、唯一 artifact identity 和 HTTPS URL。它持久化最高已接受 sequence；同 sequence 不同内容视为 equivocation，低 sequence 默认拒绝。紧急降级不会降低历史最高 sequence，授权过期后也不能重放。

生产晋级同样维持单调信任链，不接受任意本地“上一版”。首次显式受保护 bootstrap 需要双镜像 404/410；常规 N 从一致、验签通过的 N−1 推进。不可变签名 release record 在上传及目录覆盖前固定精确 N、前驱摘要、accepted CI candidate、活跃制品最大历史目录有效期与退役清单。部分失败只能按该记录恢复 N/N−1 或 N/absent；非首次 N/absent 还要验证 N−1 记录，不能重置序号。镜像同序号分叉、改变重试候选、复用 revision 修改字节均失败关闭。新目录在签发时与到期前一刻均完整验签，有效期不超过任何所含 artifact/key 的期限。

latest-only 目录每内核/目标仅保留最新版，普通退役不写安全 revocation，历史撤销账本则持续继承。被移除包的精确签名 descriptor 进入退役清单；必须等所有引用目录的最大到期时间加 24 小时、当前完整双镜像线上校验通过，才能逐对象核对 SHA-256/size 并删除旧 archive、descriptor 和 checksum。清理不采用 prefix list-delete，不碰本地安装、当前包、宿主包或其他对象。COS 版本控制 Enabled/Suspended 均拒绝自动清理；小体积签名记录/完成收据持续留存。详见 [自动发布与恢复协议](../../../harness/reference/kernel-automatic-release.md)。

轮换采用“预置信任下一把公钥”：在切换 signer 至少一个 app release 前，把新公钥连同旧公钥写入受审 trust store；旧 key 保留到其 metadata 全部过期。具体操作和吊销规则见 `kernels/trust/README.md`。

## 5. CI 权限边界与闸门

`kernel-runtime-build.yml` 在五个平台分别拉取/验证源、严格打补丁、构建、测试、物化 Node/native payload、生成并签 staging artifact。场景报告不能自行写入匿名 `true`：它必须引用一次全绿且无 skip/todo 的 Vitest JSON 报告、记录报告 SHA-256，并包含七个共享 Conversation/Data/Channel/Cron 契约套件及当前内核的专属套件。归档前的空目录扫描只证明构建阶段没有意外历史文件，不冒充真实运行时执行。

第二个全新 job 下载该 artifact，执行安全解包、逐文件校验、artifact identity initialize、health、cold-ready 与 RSS budget smoke，并实际启动对应的 managed OpenClaw 入口或 DSH host self-test。真实进程使用隔离的 state/config/cache root，退出后单独扫描其产生的路径；结果保存为逐内核、逐目标的 `runtime-artifact-smoke.json`。构建 job 只额外输出由本次 artifact 私钥推导的、仅有 `artifact` purpose 的公钥测试根；它随受保护的 Actions artifact 交给下一 job，不能签 catalog/rollback，也不进入 production publish 集合。

同一 clean-machine job 还把真实 descriptor/archive 交给生产 `KernelPackageManager`：先注入一次截断传输，再验证精确 `Range`/`If-Range` 续传、catalog 与 artifact 验签、安全解包、控制桥 smoke、原子激活、integrity rescan、卸载及统一 SQLite 数据保留。随后构建共享 Renderer，运行双内核 Chat、Catalog、Agents、Channels、Cron、Skills Electron E2E 与 comms replay；这些 UI 测试证明共享宿主契约，真实制品安装/入口由同 job 的 artifact tests 证明，两类证据不互相冒充。

当一次 staging run 同时构建两个内核时，第三个五目标 job 会在同一干净环境安装两份真实签名 artifact，并发启动两个控制桥，验证进程身份互不相同；再向 OpenClaw 安装注入完整性故障、从不可变缓存 repair，同时确认 DSH 继续健康，最后逐个卸载并证明同一 SQLite Conversation 仍存在。这是实际制品的并发/故障隔离证据；无模型密钥的 CI 控制面 smoke 不冒充真实付费模型对话，Chat 语义仍由共享 contract/E2E 证明。

`kernel-runtime-promote.yml` 在完整可信 runtime build 与同 SHA 三平台 E2E 成功后自动排队受保护审批；只消费已批准的 staging bytes，发布器 checkout 与 artifact source SHA 分开验证，审批后复验 run/attempt/artifact digest 与当前冻结输入。不重新构建或修改已公证 payload。策略读取启用内核和共用 required matrix，未知/缺失目标失败关闭。腾讯 COS `aq-pub-1252262977/clawxxx/kernels` 和 GitHub `kernel-runtimes` 保存相同版本化文件，后者不占用宿主 latest release。所有槽位的双镜像 Range/If-Range、强稳定 ETag 和签名大小验证后才替换 catalog，并在删除旧包前复验两个精确目录。默认目录 7 天有效，剩余 48 小时由每日受保护维护续期；审批不会被自动绕过，descriptor/key 到期仍需新审核版本或换钥。

仓库使用固定腾讯官方 Node SDK；上传器验证 bucket/region/versioning、限定 object key、public-read、SHA-256 metadata 与不可覆盖策略。`release.yml` 在宿主打包前仍重跑完整 unit/contract/type/lint/chaos/comms/Harness、三平台 Electron E2E 与线上双镜像 Range。远端实际证据与本地测试分开记录，不以自动触发代替成功验收。

受保护环境 secrets、首次/后续晋级命令、双镜像部分写入恢复和最终证据归档见 [可选内核运行时受保护发布 Runbook](../operations/kernel-runtime-release-runbook.md)。

## 6. 客户端不可变包生命周期

M4 的 `electron/kernels/package-manager/` 消费本章产物，不执行 npm/pnpm/postinstall、编译或补丁。Catalog 与 artifact 分别验签；兼容性在下载前检查 host version、三类协议、capability contract、平台、架构和固定 Node module ABI。Catalog 最高 sequence、已验证缓存、current/LKG、版本状态与 activation history 都由 DataService 写入 SQLite。

下载使用 artifact SHA 命名，支持 strong ETag + Range 续传；partial identity 不一致、服务器忽略 Range、ETag 改变或镜像切换时会从零开始。Electron 网络栈继承应用代理，中国区镜像只替换 base URL，不能替换签名 descriptor。磁盘预检保留下载余量、解包空间、staging margin 和 rollback reserve。

安全解包先扫描、后提取并再次核验，拒绝 traversal、链接、设备项、路径碰撞与 decompression/file-count/size bomb。内部 manifest、逐文件清单、SBOM/notices/provenance/test/storage report hash 和 entrypoints 全部吻合后才 smoke。失败版本进入 quarantine；成功版本通过同卷 rename 进入不可覆盖版本目录，再以 SQLite compare-and-swap 原子更新 current/LKG。卸载只移动 runtime 到 trash 并保留统一数据；离线导入也必须通过相同验签、兼容、解包和 smoke 路径。
