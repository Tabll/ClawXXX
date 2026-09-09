# 可选内核运行时受保护发布 Runbook

本文只描述发布操作和证据，不包含任何私钥、证书或密码。架构与信任模型见 [多内核运行时供应链](../architecture/kernel-runtime-supply-chain.md)，公钥轮换/吊销见 [`kernels/trust/README.md`](../../../kernels/trust/README.md)。

## 1. 发布前硬条件

1. 发布提交已经进入将承载生产 GitHub Release 的仓库与受保护分支。`resources/kernels/distribution.json` 当前绑定 `Tabll/ClawXXX` 和 `kernel-runtimes` tag；其他 fork 不得直接执行生产晋级，除非先正式修改、评审并发布自己的 catalog/artifact 镜像配置。
2. `kernel-staging` 与 `kernel-production` 是两个启用 required reviewers、禁止任意分支部署的 GitHub Environments。常规 build 无 production catalog/COS 写权限；常规 promotion 无 rollback 私钥。
3. 五个 required targets 都可用：macOS arm64/x64、Windows x64、Linux x64/arm64。
4. 许可证负责人已经确认 GPL/LGPL/MPL notices、source-offer/履约地址与目标分发区域。CI 许可证报告通过不等于法务批准。
5. 发布器自动分配单调 sequence 和默认 7 天目录有效期，并限制在全部所含 descriptor/key 的共同有效期内。普通旧版本退役不等于安全撤销；安全事故仍需独立审核处理。

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

按当前已批准策略，可选内核使用 `artifact-signature-only` 暂缓 Windows Authenticode；Ed25519、Windows 目标完整性/安装验收和哈希绑定的 deferred 平台报告仍强制执行，失败不能自动降级。上面两个 Windows PFX secrets 仅在未来明确启用 Authenticode 后需要；宿主正式签名验收另行处理。

### `kernel-production`

| Secret | 用途 |
|---|---|
| `CLAWX_CATALOG_SIGNING_KEY_ID` | production catalog Ed25519 key id |
| `CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64` | catalog 私钥；不得与 artifact key 相同 |
| `CLAWX_KERNEL_TRUST_KEYS_B64` | 经评审的 artifact/catalog/rollback 公钥 bundle；必须保留仍在有效 metadata 中使用的旧公钥 |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | 仅允许操作 `aq-pub-1252262977/clawxxx/*` 的腾讯 COS 发布对象 |
| `MAC_CERTS` / `MAC_CERTS_PASSWORD` | 宿主 Developer ID Application P12 的 base64 与独立随机密码 |
| `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD` | 宿主 `electron-builder` 公证；与 staging 使用可独立吊销的 App 专用密码 |

宿主 `release.yml` 还使用 Windows PFX、腾讯 COS 与 production trust bundle secrets。GitHub Release 使用 workflow 的短期 `github.token`，不配置长期 PAT。macOS 正式包必须运行 `pnpm run package:mac:release`；它显式加载 `electron-builder.release.yml` 并以 `forceCodeSigning: true` 失败关闭。`pnpm run package:mac` 仅用于普通本地打包，不得替代发布命令或发布证据。

### 密钥 bootstrap 与离线备份

完整 key set 不进入 Git。使用新随机恢复口令（示例只展示环境变量来源，不把值写入 shell history）：

```bash
CLAWX_KEY_BACKUP_PASSPHRASE="$(security find-generic-password -a 'Tabll/ClawXXX' -s 'com.clawx.release.kernel-key-backup.v1' -w)" \
  pnpm kernel:keys generate \
  --output .clawx-secrets/kernel-signing/production-YYYY-MM.enc.json \
  --not-before <ISO-8601> \
  --not-after <ISO-8601> \
  --key-id-suffix YYYY-MM
```

生成后必须执行 `verify`。需要配置 GitHub 时，`export-ci` 可临时生成 mode `0600` 的环境 secret JSON；上传完成立即删除该明文临时文件。rollback 私钥不在其中。密文与恢复口令必须分别复制到不同的离线介质；仅留在同一 Mac 或同一云盘不算离线灾备。轮换时生成新 backup，绝不覆盖旧 backup。

腾讯 COS 固定为 bucket `aq-pub-1252262977`、region `ap-shanghai`、root prefix `clawxxx`。CAM 凭据应为可独立吊销的最小权限账号，覆盖 bucket location/versioning 查询及该 prefix 的 object head/get/put/delete/ACL、multipart 操作；本自动内核发布器不列举删除 bucket/prefix。必须是从未启用版本控制的 bucket：`Enabled` 会使 forbid-overwrite 无效，`Suspended` 仍可能留下历史版本，均停止自动发布/清理并要求人工核对；脚本不改变 bucket 设置。

