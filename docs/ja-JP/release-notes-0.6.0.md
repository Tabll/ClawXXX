# ClawX 0.6.0 マルチカーネル リリースノート

状態: implementation release candidate。公開には保護CIの2 kernel × 5 target promotionと署名済みhost package gateが必要です。

## 主な変更

- OpenClawをbase installerから除外し、初回利用時に選択downloadするruntimeへ変更しました。
- DeepSeek Harness `0.1.1-rc.2+clawx.8`を第2 kernelとして追加し、両kernelは同時実行・独立update/failure/rollbackできます。
- Chat、Providers/Models、Agents、Channels、Cron、Skills、Usage、Diagnosticsは同じClawX UIとcanonical contractsを使用します。
- 新しいdurable historyは単一Main-owned SQLite/Blobへ保存します。同じConversationをturn境界でredacted portable contextにより別kernelへ継続できます。
- Runtimeはsigned/expiring metadata、platform security evidence、SBOM、provenance、license report、repair/rollback、OSS/GitHub mirrorを持つ再現可能CI artifactです。
- Kernelがなくてもhistoryの検索、rename、export、deleteができます。

0.6.0は新canonical storeから開始し、旧OpenClaw/DSH Conversation/Cronは移行、scan、削除、fallbackしません。Full runtime supportはmacOS 13.5+、Windows 10 x64、documented Linux baselineです。musl/AlpineとWindows arm64は非対応です。無license QQ QR dependencyは除外し、AppID/AppSecret手動設定を使います。

SQLiteはowner-only user profile内のplaintextです。保存時暗号化にはOS full-volume encryptionを使用してください。Default uninstallは新旧user dataを保持します。[Runtime security/support](runtime-security-support.md)と[Data security/retention](data-security-retention.md)を参照してください。
