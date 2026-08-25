import type { KernelId } from '@shared/kernels/contracts';
import type { ChannelKernelAdapter } from './channel-runtime-contracts';

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<KernelId, ChannelKernelAdapter>();

  register(adapter: ChannelKernelAdapter): () => void {
    if (!adapter.kernelId.trim() || !adapter.ownerId.trim()) {
      throw new Error('Channel adapter kernel and owner identities are required');
    }
    if (this.adapters.has(adapter.kernelId)) {
      throw new Error(`Channel adapter already registered: ${adapter.kernelId}`);
    }
    this.adapters.set(adapter.kernelId, adapter);
    return () => {
      if (this.adapters.get(adapter.kernelId) === adapter) this.adapters.delete(adapter.kernelId);
    };
  }

  require(kernelId: KernelId): ChannelKernelAdapter {
    const adapter = this.adapters.get(kernelId);
    if (!adapter) throw new Error(`Channel adapter is unavailable for kernel: ${kernelId}`);
    return adapter;
  }

  get(kernelId: KernelId): ChannelKernelAdapter | undefined {
    return this.adapters.get(kernelId);
  }

  list(): ChannelKernelAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.kernelId.localeCompare(right.kernelId));
  }
}
