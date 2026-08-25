import { lstat, mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';

const SAFE_KERNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_ARTIFACT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class KernelPackageLayout {
  readonly downloads: string;
  readonly staging: string;
  readonly quarantine: string;
  readonly trash: string;

  constructor(readonly root: string) {
    this.root = resolve(root);
    this.downloads = join(this.root, 'downloads');
    this.staging = join(this.root, 'staging');
    this.quarantine = join(this.root, 'quarantine');
    this.trash = join(this.root, 'trash');
  }

  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(this.downloads, { recursive: true, mode: 0o700 }),
      mkdir(this.staging, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantine, { recursive: true, mode: 0o700 }),
      mkdir(this.trash, { recursive: true, mode: 0o700 }),
    ]);
    const rootStats = await lstat(this.root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(`Kernel package root must be a real directory: ${this.root}`);
    }
  }

  installRoot(kernelId: string): string {
    return inside(this.root, checkedKernelId(kernelId), 'installs');
  }

  installPath(descriptor: Pick<KernelArtifactDescriptorV1, 'kernelId' | 'artifactVersion'>): string {
    return inside(this.installRoot(descriptor.kernelId), checkedVersion(descriptor.artifactVersion));
  }

  archivePath(descriptor: Pick<KernelArtifactDescriptorV1, 'archive'>): string {
    checkedSha(descriptor.archive.sha256);
    return inside(this.downloads, `${descriptor.archive.sha256}.tar.zst`);
  }

  partialPath(descriptor: Pick<KernelArtifactDescriptorV1, 'archive'>): string {
    return `${this.archivePath(descriptor)}.partial`;
  }

  partialMetadataPath(descriptor: Pick<KernelArtifactDescriptorV1, 'archive'>): string {
    return `${this.partialPath(descriptor)}.meta`;
  }

  stagingPath(descriptor: Pick<KernelArtifactDescriptorV1, 'kernelId' | 'artifactVersion' | 'archive'>, nonce: string): string {
    checkedSha(descriptor.archive.sha256);
    if (!/^[a-f0-9-]{8,64}$/.test(nonce)) throw new Error('Unsafe staging nonce');
    return inside(
      this.staging,
      `${checkedKernelId(descriptor.kernelId)}-${checkedVersion(descriptor.artifactVersion)}-${descriptor.archive.sha256.slice(0, 12)}-${nonce}`,
    );
  }

  quarantinePath(descriptor: Pick<KernelArtifactDescriptorV1, 'kernelId' | 'artifactVersion' | 'archive'>): string {
    return inside(
      this.quarantine,
      checkedKernelId(descriptor.kernelId),
      `${checkedVersion(descriptor.artifactVersion)}-${descriptor.archive.sha256.slice(0, 12)}`,
    );
  }

  trashPath(kernelId: string, artifactVersion: string, nonce: string): string {
    if (!/^[a-f0-9-]{8,64}$/.test(nonce)) throw new Error('Unsafe trash nonce');
    return inside(this.trash, `${checkedKernelId(kernelId)}-${checkedVersion(artifactVersion)}-${nonce}`);
  }
}

export function checkedKernelId(value: string): string {
  if (!SAFE_KERNEL_ID.test(value)) throw new Error(`Unsafe kernel ID: ${value}`);
  return value;
}

export function checkedVersion(value: string): string {
  if (!SAFE_ARTIFACT_VERSION.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe artifact version: ${value}`);
  }
  return value;
}

function checkedSha(value: string): void {
  if (!SHA256.test(value)) throw new Error('Unsafe artifact SHA-256');
}

function inside(root: string, ...segments: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) {
    throw new Error(`Kernel package path escapes root: ${target}`);
  }
  return target;
}