## 3. 构建 staging 完整集合

从生产仓库的目标分支触发，不从未合并 fork 触发：

```bash
gh workflow run kernel-runtime-build.yml \
  --repo Tabll/ClawXXX \
  --ref main \
  -f kernel=all \
  -f artifact-base-url=https://aq-pub-1252262977.cos.ap-shanghai.tencentcos.cn/clawxxx/kernels
```

记录 run id 与唯一 `head_sha`。准入要求完整 25 个 build/single/dual jobs 全成功，且同 SHA 的 Electron E2E 三平台全成功。该 build run 必须产生 10 个未过期、ID/digest/源码身份完整的 runtime artifact（两个内核 × 五目标），另保留 10 份 clean-machine 和 5 份同机双真实制品 evidence。任一 matrix cancel/skip/failure 都不是完整集合。发布器会验证可信仓库、main、workflow path、run attempt、来源是当前 main 祖先，冻结输入与发布工具 checkout/当前 main 一致。

重点归档：

- 每目标 `runtime-artifact-smoke.json`；
- 生产 `KernelPackageManager` 断点续传/验签/安全解包/激活/rescan/uninstall evidence；
- 双制品 distinct PID、单侧 integrity failure/repair、独立卸载与 SQLite 保留 evidence；
- macOS signing + notary submission id、Windows artifact-only/deferred（或已明确启用的 Authenticode）、Linux ABI/sandbox 报告；
- SPDX、CycloneDX、THIRD_PARTY_NOTICES、provenance 与 license report。

## 4. 晋级 production catalog

完成任一 runtime build 或 Electron E2E 都会触发只读准入任务；GitHub 的事件是 OR，代码按同 SHA 显式汇合后才进入原 `kernel-production` 环境审批。任一依赖未完成则跳过发布，不请求生产密钥。不取消正在运行的发布；发布与维护共用一个串行组。

首次发布仅通过手动 `mode=publish`、精确 build run ID、`bootstrap=true` 初始化。脚本验证双 catalog URL 都为 404/410；403、超时或服务错误绝不当作不存在。若存在部分已签 bootstrap，则只恢复它，不创建新 sequence：

```bash
gh workflow run kernel-runtime-promote.yml \
  --repo Tabll/ClawXXX \
  --ref main \
  -f mode=publish \
  -f staging-run-id=<successful-run-id> \
  -f expected-source-sha=<exact-head-sha> \
  -f bootstrap=true
```

后续由完成事件自动请求审批，手动补发仍使用上述命令但 `bootstrap=false`。无需手填 sequence/issued-at/expires-at/tag；这些由受审策略与签名连续性决定，不再接受旧参数。紧急新增安全撤销不走日常自动退役：暂停维护/发布，使用独立审核的事故恢复流程，保留新签名 journal 连续性；不要用旧低层 CLI 直接覆盖生产指针。

审批后重新检查 candidate digest、run attempt、当前 main 冻结输入，再对下载的完整原始 archive/descriptor/checksum 做签名、SHA-256、大小与目标验证。发布器 SHA 与 artifact source SHA 分别记录，不 checkout 构建来源来运行旧发布工具，也不重建/重签已公证 payload。

固定 `kernel-runtimes` GitHub Release 是资源容器，必须使用 `prerelease=true` 和 `make_latest=false`，以免仓库尚无宿主版本时被 `/releases/latest` 自动选中。此 GitHub 页面标签不是内核发布通道：App 仍只信任 `channel=production` 的签名目录与固定 URL。已有资源页分类不符时发布器拒绝继续；仅校正页面分类/说明，保留全部文件、tag、签名和下载地址，不删除重建 Release。

目录只提供每内核/平台/架构一个最新版（当前 10 项）；包名含 `artifactVersion` 且不可覆盖。先持久化双镜像不可变签名发布记录，上传全部原始文件，执行全部 10 项 × 2 host 的严格 Range/If-Range/强稳定 ETag/签名大小检查，再覆盖两份签名目录、精确读回并复验线上下载。首次真实验收与运行链接在 `harness/reference/kernel-automatic-release.md` 单独记录；本地测试不算上线。

目录上传完成不代表两个公开下载入口已同时可见。切换后先执行有界的精确目录重试（默认最多 6 次、间隔 5 秒，每个网络请求有独立超时），再执行最终严格一致性读回；两端都仍是旧目录也不能通过。同序号签名内容冲突或观察到更高序号立即停止；超出重试预算仍失败，不删除旧包。恢复只复用已经保留的签名记录，不重新签发序号或时间。

## 5. 双镜像部分发布恢复

两个服务无法构成跨云原子事务。若一边为 N，另一边为 N−1，或 GitHub delete/re-upload 期间为 404，不要手工改 JSON、改时间或创建 N+1：

