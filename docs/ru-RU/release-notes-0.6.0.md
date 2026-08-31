# ClawX 0.6.0: выпуск с несколькими ядрами

Статус: implementation release candidate. Публичный выпуск зависит от protected CI promotion для 2 kernels × 5 targets и gates подписанных host packages.

## Главное

- OpenClaw удалён из base installer и загружается по выбору при первом использовании.
- DeepSeek Harness `0.1.2-alpha.2+clawx.9` добавлен вторым optional kernel; оба могут работать одновременно и независимо обновляться, завершаться с ошибкой и откатываться.
- Оба используют единые ClawX Chat, Providers/Models, Agents, Channels, Cron, Skills, Usage, Diagnostics и canonical contracts.
- Вся новая durable history хранится в одном Main-owned SQLite/Blob. Один Conversation можно продолжить другим kernel на границе turn через redacted portable context.
- Runtime — воспроизводимый patched CI artifact с signed/expiring metadata, platform evidence, SBOM, provenance, license report, repair/rollback и зеркалами Tencent COS/GitHub.
- History можно искать, переименовывать, экспортировать и удалять даже без установленного kernel.

0.6.0 начинает новый canonical store: старые Conversation/Cron OpenClaw/DSH не мигрируются, не сканируются, не удаляются и не используются как fallback. Полная поддержка требует macOS 13.5+, Windows 10 x64 либо документированную Linux baseline; musl/Alpine и Windows arm64 не поддерживаются. QQ QR dependency без лицензии исключена, доступна ручная AppID/AppSecret настройка.

SQLite остаётся plaintext внутри owner-only user profile; используйте full-volume encryption ОС. Default uninstall сохраняет новые и legacy user data. См. [runtime security/support](runtime-security-support.md) и [data security/retention](data-security-retention.md).
