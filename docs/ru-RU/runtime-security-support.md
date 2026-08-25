# Безопасность, поддержка и EOL сред выполнения

Политика действует с ClawX 0.6.0 для отдельно загружаемых OpenClaw и DeepSeek Harness. Возможность сборки в CI не означает публикацию: продвижение в production разрешено только при наличии всех свидетельств из защищённого release environment.

## Матрица поддержки

| Хост | Архитектуры | Обязательная база | Статус |
| --- | --- | --- | --- |
| macOS 13.5+ | arm64, x64 | Hardened Runtime, Developer ID, notarization Apple | обязательно |
| Windows 10 / Server 2016+ | x64 | Authenticode SHA-256 и timestamp | обязательно |
| Ubuntu 24.04 или совместимый glibc | x64, arm64 | glibc >= 2.39, kernel >= 6.8, sandbox smoke | обязательно |
| Linux musl/Alpine | — | вне контракта glibc | не поддерживается |
| Windows arm64 | — | нет release artifact | отложено |
| Linux arm64 RPM | arm64 | tar.zst/deb поддерживаются | отложено |

Для каждого ядра обязательны пять artifacts: Darwin arm64/x64, Windows x64 и Linux arm64/x64. Базовое приложение может открыть offline-данные на более широкой ОС, но install/start ядра поддерживается только по этой таблице.

## Supply-chain и выпуск

Source manifest фиксирует upstream commit/npm integrity, lockfile, patch series, overlay, дистрибутив Node и воспроизводимый timestamp. На машине пользователя npm/pnpm не запускается. Точный payload проходит contract tests, запрет native history, license audit и platform security; CI создаёт SPDX/CycloneDX, provenance и отчёты.

Mach-O подписываются leaf-first, а notarization всего macOS closure должна иметь статус `Accepted`. Windows `.exe`/`.dll`/`.node` проходят Authenticode. Linux фиксирует и повторно проверяет ABI. Ed25519 artifact key подписывает immutable descriptor, отдельный catalog key — монотонный и ограниченный по времени catalog. Сначала публикуются неизменяемые artifacts в OSS и GitHub, catalog — последним. После этого проверяются идентичность catalog, conditional cache и Range resume с двух независимых hosts.

До activation клиент отклоняет expired/revoked/downgrade/incompatible, non-HTTPS, oversized, traversal/symlink, неверно подписанные или нарушающие storage authority inputs.

## Rotation и revocation ключей

Private keys находятся только в защищённом CI или approved offline signer и не попадают в repository, artifact, logs или user profile. При штатной rotation сначала выпускается host с обоими public roots. Overlap длится минимум один поддерживаемый host release и весь срок проверки ещё действующих metadata. Затем новые metadata подписываются новым key, выполняется production drill, старый private key отключается. Root нельзя удалять, пока он нужен valid catalog/artifact/rollback.

При компрометации promotion останавливается, evidence сохраняется, root получает `revokedAt`, а affected descriptors — catalog revocations, подписанные незатронутым catalog key либо offline rollback key. На оба mirror публикуется short-lived catalog с большим sequence. Sequence нельзя повторять, immutable bytes нельзя перезаписывать. Если безопасного online key не осталось, клиент fail closed до host trust-store update. Исправление собирается из reviewed source с новым artifact/patch version; переименование или повторная подпись скомпрометированных bytes запрещены.

Offline rollback key имеет только purpose `rollback`, не применяется для обычных releases и не обходит compatibility, revocation, digest, platform signature или storage authority.

## Platform signing, compatibility и EOL

macOS host CI проверяет strict `codesign`, Gatekeeper и stapled ticket. Windows подписывается во время electron-builder packaging, поэтому подписаны installed app и installer, а electron-updater проверяет publisher. Alpha, beta и stable имеют один gate.

Compatibility принудительно проверяет host version, protocol, bridge identity, platform/arch и mandatory capabilities. Kernels обновляются независимо; active и предыдущая verified версия сохраняются для atomic rollback. Security revocation может дать немедленный EOL; обычный EOL заранее публикуется в release notes. Удаление из catalog не удаляет установленный runtime или canonical data. Для prerelease DSH поддерживается только точная patched revision.

License audit — инженерный gate, не юридическая консультация. До публичного выпуска обязательны GPL/LGPL/MPL source obligations и юридическое одобрение `libsignal`. QQ QR connector без лицензии исключён; ручная настройка AppID/AppSecret остаётся.

`kernel-runtime-build.yml` проводит каждый реальный artifact через production-путь Package Manager и отдельным job проверяет одновременный запуск двух artifacts и изоляцию отказа. `kernel-runtime-promote.yml` проверяет и публикует полный набор. Перед упаковкой `release.yml` повторяет все unit/contract/type/lint/chaos/comms/Harness, Electron E2E на macOS/Windows/Linux и live Range drill двух mirrors; `win-build-test.yml` сохраняет focused-проверку подписанного installer. Logs подписи/notarization, catalog sequence, hashes, distribution drill и legal approval хранятся с release; локальный тест их не заменяет.
