# ClawXのアーキテクチャ

このドキュメントは、READMEの「アーキテクチャ」セクションの詳細版です。

## ClawX 0.6 マルチカーネルauthority

ClawXはoptionalかつ独立versionのkernel hostになりました。OpenClawはbase installerに含まれず、OpenClawとDeepSeek Harnessは署名済みCI runtime artifactからinstallし同時実行できます。既存Rendererを完全共有し、upstream session/config protocolではなくClawX canonical domain contractだけを扱います。

```text
React Renderer -> typed Host API/events
Electron Main domain services
  -> ClawXDataService utility -> one SQLite + content-addressed Blobs
  -> ConversationRouter / Scheduler / Channel Orchestrator / Credential Broker
  -> KernelPackageManager + SupervisorRegistry
       -> OpenClawDriver -> downloaded OpenClaw runtime
       -> DeepSeekHarnessDriver -> downloaded DSH runtime host
       -> future KernelDriver
```

SQLiteが全ての新しいConversation、Cron、Channel、Usage、Agent/Provider/Skill state、runtime operationの唯一のdurable authorityです。RuntimeはDBを開かず、第2 transcript/scheduler historyを保持しません。ACP/DSH bridgeはlive execution専用で、DataServiceはconversation/run/kernel/generation/sequence identityを持つeventだけを受理します。同じConversationの次kernel変更はturn境界だけで行い、visibility/redaction/budget済みportable contextだけを渡します。

Installはtransactionalです。Mainが期限付き署名catalog/descriptorを検証し、bounded resume download、link/traversalを拒否するstaging extraction、artifact/platform/storage self-test後にatomic activationします。各kernelは独立supervisor、directory、port/stdio bridge、operation queue、health、rollback slotを持ち、一方のstop/crash/repair/updateは他方を置換しません。

以降のOpenClaw Gateway/config記述は`OpenClawDriver` adapter固有でありglobal architectureではありません。DSHはpatched ACP/control/persistence bridgesから同じHost API/domain layerを使います。[設計](../zh-CN/multi-kernel-design.md)、[runtime security/support](runtime-security-support.md)、[data security/retention](data-security-retention.md)を参照してください。

ClawXは **Main所有のマルチプロセス構成と統合Host API**を採用します。Rendererは単一のclient abstractionだけを呼び、DataService utility process、runtime選択、protocol adapter、process lifecycleはElectron Mainが管理します。

OpenClaw設定配信はElectron Mainが管理するadapter projectionです。optional Gatewayの実行中は`config.get`/`config.set`で状態を投影し、停止中または起動中はprocessを起動せずreplaceableなmanaged JSON5だけを更新します。Provider、Agent、Channel、binding、Skill、modelのcanonical intentはSQLiteに残ります。通常のprojection変更ではprocessを置換せず、完全なrestartはproxyなどlaunch environment変更または明示操作に限定します。Heartbeat recoveryは所有中のOpenClaw supervisorだけに作用し、他kernelをrestartしません。認証metadata commit後もsecretはOS credential storeに残り、OpenClawにはscope付き`secrets.reload`だけを通知します。

OpenClaw実行時、Main所有のACP stdio bridgeにはadmission済みConversation snapshot、run identity、scope付きcredential、workspace grantだけを渡します。BridgeはruntimeからUI historyをloadしません。保護されたrecoveryが受理済みrunを中断した場合、patched runtimeはreplacement process/runのlineageを明示し、ConversationRouterはkernel、generation、run、monotonic event sequenceが一致するeventだけを受理します。OpenClawはmodel、skill、diagnostics等のruntime projectionを実装しますが、durable ownershipはClawX domain serviceにあります。

### Live Adapter SemanticsとCanonical History

ACPはadmission済みOpenClaw runが発するlive execution semanticsだけを担当し、DSH bridgeも同じ役割です。Mainはtext、reasoning、tool、permission、plan、usage、image、resourceを`KernelEventEnvelopeV1`へ正規化し、ConversationRouterがidentityを検証してDataServiceへ保存します。TransportがConversation catalog/history、Cron history、Usage historyをUIへ提供することはありません。

SQLite Conversation recordが唯一のhistory sourceです。Conversationを開く・reloadする際はcanonical turn、content block、run、tool call、permission、usage、timestampを既存Chat timelineへ投影し、runtime `session/load`、JSONL、runtime directory scanを使いません。Canonical recordがなければ欠落のままとし、transcript、Gateway、native history fallbackで再構成しません。Legacy名のcompatibility APIも同じConversation repository上のfacadeです。

別Conversationやpageを開いても未完了responseはstreamingを続けます。Live snapshotはConversation/run/kernel/generationで隔離され、terminal commitはfinal assistant turnと関連recordをatomicに保存します。完了前に戻ればin-memory streamを継続し、完了後は同じSQLite projectionをreloadします。

