import { Transform } from 'node:stream';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import * as tar from 'tar';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';
import { canonicalJson } from '../catalog';
import { KernelPackageError } from './errors';
import { sha256File } from './downloader';

type TarEntry = {
  path: string;
  type: string;
  size: number;
  mode?: number;
  linkpath?: string;
};

type FileManifestV1 = {
  schemaVersion: 1;
  sourceDateEpoch: number;
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string; sha256: string; size: number; mode: '0644' | '0755' }>;
};

export type SafeExtractionReport = {
  fileCount: number;
  unpackedBytes: number;
  runtimeFileCount: number;
  runtimeBytes: number;
};

export class SafeKernelArtifactExtractor {
  async extract(
    archivePath: string,
    destination: string,
    descriptor: KernelArtifactDescriptorV1,
  ): Promise<SafeExtractionReport> {
    const archiveStats = await stat(archivePath);
    if (!archiveStats.isFile() || archiveStats.size !== descriptor.archive.compressedSize
      || await sha256File(archivePath) !== descriptor.archive.sha256) {
      throw new KernelPackageError('archive-digest', 'Runtime archive identity changed before extraction');
    }
    await this.scanArchive(archivePath, descriptor);
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: false, mode: 0o700 });
    try {
      const extractionGuard = new TarGuard(descriptor);
      const unpack = tar.x({
        cwd: destination,
        strict: true,
        preservePaths: false,
        unlink: true,
        filter: (_path, entry) => extractionGuard.observe(entry as unknown as TarEntry),
      });
      await pipeArchiveToTar(archivePath, new OutputByteLimit(maxTarStreamBytes(descriptor)), unpack);
      extractionGuard.finish();
      if (await sha256File(archivePath) !== descriptor.archive.sha256) {
        throw new KernelPackageError('archive-digest', 'Runtime archive changed during extraction');
      }
      const report = await verifyExtractedArtifact(destination, descriptor);
      await writeFile(
        inside(destination, 'metadata/descriptor.json'),
        canonicalJson(descriptor),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await makeTreeReadOnly(destination);
      return report;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (error instanceof KernelPackageError) throw error;
      throw new KernelPackageError('archive-unsafe', `Runtime archive extraction failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }

  async scanArchive(archivePath: string, descriptor: KernelArtifactDescriptorV1): Promise<void> {
    const guard = new TarGuard(descriptor);
    const listing = tar.t({
      strict: true,
      preservePaths: true,
      onentry: entry => { guard.observe(entry as unknown as TarEntry); },
    });
    try {
      await pipeArchiveToTar(archivePath, new OutputByteLimit(maxTarStreamBytes(descriptor)), listing);
      guard.finish();
    } catch (error) {
      if (error instanceof KernelPackageError) throw error;
      throw new KernelPackageError('archive-unsafe', `Runtime archive validation failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  }
}

class TarGuard {
  private readonly paths = new Set<string>();
  private readonly caseFolded = new Set<string>();
  private readonly files = new Set<string>();
  private fileCount = 0;
  private directoryCount = 0;
  private unpackedBytes = 0;
  private failure?: KernelPackageError;

  constructor(private readonly descriptor: KernelArtifactDescriptorV1) {}

  observe(entry: TarEntry): boolean {
    if (this.failure) return false;
    try {
      this.check(entry);
      return true;
    } catch (error) {
      this.failure = error instanceof KernelPackageError
        ? error
        : new KernelPackageError('archive-unsafe', error instanceof Error ? error.message : String(error), error);
      return false;
    }
  }

  private check(entry: TarEntry): void {
    const path = assertSafeArchivePath(entry.path);
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new KernelPackageError('archive-unsafe', `Archive contains forbidden ${entry.type} entry: ${path}`);
    }
    if (entry.linkpath) throw new KernelPackageError('archive-unsafe', `Archive contains a link: ${path}`);
    if ((entry.mode ?? 0) & 0o6000) throw new KernelPackageError('archive-unsafe', `Archive contains setuid/setgid mode: ${path}`);
    const normalized = entry.type === 'Directory' ? path.replace(/\/$/, '') : path;
    const folded = normalized.normalize('NFC').toLocaleLowerCase('en-US');
    if (this.paths.has(normalized) || this.caseFolded.has(folded)) {
      throw new KernelPackageError('archive-unsafe', `Archive contains duplicate or case-colliding path: ${normalized}`);
    }
    this.paths.add(normalized);
    this.caseFolded.add(folded);
    if (entry.type === 'Directory') {
      this.directoryCount += 1;
      if (this.directoryCount > this.descriptor.archive.fileCount * 4 + 128) {
        throw new KernelPackageError('archive-bomb', 'Archive contains too many directories');
      }
      return;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > this.descriptor.archive.unpackedSize) {
      throw new KernelPackageError('archive-bomb', `Archive entry has an invalid size: ${normalized}`);
    }
    this.files.add(normalized);
    this.fileCount += 1;
    this.unpackedBytes += entry.size;
    if (this.fileCount > this.descriptor.archive.fileCount || this.unpackedBytes > this.descriptor.archive.unpackedSize) {
      throw new KernelPackageError('archive-bomb', 'Archive exceeds its signed file-count or unpacked-size budget');
    }
  }

  finish(): void {
    if (this.failure) throw this.failure;
    if (this.fileCount !== this.descriptor.archive.fileCount
      || this.unpackedBytes !== this.descriptor.archive.unpackedSize) {
      throw new KernelPackageError(
        'artifact-integrity',
        `Archive contents differ from signed totals (${this.fileCount}/${this.descriptor.archive.fileCount} files, ${this.unpackedBytes}/${this.descriptor.archive.unpackedSize} bytes)`,
      );
    }
    for (const path of this.files) {
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        if (this.files.has(parts.slice(0, index).join('/'))) {
          throw new KernelPackageError('archive-unsafe', `Archive nests an entry below a file: ${path}`);
        }
      }
    }
  }
}

