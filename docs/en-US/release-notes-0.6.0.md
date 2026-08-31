# ClawX 0.6.0 Multi-Kernel Release Notes

Status: implementation release candidate. Public availability remains conditional on the protected five-target runtime build/promotion and signed packaged-app gates.

## Highlights

- OpenClaw is removed from the base installer and becomes an optional first-use download.
- DeepSeek Harness `0.1.1-rc.2+clawx.8` is the second optional kernel; OpenClaw and DSH can run concurrently and update or fail independently.
- Both kernels use the existing ClawX Chat, Providers/Models, Agents, Channels, Cron, Skills, Usage, and Diagnostics UI and the same canonical contracts.
- One Main-owned SQLite/Blob service stores all new durable history. The same Conversation can continue on another kernel at a turn boundary through a redacted portable context.
- Kernel runtimes are reproducible, patched CI artifacts with signed expiring metadata, platform security evidence, SBOMs, provenance, license reports, rollback, repair, and two-mirror distribution.
- History remains available for search, rename, export, and deletion when no kernel is installed.

## Intentional compatibility changes

- ClawX 0.6.0 starts a new canonical history store. Existing OpenClaw/DSH conversation or Cron files are not migrated, scanned, deleted, or used as fallback.
- Full optional-kernel support requires macOS 13.5+, Windows 10 x64, or the documented Linux baseline. Linux musl/Alpine and Windows arm64 are not supported in this release.
- The unlicensed QQ QR-login dependency is not distributed; configure QQ manually with AppID/AppSecret.
- OpenClaw and DSH runtime versions are pinned. Installing arbitrary upstream package builds is unsupported.

## Security and data notes

SQLite data is plaintext inside an owner-only user profile; use OS full-volume encryption for at-rest confidentiality. Uninstall preserves canonical and legacy user data by default. Read the [runtime security/support policy](runtime-security-support.md) and [data security/retention policy](data-security-retention.md) before deployment.

## Release evidence required before publishing

- two kernels × five target runtime artifacts pass clean-machine smoke and storage-contract scans;
- macOS signing/notarization and Windows Authenticode/install/update/uninstall evidence is retained;
- Tencent COS/GitHub catalog and Range-resume drill passes;
- complete typecheck, lint, unit, Electron E2E, comms and Harness checks pass;
- GPL/LGPL/MPL source obligations and the `libsignal` legal checkpoint are approved.
