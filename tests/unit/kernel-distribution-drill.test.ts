// @vitest-environment node

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../scripts/kernel-runtime/lib/canonical.mjs';
import { drillKernelDistribution } from '../../scripts/kernel-runtime/distribution-drill.mjs';

describe('production kernel distribution drill', () => {
  it('verifies mirrored catalogs and two-host Range/If-Range resume for each kernel', async () => {
    const keys = {
      artifact: generateKeyPairSync('ed25519'),
      catalog: generateKeyPairSync('ed25519'),
    };
    const descriptor = (kernelId: string) => signed({
      schemaVersion: 1,
      kernelId,
      artifactVersion: `1.0.0+clawx.1`,
      platform: 'linux',
      arch: 'x64',
      storage: { authority: 'clawx-data-service', nativeDurableHistory: false },
      archive: {
        format: 'tar.zst',
        url: `http://primary.test/${kernelId}.tar.zst`,
        sha256: 'a'.repeat(64),
      },
      publishedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }, 'descriptorSignature', 'artifact-key', keys.artifact.privateKey);
    const catalog = signed({
      schemaVersion: 1,
      channel: 'production',
      sequence: 7,
      issuedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      artifacts: [descriptor('openclaw'), descriptor('deepseek-harness')],
      revokedArtifactIdentities: [],
    }, 'catalogSignature', 'catalog-key', keys.catalog.privateKey);
    const trustStore = {
      schemaVersion: 1,
      keys: [
        trustKey('artifact-key', ['artifact'], keys.artifact.publicKey),
        trustKey('catalog-key', ['catalog'], keys.catalog.publicKey),
      ],
    };
    const calls: Array<{ url: string; range?: string }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, range: headers.get('range') ?? undefined });
      if (url.includes('catalog')) {
        if (headers.has('if-none-match')) return new Response(null, { status: 304 });
        return new Response(JSON.stringify(catalog), { status: 200, headers: { ETag: '"catalog-7"' } });
      }
      const range = headers.get('range');
      const start = range?.includes('1024-') ? 1024 : 0;
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: { ETag: '"artifact"', 'Content-Range': `bytes ${start}-${start + 1023}/4096` },
      });
    };
    const result = await drillKernelDistribution({
      distribution: {
        catalogUrls: ['http://catalog-a.test/catalog', 'http://catalog-b.test/catalog'],
        mirrorBaseUrls: ['http://mirror.test/kernels'],
      },
      trustStore,
      kernelIds: ['openclaw', 'deepseek-harness'],
      platform: 'linux',
      arch: 'x64',
      now: new Date('2026-08-24T00:00:00.000Z'),
      fetcher,
      allowHttp: true,
    });
    expect(result).toMatchObject({ ok: true, catalogSequence: 7 });
    expect(result.artifacts).toHaveLength(2);
    expect(calls.filter(call => call.range === 'bytes=1024-2047')).toHaveLength(4);
  });

  it('retries transient mirror propagation failures before accepting a consistent release', async () => {
    const keys = {
      artifact: generateKeyPairSync('ed25519'),
      catalog: generateKeyPairSync('ed25519'),
    };
    const descriptor = signed({
      schemaVersion: 1,
      kernelId: 'openclaw',
      artifactVersion: '1.0.0+clawx.1',
      platform: 'linux',
      arch: 'x64',
      storage: { authority: 'clawx-data-service', nativeDurableHistory: false },
      archive: { format: 'tar.zst', url: 'http://primary.test/openclaw.tar.zst', sha256: 'a'.repeat(64) },
      publishedAt: '2026-08-23T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }, 'descriptorSignature', 'artifact-key', keys.artifact.privateKey);
    const catalog = signed({
      schemaVersion: 1, channel: 'production', sequence: 8,
      issuedAt: '2026-08-23T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
      artifacts: [descriptor], revokedArtifactIdentities: [],
    }, 'catalogSignature', 'catalog-key', keys.catalog.privateKey);
    let failedCatalogOnce = false;
    let failedRangeOnce = false;
    const fetcher = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (url.includes('catalog')) {
        if (!failedCatalogOnce) {
          failedCatalogOnce = true;
          return new Response(null, { status: 503 });
        }
        if (headers.has('if-none-match')) return new Response(null, { status: 304 });
        return new Response(JSON.stringify(catalog), { status: 200, headers: { ETag: '"catalog-8"' } });
      }
      if (!failedRangeOnce) {
        failedRangeOnce = true;
        return new Response(null, { status: 503 });
      }
      const start = headers.get('range')?.includes('1024-') ? 1024 : 0;
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: { ETag: '"artifact"', 'Content-Range': `bytes ${start}-${start + 1023}/4096` },
      });
    };
    const result = await drillKernelDistribution({
      distribution: {
        catalogUrls: ['http://catalog-a.test/catalog', 'http://catalog-b.test/catalog'],
        mirrorBaseUrls: ['http://mirror.test/kernels'],
      },
      trustStore: {
        schemaVersion: 1,
        keys: [
          trustKey('artifact-key', ['artifact'], keys.artifact.publicKey),
          trustKey('catalog-key', ['catalog'], keys.catalog.publicKey),
        ],
      },
      kernelIds: ['openclaw'], platform: 'linux', arch: 'x64',
      now: new Date('2026-08-24T00:00:00.000Z'), fetcher, allowHttp: true,
      probeAttempts: 2, retryDelayMs: 0,
    });
    expect(result).toMatchObject({ ok: true, catalogSequence: 8 });
    expect(failedCatalogOnce).toBe(true);
    expect(failedRangeOnce).toBe(true);
  });
});

function signed(value: Record<string, unknown>, field: string, keyId: string, privateKey: KeyObject) {
  return {
    ...value,
    [field]: {
      algorithm: 'Ed25519',
      keyId,
      signature: sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64url'),
    },
  };
}

function trustKey(keyId: string, purposes: string[], publicKey: KeyObject) {
  return {
    keyId,
    algorithm: 'Ed25519',
    purposes,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2028-01-01T00:00:00.000Z',
  };
}
