# Архитектура ClawX

Этот документ содержит подробную версию раздела «Архитектура» из README.

## Авторитетная multi-kernel архитектура ClawX 0.6

ClawX теперь является host для optional kernels с независимыми версиями. OpenClaw исключён из base installer; OpenClaw и DeepSeek Harness устанавливаются из подписанных CI runtime artifacts и могут работать одновременно. Renderer полностью общий и знает только canonical domain contracts ClawX, а не upstream session/config protocols.

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

SQLite — единственный durable authority для всех новых Conversation, Cron, Channel, Usage, Agent/Provider/Skill states и runtime operations. Runtime не открывает DB и не имеет второго transcript/scheduler history. ACP и DSH bridges служат только live execution; DataService принимает events с conversation/run/kernel/generation/sequence identity. Kernel следующего turn меняется только на границе turn, и target получает лишь portable context после visibility/redaction/budget.

Install транзакционен: Main проверяет подписанные и expiring catalog/descriptor, выполняет bounded resume download, staging extraction без links/traversal, artifact/platform/storage self-tests и atomic activation. У каждого kernel независимые supervisor, directory, port/stdio bridge, operation queue, health и rollback slot; stop/crash/repair/update одного не заменяет другой.

Дальнейшие разделы о OpenClaw Gateway/config описывают только adapter `OpenClawDriver`, а не global host. DSH использует тот же Host API/domain layer через patched ACP/control/persistence bridges. См. [полный дизайн](../zh-CN/multi-kernel-design.md), [runtime security/support](runtime-security-support.md) и [data security/retention](data-security-retention.md).

ClawX использует **Main-owned многопроцессную архитектуру с единым Host API**. Renderer обращается только к одной client abstraction; Electron Main владеет utility process DataService, выбором runtime, protocol adapters и lifecycle процессов.

Доставка конфигурации OpenClaw — adapter projection под управлением Electron Main. При работающем optional Gateway состояние проецируется через `config.get`/`config.set`; при остановке или запуске обновляется replaceable managed JSON5 без запуска процесса. Canonical intent Provider, Agent, Channel, binding, Skill и model остаётся в SQLite. Обычные projection changes не заменяют процесс; полный restart нужен только для launch environment (например proxy) или явного действия. Heartbeat recovery ограничен owned OpenClaw supervisor и не перезапускает другой kernel. После commit auth metadata secret остаётся в OS credential store, а OpenClaw получает scoped `secrets.reload`.

При исполнении OpenClaw Main-owned ACP stdio bridge получает только admitted Conversation snapshot, run identity, scoped credentials и workspace grant. Bridge не загружает UI history из runtime. Если защищённое recovery прерывает принятый run, patched runtime объявляет lineage replacement process/run; ConversationRouter принимает event только при совпадении kernel, generation, run и монотонной event sequence. OpenClaw реализует runtime projections для models, skills и diagnostics, но durable ownership остаётся у domain services ClawX.

### Live adapter semantics и canonical history

ACP отвечает только за live execution semantics, которые выдаёт admitted OpenClaw run; DSH bridge имеет ту же роль. Main нормализует text, reasoning, tool, permission, plan, usage, image и resource в `KernelEventEnvelopeV1`, после чего ConversationRouter проверяет identity и пишет через DataService. Ни один transport не предоставляет UI Conversation catalog/history, Cron history или Usage history.

SQLite Conversation records — единственный history source. При открытии или reload Conversation canonical turns, content blocks, runs, tool calls, permissions, usage и timestamps проецируются в существующую Chat timeline без runtime `session/load`, чтения JSONL или scan runtime directory. Отсутствующий canonical record остаётся отсутствующим: transcript, Gateway и native-history fallback его не восстанавливают. Compatibility API со старыми именами — facade над тем же Conversation repository, а не второе хранилище.

Незавершённый response продолжает streaming при переходе в другой Conversation или page. Live snapshot изолирован по Conversation/run/kernel/generation, а terminal commit атомарно сохраняет final assistant turn и связанные records. Возврат до завершения продолжает in-memory stream; после завершения загружается та же durable SQLite projection.

Длительность assistant turn берётся из canonical admission и terminal timestamps. Attachments, generated images и file activity сохраняются как canonical content blocks и structured run events. Стандартные ACP/DSH resource/image нормализуются на live adapter boundary; historical rendering не разбирает `MEDIA:` text или native transcript. User image отображается thumbnail, прочие resources — attachment card; каждое действие с local file повторно проверяется Electron Main по точному Conversation/run workspace grant.

