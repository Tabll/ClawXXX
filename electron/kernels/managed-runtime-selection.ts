import type { KernelInstallationRecord } from '@shared/kernels/package-manager';

/** Development and packaged hosts share the same active-installation authority. */
export async function resolveManagedKernelRuntime<T>(options: {
  packaged: boolean;
  getInstallation(): Promise<KernelInstallationRecord | undefined>;
  resolveInstalled(installation: KernelInstallationRecord): T;
  resolveDevelopment(): T | undefined | Promise<T | undefined>;
}): Promise<T | undefined> {
  const installation = await options.getInstallation();
  // A damaged/pending installation must fail admission, not silently launch
  // unrelated development bytes against the same user state.
  if (installation && installation.state !== 'not-installed') {
    return options.resolveInstalled(installation);
  }
  if (options.packaged) return undefined;
  return options.resolveDevelopment();
}
