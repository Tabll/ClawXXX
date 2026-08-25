import type { CanonicalChannelAccount, CanonicalChannelTarget } from '@shared/domains/channels';
import type { KernelId } from '@shared/kernels/contracts';

export type ChannelConnectorStatus = {
  state: CanonicalChannelAccount['status'];
  detail?: string;
  changedAt: string;
};

export type ChannelInboundAttachment = {
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
};

/**
 * Connector-facing inbound envelope. It deliberately has no credentials or
 * kernel-native session identity; only the orchestrator may turn it into a
 * canonical message/run.
 */
export type ChannelInboundEnvelope = {
  accountId: CanonicalChannelAccount['id'];
  channelType: string;
  externalConversationId: string;
  externalMessageId: string;
  targetId: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  attachments?: ChannelInboundAttachment[];
  replyToExternalMessageId?: string;
  receivedAt: string;
};

export type ChannelOutboundAttachment = {
  data: Uint8Array;
  mimeType: string;
  fileName?: string;
};

export type ChannelOutboundEnvelope = {
  accountId: CanonicalChannelAccount['id'];
  channelType: string;
  externalConversationId: string;
  externalMessageId: string;
  targetId: string;
  text?: string;
  attachments: ChannelOutboundAttachment[];
  replyToExternalMessageId?: string;
};

export type ChannelCredentialValidation = {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  details?: Record<string, string>;
};

export type ChannelLoginEvent =
  | { type: 'qr'; qr: string; sessionKey?: string }
  | { type: 'success'; nativeAccountId?: string; message?: string; credential?: Record<string, string> }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export type ChannelAdapterActivation = {
  account: CanonicalChannelAccount;
  /** Public connector config merged with decrypted values for this call only. */
  connectionConfig: Readonly<Record<string, unknown>>;
  onInbound(envelope: ChannelInboundEnvelope): Promise<void>;
  onStatus(status: ChannelConnectorStatus): Promise<void> | void;
};

export interface ChannelKernelAdapter {
  readonly kernelId: KernelId;
  readonly ownerId: string;
  readonly supportedChannels: readonly string[];
  validate(channelType: string, connectionConfig: Readonly<Record<string, unknown>>): Promise<ChannelCredentialValidation>;
  activate(input: ChannelAdapterActivation): Promise<void>;
  deactivate(accountId: CanonicalChannelAccount['id']): Promise<void>;
  send(message: ChannelOutboundEnvelope): Promise<void>;
  targets(accountId: CanonicalChannelAccount['id'], query?: string): Promise<CanonicalChannelTarget[]>;
  status(accountId: CanonicalChannelAccount['id']): Promise<ChannelConnectorStatus>;
  startLogin?(
    channelType: string,
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void>;
  cancelLogin?(channelType: string, nativeAccountId?: string): Promise<void>;
}

export type ChannelConnectorContext = Omit<ChannelAdapterActivation, 'account'> & {
  account: CanonicalChannelAccount;
};

export interface ChannelConnectorSession {
  stop(): Promise<void>;
  send(message: ChannelOutboundEnvelope): Promise<void>;
  targets(query?: string): Promise<CanonicalChannelTarget[]>;
  status(): Promise<ChannelConnectorStatus>;
}

/** Connector factories are host extensions; they never own history or bindings. */
export interface ChannelConnectorFactory {
  readonly channelType: string;
  validate(connectionConfig: Readonly<Record<string, unknown>>): Promise<ChannelCredentialValidation>;
  connect(context: ChannelConnectorContext): Promise<ChannelConnectorSession>;
  startLogin?(
    nativeAccountId: string | undefined,
    emit: (event: ChannelLoginEvent) => void,
  ): Promise<void>;
  cancelLogin?(nativeAccountId?: string): Promise<void>;
  /** Delete disposable local auth/cache projections after canonical removal. */
  removeProjection?(account: CanonicalChannelAccount): Promise<void>;
}
