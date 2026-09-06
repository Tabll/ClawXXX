# ClawX 0.6.0 マルチカーネル リリースノート

DSH 0.1.3 のサービス構成、ストリーム確定、SessionHandle の破壊的変更に対応しました。失敗した試行のテキストを置換し、使用量をリクエストごとに重複なく保存します。共有履歴は変更しません。上流は性能低下を報告しています。`.11` のソース更新は署名・公証・公開の完了を意味しません。[互換性](../../harness/reference/deepseek-harness-0.1.3-upgrade.md)。

状態: implementation release candidate。公開には保護CIの2 kernel × 5 target promotionと署名済みhost package gateが必要です。

## 主な変更

- OpenClawをbase installerから除外し、初回利用時に選択downloadするruntimeへ変更しました。
- DeepSeek Harness `0.1.3-alpha.1+clawx.11`を第2 kernelとして追加し、両kernelは同時実行・独立update/failure/rollbackできます。
- Chat、Providers/Models、Agents、Channels、Cron、Skills、Usage、Diagnosticsは同じClawX UIとcanonical contractsを使用します。
- 新しいdurable historyは単一Main-owned SQLite/Blobへ保存します。同じConversationをturn境界でredacted portable contextにより別kernelへ継続できます。
- Runtimeはsigned/expiring metadata、platform security evidence、SBOM、provenance、license report、repair/rollback、Tencent COS/GitHub mirrorを持つ再現可能CI artifactです。
- Kernelがなくてもhistoryの検索、rename、export、deleteができます。

0.6.0は新canonical storeから開始し、旧OpenClaw/DSH Conversation/Cronは移行、scan、削除、fallbackしません。Full runtime supportはmacOS 13.5+、Windows 10 x64、documented Linux baselineです。musl/AlpineとWindows arm64は非対応です。無license QQ QR dependencyは除外し、AppID/AppSecret手動設定を使います。

SQLiteはowner-only user profile内のplaintextです。保存時暗号化にはOS full-volume encryptionを使用してください。Default uninstallは新旧user dataを保持します。[Runtime security/support](runtime-security-support.md)と[Data security/retention](data-security-retention.md)を参照してください。
