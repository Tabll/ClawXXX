# データセキュリティ・復旧・保持ポリシー

ClawX 0.6.0以降に作成されるcanonical multi-kernel dataへ適用します。以前のOpenClaw/DSHファイルは移行、scan、自動削除しません。

## Authorityとthreat model

Electron Mainが起動する単一DataService utility processだけが`<userData>/state/clawx.sqlite`を開きます。Runtime、Channel、Scheduler、Extension、RendererはSQLを実行できず、認証・version化された最小RPCだけを使います。SQLiteは新しいConversation、Turn、Run、Event、Permission、Usage、Agent、Provider metadata、Skill state、Channel、Cron、installation/projection/operationの唯一のdurable authorityです。大きなattachment/artifactはcontent-addressed Blob Storeへ置き、SQLiteには検証済みhash/referenceだけを保存します。Runtime directoryに第2のdurable historyは許可しません。

これはcross-kernel誤アクセス、partial write、duplicate、path traversal、symlink、corruption、process interruption、他の通常OS userを対象にします。同じOS accountを支配するmalware/admin、侵害OS/kernel、screen capture、unlock中の物理アクセスは対象外です。

## At-rest境界

`node:sqlite`はtransaction、WAL、integrity check、backupを提供しますが、**暗号化は提供しません**。0.6.0はSQLCipher/application encryptionを実装済みとは表現しません。DB/Blob/backup/quarantineはowner-only（POSIX対応環境ではdirectory `0700`、file `0600`）で作成し、symlinkを拒否します。Windowsはuser-profile ACLを境界とし、provider secretはOS credential storeに置きSQLiteにはreferenceだけを保存します。

保存時の機密性にはFileVault、BitLocker/Device Encryption、LUKS/full-volume encryptionを使用してください。将来のSQLCipherにはnative dependency/license review、OS keychain key、crash-safe migration、backup/export/recovery/rekey、secure deletion限界、5 target packaged testが必要です。それまではplaintext in protected profileと明記します。

## Crash、backup、recovery

Foreign key、WAL、busy timeout、schema version、stable event ID、idempotent admissionを強制します。Prompt/runはdispatch前にcommitし、terminal stateはatomic commit、tool/permissionは即時commit、stream deltaはbounded batchです。Conversationのsingle-active-run leaseとkernel/generation/sequenceがlate event混入を防ぎます。

Startupはruntimeより先にrecovery/integrity checkを実行します。Primaryが壊れていればverified backupを復元し、できなければbytesをquarantineして新DBを作ります。安全にwriteできない場合はread-only recoveryとなり、新prompt、Channel/Cron admission、mutationを拒否します。Disk-full/I/O/backup/restore failureはfail closedで、native historyやdual-writeへfallbackしません。

BackupはMain-owned consistent snapshotと参照Blobをstagingへ作り、manifest/hash、schema、owner permission、symlink不在を検証してから保管します。暗号化された保存先を使います。Restore時はruntime/schedulerを止め、stagingで全検証後にatomic replaceし、quick/integrity check後に再開します。失敗時は現storeを変更せずcandidateをquarantineします。WAL/SHMだけのcopyやlive DB同士のmergeは禁止です。

## Retention、delete、export、uninstall

0.6.0は年齢による自動削除をしません。Hard deleteはConversation graphをcascadeし、unreferenced Blob bytesをmetadataより先にGCします。共有Blobは残ります。Agent削除、kernel stop/uninstall/updateはhistory/provenanceを削除せず、kernelなしでも検索・exportできます。Exportはversion化されたcanonical plaintextで、ClawXのowner-only境界外になります。

古いbackupは独立copyなのでlive deleteでは消えません。Operatorが独自retentionに従って破棄します。Default uninstallerは`<userData>`、SQLite、Blob、backup、legacy upstream filesを保持します。旧`session.json`/JSONL/Cron/DSH persistenceはimport、fallback、auto-deleteせず、利用者が必要性確認後に手動archive/deleteします。

Recovery完了時はstate、integrity、schema、backup/Blob hash、GC、影響operation、runtime/scheduler再開を記録します。空DB作成をquarantine dataの復旧成功と呼びません。
