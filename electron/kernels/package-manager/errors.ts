export type KernelPackageErrorCode =
  | 'catalog-unavailable'
  | 'catalog-stale'
  | 'catalog-invalid'
  | 'artifact-incompatible'
  | 'artifact-downgrade'
  | 'download-cancelled'
  | 'download-failed'
  | 'download-identity'
  | 'archive-digest'
  | 'archive-unsafe'
  | 'archive-bomb'
  | 'artifact-integrity'
  | 'disk-space'
  | 'smoke-failed'
  | 'runtime-in-use'
  | 'rollback-unavailable'
  | 'state-conflict'
  | 'confirmation-required';

export class KernelPackageError extends Error {
  constructor(
    readonly code: KernelPackageErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'KernelPackageError';
  }
}

export function packageError(code: KernelPackageErrorCode, message: string, cause?: unknown): KernelPackageError {
  return cause instanceof KernelPackageError ? cause : new KernelPackageError(code, message, cause);
}