function pipeArchiveToTar(archivePath: string, limiter: OutputByteLimit, destination: NodeJS.ReadWriteStream): Promise<void> {
  return new Promise((accept, reject) => {
    const source = createReadStream(archivePath);
    const decompressor = createZstdDecompress();
    let settled = false;
    const cleanup = () => {
      source.removeListener('error', fail);
      decompressor.removeListener('error', fail);
      limiter.removeListener('error', fail);
      destination.removeListener('error', fail);
      destination.removeListener('end', succeed);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      source.destroy();
      decompressor.destroy();
      limiter.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      accept();
    };
    source.once('error', fail);
    decompressor.once('error', fail);
    limiter.once('error', fail);
    destination.once('error', fail);
    destination.once('end', succeed);
    source.pipe(decompressor).pipe(limiter).pipe(destination);
  });
}

class OutputByteLimit extends Transform {
  private seen = 0;

  constructor(private readonly maximum: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.seen += chunk.byteLength;
    if (this.seen > this.maximum) {
      callback(new KernelPackageError('archive-bomb', 'Decompressed tar stream exceeds its signed overhead budget'));
      return;
    }
    callback(null, chunk);
  }
}

export function assertSafeArchivePath(rawPath: string): string {
  if (!rawPath || rawPath.length > 1_024 || rawPath.includes('\0') || rawPath.includes('\\')
    || rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
    throw new KernelPackageError('archive-unsafe', `Archive contains an unsafe path: ${rawPath}`);
  }
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  const parts = path.split('/');
  if (parts.length === 0 || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    throw new KernelPackageError('archive-unsafe', `Archive contains an unsafe path: ${rawPath}`);
  }
  if (parts[0] !== 'runtime' && parts[0] !== 'metadata') {
    throw new KernelPackageError('archive-unsafe', `Archive contains an unexpected top-level path: ${rawPath}`);
  }
  if (path === 'metadata/descriptor.json') {
    throw new KernelPackageError('archive-unsafe', 'Archive contains a host-reserved descriptor path');
  }
  return rawPath;
}

