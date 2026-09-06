# カーネルランタイムのセキュリティ・サポート・EOLポリシー

ClawX 0.6.0から、個別にダウンロードされるOpenClawとDeepSeek Harnessに適用します。CIでビルド可能であることだけでは公開済みとはみなしません。保護されたリリース環境に全ゲートの証跡が残った場合のみproduction catalogへ昇格できます。

## サポートマトリクス

| ホスト | アーキテクチャ | 必須条件 | 状態 |
| --- | --- | --- | --- |
| macOS 13.5+ | arm64、x64 | Hardened Runtime、Developer ID署名、Apple notarization | 必須 |
| Windows 10 / Server 2016+ | x64 | Ed25519 artifact署名、Authenticodeは延期 | 必須 |
| Ubuntu 24.04または互換glibc環境 | x64、arm64 | glibc >= 2.39、kernel >= 6.8、sandbox smoke | 必須 |
| Linux musl/Alpine | — | glibc契約外 | 非対応 |
| Windows arm64 | — | runtime artifactなし | 延期 |
| Linux arm64 RPM | arm64 | tar.zst/debは対応 | 延期 |

各カーネルはDarwin arm64/x64、Windows x64、Linux arm64/x64の5 artifactを揃える必要があります。ベースアプリがより古いOSでオフラインデータを表示できても、カーネルのinstall/startは上表だけがサポート対象です。

## Supply-chainゲート

Source manifestはupstream commit/npm integrity、lockfile、patch、overlay、Node配布物、再現可能timestampを固定します。エンドユーザー環境でnpm/pnpm installは行いません。正確なpayloadに対してcontract test、native-history禁止scan、license audit、platform securityを実行し、SPDX/CycloneDX、provenance、license/security reportを生成します。

macOSのMach-Oはleaf-firstで署名し、closure全体のnotarizationが`Accepted`でなければなりません。Windowsの`.exe`/`.dll`/`.node`はAuthenticodeを通過し、LinuxはABI baselineを記録・検証します。Ed25519 artifact keyがimmutable descriptorを、別のcatalog keyが単調増加かつ期限付きcatalogを署名します。Tencent COSとGitHubへartifactを先に公開し、catalogは最後に公開します。その後、同一catalog、conditional cache、2つの独立したRange対応hostを実測します。

クライアントは期限切れ、revoked、downgrade、不適合、非HTTPS、過大、path traversal、symlink、署名不正、storage authority不正をactivation前に拒否します。

## 鍵rotation/revocation runbook

秘密鍵は保護CIまたは承認済みoffline signerだけに置き、repository、artifact、log、user profileへ入れません。通常rotationでは、新しいkey IDを発行し、まず旧/新public keyを含むhostを配布します。少なくとも1つのサポートhost releaseと全valid metadataの検証期間でoverlapさせ、新keyで署名・production drill後に旧秘密鍵を停止します。有効なcatalog/artifact/rollbackが依存するrootは削除しません。

漏えい時はpromotionを停止して証跡を保存し、`revokedAt`とcatalog revocationsを未侵害keyまたはoffline rollback keyで署名します。より大きいsequenceの短期recovery catalogを両mirrorへ公開し、sequence再利用やimmutable bytes上書きを禁止します。利用可能keyがなければtrust-store host updateまでfail closedとします。修正版はreviewed sourceから新artifact/patch versionとして再buildし、汚染bytesの改名・再署名は禁止です。

Rollback keyはofflineかつ`rollback` purpose専用で、通常releaseには使いません。互換性、revocation、digest、platform signature、storage authorityを回避できません。

## Platform signing、compatibility、EOL

Optional Windows runtimeは`artifact-signature-only`を明示的に選択できます。Hash-bound reportに`authenticode: false`と`status: deferred`を記録し、descriptor/catalog署名、整合性、sandbox検証は維持します。Authenticode失敗による自動fallbackはありません。

macOS host releaseはstrict `codesign`、Gatekeeper、stapled ticketを検証します。WindowsはNSIS完成後の外側だけでなくelectron-builder packaging中に署名し、installed app、installer、electron-updater publisher検証を一貫させます。alpha/beta/stableは同じ署名ゲートです。

互換性はhost version、protocol、bridge identity、platform/arch、mandatory capabilitiesで強制します。各kernelは独立更新され、activeと直前のverified versionを保持し、atomic activation失敗時にrollbackします。Security revocationは即時EOLになり得ます。通常EOLはrelease notesで予告します。Catalogからの削除はinstalled bytesやcanonical dataを削除しません。DSHは指定されたpatched prereleaseだけをサポートします。

License auditはengineering gateであり法的助言ではありません。GPL/LGPL/MPLのsource義務と`libsignal`法務承認が公開前に必要です。無licenseのQQ QR connectorは除外し、AppID/AppSecret設定は残します。

`kernel-runtime-build.yml`は各targetの実artifactをproduction Package Manager経路へ通し、別jobで同一machine上の2 artifact同時起動とfailure isolationも検証します。`kernel-runtime-promote.yml`は完全setを検証・公開します。`release.yml`はpackage前に全unit/contract/type/lint/chaos/comms/Harness、macOS/Windows/Linux Electron E2E、live 2-mirror Range drillを再実行し、`win-build-test.yml`はsigned installerのfocused検証を保持します。署名/notarization log、catalog sequence、hash、distribution drill、法務承認をreleaseと共に保持し、local testで代替しません。
