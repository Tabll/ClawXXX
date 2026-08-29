# 可选内核运行时受保护发布 Runbook

本文只描述发布操作和证据，不包含任何私钥、证书或密码。架构与信任模型见 [多内核运行时供应链](../architecture/kernel-runtime-supply-chain.md)，公钥轮换/吊销见 [`kernels/trust/README.md`](../../../kernels/trust/README.md)。

## 1. 发布前硬条件

1. 发布提交已经进入将承载生产 GitHub Release 的仓库与受保护分支。`resources/kernels/distribution.json` 当前绑定 `Tabll/ClawXXX` 和 `kernel-runtimes` tag；其他 fork 不得直接执行生产晋级，除非先正式修改、评审并发布自己的 catalog/artifact 镜像配置。
2. `kernel-staging` 与 `kernel-production` 是两个启用 required reviewers、禁止任意分支部署的 GitHub Environments。常规 build 无 production catalog/OSS 写权限；常规 promotion 无 rollback 私钥。
3. 五个 required targets 都可用：macOS arm64/x64、Windows x64、Linux x64/arm64。
4. 许可证负责人已经确认 GPL/LGPL/MPL notices、source-offer/履约地址与目标分发区域。CI 许可证报告通过不等于法务批准。
5. `issued-at`/`expires-at` 落在 catalog key、全部 retained artifact keys 和全部 retained descriptors 的共同有效期内。过期 artifact 必须用精确 identity 显式撤销。

## 2. Protected environment secrets

### `kernel-staging`

| Secret | 用途 |
|---|---|
| `CLAWX_ARTIFACT_SIGNING_KEY_ID` | artifact Ed25519 key id |
| `CLAWX_ARTIFACT_SIGNING_PRIVATE_KEY_B64` | PKCS#8 PEM 的 base64；只签 descriptor |
| `CLAWX_MAC_RUNTIME_CERT_P12_B64` | Developer ID Application 证书 |
| `CLAWX_MAC_RUNTIME_CERT_PASSWORD` | P12 密码 |
| `CLAWX_MAC_RUNTIME_SIGNING_IDENTITY` | 叶到根 runtime 签名 identity |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | `notarytool` 公证 |
| `CLAWX_WINDOWS_SIGNING_CERT_PFX_B64` | Windows Authenticode 证书 |
| `CLAWX_WINDOWS_SIGNING_CERT_PASSWORD` | PFX 密码 |

### `kernel-production`

| Secret | 用途 |
|---|---|
| `CLAWX_CATALOG_SIGNING_KEY_ID` | production catalog Ed25519 key id |
| `CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64` | catalog 私钥；不得与 artifact key 相同 |
| `CLAWX_KERNEL_TRUST_KEYS_B64` | 经评审的 artifact/catalog/rollback 公钥 bundle；必须保留仍在有效 metadata 中使用的旧公钥 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 仅允许写 runtime immutable prefix 与 catalog object |
| `MAC_CERTS` / `MAC_CERTS_PASSWORD` | 宿主 Developer ID Application P12 的 base64 与独立随机密码 |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | 宿主 `electron-builder` 公证；与 staging 使用可独立吊销的 App 专用密码 |

宿主 `release.yml` 还使用 Windows PFX、OSS 与 production trust bundle secrets。GitHub Release 使用 workflow 的短期 `github.token`，不配置长期 PAT。macOS 正式包必须运行 `pnpm run package:mac:release`；它显式加载 `electron-builder.release.yml` 并以 `forceCodeSigning: true` 失败关闭。`pnpm run package:mac` 仅用于普通本地打包，不得替代发布命令或发布证据。

## 3. 构建 staging 完整集合

从生产仓库的目标分支触发，不从未合并 fork 触发：

```bash
gh workflow run kernel-runtime-build.yml \
  --repo Tabll/ClawXXX \
  --ref <protected-branch> \
  -f kernel=all \
  -f artifact-base-url=https://oss.intelli-spectrum.com/kernels
```

记录 run id 与唯一 `head_sha`。只有 `Build signed kernel runtimes` conclusion 为 `success` 才可晋级。该 run 必须产生 10 个 runtime artifact（两个内核 × 五目标）、10 份 clean-machine evidence，以及 5 份同机双真实制品 evidence。任一 matrix cancel/skip/failure 都不是完整集合。

