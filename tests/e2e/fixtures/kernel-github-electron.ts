import { app } from 'electron';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelArtifactDownloader } from '../../../electron/kernels/package-manager/downloader';
import { KernelPackageLayout } from '../../../electron/kernels/package-manager/layout';
import type { KernelArtifactDescriptorV1 } from '../../../shared/kernels/catalog';

const root = process.env.CLAWX_GITHUB_TEST_ROOT!;
const repository = process.env.CLAWX_GITHUB_TEST_REPOSITORY!;
if (!root || !repository) throw new Error('Isolated regression paths are required');
app.setPath('userData', join(root, 'electron-data'));

Object.assign(globalThis, { kernelGithubRegression: async () => {
  const config = JSON.parse(await readFile(join(repository, 'resources/kernels/distribution.json'), 'utf8'));
  const requests: Array<{ url: string; range: string | null; ifRange: string | null }> = [];
  const results = [];
  for (const kernelId of ['openclaw', 'deepseek-harness']) {
    const bytes = Buffer.from(`${kernelId}/GitHub-only`.repeat(500));
    const digest = createHash('sha256').update(bytes).digest('hex');
    // A legacy signed primary is identity only; the actual download policy is
    // loaded from the same distribution document shipped with the application.
    const descriptor = { kernelId, artifactVersion: '1.0.0+clawx.1', platform: process.platform, arch: process.arch,
      archive: { url: `https://retired-cos.invalid/kernels/${kernelId}-1.0.0+clawx.1.tar.zst`,
        sha256: digest, compressedSize: bytes.length } } as KernelArtifactDescriptorV1;
    let first = true;
    const downloader = new KernelArtifactDownloader(new KernelPackageLayout(join(root, kernelId)), {
      fetcher: async (url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({ url: String(url), range: headers.get('range'), ifRange: headers.get('if-range') });
        if (first) { first = false; return new Response(bytes.subarray(0, 1024), { headers: { ETag: '"stable"' } }); }
        if (headers.get('range') !== 'bytes=1024-' || headers.get('if-range') !== '"stable"') throw new Error('Resume validators missing');
        return new Response(bytes.subarray(1024), { status: 206,
          headers: { ETag: '"stable"', 'Content-Range': `bytes 1024-${bytes.length - 1}/${bytes.length}` } });
      },
    });
    let interrupted = false;
    try { await downloader.download(descriptor, { mirrorBaseUrls: config.mirrorBaseUrls }); }
    catch { interrupted = true; }
    const path = await downloader.download(descriptor, { mirrorBaseUrls: config.mirrorBaseUrls });
    const actual = await readFile(path);
    results.push({ kernelId, interrupted, identical: bytes.equals(actual), sha256: createHash('sha256').update(actual).digest('hex') === digest });
  }
  return { electron: process.versions.electron, config, requests, results };
} });
