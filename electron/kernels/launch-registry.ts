import type { KernelId } from '@shared/kernels/contracts';
import type { KernelProcessLaunch } from './stdio-kernel-process';
import type { InProcessKernelDriverLaunch } from './driver-runtime';

export type KernelRuntimeLaunch = KernelProcessLaunch | InProcessKernelDriverLaunch;

export type RegisteredKernelLaunchResolver = (
  generation: number,
) => KernelRuntimeLaunch | Promise<KernelRuntimeLaunch>;

/**
 * Drivers register launch resolution only after an installed artifact has
 * passed package verification. This keeps the supervisor independent from
 * any concrete kernel and prevents mutable path lookup during a generation.
 */
export class KernelLaunchRegistry {
  private readonly resolvers = new Map<KernelId, RegisteredKernelLaunchResolver>();

  register(kernelId: KernelId, resolver: RegisteredKernelLaunchResolver): () => void {
    if (this.resolvers.has(kernelId)) {
      throw new Error(`Kernel launch provider is already registered: ${kernelId}`);
    }
    this.resolvers.set(kernelId, resolver);
    return () => {
      if (this.resolvers.get(kernelId) === resolver) this.resolvers.delete(kernelId);
    };
  }

  has(kernelId: KernelId): boolean {
    return this.resolvers.has(kernelId);
  }

  unregister(kernelId: KernelId): void {
    this.resolvers.delete(kernelId);
  }

  resolve(kernelId: KernelId, generation: number): KernelRuntimeLaunch | Promise<KernelRuntimeLaunch> {
    const resolver = this.resolvers.get(kernelId);
    if (!resolver) throw new Error(`Kernel ${kernelId} is not installed or has no runtime driver`);
    return resolver(generation);
  }
}
