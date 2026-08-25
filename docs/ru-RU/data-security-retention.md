# Безопасность, восстановление и хранение данных

Политика действует с ClawX 0.6.0 для новых canonical multi-kernel данных. Старые файлы OpenClaw/DSH не мигрируются, не сканируются и не удаляются автоматически.

## Authority и модель угроз

Только один DataService utility process, запущенный Electron Main, открывает `<userData>/state/clawx.sqlite`. Runtime, Channels, Scheduler, Extensions и Renderer не могут выполнять SQL и используют узкие authenticated/versioned RPC. SQLite — единственный durable authority для новых Conversations, Turns, Runs, Events, Permissions, Usage, Agents, Provider metadata, Skills, Channels, Cron и installation/projection/operation. Крупные attachment/artifact bytes находятся в content-addressed Blob Store; SQLite хранит проверенные hashes/references. Runtime directories не могут содержать вторую durable history.

Граница защищает от ошибочного cross-kernel доступа, partial writes, duplicates, traversal, symlinks, corruption, interruption и обычных других OS users. Она не защищает от malware/admin с контролем той же OS account, скомпрометированной ОС, screen capture или физического доступа к разблокированному устройству.

## Шифрование at rest

`node:sqlite` даёт transactions, WAL, integrity check и backup, но **не шифрует базу**. ClawX 0.6.0 не заявляет SQLCipher/application encryption. DB/Blob/backup/quarantine создаются owner-only (directories `0700`, files `0600` там, где доступны POSIX modes), symlinks запрещены. В Windows границей служит ACL user profile. Provider secrets остаются в OS credential store, SQLite содержит только references.

Для конфиденциальности at rest включите FileVault, BitLocker/Device Encryption или LUKS/full-volume encryption. Будущий SQLCipher потребует отдельной проверки native dependency/license, ключа в OS keychain, crash-safe migration, backup/export/recovery/rekey, ограничений secure deletion и packaged tests на пяти targets. До этого данные описываются как plaintext в защищённом user profile.

## Transactions и recovery

Обязательны foreign keys, WAL, busy timeout, schema version, stable event IDs и idempotent admissions. Prompt/run commit выполняется до dispatch, terminal state — атомарно, tool/permission — немедленно, stream deltas — bounded batches. Single-active-run lease и kernel/generation/sequence исключают смешивание late events.

Startup проверяет recovery/integrity до запуска runtimes. Повреждённый primary может быть восстановлен из verified backup; иначе bytes помещаются в quarantine и создаётся новая DB. Если безопасная запись невозможна, включается read-only recovery и отклоняются новые prompts, Channel/Cron admissions и mutations. Disk-full/I/O/backup/restore fail closed без fallback к native history или dual-write.

Backup создаёт Main-owned consistent SQLite snapshot и referenced Blobs в staging, проверяет manifest/hash/schema/owner permissions и отсутствие symlinks. Храните его на зашифрованном носителе. Restore останавливает runtimes/scheduler, проверяет всё в staging, выполняет atomic replace и quick/integrity check. При ошибке текущий store не меняется, candidate quarantine. Нельзя объединять две live DB или копировать только WAL/SHM.

## Retention, delete, export, uninstall

В 0.6.0 нет автоматического удаления по возрасту. Hard delete удаляет Conversation graph и сначала bytes непривязанных Blobs, затем metadata; shared Blobs остаются. Удаление Agent, stop/uninstall/update kernel не удаляет history/provenance; offline history доступна без kernel. Versioned export является обычным plaintext вне owner-only boundary.

Старый backup — независимая копия и не очищается live delete; operator удаляет его по своей retention policy. Default uninstaller сохраняет `<userData>`, SQLite, Blobs, backups и legacy upstream files. Старые `sessions.json`, JSONL, Cron и DSH persistence не импортируются, не служат fallback и не удаляются автоматически; пользователь архивирует/удаляет их вручную.

При завершении recovery запишите state, integrity, schema, backup/Blob hashes, GC, affected operations и restart runtime/scheduler. Новую пустую DB нельзя называть успешным восстановлением quarantined content.
