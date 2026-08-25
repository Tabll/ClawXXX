import type { CanonicalChannelAccount, CanonicalChannelTarget } from '@shared/domains/channels';
import { SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';
import type { ChannelConnectorRegistry } from './channel-connector-registry';
import type {
  ChannelAdapterActivation,
  ChannelConnectorSession,
  ChannelCredentialValidation,
  ChannelKernelAdapter,
  ChannelLoginEvent,
  ChannelOutboundEnvelope,
} from './channel-runtime-contracts';

/** Main-owned connector runtime used when DeepSeek Harness executes the turn. */
export class RelayChannelAdapter implements ChannelKernelAdapter {
  readonly kernelId = 'deepseek-harness';
  readonly ownerId = 'clawx-channel-relay';
  readonly supportedChannels = SUPPORTED_CHANNEL_TYPES;
  private readonly sessions = new Map<CanonicalChannelAccount['id'], ChannelConnectorSession>();

  constructor(private readonly connectors: ChannelConnectorRegistry) {}

  validate(
    channelType: string,
    connectionConfig: Readonly<Record<string, unknown>>,
  ): Promise<ChannelCredentialValidation> {
    return this.connectors.require(channelType).validate(connectionConfig);
  }

  async activate(input: ChannelAdapterActivation): Promise<void> {
    if (!this.supportedChannels.includes(input.account.channelType as typeof SUPPORTED_CHANNEL_TYPES[number])) {
      throw new Error(`Unsupported ClawX Relay channel: ${input.account.channelType}`);
    }
    await this.deactivate(input.account.id);
    const session = await this.connectors.require(input.account.channelType).connect(input);
    this.sessions.set(input.account.id, session);
  }

  async deactivate(accountId: CanonicalChannelAccount['id']): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    this.sessions.delete(accountId);
    await session.stop();
  }

  async send(message: ChannelOutboundEnvelope): Promise<void> {
    const session = this.sessions.get(message.accountId);
    if (!session) throw new Error(`ClawX Relay account is not active: ${message.accountId}`);
    await session.send(message);
  }

  async targets(accountId: CanonicalChannelAccount['id'], query?: string): Promise<CanonicalChannelTarget[]> {
    const session = this.sessions.get(accountId);
    return session ? session.targets(query) : [];
  }

  async status(accountId: CanonicalChannelAccount['id']) {
    const session = this.sessions.get(accountId);
    return session
      ? session.status()
      : { state: 'disconnected' as const, changedAt: new Date().toISOString() };
  }

  async startLogin(
    channelType: string,
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void> {
    const login = this.connectors.require(channelType).startLogin;
    if (!login) throw new Error(`Login is not supported by the ClawX Relay connector: ${channelType}`);
    await login(nativeAccountId, emit);
  }

  async cancelLogin(channelType: string, nativeAccountId?: string): Promise<void> {
    await this.connectors.require(channelType).cancelLogin?.(nativeAccountId);
  }

  async remove(account: CanonicalChannelAccount): Promise<void> {
    await this.deactivate(account.id);
    await this.connectors.require(account.channelType).removeProjection?.(account);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(([, session]) => session.stop()));
  }
}
