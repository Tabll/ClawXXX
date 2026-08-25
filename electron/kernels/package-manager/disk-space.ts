import { statfs } from 'node:fs/promises';
import type { KernelArtifactDescriptorV1 } from '@shared/kernels/catalog';
import { KernelPackageError } from './errors';

const MINIMUM_STAGING_MARGIN = 64 * 1024 * 1024;

export type DiskSpaceEstimate = {
  availableBytes: number;
  requiredBytes: number;
  remainingDownloadBytes: number;
  extractionBytes: number;
  stagingReserveBytes: number;
  rollbackReserveBytes: number;
};

export function estimateKernelInstallDiskBytes(
  descriptor: KernelArtifactDescriptorV1,
  downloadedBytes = 0,
  rollbackReserveBytes = descriptor.archive.unpackedSize,
): Omit<DiskSpaceEstimate, 'availableBytes'> {
  const remainingDownloadBytes = Math.max(0, descriptor.archive.compressedSize - downloadedBytes);
  const extractionBytes = descriptor.archive.unpackedSize;
  const stagingReserveBytes = Math.max(MINIMUM_STAGING_MARGIN, Math.ceil(extractionBytes * 0.1));
  const safeRollbackReserve = Math.max(0, rollbackReserveBytes);
  const requiredBytes = remainingDownloadBytes + extractionBytes + stagingReserveBytes + safeRollbackReserve;
  if (!Number.isSafeInteger(requiredBytes)) {
    throw new KernelPackageError('disk-space', 'Runtime artifact disk-space estimate exceeds safe integer limits');
  }
  return {
    requiredBytes,
    remainingDownloadBytes,
    extractionBytes,
    stagingReserveBytes,
    rollbackReserveBytes: safeRollbackReserve,
  };
}

export async function assertKernelInstallDiskSpace(
  path: string,
  descriptor: KernelArtifactDescriptorV1,
  options: {
    downloadedBytes?: number;
    rollbackReserveBytes?: number;
    statfsImpl?: typeof statfs;
  } = {},
): Promise<DiskSpaceEstimate> {
  const estimate = estimateKernelInstallDiskBytes(
    descriptor,
    options.downloadedBytes,
    options.rollbackReserveBytes,
  );
  const filesystem = await (options.statfsImpl ?? statfs)(path);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < estimate.requiredBytes) {
    throw new KernelPackageError(
      'disk-space',
      `Insufficient disk space for runtime installation: ${availableBytes} available, ${estimate.requiredBytes} required`,
    );
  }
  return { availableBytes, ...estimate };
}
