import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';
import type { KernelDownloadProgress } from '@shared/kernels/package-manager';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { KernelPackageError } from './errors';
import type { KernelPackageLayout } from './layout';

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

type PartialMetadataV1 = {
  schemaVersion: 1;
  kernelId: string;
  artifactVersion: string;
  archiveSha256: string;
  compressedSize: number;
  sourceUrl: string;
  etag?: string;
  updatedAt: string;
};

export type ArtifactDownloadOptions = {
  signal?: AbortSignal;
  mirrorBaseUrls?: string[];
  onProgress?: (progress: KernelDownloadProgress) => void;
};

export class KernelArtifactDownloader {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;

  constructor(
    private readonly layout: KernelPackageLayout,
    options: { fetcher?: Fetcher; now?: () => Date } = {},
  ) {
    this.fetcher = options.fetcher ?? proxyAwareFetch;
    this.now = options.now ?? (() => new Date());
  }

  async download(descriptor: KernelArtifactDescriptorV1, options: ArtifactDownloadOptions = {}): Promise<string> {
    await this.layout.ensure();
    const finalPath = this.layout.archivePath(descriptor);
    if (await fileMatches(finalPath, descriptor.archive.compressedSize, descriptor.archive.sha256)) return finalPath;
    const urls = artifactDownloadUrls(descriptor, options.mirrorBaseUrls ?? []);
    const failures: string[] = [];
    for (const url of urls) {
      try {
        return await this.downloadFrom(url, descriptor, options);
      } catch (error) {
        if (error instanceof KernelPackageError && error.code === 'download-cancelled') throw error;
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new KernelPackageError('download-failed', `Every runtime artifact source failed: ${failures.join('; ')}`);
  }

  private async downloadFrom(
    url: string,
    descriptor: KernelArtifactDescriptorV1,
    options: ArtifactDownloadOptions,
  ): Promise<string> {
    const partialPath = this.layout.partialPath(descriptor);
    const metadataPath = this.layout.partialMetadataPath(descriptor);
    for (let requestAttempt = 0; requestAttempt < 2; requestAttempt += 1) {
      throwIfAborted(options.signal);
      let offset = await validPartialSize(partialPath, metadataPath, descriptor);
      let metadata = offset > 0 ? await readPartialMetadata(metadataPath) : undefined;
      if (offset > 0 && (!metadata?.etag || metadata.etag.startsWith('W/'))) {
        await discardPartial(partialPath, metadataPath);
        offset = 0;
        metadata = undefined;
      }
      const headers = new Headers({ Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' });
      if (offset > 0) {
        headers.set('Range', `bytes=${offset}-`);
        headers.set('If-Range', metadata!.etag!);
      }
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: options.signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (options.signal?.aborted || isAbort(error)) {
          throw new KernelPackageError('download-cancelled', 'Runtime artifact download was cancelled', error);
        }
        throw error;
      }
      assertSecureArtifactResponse(response);
      const responseEtag = normalizeEtag(response.headers.get('etag'));
      if (offset > 0 && response.status === 206) {
        assertContentRange(response.headers.get('content-range'), offset, descriptor.archive.compressedSize);
        if (!responseEtag || responseEtag !== metadata?.etag) {
          await response.body?.cancel();
          await discardPartial(partialPath, metadataPath);
          continue;
        }
      } else if (offset > 0 && response.status === 200) {
        offset = 0;
        await discardPartial(partialPath, metadataPath);
      } else if (response.status === 416 && offset === descriptor.archive.compressedSize) {
        return this.finishDownload(descriptor);
      } else if (response.status !== 200 && response.status !== 206) {
        throw new Error(`Artifact request returned HTTP ${response.status}`);
      } else if (response.status === 206) {
        assertContentRange(response.headers.get('content-range'), offset, descriptor.archive.compressedSize);
      }
      const contentEncoding = response.headers.get('content-encoding');
      if (contentEncoding && contentEncoding !== 'identity') {
        await response.body?.cancel();
        throw new KernelPackageError('download-identity', 'Runtime archives must not use HTTP content encoding');
      }
      if (!response.body) throw new Error('Artifact response has no body');
      const advertisedLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertisedLength)
        && advertisedLength > descriptor.archive.compressedSize - offset) {
        await response.body.cancel();
        throw new KernelPackageError('download-identity', 'Artifact response exceeds its signed compressed size');
      }
      const nextMetadata: PartialMetadataV1 = {
        schemaVersion: 1,
        kernelId: descriptor.kernelId,
        artifactVersion: descriptor.artifactVersion,
        archiveSha256: descriptor.archive.sha256,
        compressedSize: descriptor.archive.compressedSize,
        sourceUrl: url,
        ...(responseEtag ? { etag: responseEtag } : {}),
        updatedAt: this.now().toISOString(),
      };
      await writeMetadataAtomically(metadataPath, nextMetadata);
      const handle = await open(partialPath, offset > 0 ? 'a' : 'w', 0o600);
      let received = offset;
      try {
        const reader = response.body.getReader();
        while (true) {
          throwIfAborted(options.signal);
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > descriptor.archive.compressedSize) {
            await reader.cancel();
            throw new KernelPackageError('download-identity', 'Artifact body exceeds its signed compressed size');
          }
          await handle.write(value);
          options.onProgress?.({
            kernelId: descriptor.kernelId,
            artifactVersion: descriptor.artifactVersion,
            phase: 'downloading',
            receivedBytes: received,
            totalBytes: descriptor.archive.compressedSize,
            resumed: offset > 0,
            sourceUrl: url,
          });
        }
        await handle.sync();
      } catch (error) {
        if (options.signal?.aborted || isAbort(error)) {
          throw new KernelPackageError('download-cancelled', 'Runtime artifact download was cancelled', error);
        }
        throw error;
      } finally {
        await handle.close();
      }
      if (received !== descriptor.archive.compressedSize) {
        throw new Error(`Artifact download was truncated at ${received}/${descriptor.archive.compressedSize} bytes`);
      }
      return this.finishDownload(descriptor);
    }
    throw new KernelPackageError('download-identity', 'Artifact ETag changed while resuming the download');
  }