export async function verifyExtractedArtifact(
  root: string,
  descriptor: KernelArtifactDescriptorV1,
): Promise<SafeExtractionReport> {
  const descriptorMetadataPath = inside(root, 'metadata/descriptor.json');
  const discoveredFiles = await walkRegularFiles(root);
  const allFiles = discoveredFiles.filter(path => path !== descriptorMetadataPath);
  if (discoveredFiles.length !== allFiles.length) {
    const installedDescriptor = await readJsonFile(descriptorMetadataPath, 2 * 1024 * 1024);
    if (canonicalJson(installedDescriptor) !== canonicalJson(descriptor)) {
      throw new KernelPackageError('artifact-integrity', 'Installed artifact descriptor was modified');
    }
  }
  const totalBytes = await sumFileBytes(allFiles);
  if (allFiles.length !== descriptor.archive.fileCount || totalBytes !== descriptor.archive.unpackedSize) {
    throw new KernelPackageError('artifact-integrity', 'Extracted runtime differs from the signed archive totals');
  }
  const artifactManifest = await readJsonFile(inside(root, 'metadata/artifact-manifest.json'), 2 * 1024 * 1024) as Record<string, unknown>;
  const expectedIdentity = {
    schemaVersion: 1,
    kernelId: descriptor.kernelId,
    artifactVersion: descriptor.artifactVersion,
    upstreamVersion: descriptor.upstreamVersion,
    upstreamCommit: descriptor.upstreamCommit,
    patchRevision: descriptor.patchRevision,
    platform: descriptor.platform,
    arch: descriptor.arch,
    node: descriptor.node,
    capabilityContractVersion: descriptor.capabilityContractVersion,
    protocols: descriptor.protocols,
    checkpointCodecs: descriptor.checkpointCodecs,
    storage: descriptor.storage,
    entrypoints: descriptor.entrypoints,
    supplyChain: descriptor.supplyChain,
  };
  const actualIdentity = Object.fromEntries(Object.keys(expectedIdentity).map(key => [key, artifactManifest[key]]));
  if (canonicalJson(actualIdentity) !== canonicalJson(expectedIdentity)) {
    throw new KernelPackageError('artifact-integrity', 'Internal artifact manifest does not match its signed descriptor');
  }
  const metadataHashes: Array<[string, string]> = [
    ['metadata/files.json', descriptor.supplyChain.fileManifestSha256],
    ['metadata/sbom.spdx.json', descriptor.supplyChain.sbomSha256],
    ['metadata/THIRD_PARTY_NOTICES.md', descriptor.supplyChain.noticesSha256],
    ['metadata/provenance.slsa.json', descriptor.supplyChain.provenanceSha256],
    ['metadata/tests.json', descriptor.supplyChain.testReportSha256],
    ['metadata/storage-contract.json', descriptor.storage.regressionReportSha256],
    ...(descriptor.supplyChain.licenseReportSha256
      ? [['metadata/licenses.json', descriptor.supplyChain.licenseReportSha256] as [string, string]]
      : []),
    ...(descriptor.supplyChain.platformSecurityReportSha256
      ? [['metadata/platform-security.json', descriptor.supplyChain.platformSecurityReportSha256] as [string, string]]
      : []),
  ];
  for (const [path, expected] of metadataHashes) {
    if (await sha256File(inside(root, path)) !== expected) {
      throw new KernelPackageError('artifact-integrity', `Artifact metadata failed integrity verification: ${path}`);
    }
  }
  const manifest = await readJsonFile(inside(root, 'metadata/files.json'), 32 * 1024 * 1024) as FileManifestV1;
  const runtimeRoot = inside(root, 'runtime');
  const runtimeFiles = await walkRegularFiles(runtimeRoot);
  assertFileManifestShape(manifest, descriptor);
  if (runtimeFiles.length !== manifest.fileCount) {
    throw new KernelPackageError('artifact-integrity', 'Runtime file count differs from metadata/files.json');
  }
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]));
  for (const path of runtimeFiles) {
    const name = relative(runtimeRoot, path).split(sep).join('/');
    const expected = expectedFiles.get(name);
    const fileStats = await stat(path);
    if (!expected || expected.size !== fileStats.size || expected.sha256 !== await sha256File(path)) {
      throw new KernelPackageError('artifact-integrity', `Runtime file failed integrity verification: ${name}`);
    }
    expectedFiles.delete(name);
  }
  if (expectedFiles.size > 0) throw new KernelPackageError('artifact-integrity', 'Runtime file manifest contains missing files');
  for (const entrypoint of Object.values(descriptor.entrypoints)) {
    const path = inside(root, entrypoint);
    const entryStats = await lstat(path);
    if (!entryStats.isFile() || entryStats.isSymbolicLink()) {
      throw new KernelPackageError('artifact-integrity', `Runtime entrypoint is unavailable: ${entrypoint}`);
    }
  }
  return {
    fileCount: allFiles.length,
    unpackedBytes: totalBytes,
    runtimeFileCount: runtimeFiles.length,
    runtimeBytes: manifest.totalBytes,
  };
}

