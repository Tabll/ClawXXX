import { SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';
import type { ChannelConnectorFactory } from './channel-runtime-contracts';

export class ChannelConnectorRegistry {
  private readonly factories = new Map<string, ChannelConnectorFactory>();

  register(factory: ChannelConnectorFactory): () => void {
    const channelType = factory.channelType.trim().toLowerCase();
    if (!channelType) throw new Error('Channel connector type is required');
    if (this.factories.has(channelType)) throw new Error(`Channel connector already registered: ${channelType}`);
    this.factories.set(channelType, factory);
    return () => {
      if (this.factories.get(channelType) === factory) this.factories.delete(channelType);
    };
  }

  require(channelType: string): ChannelConnectorFactory {
    const factory = this.factories.get(channelType.trim().toLowerCase());
    if (!factory) throw new Error(`ClawX Relay connector is unavailable: ${channelType}`);
    return factory;
  }

  get(channelType: string): ChannelConnectorFactory | undefined {
    return this.factories.get(channelType.trim().toLowerCase());
  }

  missingBuiltins(): string[] {
    return SUPPORTED_CHANNEL_TYPES.filter(channelType => !this.factories.has(channelType));
  }

  list(): ChannelConnectorFactory[] {
    return [...this.factories.values()].sort((left, right) => left.channelType.localeCompare(right.channelType));
  }
}