Assistant turn durationはcanonical run admission/terminal timestampから得ます。Attachment、generated image、file activityはcanonical content blockとstructured run eventとして保存されます。標準ACP/DSH resource/imageはlive adapter boundaryで正規化され、history renderingが`MEDIA:`文やnative transcriptを解析することはありません。ユーザー画像はthumbnail、他resourceはattachment cardとして表示し、local file actionは正確なConversation/run workspace grantに対してElectron Mainが再検証します。

既存のローカルファイル参照は、アクティブなworkspace外のパスを含め、プレビューやオープンのたびにElectron Mainが正確なsessionとgenerationについて再検証します。AIが生成したプレビュー可能なローカル添付（20 MB以下の`.docx`と`.pptx`を含む）は、読み取り専用のアプリ内プレビューを主操作として保持し、対応アプリで開く操作やFinder、エクスプローラー、システムのファイルマネージャーで表示する操作を副次メニューから選べます。ローカルHTML添付では、そのメニューの先頭項目から右側のPreviewタブでファイルを開けます。

Officeプレビューには同じ制限があります。`.doc`と`.ppt`はシステムアプリで開き、DOCXのページ区切りはMicrosoft Wordと異なる場合があり、PPTXのアニメーション、画面切り替え、メディア再生はサポートされません。対応アプリの検出はmacOSとWindowsでのみ利用でき、Linuxまたは検出失敗時は通知なしにファイル位置の表示だけへ切り替わります。その他のローカルファイル（20 MBを超えるOfficeファイルを含む）は、クリック後にシステムアプリで開きます。ユーザーが選択したフォルダー添付は送信後も利用でき、クリックするとシステムのファイルマネージャーで開きます。ClawXはその内容を読み取ったりプレビューしたりしません。リモートHTTP/HTTPS添付はクリック後に外部で開きます。正規のメディア情報を伴わない通常の文章中のパスは添付として扱われません。

生成画像はcanonical runが受理したtrusted structured runtime eventからだけ表示します。Task-correlated final replyはtext-only failureを含む元のuser-facing textを保持します。PreviewはRendererの任意filesystem accessではなくElectron Mainのhost media処理で読み込みます。

### ACPファイルアクティビティのセマンティクス

- ファイルアクティビティは、成功して完了したOpenClawの`write`、`edit`、`apply_patch`呼び出しから投影されます。ツール認識は公式OpenClaw Chat UIに従い、完了した呼び出しだけに絞る処理はClawX固有です。
- 作成・変更された行は、プレビュー可能なassistant添付と同じファイルカードと**Open with**メニューを使い、状態と任意の`+/-`概要を保持します。HTMLではメニューの先頭項目が右側の**Preview**タブでファイルを開きます。削除行には **Changes** 操作だけを残します。アプリ一覧、選択アプリで開く操作、表示位置の要求は、workspaceルートと相対パスからElectron Mainが個別に再検証します。ツール由来のパスは添付にならず、Rendererへ正規化済みのネイティブパスも公開されません。
- `write` はツールの宣言どおり、対象パスがすでに存在する可能性があっても、作成および全行追加の差分として表示されます。
- **Changes** はツールが宣言したアクティビティを時系列に記録するセッション単位の記録です。Gitの出力でも、検証済みソースベースラインとの差分でもありません。
- 各ファイルについて、Changesはassistantの各ターンに最大1つのdiffエディターを表示します。安全に連結できる断片は合成し、独立した断片は1つのエディターに連結しますが、完全なファイルベースラインとの差分とはみなしません。
- シェルコマンド、スクリプト、ユーザー、IDEによる副作用は検出されません。
- Canonical Conversation projectionから記録済みfile activityを復元します。Structured recordがなければprose、filesystem、runtime historyから推論しません。

```
┌──────────────────────────────────────────────────────────────────┐
│                        ClawX デスクトップアプリ                    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Electron メインプロセス                        │  │
│  │  • ウィンドウとアプリケーションのライフサイクル管理        │  │
│  │  • Gatewayプロセスの監視                                    │  │
│  │  • システム統合（トレイ、通知、キーチェーン）               │  │
│  │  • 自動更新のオーケストレーション                           │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ IPC（権威ある制御プレーン）
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              React Rendererプロセス                              │
│  • モダンなコンポーネントベースUI（React 19）                    │
│  • Zustandによる状態管理                                         │
│  • 統一host-api/api-client呼び出し                               │
│  • assistant返信はMarkdown、ユーザー入力はプレーンテキスト       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ 型付きIPCリクエスト
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                Main Host ServicesとGateway Manager                │
│  • host:invoke型付きサービスディスパッチ                         │
│  • 設定、ファイル、セッション、スキル、プロバイダー、診断       │
│  • Main所有のGateway WebSocketとプロセス監視                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ Main所有WebSocket
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                             │
│  • AIエージェントランタイムとオーケストレーション                │
│  • メッセージチャネル管理                                        │
│  • スキル/プラグイン実行環境                                     │
│  • プロバイダー抽象化レイヤー                                    │
└──────────────────────────────────────────────────────────────────┘
```