function assertFileManifestShape(manifest: FileManifestV1, descriptor: KernelArtifactDescriptorV1): void {
  if (manifest?.schemaVersion !== 1 || !Number.isSafeInteger(manifest.fileCount)
    || !Number.isSafeInteger(manifest.totalBytes) || !Array.isArray(manifest.files)
    || manifest.files.length !== manifest.fileCount || manifest.fileCount > descriptor.archive.fileCount
    || manifest.totalBytes > descriptor.archive.unpackedSize) {
    throw new KernelPackageError('artifact-integrity', 'Runtime file manifest is malformed');
  }
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    const path = assertSafeRuntimeRelativePath(file.path);
    if (paths.has(path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || (file.mode !== '0644' && file.mode !== '0755')) {
      throw new KernelPackageError('artifact-integrity', `Runtime file manifest entry is malformed: ${String(file.path)}`);
    }
    paths.add(path);
    total += file.size;
  }
  if (total !== manifest.totalBytes) throw new KernelPackageError('artifact-integrity', 'Runtime file manifest byte total is incorrect');
}

function assertSafeRuntimeRelativePath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new KernelPackageError('artifact-integrity', `Unsafe runtime manifest path: ${path}`);
  }
  return path;
}

async function readJsonFile(path: string, maximum: number): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maximum) throw new KernelPackageError('artifact-integrity', `Metadata file exceeds limit: ${path}`);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new KernelPackageError('artifact-integrity', `Metadata file is not valid JSON: ${path}`, error);
  }
}

async function walkRegularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      const rel = relative(root, path);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new KernelPackageError('archive-unsafe', 'Extracted path escaped its root');
      const fileStats = await lstat(path);
      if (fileStats.isSymbolicLink()) throw new KernelPackageError('archive-unsafe', `Extracted tree contains a symlink: ${path}`);
      if (fileStats.isDirectory()) await visit(path);
      else if (fileStats.isFile()) output.push(path);
      else throw new KernelPackageError('archive-unsafe', `Extracted tree contains a non-regular entry: ${path}`);
    }
  };
  await visit(root);
  return output;
}

async function sumFileBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        // Keep owner-write on directories so Windows locked-file recovery and
        // quarantine cleanup can remove the immutable file payload later.
        await chmod(child, 0o755).catch(() => undefined);
      } else {
        const childStats = await stat(child);
        await chmod(child, childStats.mode & 0o111 ? 0o555 : 0o444).catch(() => undefined);
      }
    }
  };
  await visit(root);
  await chmod(root, 0o755).catch(() => undefined);
}

function inside(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    throw new KernelPackageError('artifact-integrity', `Unsafe artifact path: ${relativePath}`);
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new KernelPackageError('artifact-integrity', `Artifact path escapes root: ${relativePath}`);
  }
  return target;
}

function maxTarStreamBytes(descriptor: KernelArtifactDescriptorV1): number {
  const overhead = Math.max(10 * 1024 * 1024, descriptor.archive.fileCount * 2_048);
  const maximum = descriptor.archive.unpackedSize + overhead;
  if (!Number.isSafeInteger(maximum)) throw new KernelPackageError('archive-bomb', 'Signed archive limits exceed safe integers');
  return maximum;
}
