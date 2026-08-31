// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeRelativeKey, TencentCosPublisher } from '../../scripts/kernel-runtime/lib/tencent-cos.mjs';

function publisher(client: Record<string, ReturnType<typeof vi.fn>>) {
  return new TencentCosPublisher({
    client,
    bucket: 'aq-pub-1252262977',
    region: 'ap-shanghai',
    rootPrefix: 'clawxxx',
  });
}

describe('Tencent COS release publisher', () => {
  it('keeps both publishing workflows on the pinned COS tool and protected production environment', () => {
    const promote = readFileSync(join(process.cwd(), '.github/workflows/kernel-runtime-promote.yml'), 'utf8');
    const release = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const distribution = readFileSync(join(process.cwd(), 'resources/kernels/distribution.json'), 'utf8');
    for (const source of [promote, release]) {
      expect(source).toContain('TENCENTCLOUD_SECRET_ID');
      expect(source).toContain('TENCENTCLOUD_SECRET_KEY');
      expect(source).toContain('node scripts/tencent-cos.mjs verify-bucket');
      expect(source).not.toMatch(/ossutil|OSS_ACCESS_KEY|valuecell-clawx|intelli-spectrum/);
    }
    expect(promote.indexOf('verify-bucket')).toBeLessThan(promote.indexOf('put-immutable'));
    expect(promote.indexOf('put-immutable')).toBeLessThan(promote.indexOf('put-mutable'));
    expect(release).toContain('upload-cos:');
    expect(release).toMatch(/upload-cos:\n\s+needs: release\n\s+environment: kernel-production/);
    expect(release.indexOf('put-directory-immutable')).toBeLessThan(release.indexOf('sync-channel'));
    expect(distribution).toContain('aq-pub-1252262977.cos.ap-shanghai.tencentcos.cn/clawxxx/kernels/');
  });

  it('rejects traversal, absolute and backslash object keys', () => {
    expect(() => normalizeRelativeKey('../catalog.json')).toThrow(/Unsafe/);
    expect(() => normalizeRelativeKey('/catalog.json')).toThrow(/Unsafe/);
    expect(() => normalizeRelativeKey('kernels\\catalog.json')).toThrow(/Unsafe/);
    expect(() => normalizeRelativeKey('kernels//catalog.json')).toThrow(/Unsafe/);
    expect(() => normalizeRelativeKey('kernels/%2e%2e/catalog.json')).toThrow(/Unsafe/);
    expect(() => normalizeRelativeKey('kernels/catalog.json?version=2')).toThrow(/Unsafe/);
    expect(normalizeRelativeKey('kernels/catalog.json')).toBe('kernels/catalog.json');
  });

  it('never overwrites a differing immutable object', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-cos-test-'));
    const file = join(root, 'runtime.tar.zst');
    writeFileSync(file, 'new bytes');
    const client = {
      headObject: vi.fn().mockResolvedValue({ headers: { 'x-cos-meta-clawx-sha256': '0'.repeat(64) } }),
      getObject: vi.fn().mockImplementation(async ({ Output }) => {
        Output.end('old bytes');
        await new Promise(resolve => Output.on('finish', resolve));
        return {};
      }),
      uploadFile: vi.fn(),
    };
    try {
      await expect(publisher(client).putImmutable(file, 'kernels/runtime.tar.zst')).rejects.toThrow(/Immutable Tencent COS object differs/);
      expect(client.uploadFile).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads immutable content with public-read, digest metadata and overwrite prohibition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-cos-test-'));
    const file = join(root, 'descriptor.json');
    writeFileSync(file, '{}');
    const client = {
      headObject: vi.fn()
        .mockRejectedValueOnce({ statusCode: 404, code: 'NoSuchKey' })
        .mockResolvedValueOnce({ headers: { 'x-cos-meta-clawx-sha256': '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' } }),
      putObject: vi.fn().mockImplementation(async ({ Body }) => {
        for await (const _chunk of Body) {
          // Drain the same stream shape used by the real COS client.
        }
        return {};
      }),
      uploadFile: vi.fn(),
    };
    try {
      await expect(publisher(client).putImmutable(file, 'kernels/descriptor.json')).resolves.toMatchObject({ action: 'uploaded' });
      expect(client.putObject).toHaveBeenCalledWith(expect.objectContaining({
        Bucket: 'aq-pub-1252262977',
        Region: 'ap-shanghai',
        Key: 'clawxxx/kernels/descriptor.json',
        ACL: 'public-read',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
        'x-cos-meta-clawx-sha256': '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      }));
      expect(client.uploadFile).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('syncs only the three allowed mutable channels and removes stale keys after uploads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-cos-test-'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'app.zip'), 'zip');
    writeFileSync(join(root, 'latest.yml'), 'version: 1');
    const client = {
      uploadFile: vi.fn().mockResolvedValue({}),
      headObject: vi.fn().mockImplementation(async ({ Key }) => ({
        headers: { 'x-cos-meta-clawx-sha256': Key.endsWith('.zip')
          ? '4a70fe9aa6436e02c2dea340fbd1e352e4ef2d8ce6ca52ad25d4b95471fc8bf2'
          : '1a6ddd3533d91cae4b3742d4294fb07ee863a4d667fe598f01365bd68a18bcfd' },
      })),
      getBucket: vi.fn().mockResolvedValue({
        Contents: [
          { Key: 'clawxxx/latest/app.zip' },
          { Key: 'clawxxx/latest/latest.yml' },
          { Key: 'clawxxx/latest/stale.exe' },
        ],
        IsTruncated: 'false',
      }),
      deleteMultipleObject: vi.fn().mockResolvedValue({ Error: [] }),
    };
    try {
      await expect(publisher(client).syncMutableChannel(root, 'nightly')).rejects.toThrow(/unsupported release channel/);
      const result = await publisher(client).syncMutableChannel(root, 'latest');
      expect(result.deleted).toEqual(['clawxxx/latest/stale.exe']);
      expect(client.uploadFile.mock.calls[0][0].Key).toBe('clawxxx/latest/app.zip');
      expect(client.uploadFile.mock.calls[1][0].Key).toBe('clawxxx/latest/latest.yml');
      expect(client.deleteMultipleObject).toHaveBeenCalledWith(expect.objectContaining({
        Objects: [{ Key: 'clawxxx/latest/stale.exe' }],
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('verifies the configured bucket region and fails closed when versioning is enabled', async () => {
    const client = {
      getBucketLocation: vi.fn().mockResolvedValue({ LocationConstraint: 'ap-shanghai' }),
      getBucketVersioning: vi.fn().mockResolvedValue({ VersioningConfiguration: { Status: 'Enabled' } }),
    };
    await expect(publisher(client).verifyBucket()).rejects.toThrow(/versioning must not be Enabled/);
  });
});