  private async finishDownload(descriptor: KernelArtifactDescriptorV1): Promise<string> {
    const partialPath = this.layout.partialPath(descriptor);
    const metadataPath = this.layout.partialMetadataPath(descriptor);
    const digest = await sha256File(partialPath);
    if (digest !== descriptor.archive.sha256) {
      await discardPartial(partialPath, metadataPath);
      throw new KernelPackageError('archive-digest', 'Downloaded runtime archive failed SHA-256 verification');
    }
    const finalPath = this.layout.archivePath(descriptor);
    await rm(finalPath, { force: true });
    await rename(partialPath, finalPath);
    await rm(metadataPath, { force: true });
    return finalPath;
  }
}

export function artifactDownloadUrls(descriptor: KernelArtifactDescriptorV1, mirrorBaseUrls: string[]): string[] {
  const primary = checkedHttpsUrl(descriptor.archive.url);
  const fileName = basename(new URL(primary).pathname);
  if (!fileName || fileName === '.' || fileName === '..') throw new Error('Artifact URL has no safe filename');
  const urls = [primary];
  for (const baseValue of mirrorBaseUrls) {
    const base = new URL(checkedHttpsUrl(baseValue));
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    urls.push(checkedHttpsUrl(new URL(encodeURIComponent(fileName), base).toString()));
  }
  return [...new Set(urls)];
}

function checkedHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Runtime artifact URLs must use credential-free HTTPS');
  }
  return url.toString();
}

function assertSecureArtifactResponse(response: Response): void {
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new KernelPackageError('download-identity', 'Runtime artifact redirect downgraded from HTTPS');
  }
}

function normalizeEtag(value: string | null): string | undefined {
  const etag = value?.trim();
  return etag && etag.length <= 512 ? etag : undefined;
}

function assertContentRange(value: string | null, expectedOffset: number, expectedTotal: number): void {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match || Number(match[1]) !== expectedOffset || Number(match[2]) < expectedOffset
    || Number(match[3]) !== expectedTotal) {
    throw new KernelPackageError('download-identity', 'Artifact server returned an invalid Content-Range');
  }
}

async function validPartialSize(
  partialPath: string,
  metadataPath: string,
  descriptor: KernelArtifactDescriptorV1,
): Promise<number> {
  let size: number;
  try {
    const stats = await stat(partialPath);
    size = stats.isFile() ? stats.size : -1;
  } catch {
    return 0;
  }
  const metadata = await readPartialMetadata(metadataPath);
  if (size < 0 || size > descriptor.archive.compressedSize || !metadata
    || metadata.kernelId !== descriptor.kernelId
    || metadata.artifactVersion !== descriptor.artifactVersion
    || metadata.archiveSha256 !== descriptor.archive.sha256
    || metadata.compressedSize !== descriptor.archive.compressedSize) {
    await discardPartial(partialPath, metadataPath);
    return 0;
  }
  return size;
}

async function readPartialMetadata(path: string): Promise<PartialMetadataV1 | undefined> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > 16_384) return undefined;
    const value = JSON.parse(bytes.toString('utf8')) as PartialMetadataV1;
    return value?.schemaVersion === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeMetadataAtomically(path: string, metadata: PartialMetadataV1): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'w' });
  await rename(temporary, path);
}

async function discardPartial(partialPath: string, metadataPath: string): Promise<void> {
  await Promise.all([rm(partialPath, { force: true }), rm(metadataPath, { force: true })]);
}

async function fileMatches(path: string, expectedSize: number, expectedDigest: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile() && stats.size === expectedSize && await sha256File(path) === expectedDigest;
  } catch {
    return false;
  }
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KernelPackageError('download-cancelled', 'Runtime artifact download was cancelled');
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
