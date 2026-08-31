# Kernel release trust and key operations

ClawX kernel distribution uses three independent Ed25519 key roles:

- `artifact`: signs one immutable OS/architecture artifact descriptor in the staging build environment.
- `catalog`: signs the production catalog only after clean-machine smoke and approval; the build environment never receives this key.
- `rollback`: an offline emergency key that authorizes one exact `highest sequence -> target sequence + target catalog digest` downgrade for a short time window.

Private keys must be generated and retained in the release operator's HSM or CI secret manager. They are never generated during a normal build, committed, placed in an artifact, or printed in logs. The repository deliberately contains no production private key and no fake production root. An app release injects the reviewed public trust store as `kernels/trust/roots.production.json`; release validation fails if that file is missing, has a development key ID, lacks one of the three roles, or contains an expired key.

The supported bootstrap path is `pnpm kernel:keys`. It creates three independent Ed25519 key pairs and encrypts the complete recovery payload with scrypt plus AES-256-GCM. Secret inputs and outputs are restricted to the git-ignored, owner-only `.clawx-secrets/` directory, existing backups are never overwritten, and the CLI never accepts a passphrase as a command-line argument. The artifact private key is exported only to `kernel-staging`; the catalog private key and public trust bundle are exported only to `kernel-production`; the rollback private key is never exported to GitHub. A local encrypted file is only an offline-ready copy: the encrypted file and its recovery passphrase must be copied to separate offline media before the local copy is considered a disaster-recovery backup.

## Rotation

At least one app release before switching signers, add the next public key with an overlapping validity window while retaining the old key. Publish with the new key only after clients have the next root. Keep the old public key until every catalog/artifact it signed has expired. This “pre-trusted next root” process avoids fetching trust roots from the same channel they authenticate.

## Revocation

- Compromised artifact: add its full `kernelId/artifactVersion/platform-arch` identity to the next catalog's signed revocation list.
- Compromised artifact/catalog key: ship a trust-store update setting `revokedAt`, switch to the already pre-trusted next key, and increment the catalog sequence. Do not silently reuse an old sequence.
- Bad runtime without key compromise: publish a higher-sequence fixed artifact. If availability requires a downgrade, use `authorize-rollback.mjs` with the offline rollback key; clients retain their historical highest sequence after the temporary downgrade.

CI environments are separated as follows: `kernel-staging` may read the artifact key and build staging objects; `kernel-production` may read the catalog key and publish only the reviewed Tencent COS/GitHub objects after approval; the rollback key is never available to either routine environment.

The exact protected-environment secret inventory, staging/promotion commands, repository binding, evidence checklist, and safe recovery from a partially published two-mirror catalog are documented in `docs/zh-CN/operations/kernel-runtime-release-runbook.md`.
