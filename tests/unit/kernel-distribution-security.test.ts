// @vitest-environment node

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKernelDistributionConfiguration } from '@electron/kernels/package-manager/config';
import { canonicalJson } from '@electron/kernels/catalog';
import { buildTrustStoreFromBundle } from '../../scripts/kernel-runtime/lib/trust-store.mjs';
import { buildStagingArtifactTrust } from '../../scripts/kernel-runtime/write-staging-artifact-trust.mjs';
import { assertDescriptorDistributionUrl } from '../../scripts/kernel-runtime/verify-release-set.mjs';

const now = new Date('2026-08-24T00:00:00.000Z');

function key(keyId: string, purposes: string[], overrides: Record<string, unknown> = {}) {
  const pair = generateKeyPairSync('ed25519');
  return {
    keyId,
    purposes,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2028-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function encoded(keys: unknown[]): string {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, keys })).toString('base64');
}

describe('kernel distribution release trust', () => {
  it('derives an artifact-only clean-machine trust root from the exact staging signing key', () => {
    const pair = generateKeyPairSync('ed25519');
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const unsigned = {
      schemaVersion: 1,
      kernelId: 'openclaw',
      publishedAt: '2026-08-24T00:00:00.000Z',
      expiresAt: '2027-08-24T00:00:00.000Z',
    };
    const descriptor = {
      ...unsigned,
      descriptorSignature: {
        algorithm: 'Ed25519',
        keyId: 'artifact-staging-2026-08',
        signature: sign(null, Buffer.from(canonicalJson(unsigned)), pair.privateKey).toString('base64url'),
      },
    };
    const trust = buildStagingArtifactTrust([descriptor], privateKeyPem, 'artifact-staging-2026-08');
    expect(trust).toEqual({
      schemaVersion: 1,
      keys: [expect.objectContaining({
        keyId: 'artifact-staging-2026-08',
        algorithm: 'Ed25519',
        purposes: ['artifact'],
        notBefore: unsigned.publishedAt,
        notAfter: unsigned.expiresAt,
      })],
    });
    expect(() => buildStagingArtifactTrust([descriptor], privateKeyPem, 'artifact-other'))
      .toThrow(/does not match the staging artifact key/);
  });

  it('binds production promotion to one successful staging run and exact source SHA', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/kernel-runtime-promote.yml'), 'utf8');
    expect(workflow).toContain('expected-source-sha:');
    expect(workflow).toContain("test \"$actual_name\" = 'Build signed kernel runtimes'");
    expect(workflow).toContain("test \"$actual_conclusion\" = 'success'");
    expect(workflow).toContain('test "$actual_sha" = "$EXPECTED_SOURCE_SHA"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA"');
    expect(workflow).toContain('pattern: kernel-runtime-*');
    expect(workflow).not.toContain('pattern: kernel-*\n');
    expect(workflow).toContain('scripts/kernel-runtime/resolve-previous-catalog.mjs');
    expect(workflow).toContain('--trust-store temp/roots.production.json');
    expect(workflow).toContain('--bootstrap "$BOOTSTRAP"');
    expect(workflow).toContain('--github-repository "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('--distribution resources/kernels/distribution.json');
    expect(workflow).not.toContain('previous-catalog-artifact:');
  });

  it('allows descriptor URLs only at an exact configured immutable mirror root', () => {
    const distribution = {
      mirrorBaseUrls: [
        'https://oss.example.invalid/kernels/',
        'https://github.com/example/clawx/releases/download/kernel-runtimes/',
      ],
    };
    const descriptor = {
      kernelId: 'openclaw', artifactVersion: '1.0.0+clawx.1', platform: 'linux', arch: 'x64',
      archive: { url: 'https://oss.example.invalid/kernels/openclaw.tar.zst' },
    };
    expect(() => assertDescriptorDistributionUrl(descriptor, distribution)).not.toThrow();
    expect(() => assertDescriptorDistributionUrl({
      ...descriptor,
      archive: { url: 'https://oss.example.invalid/kernels/nested/openclaw.tar.zst' },
    }, distribution)).toThrow(/outside configured immutable mirrors/);
    expect(() => assertDescriptorDistributionUrl({
      ...descriptor,
      archive: { url: 'https://attacker.invalid/openclaw.tar.zst' },
    }, distribution)).toThrow(/outside configured immutable mirrors/);
  });

  it('builds deterministic public roots and retains revoked predecessors during rotation', () => {
    const retired = key('artifact-2025-01', ['artifact'], { revokedAt: '2026-08-01T00:00:00.000Z' });
    const keys = [
      retired,
      key('artifact-2026-08', ['artifact']),
      key('catalog-2026-08', ['catalog']),
      key('rollback-2026-08', ['rollback']),
    ];
    const store = buildTrustStoreFromBundle(encoded(keys), { channel: 'production', now });
    expect(store.keys.map(item => item.keyId)).toEqual([
      'artifact-2025-01', 'artifact-2026-08', 'catalog-2026-08', 'rollback-2026-08',
    ]);
    expect(store.keys[0]).toMatchObject({ revokedAt: '2026-08-01T00:00:00.000Z' });
  });

  it('loads a rotation keyring when every purpose has an active key and rejects revoked-only purpose coverage', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-release-trust-'));
    const kernels = join(root, 'resources', 'kernels');
    mkdirSync(join(kernels, 'trust'), { recursive: true });
    writeFileSync(join(kernels, 'distribution.json'), JSON.stringify({
      schemaVersion: 1,
      channel: 'production',
      catalogUrls: ['https://oss.example.invalid/catalog.json'],
      mirrorBaseUrls: ['https://github.example.invalid/kernels/'],
    }));
    const active = [
      key('artifact-2026-08', ['artifact']),
      key('catalog-2026-08', ['catalog']),
      key('rollback-2026-08', ['rollback']),
    ];
    const withRetired = buildTrustStoreFromBundle(encoded([
      key('artifact-2025-01', ['artifact'], { revokedAt: '2026-08-01T00:00:00.000Z' }),
      ...active,
    ]), { channel: 'production', now });
    writeFileSync(join(kernels, 'trust', 'roots.production.json'), JSON.stringify(withRetired));
    expect(loadKernelDistributionConfiguration({
      packaged: true, resourcesPath: root, now,
    }).trustStore?.keys).toHaveLength(4);

    const revokedCatalog = {
      schemaVersion: 1,
      keys: active.map(item => ({ algorithm: 'Ed25519', ...item })).map(item => (
        item.keyId.startsWith('catalog-') ? { ...item, revokedAt: '2026-08-01T00:00:00.000Z' } : item
      )),
    };
    writeFileSync(join(kernels, 'trust', 'roots.production.json'), JSON.stringify(revokedCatalog));
    expect(loadKernelDistributionConfiguration({
      packaged: true, resourcesPath: root, now,
    }).unavailableReason).toMatch(/no active catalog verification key/);
  });

  it('rejects production-looking mistakes and non-Ed25519 material before packaging', () => {
    expect(() => buildTrustStoreFromBundle(encoded([
      key('artifact-test-key', ['artifact', 'catalog', 'rollback']),
    ]), { channel: 'production', now })).toThrow(/not release-safe/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => buildTrustStoreFromBundle(encoded([{
      ...key('release-2026-08', ['artifact', 'catalog', 'rollback']),
      publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }]), { channel: 'production', now })).toThrow(/Ed25519/);
  });
});
