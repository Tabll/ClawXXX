// @vitest-environment node

import { createPublicKey } from 'node:crypto';
import {
  buildGitHubEnvironmentSecrets,
  buildPublicTrustBundle,
  decryptKernelSigningKeyPayload,
  encryptKernelSigningKeyPayload,
  generateKernelSigningKeyPayload,
} from '../../scripts/kernel-runtime/lib/key-backup.mjs';
import { buildTrustStoreFromBundle } from '../../scripts/kernel-runtime/lib/trust-store.mjs';
import { describe, expect, it } from 'vitest';

const passphrase = 'correct horse battery staple with entropy';
const payload = () => generateKernelSigningKeyPayload({
  createdAt: '2026-08-31T00:00:00.000Z',
  notBefore: '2026-08-30T00:00:00.000Z',
  notAfter: '2028-09-01T00:00:00.000Z',
  keyIdSuffix: '2026-08',
});

describe('kernel signing key encrypted backup', () => {
  it('creates three independent Ed25519 roles and a production-valid public trust bundle', () => {
    const generated = payload();
    expect(generated.keys.map(key => key.role)).toEqual(['artifact', 'catalog', 'rollback']);
    expect(new Set(generated.keys.map(key => key.publicKeyPem)).size).toBe(3);
    for (const key of generated.keys) {
      expect(createPublicKey(key.publicKeyPem).asymmetricKeyType).toBe('ed25519');
    }
    const bundle = buildPublicTrustBundle(generated);
    const store = buildTrustStoreFromBundle(Buffer.from(JSON.stringify(bundle)).toString('base64'), {
      channel: 'production',
      now: new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(store.keys).toHaveLength(3);
  });

  it('round-trips only with the correct passphrase and authenticates every envelope field', () => {
    const generated = payload();
    const envelope = encryptKernelSigningKeyPayload(generated, passphrase, {
      salt: Buffer.alloc(32, 7),
      nonce: Buffer.alloc(12, 9),
    });
    expect(decryptKernelSigningKeyPayload(envelope, passphrase)).toEqual(generated);
    expect(() => decryptKernelSigningKeyPayload(envelope, `${passphrase}-wrong`)).toThrow(/authentication failed/);
    expect(() => decryptKernelSigningKeyPayload({ ...envelope, plaintextSha256: '0'.repeat(64) }, passphrase))
      .toThrow(/digest mismatch/);
    expect(() => decryptKernelSigningKeyPayload({
      ...envelope,
      kdf: { ...envelope.kdf, N: 16384 },
    }, passphrase)).toThrow(/unsupported cryptographic parameters/);
  });

  it('exports only artifact material to staging and only catalog plus public roots to production', () => {
    const secrets = buildGitHubEnvironmentSecrets(payload());
    expect(Object.keys(secrets['kernel-staging']).sort()).toEqual([
      'CLAWX_ARTIFACT_SIGNING_KEY_ID',
      'CLAWX_ARTIFACT_SIGNING_PRIVATE_KEY_B64',
    ]);
    expect(Object.keys(secrets['kernel-production']).sort()).toEqual([
      'CLAWX_CATALOG_SIGNING_KEY_ID',
      'CLAWX_CATALOG_SIGNING_PRIVATE_KEY_B64',
      'CLAWX_KERNEL_TRUST_KEYS_B64',
    ]);
    expect(JSON.stringify(secrets)).not.toContain('ROLLBACK_SIGNING_PRIVATE');
  });
});
