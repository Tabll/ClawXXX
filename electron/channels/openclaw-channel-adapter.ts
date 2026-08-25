import type { CanonicalChannelAccount, CanonicalChannelTarget } from '@shared/domains/channels';
import { SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';
import type {
  ChannelAdapterActivation,
  ChannelConnectorStatus,
  ChannelCredentialValidation,
  ChannelInboundEnvelope,
  ChannelKernelAdapter,
  ChannelLoginEvent,
  ChannelOutboundEnvelope,
} from './channel-runtime-contracts';

export type OpenClawNativeChannelBackend = {
  validate(channelType: string, config: Readonly<Record<string, unknown>>): Promise<ChannelCredentialValidation>;
  projectAccount(account: CanonicalChannelAccount, config: Readonly<Record<string, unknown>>): Promise<void>;
  removeAccount(account: CanonicalChannelAccount): Promise<void>;
  enableAccount(account: CanonicalChannelAccount): Promise<void>;
  disableAccount(account: CanonicalChannelAccount): Promise<void>;
  send(message: ChannelOutboundEnvelope): Promise<void>;
  targets(account: CanonicalChannelAccount, query?: string): Promise<CanonicalChannelTarget[]>;
  status(account: CanonicalChannelAccount): Promise<ChannelConnectorStatus>;
  /**
   * The managed OpenClaw patch emits connector ingress before agent execution.
   * Returning the disposer completes the admission hand-off to ClawX.
   */
  subscribeInbound(
    account: CanonicalChannelAccount,
    handler: (message: ChannelInboundEnvelope) => Promise<void>,
  ): Promise<() => Promise<void> | void>;
  startLogin?(
    channelType: string,
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void>;
  cancelLogin?(channelType: string, nativeAccountId?: string): Promise<void>;
};

/** Compatibility adapter around the managed OpenClaw connector host. */
export class OpenClawChannelAdapter implements ChannelKernelAdapter {
  readonly kernelId = 'openclaw';
  readonly ownerId = 'openclaw-native-channel-adapter';
  readonly supportedChannels = SUPPORTED_CHANNEL_TYPES;
  private readonly accounts = new Map<CanonicalChannelAccount['id'], CanonicalChannelAccount>();
  private readonly disposers = new Map<CanonicalChannelAccount['id'], () => Promise<void> | void>();

  constructor(private readonly backend: OpenClawNativeChannelBackend) {}

  validate(
    channelType: string,
    connectionConfig: Readonly<Record<string, unknown>>,
  ): Promise<ChannelCredentialValidation> {
    return this.backend.validate(channelType, connectionConfig);
  }

  async activate(input: ChannelAdapterActivation): Promise<void> {
    await this.deactivate(input.account.id);
    await this.backend.projectAccount(input.account, input.connectionConfig);
    const dispose = await this.backend.subscribeInbound(input.account, input.onInbound);
    try {
      await this.backend.enableAccount(input.account);
      this.accounts.set(input.account.id, input.account);
      this.disposers.set(input.account.id, dispose);
      await input.onStatus(await this.backend.status(input.account));
    } catch (error) {
      await Promise.resolve(dispose()).catch(() => undefined);
      throw error;
    }
  }

  async deactivate(accountId: CanonicalChannelAccount['id']): Promise<void> {
    const account = this.accounts.get(accountId);
    const dispose = this.disposers.get(accountId);
    this.accounts.delete(accountId);
    this.disposers.delete(accountId);
    await Promise.resolve(dispose?.()).catch(() => undefined);
    if (account) await this.backend.disableAccount(account);
  }

  send(message: ChannelOutboundEnvelope): Promise<void> {
    if (!this.accounts.has(message.accountId)) {
      return Promise.reject(new Error(`OpenClaw Channel account is not active: ${message.accountId}`));
    }
    return this.backend.send(message);
  }

  async targets(accountId: CanonicalChannelAccount['id'], query?: string): Promise<CanonicalChannelTarget[]> {
    const account = this.accounts.get(accountId);
    return account ? this.backend.targets(account, query) : [];
  }

  async status(accountId: CanonicalChannelAccount['id']): Promise<ChannelConnectorStatus> {
    const account = this.accounts.get(accountId);
    return account
      ? this.backend.status(account)
      : { state: 'disconnected', changedAt: new Date().toISOString() };
  }

  async remove(account: CanonicalChannelAccount): Promise<void> {
    await this.deactivate(account.id);
    await this.backend.removeAccount(account);
  }

  async startLogin(
    channelType: string,
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void> {
    if (!this.backend.startLogin) throw new Error(`OpenClaw login is unsupported: ${channelType}`);
    await this.backend.startLogin(channelType, nativeAccountId, emit);
  }

  async cancelLogin(channelType: string, nativeAccountId?: string): Promise<void> {
    await this.backend.cancelLogin?.(channelType, nativeAccountId);
  }

  async stop(): Promise<void> {
    const accountIds = [...this.accounts.keys()];
    await Promise.allSettled(accountIds.map(accountId => this.deactivate(accountId)));
  }
}