### 設計原則

- **プロセス分離**：AIランタイムは別プロセスで動作し、重い計算中もUIの応答性を保ちます。
- **フロントエンド呼び出しの単一入口**：Rendererのリクエストは`host-api` / `api-client`を経由し、プロトコルの詳細は安定したインターフェースの背後に隠されます。
- **Mainプロセスによるトランスポート管理**：Electron MainがACP Chat stdio bridgeとGatewayトランスポートを所有し、Rendererは型付きIPCでMainと通信します。
- **拡張IPCの貢献点**：Mainプロセス拡張はHTTP routeではなく、型付きIPCレジストリを通じてhost-api actionを提供します。
- **グレースフルリカバリ**：再接続、タイムアウト、バックオフを内蔵し、一時的な障害を自動処理します。
- **セキュアストレージ**：APIキーや機密データにはOSのネイティブな安全な保存機構を使用します。
- **CORSセーフ設計**：RendererはローカルGatewayやHost API HTTPエンドポイントを直接呼び出しません。

### Gatewayの存活復旧

Gatewayの存活判定はElectron Mainが行います。WebSocket pongは有用なトランスポート証拠です。通常のトランスポート喪失時は、Mainが既存のGateway WebSocket再接続パスを優先して接続を復旧します。ClawXは3分間の信頼できる存活信号なしの期限を設け、その後に`system-presence`でコアRPCルーターを検証してから、自身が所有するプロセスを置き換えるか判断します。

| 設計点 | 処理 | 目的 |
| --- | --- | --- |
| pong、任意の受信Gatewayフレーム、成功したRPCを存活信号として扱う* | `lastAliveAt`を更新し、古いdeadlineコールバックを取り消す | 接続が実際のトラフィックを処理している際、大規模なAI操作（Skillやツール呼び出しなど）がpongを遅延させることがあるため、その遅延をGateway停止と誤判定しない |
| 単一の3分間静止deadlineを使う | 180秒まではheartbeat missを記録するだけで、socketやプロセスを変更しない | 自動復旧を制限しつつ、pongだけによる再起動を防ぐ |
| deadline時にコントロールプレーンを検証する | 5秒タイムアウトで`system-presence` RPCを1回呼び出し、純粋なWebSocket信号ではなくコントロールプレーンからGateway状態を確認する。成功時は通常監視へ戻る | 静かなイベントストリームとコア読取RPCを処理できないGatewayを区別する |
| 利用不能なClawX所有プロセスだけを再起動する | deadline probe失敗時に保護されたGateway再起動パスを要求する | 真に応答しないローカル子プロセスを復旧する |
| 外部Gatewayを自動停止しない | ClawXのWebSocketだけを優先して置き換えまたは再接続し、利用不能診断を報告する | ClawXが所有しないプロセスにshutdownを発行しない |
| 権威的なライフサイクルパスを分離する | 既存のWebSocket close再接続、code 1012 reload復旧、プロセス終了復旧、手動再起動を維持する | 重複または競合するstop/start操作を防ぐ |
| この経路でアクティブな作業負荷を追跡しない | chat、tool、cronの実行中かどうかにかかわらず同じdeadlineを適用する | 存活復旧を虚偽の再起動防止とプロセス所有権に集中させる |

> * この存活信号の設計は [LobsterAI](https://github.com/netease-youdao/lobsterai) を参考にしています。

### プロセスモデルとGatewayのトラブルシューティング

- ClawXはElectronアプリのため、**1つのアプリインスタンスでも複数のOSプロセスが表示される**（main/renderer/zygote/utility）のは正常です。
- 単一起動保護にはElectronのロックに加えてローカルのプロセスファイルロックのフォールバックを使用し、デスクトップIPCやセッションバスが不安定な環境での二重起動を防ぎます。
- ローリングアップグレード中に旧版と新版が混在すると、単一起動保護が非対称になる場合があります。安定性のため、すべてのデスクトップクライアントを同じバージョンへ更新してください。
- OpenClaw Gatewayのリスナーは**単一所有者**である必要があります。`127.0.0.1:18789`をListenするプロセスは1つだけにしてください。
- Gatewayのreadinessは`system-presence`、`health`、`status`などOpenClawのコア信号を基準にします。メモリまたはチャネルの失敗は、Gateway全体の障害ではなく機能低下として表示されます。
- アクティブなリスナーは次のコマンドで確認できます。
  - macOS/Linux：`lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows（PowerShell）：`Get-NetTCPConnection -LocalPort 18789 -State Listen`
- ウィンドウの閉じるボタン（`X`）はClawXをトレイに隠すだけで、完全終了ではありません。完全終了にはトレイメニューの **Quit ClawX** を使用してください。