重点归档：

- 每目标 `runtime-artifact-smoke.json`；
- 生产 `KernelPackageManager` 断点续传/验签/安全解包/激活/rescan/uninstall evidence；
- 双制品 distinct PID、单侧 integrity failure/repair、独立卸载与 SQLite 保留 evidence；
- macOS signing + notary submission id、Windows Authenticode、Linux ABI/sandbox 报告；
- SPDX、CycloneDX、THIRD_PARTY_NOTICES、provenance 与 license report。

## 4. 晋级 production catalog

首次发布使用 sequence 1、`bootstrap=true`。脚本会先确认两个 catalog URL 都是 404/410；任一镜像存在 catalog 都会失败：

```bash
gh workflow run kernel-runtime-promote.yml \
  --repo Tabll/ClawXXX \
  --ref <protected-branch> \
  -f staging-run-id=<successful-run-id> \
  -f expected-source-sha=<exact-head-sha> \
  -f sequence=1 \
  -f issued-at=<ISO-8601> \
  -f expires-at=<ISO-8601> \
  -f bootstrap=true \
  -f github-release-tag=kernel-runtimes
```

后续发布使用当前 sequence + 1、`bootstrap=false`。不要提供本地 previous catalog；workflow 必须从全部生产 HTTPS mirrors 解析并验签精确 N−1。需要删除失效条目时，额外传递逗号分隔的完整 identity：

```text
kernelId/artifactVersion/platform-arch
```

例如：

```bash
-f revoke-artifact-identities=openclaw/2026.7.1-2+clawx.6/linux-x64
```

晋级在任何远端写入前验证：staging run/name/conclusion/head SHA、当前 GitHub repository/tag 与 `distribution.json` 绑定、descriptor URL 处于配置的 immutable mirror 根、previous catalog 签名与 sequence、完整五目标集合，以及新 catalog 在 `issuedAt` 和 `expiresAt - 1ms` 的全量有效性。

## 5. 双镜像部分发布恢复

Catalog 是最后写入项，但两个服务无法构成跨云原子事务。若一个镜像已是 sequence N、另一个仍是 N−1（首次发布也可能是 N/absent），不要创建 N+1，也不要手工改 JSON：

1. 使用完全相同的 staging run id、source SHA、sequence、issued-at、expires-at、bootstrap 和 revocation inputs 重新触发 promotion。
2. resolver 只接受可信签名且 sequence 恰为 N 的 ahead catalog；N 与 N−1 各自出现多份时内容必须分别完全一致。
3. 已发布 N 的时间窗和 requested revocations 必须与重试请求相符；本次 staging 的全部 descriptors/archives 必须与 N catalog 精确匹配。
4. workflow 复用该不可变 N catalog，向落后镜像补写并重新执行双 catalog/双 artifact host Range drill。

若两个镜像同 sequence 但内容不同，立即停止常规发布并进入安全事件处理；不得用 `--clobber` 人工选择一边。若两个镜像都已是相同 N，重复运行是只做校验/修复的幂等操作。

## 6. 宿主发布与最终签字

只有 production promotion、线上 Range drill 与法务批准完成后才创建 `v<package.json version>` tag。`release.yml` 会重新运行完整 unit/contract/type/lint/chaos/comms/Harness、macOS/Windows/Linux Electron E2E、production catalog/trust drill，再构建并验证宿主签名包。

最终证据包至少记录：

- staging、promotion、release 三个 run URL/id、head SHA 与 conclusions；
- production catalog sequence、SHA-256、continuity evidence 和两个 catalog validators；
- 10 个 artifact identities/SHA-256 与两个下载 host 的 Range evidence；
- Apple notary ids、Windows signer/thumbprint、Linux runner image/glibc/kernel；
- license/security reviewers、批准时间和适用版本；
- `TODO.md` 中 17 个 `[-]` 项逐项对应的证据链接。

拿到证据后才把相应 TODO 改为 `[x]`。本机测试、fixture 签名、未受保护 fork Actions 或控制面 smoke 不能替代这些项目。