Существующие локальные ссылки на файлы, включая пути за пределами активного рабочего пространства, перед каждым предпросмотром или открытием повторно проверяются Electron Main для точной session и generation. Локальные вложения, созданные AI и доступные для предпросмотра, включая `.docx` и `.pptx` размером до 20 МБ, сохраняют основное действие предпросмотра только для чтения внутри приложения и дополнительное меню для открытия совместимым приложением или показа в Finder, File Explorer либо системном файловом менеджере. Для локальных HTML-вложений первый пункт меню открывает файл во вкладке Preview справа.

Для Office действуют те же ограничения: `.doc` и `.ppt` открываются системным приложением, разбиение DOCX на страницы может отличаться от Microsoft Word, а анимации, переходы и воспроизведение медиа в PPTX не поддерживаются. Поиск совместимых приложений доступен только в macOS и Windows; в Linux или при ошибке поиска происходит незаметный переход к действию показа расположения. Остальные локальные файлы, включая Office-файлы размером более 20 МБ, открываются системным приложением после нажатия пользователя. Выбранные пользователем папки остаются доступными после отправки и открываются системным файловым менеджером; ClawX не читает и не просматривает их содержимое. Вложения HTTP и HTTPS открываются внешне после нажатия. Обычные пути в тексте без канонических media-фактов не считаются вложениями.

Generated image показываются только из trusted structured runtime events, принятых canonical run. Task-correlated final reply сохраняет исходный user-facing text, включая text-only failure. Preview загружается через Main-owned media handling, а не через произвольный filesystem access Renderer.

### Семантика файловых операций ACP

