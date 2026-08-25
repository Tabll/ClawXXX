# 数据安全、恢复与保留策略

自 ClawX 0.6.0 起生效，适用于新建的多内核 canonical 数据。旧 OpenClaw/DeepSeek Harness 文件不迁移、不扫描、也不自动删除。

## 数据权威与威胁模型

Electron Main 启动唯一 DataService utility process，并由它独占 `<userData>/state/clawx.sqlite`。OpenClaw、DSH、Channels、Scheduler、Extensions 和 Renderer 都不能打开数据库或执行 SQL，只能使用狭窄、认证、版本化的 RPC 能力。即使某个 runtime 被攻破，也不能因此读取无关 Conversation、凭据、任务或另一个内核的私有 checkpoint。

SQLite 是新 Conversation、Turn、Run、Event、Permission、Usage、Agent、Provider 元数据、Skill 状态、Channel account/binding/message/delivery、Cron job/admission/run、安装、投影和 operation 的唯一 durable authority。大附件/制品字节进入 content-addressed Blob Store，SQLite 只保存已校验 hash 与引用。Runtime 目录只能有可替换配置、缓存和进程态，不得出现第二份 durable history。

该边界防护跨内核误访问、部分写入、重复事件、路径穿越、软链接、损坏、中断和其他普通 OS 用户访问；不防护已控制同一 OS 账号的恶意程序/管理员、被攻破的 OS/kernel、屏幕窃取或解锁设备的物理访问。

## 静态数据加密边界

`node:sqlite` 提供 SQLite、事务、WAL、integrity check 和 backup，**不提供数据库加密**。ClawX 0.6.0 不声称已使用 SQLCipher 或应用层加密。数据库、Blob、backup、quarantine 目录以 owner-only 创建（支持 POSIX mode 的平台上目录 `0700`、文件 `0600`），拒绝软链接；Windows 依赖当前用户 profile ACL 边界。Provider secret 只在 OS 安全凭据存储，SQLite 仅保存引用。

需要静态机密性时，请启用 macOS FileVault、Windows BitLocker/设备加密或 Linux LUKS/全盘加密；这是 0.6.0 的受支持加密边界。

未来采用 SQLCipher 必须单独评审 native 依赖与许可证、由 OS keychain 生成/保存密钥、可崩溃恢复的明文到密文迁移、backup/export/recovery/rekey、secure deletion 限制及五目标 packaged test。全部闸门通过前，UI 和文档必须继续明确 canonical 数据在受保护用户目录内为明文。

## 事务、崩溃与损坏行为

- 强制 foreign keys、WAL、busy timeout、schema version、stable event ID 和幂等 admission。
- Prompt/run admission 在 dispatch 前提交；terminal state 与最终规范记录原子提交；tool/permission 立即提交，stream delta 有界批量提交。
- 单 Conversation single-active-run lease 防止并发写；kernel/generation/event sequence 防止旧进程迟到事件串线。
- 正常退出与 backup 使用一致 SQLite snapshot/checkpoint。Runtime 从不打开数据库，因此被 kill 不会拥有或直接损坏 DB。
- Startup 在 runtime 前完成恢复与 integrity check。主库损坏时可恢复已验证 backup；否则隔离损坏字节并新建库。若可读但不能安全写，进入 read-only recovery，并拒绝新 prompt、Channel/Cron admission 和 mutation。
- Disk-full、I/O、backup/restore 失败全部 fail closed；不得回退 runtime native history 或长期双写。

## Backup/Restore Runbook

1. 停止新 mutation，或使用 Main-owned backup 操作获取一致 SQLite snapshot，并把被引用 Blob 复制到 staging。
2. 发布 backup 前验证所有 Blob hash 与 manifest，递归设置 owner-only 权限且绝不跟随软链接。
3. Backup 包含全部会话与附件，应存放在加密且有相应访问控制的目标。
4. Restore 时停止 runtimes 与 scheduler，验证 schema/manifest/hash，在 staging 恢复后原子替换，并在恢复工作前运行 quick/integrity check。
5. 验证失败时保持当前 store 不变，隔离无效候选；不得合并两个 live DB，也不得只复制 WAL/SHM。

Backup 是独立快照。删除 live Conversation 不会擦除旧 backup 中的副本；操作者必须按自己的保留要求到期或销毁 backup。

## 保留、删除、导出与卸载

- 0.6.0 不按年龄自动删除 canonical records；用户明确删除或删除整个 ClawX profile 前一直保留。
- 普通删除在适用处是逻辑删除；hard delete 通过外键级联删除 Conversation graph，然后先删除无引用 Blob 字节、再清理其 metadata；仍被引用/共享的 Blob 保留。
- 删除 Agent、停止/卸载内核或移除 runtime 版本都不删除 Conversation、Usage、Channel、Cron provenance；无内核也能离线搜索/导出历史。
- Conversation export 使用版本化 canonical 格式并包含规范记录/引用；导出文件是用户控制的普通明文，已离开 ClawX owner-only 边界。
- “清除日志”只影响脱敏 diagnostics log，不影响 canonical history；Kernel repair/update 只移除可替换 runtime 字节。
- 默认卸载器保留 `<userData>`、SQLite、Blob、backup 和旧上游文件。未来“删除全部数据”必须显式、二次确认、精确限定范围并经过测试。
- 旧 OpenClaw `sessions.json`、transcript/trajectory JSONL、Cron history 和 DSH persistence/schedule 不导入、不作 fallback、不自动删除；用户确认自身保留要求后可自行归档或清理。

## 恢复完成检查

必须记录 DB 状态（`healthy`、`restored-backup`、`read-only` 或 `quarantined`）、integrity 结果、schema version、backup manifest/hash、Blob 校验/GC、受影响 operations，以及 runtimes/scheduler 是否重启。新建空库不能描述为“已恢复”被隔离的内容。