1. 使用相同 staging run ID/source SHA 重新触发，并重新走只读检查和正常审批。两端已是相同已签 N 时使用 `bootstrap=false` 幂等验收；仅首次尚未完成的 N=1/404（或双目录尚未写出）恢复仍需要明确的 `bootstrap=true`，不得为正常已有目录重复声明空目录初始化。
2. 从双镜像 `kernel-release-N.json` 恢复精确已签 catalog 和 candidate，验证前驱摘要。N/404 在 N>1 时必须额外验证 `kernel-release-(N-1).json`。
3. 已保留 candidate 的来源/run attempt/descriptor set 必须相同；冲突不可覆盖。源制品已过期、记录不存在/过期、签名撤销或 main 冻结输入已变化时停止，要求审核后的恢复方案，不能悄悄重新签 N。
4. 重复上传只允许相同 digest/size。GitHub 502 留下的同名 `starter` 且 size=0/无 digest 空 reservation 可以重试移除；含字节或身份不符则停止。
5. 复用精确 N 向落后镜像补写，再跑全目标双镜像验证。首次签名记录可能已存在但目录尚未上传，这同样复用，不更换签发时间。

若两个镜像同 sequence 但内容不同，立即停止常规发布并进入安全事件处理；不得用 `--clobber` 人工选择一边。若两个镜像都已是相同 N，重复运行是只做校验/修复的幂等操作。

## 6. 目录续期与安全清理

`kernels/release-policy.json` 当前规定 catalog 默认 7 天、剩余 48 小时续期、旧引用到期后 24 小时下载缓冲。每天 UTC 03:35（北京时间 11:35）的只读作业只在续期、退役到期或镜像修复需要时请求原生产审批；GitHub 定时任务可能延迟，审批拖延也可能导致 catalog 过期。维护不会自动绕过审核，也不延长 artifact/key 自身有效期；不足 1 小时可用有效期时失败，需要审核新 revision 或轮换密钥。

手动触发维护：

```bash
gh workflow run kernel-runtime-promote.yml --repo Tabll/ClawXXX --ref main -f mode=maintain
```

维护不下载 Actions artifact、不重传旧 runtime。只重签目录元数据，沿用已签发布记录中的原始验收来源。新版本发布中断必须用原候选恢复，maintenance 不能冒充它。

签名记录的 `activeCatalogExpiry` 持续累计每个活跃 identity 在所有历史目录中的最大有效期，避免缩短后续 TTL 时提前删除旧包。替换版本时生成精确退役清单，在该最大期限加缓冲后，要求两个 live catalog 与记录完全相同、全目标在线验证成功，才逐个核对旧 archive/descriptor/checksum 的 SHA metadata/digest 与 size 并删除。每个文件删除前再次检查 live 指针；任一差异或权限错误即停。缺失文件幂等成功，全部三文件/两镜像完成后才写签名 receipt，部分失败下次继续。

只清理签名清单中的普通退役版本，不把它们标为安全撤销；不列举清空 COS prefix，不触碰当前包、宿主 installer、未知对象、已安装本地版本或统一 SQLite。云端旧包最终不可再次下载，已验证本地 last-known-good/修复缓存不被云作业删除。小体积 `metadata/kernel-release-N.json`、`kernel-retirement-<hash>.json`（GitHub 同名文件在 release 根）长期保留；CI 的公开证据另保留 90 天。若 legacy 包没有签名记录，先人工盘点，不推测删除。

## 7. 宿主发布与最终签字

只有 production promotion、线上 Range drill 与法务批准完成后才创建 `v<package.json version>` tag。`release.yml` 会重新运行完整 unit/contract/type/lint/chaos/comms/Harness、macOS/Windows/Linux Electron E2E、production catalog/trust drill，再构建并验证宿主签名包。

最终证据包至少记录：

- staging、promotion、release 三个 run URL/id、head SHA 与 conclusions；
- production catalog sequence、SHA-256、continuity evidence 和两个 catalog validators；
- 10 个 artifact identities/SHA-256 与两个下载 host 的 Range evidence；
- Apple notary ids、Windows signer/thumbprint、Linux runner image/glibc/kernel；
- license/security reviewers、批准时间和适用版本；
- `TODO.md` 中尚未完成项逐项对应的证据链接，含 M20 自动发布首次线上验收。

拿到证据后才把相应 TODO 改为 `[x]`。本机测试、fixture 签名、未受保护 fork Actions 或控制面 smoke 不能替代这些项目。

许可证/法务签字可以在开发阶段暂缓，但不能因此把发布硬条件标为完成，也不能创建面向公众的最终 production release；恢复发布前必须补齐第 1 节第 4 项和上述证据。