- Файловые операции проецируются из успешных завершённых вызовов OpenClaw `write`, `edit` и `apply_patch`. Распознавание инструментов соответствует официальному OpenClaw Chat UI; фильтрация только завершённых вызовов специфична для ClawX.
- Строки созданных и изменённых файлов используют ту же оболочку карточки и меню **Open with**, что и предпросматриваемые вложения assistant, сохраняя статус и необязательную сводку `+/-`. Для HTML первый пункт меню открывает файл во вкладке **Preview** справа. Удалённые строки сохраняют только действие **Changes**. Каждый запрос списка приложений, выбора приложения и показа расположения заново проверяется Electron Main по корню рабочего пространства и относительному пути. Пути из инструментов не становятся вложениями и не раскрывают Renderer канонические системные пути.
- `write` отображается так, как его объявляет инструмент: как создание с разницей из всех добавленных строк, даже если путь уже может существовать.
- **Changes** — это хронологическая запись объявленной инструментом активности на уровне сессии. Это не вывод Git и не проверенная разница относительно исходной базы.
- Для каждого файла Changes отображает не более одного diff-редактора на ход assistant. Последовательные фрагменты объединяются, если это безопасно; независимые фрагменты объединяются в один редактор без утверждения, что это полная разница относительно базовой версии файла.
- Побочные эффекты shell-команд, скриптов, пользователей или IDE не обнаруживаются.
- Canonical Conversation projection восстанавливает записанные file operations. Если structured records нет, ClawX не выводит activity из prose, filesystem или runtime history.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Десктопное приложение ClawX                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Главный процесс Electron                       │  │
│  │  • Управление жизненным циклом окна и приложения             │  │
│  │  • Наблюдение за процессом Gateway                           │  │
│  │  • Интеграция с системой (трей, уведомления, связка ключей)  │  │
│  │  • Оркестрация автообновлений                                │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ IPC (авторитетная плоскость управления)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│              Процесс Renderer на React                            │
│  • Современный компонентный UI (React 19)                         │
│  • Управление состоянием с Zustand                                │
│  • Унифицированные вызовы host-api/api-client                     │
│  • Ответы assistant в Markdown, ввод пользователя как обычный текст│
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ Типизированные IPC-запросы
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                Main Host Services и Gateway Manager               │
│  • Типизированный диспетчер сервисов host:invoke                  │
│  • Настройки, файлы, сессии, навыки, провайдеры, диагностика       │
│  • WebSocket Gateway и наблюдение за процессом принадлежат Main   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ WebSocket под управлением Main
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                              │
│  • Среда выполнения и оркестрация AI-агентов                       │
│  • Управление каналами сообщений                                  │
│  • Среда выполнения навыков/плагинов                              │
│  • Уровень абстракции провайдеров                                 │
└──────────────────────────────────────────────────────────────────┘
```

### Принципы проектирования

- **Изоляция процессов**: AI-среда выполнения работает в отдельном процессе, сохраняя отзывчивость UI даже при тяжёлых вычислениях.
- **Единая точка входа для фронтенда**: запросы Renderer проходят через `host-api` / `api-client`, а детали протокола скрыты за стабильным интерфейсом.
- **Транспорт принадлежит Main**: Electron Main владеет ACP Chat stdio bridge и транспортами Gateway; Renderer общается с Main через типизированный IPC.
- **Расширения через IPC**: расширения Main-процесса добавляют действия host-api через типизированный IPC-реестр, а не через HTTP routes.
- **Корректное восстановление**: встроенные переподключение, таймауты и backoff автоматически обрабатывают временные сбои.
- **Безопасное хранение**: API-ключи и конфиденциальные данные используют нативные механизмы безопасного хранения ОС.
- **CORS-безопасность**: Renderer не вызывает напрямую локальные HTTP-эндпоинты Gateway или Host API.

### Восстановление доступности Gateway

Доступность Gateway определяет Electron Main. WebSocket pong является полезным транспортным сигналом. При обычной потере транспорта Main сначала использует существующий путь переподключения WebSocket Gateway. После трёх минут без достоверного сигнала ClawX проверяет основной RPC-маршрутизатор через `system-presence` и только затем решает, заменять ли принадлежащий ему процесс.

| Проектное решение | Обработка | Цель |
| --- | --- | --- |
| Считать pong, любой входящий кадр Gateway и успешный RPC сигналом доступности* | Обновлять `lastAliveAt` и отменять устаревший deadline callback | При передаче реального трафика крупные AI-операции, например вызовы Skill или инструментов, могут задерживать pong; не принимать такую задержку за остановку Gateway |
| Использовать единый трёхминутный deadline тишины | До 180 секунд только записывать heartbeat miss, не менять socket или процесс | Ограничить автоматическое восстановление и не перезапускать процесс только из-за pong |
| Проверять управляющую плоскость в deadline | Один раз вызвать `system-presence` RPC с таймаутом 5 секунд и подтвердить состояние Gateway через управляющую плоскость, а не только по WebSocket; при успехе вернуться к обычному мониторингу | Отличать тихий поток событий от Gateway, не способного обработать основной read RPC |
| Перезапускать только недоступный процесс под управлением ClawX | При неудачном deadline probe запрашивать защищённый путь перезапуска Gateway | Восстанавливать действительно не отвечающий локальный дочерний процесс |
| Никогда не останавливать внешний Gateway автоматически | Предпочтительно заменять или переподключать только WebSocket ClawX и сообщать о недоступности в диагностике | Не отправлять shutdown процессу, которым ClawX не владеет |
| Разделять авторитетные пути жизненного цикла | Сохранять существующие восстановление после WebSocket close, reload с code 1012, восстановление после завершения процесса и ручной перезапуск | Не допускать дублирующих или конкурирующих операций stop/start |
| Не отслеживать активные нагрузки в этом пути | Применять тот же deadline независимо от работы chat, tool или cron | Сосредоточить восстановление на предотвращении ложных перезапусков и владении процессом |

> * Этот подход к сигналам доступности вдохновлён [LobsterAI](https://github.com/netease-youdao/lobsterai).

### Модель процессов и устранение неполадок Gateway

- ClawX — приложение Electron, поэтому **один экземпляр обычно отображается как несколько процессов ОС** (main/renderer/zygote/utility). Это нормально.
- Защита единственного экземпляра использует блокировку Electron и резервный локальный файл блокировки процесса, предотвращая дублирование запуска при нестабильном desktop IPC или сессионной шине.
- При последовательном обновлении смешанные старые и новые версии могут вести себя асимметрично. Для надёжности обновляйте все десктопные клиенты до одной версии.
- Слушатель OpenClaw Gateway должен иметь **единственного владельца**: только один процесс должен слушать `127.0.0.1:18789`.
- Готовность Gateway определяется основными сигналами OpenClaw, такими как `system-presence`, `health` и `status`. Ошибки памяти или каналов отображаются как снижение возможностей, а не как общий сбой Gateway.
- Проверить активный слушатель можно командами:
  - macOS/Linux: `lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows (PowerShell): `Get-NetTCPConnection -LocalPort 18789 -State Listen`
- Нажатие кнопки закрытия окна (`X`) скрывает ClawX в трее, но не завершает приложение. Для полного завершения используйте **Quit ClawX** в меню трея.
