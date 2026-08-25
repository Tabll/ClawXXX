import type { ConversationId, RunId, TurnId } from '../conversations/contracts';
import type { KernelId } from '../kernels/contracts';
import type {
  AgentId,
  ChannelAccountId,
  ChannelBindingId,
  KernelEntityProjection,
} from './identity';

export type CanonicalChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error';

export type CanonicalChannelFormField = {
  key: string;
  labelKey: string;
  type: 'text' | 'password' | 'select' | 'boolean';
  required: boolean;
  secret: boolean;
  options?: Array<{ value: string; labelKey: string }>;
};

export type CanonicalChannelTarget = {
  id: string;
  displayName: string;
  kind: 'direct' | 'group' | 'room' | 'thread';
  metadata?: Record<string, string>;
};

export type ChannelOwnerLease = {
  accountId: ChannelAccountId;
  ownerId: string;
  kernelId: KernelId;
  generation: number;
  leaseExpiresAt: string;
  updatedAt: string;
};

/**
 * Canonical account identity is global (`channelType:nativeAccountId`). The
 * native account id remains separate because most connectors call their main
 * account `default`, which is not globally unique.
 */
export type CanonicalChannelAccount = {
  id: ChannelAccountId;
  channelType: string;
  nativeAccountId: string;
  displayName: string;
  credentialRef?: string;
  connectionOwner?: ChannelOwnerLease;
  status: CanonicalChannelStatus;
  statusDetail?: string;
  /** Non-secret connector configuration only. */
  config: Record<string, unknown>;
  form: CanonicalChannelFormField[];
  targets: CanonicalChannelTarget[];
  enabled: boolean;
  isDefault: boolean;
  supportedKernels: KernelId[];
  projections: KernelEntityProjection[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ChannelConversationPolicy = 'reuse' | 'per-thread' | 'per-message';

export type CanonicalChannelBinding = {
  id: ChannelBindingId;
  accountId: ChannelAccountId;
  /** Connector target, or `*` for the account-wide fallback binding. */
  targetId: string;
  kernelId: KernelId;
  agentId: AgentId;
  conversationPolicy: ChannelConversationPolicy;
  conversationId?: ConversationId;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalChannelMessageIdentity = {
  accountId: ChannelAccountId;
  externalConversationId: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
};

export type CanonicalChannelAttachment = {
  blobHash: string;
  mimeType: string;
  fileName?: string;
  byteLength: number;
};

export type ChannelMessageStatus =
  | 'admitted'
  | 'processing'
  | 'processed'
  | 'pending-delivery'
  | 'retrying'
  | 'delivered'
  | 'dead-letter'
  | 'failed';

export type CanonicalChannelMessage = CanonicalChannelMessageIdentity & {
  id: string;
  conversationId: ConversationId;
  turnId?: TurnId;
  runId?: RunId;
  targetId: string;
  text?: string;
  attachments: CanonicalChannelAttachment[];
  payload: Record<string, unknown>;
  status: ChannelMessageStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChannelDeliveryAttemptStatus = 'sending' | 'retry' | 'sent' | 'dead-letter';

export type CanonicalChannelDeliveryAttempt = {
  id: string;
  messageId: string;
  attempt: number;
  status: ChannelDeliveryAttemptStatus;
  error?: string;
  nextRetryAt?: string;
  attemptedAt: string;
};

export type ChannelMessageAdmissionInput = {
  messageId: string;
  accountId: ChannelAccountId;
  externalConversationId: string;
  externalMessageId: string;
  direction: 'inbound' | 'outbound';
  targetId: string;
  text?: string;
  attachments?: CanonicalChannelAttachment[];
  payload?: Record<string, unknown>;
  status?: ChannelMessageStatus;
  conversationPolicy: ChannelConversationPolicy;
  bindingConversationId?: ConversationId;
  proposedConversationId: ConversationId;
  conversationTitle?: string;
  createdAt: string;
};

export type ChannelMessageAdmissionResult = {
  inserted: boolean;
  message: CanonicalChannelMessage;
};

export type ChannelOwnerLeaseAcquireResult = {
  acquired: boolean;
  lease: ChannelOwnerLease;
};

export type ChannelRebindResult = {
  ok: boolean;
  rolledBack: boolean;
  binding?: CanonicalChannelBinding;
  error?: string;
};

export function canonicalChannelAccountKey(channelType: string, nativeAccountId: string): ChannelAccountId {
  const encodedType = encodeURIComponent(channelType.trim().toLowerCase());
  const encodedAccount = encodeURIComponent(nativeAccountId.trim());
  return `${encodedType}:${encodedAccount}` as ChannelAccountId;
}

export function channelBindingKey(accountId: ChannelAccountId, targetId = '*'): ChannelBindingId {
  return `${accountId}:${encodeURIComponent(targetId)}` as ChannelBindingId;
}

export function channelCredentialReference(accountId: ChannelAccountId): string {
  return `channel-credential://${encodeURIComponent(accountId)}`;
}
