# Data Security, Recovery, and Retention Policy

Effective for ClawX 0.6.0. This policy applies to new canonical multi-kernel data. Historical OpenClaw or DeepSeek Harness files are not migrated, scanned, or automatically deleted.

## Authority and threat model

Electron Main starts a single DataService utility process, and that process exclusively owns `<userData>/state/clawx.sqlite`. OpenClaw, DeepSeek Harness, channels, the scheduler, extensions, and the Renderer cannot open the database or execute SQL. They receive narrow, authenticated, versioned RPC capabilities. This boundary limits a compromised runtime from reading unrelated conversations, credentials, schedules, or another kernel's private checkpoint.

The SQLite database is the only durable authority for new Conversations, Turns, Runs, events, permissions, Usage, Agents, Provider metadata, Skills state, Channel accounts/bindings/messages/delivery attempts, Cron jobs/admissions/runs, installations, projections, and operations. Large attachment/artifact bytes live in the content-addressed Blob Store; SQLite stores verified hashes and references. Runtime directories may contain replaceable configuration/cache/live process state, but never a second durable history.

The controls protect against accidental cross-kernel access, partial writes, duplicate events, path traversal, symlinks, corruption, interrupted processes, and ordinary access by other OS users. They do not protect against malware or an administrator already controlling the same OS account, a compromised OS/kernel, malicious screen capture, or physical access to an unlocked machine.

## At-rest security boundary

`node:sqlite` provides SQLite, transactions, WAL, integrity checks, and backup; it does **not** encrypt the database. ClawX 0.6.0 does not claim SQLCipher or application-level database encryption. Database, Blob, backup, and quarantine directories are created owner-only (directories `0700`, files `0600` where the platform exposes POSIX modes), reject symlinks, and inherit the current user's Windows profile ACL boundary. Provider secrets remain in OS-protected credential storage and only references appear in SQLite.

For confidentiality at rest, enable FileVault on macOS, BitLocker/Device Encryption on Windows, or LUKS/full-volume encryption on Linux. This is the supported encryption boundary for 0.6.0.

Future SQLCipher adoption requires a separately reviewed native dependency and license, a key generated/stored in the OS keychain, crash-safe plaintext-to-encrypted migration, backup/export/recovery and key-rotation designs, secure deletion limits, five-target packaged tests, and a documented recovery story. Until every gate passes, UI and documentation must continue to say that canonical data is plaintext within the protected user profile.

## Transaction, crash, and corruption behavior

- Foreign keys, WAL, busy timeout, schema versioning, stable event IDs, and idempotent admissions are mandatory.
- A prompt/run admission commits before dispatch. Terminal state and final normalized records commit atomically. Tool and permission decisions commit immediately; stream deltas are bounded batches.
- A single-active-run lease prevents concurrent writers for one Conversation. Kernel/generation/event sequence identity prevents late events from another process incarnation.
- On clean shutdown and backup, WAL state is checkpointed consistently. A killed runtime cannot own or corrupt the database because it never opens it.
- Startup performs recovery and integrity checks before runtimes start. If the primary is corrupt, ClawX may restore a verified backup; otherwise it quarantines the corrupt bytes and starts a new database. If the store is readable but cannot safely write, the app enters read-only recovery and refuses new prompts, channel admissions, Cron admissions, or mutations.
- Disk-full, I/O, backup, and restore failures fail closed and remain diagnosable; they do not fall back to native runtime history or long-term dual writes.

## Backup and restore runbook

1. Stop accepting new mutations or use the Main-owned backup operation, which obtains a consistent SQLite snapshot and copies referenced Blob bytes into a staging directory.
2. Verify every Blob hash and the manifest before publishing the backup directory. Set owner-only permissions recursively and never follow symlinks.
3. Keep the backup on an encrypted destination with access controls appropriate for all contained conversations and attachments.
4. For restore, stop runtimes and the scheduler, verify schema/manifest/hashes, restore into staging, then atomically replace the store. Run quick/integrity checks before resuming work.
5. If validation fails, leave the current store untouched and quarantine the invalid candidate for diagnosis. Never merge two live databases or copy only WAL/SHM files.

Backups are independent snapshots. Deleting a Conversation from the live store does not erase copies in an older backup; the operator must expire or destroy those backups according to their own retention requirement.

## Retention, deletion, export, and uninstall

- Canonical records have no automatic age-based deletion in 0.6.0. They remain until the user explicitly deletes them or removes the ClawX profile.
- Normal delete is a logical delete where offered; hard delete removes the Conversation graph through foreign-key cascades and then garbage-collects unreferenced Blob bytes before their metadata. Referenced/shared blobs remain.
- Deleting an Agent, uninstalling/stopping a kernel, or removing a runtime version never deletes Conversation, Usage, Channel, or Cron provenance. Offline history remains searchable/exportable without a kernel installed.
- Conversation export uses the versioned canonical export format and includes its canonical records/references. Exported files are ordinary user-controlled plaintext and leave ClawX's owner-only directory boundary.
- “Clear logs” affects redacted diagnostics logs, not canonical Conversation history. Kernel repair/update removes replaceable runtime bytes only.
- The default uninstaller preserves `<userData>`, SQLite, Blobs, backups, and legacy upstream files. A future “delete all data” action must be explicit, separately confirmed, precisely scoped, and tested.
- Old OpenClaw `sessions.json`, transcript/trajectory JSONL, Cron history and DSH persistence/schedule files are deliberately not imported, read as fallback, or auto-deleted. Users may archive or delete them manually after verifying their own retention needs.

## Recovery checklist

Before declaring recovery complete, record: database state (`healthy`, `restored-backup`, `read-only`, or `quarantined`), integrity result, schema version, backup manifest/hash result, Blob verification/GC result, affected operations, and whether runtimes/scheduler were restarted. Never describe a newly created empty database as a successful recovery of quarantined content.
