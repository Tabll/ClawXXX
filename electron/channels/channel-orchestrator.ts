import { randomUUID } from 'node:crypto';
import type {
  CanonicalContentBlock,
  ConversationExport,
  ConversationId,
  RunId,
  TurnId,
} from '@shared/conversations/contracts';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type {
  CanonicalChannelAttachment,
  CanonicalChannelBinding,
  CanonicalChannelDeliveryAttempt,
  CanonicalChannelMessage,
  ChannelMessageAdmissionResult,
  ChannelOwnerLease,
} from '@shared/domains/channels';
import { canonicalChannelAccountKey } from '@shared/domains/channels';
import type { CanonicalCronDelivery } from '@shared/domains/cron';
import type { KernelId } from '@shared/kernels/contracts';
import type { ChannelDataClient } from './channel-account-service';
import type { ChannelOwnerCoordinator } from './channel-owner-coordinator';
import type {
  ChannelInboundAttachment,
  ChannelInboundEnvelope,
  ChannelOutboundAttachment,
  ChannelOutboundEnvelope,
} from './channel-runtime-contracts';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export type ChannelConversationRouter = {
  prompt(input: {
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: KernelId;
    agentId: string;
    workspaceUri: string;
    permissionMode: 'deny';
    blocks: CanonicalContentBlock[];
    attachments: Array<{ blockId: string; blobHash: string; accessGrantId: string }>;
  }): Promise<{
    conversationId: ConversationId;
    turnId: TurnId;
    runId: RunId;
    kernelId: KernelId;
    generation: number;
    acceptedAt: string;
  }>;
};

type StoredBlob = { hash: string; byteLength: number; mimeType: string };

/**
 * The only ingress/egress path for Channel messages. Connectors transport
 * bytes; this service owns admission, Conversation execution and delivery.
 */
export class ChannelOrchestrator {
  private readonly conversationTails = new Map<ConversationId, Promise<unknown>>();
  private readonly deliveryTails = new Map<string, Promise<unknown>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private readonly data: ChannelDataClient,
    private readonly router: ChannelConversationRouter,
    private readonly owners: ChannelOwnerCoordinator,
    private readonly options: {
      now?: () => Date;
      id?: () => string;
      maxDeliveryAttempts?: number;
      retryBaseMs?: number;
    } = {},
  ) {}

  async admitInbound(envelope: ChannelInboundEnvelope): Promise<CanonicalChannelMessage> {
    return this.admitInboundWithPolicy(envelope, true);
  }

  /**
   * Persist an inbound message before acknowledging a connector hand-off, then
   * execute it on the per-conversation queue. Connector processes never need
   * to remain blocked for the duration of a model run.
   */
  async acceptInbound(envelope: ChannelInboundEnvelope): Promise<CanonicalChannelMessage> {
    return this.admitInboundWithPolicy(envelope, false);
  }

  private async admitInboundWithPolicy(
    envelope: ChannelInboundEnvelope,
    waitForCompletion: boolean,
  ): Promise<CanonicalChannelMessage> {
    if (this.stopped) throw new Error('Channel Orchestrator is stopped');
    validateInbound(envelope);
    const binding = await this.data.call<CanonicalChannelBinding | undefined>(
      'resolveChannelBinding',
      envelope.accountId,
      envelope.targetId,
    );
    if (!binding) throw new Error(`Channel target has no kernel/agent binding: ${envelope.accountId}/${envelope.targetId}`);
    const lease = await this.data.call<ChannelOwnerLease | undefined>(
      'getChannelOwnerLease',
      envelope.accountId,
      this.now().toISOString(),
    );
    if (!lease || lease.kernelId !== binding.kernelId) {
      throw new Error(`Channel binding has no active ${binding.kernelId} owner lease`);
    }

    const staged = await this.stageInboundAttachments(envelope.attachments ?? []);
    const promptBlocks: CanonicalContentBlock[] = [
      ...(envelope.text !== undefined ? [{
        id: this.id(),
        type: 'text' as const,
        visibility: 'portable' as const,
        text: envelope.text,
      }] : []),
      ...staged.blocks,
    ];
    const admission = await this.data.call<ChannelMessageAdmissionResult>('admitChannelMessage', {
      messageId: this.id(),
      accountId: envelope.accountId,
      externalConversationId: envelope.externalConversationId,
      externalMessageId: envelope.externalMessageId,
      direction: 'inbound',
      targetId: envelope.targetId,
      ...(envelope.text !== undefined ? { text: envelope.text } : {}),
      ...(staged.attachments.length > 0 ? { attachments: staged.attachments } : {}),
      payload: {
        ...(envelope.senderId ? { senderId: envelope.senderId } : {}),
        ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
        ...(envelope.replyToExternalMessageId ? { replyToExternalMessageId: envelope.replyToExternalMessageId } : {}),
        receivedAt: envelope.receivedAt,
      },
      status: 'admitted',
      conversationPolicy: binding.conversationPolicy,
      ...(binding.conversationId ? { bindingConversationId: binding.conversationId } : {}),
      proposedConversationId: asConversationId(this.id()),
      conversationTitle: `${envelope.channelType} · ${envelope.targetId}`,
      createdAt: envelope.receivedAt,
    });
    if (!admission.inserted) return admission.message;
    const execution = this.serializeConversation(admission.message.conversationId, () => (
      this.executeInbound(admission.message, binding, promptBlocks, staged.grants)
    ));
    if (waitForCompletion) return execution;
    void execution.catch(() => undefined);
    return admission.message;
  }

  async retryPending(): Promise<void> {
    if (this.stopped) return;
    const pending = await this.data.call<CanonicalChannelMessage[]>('listPendingChannelDeliveries', 500);
    await Promise.allSettled(pending.map(message => this.scheduleOrDeliver(message)));
  }

  async retryMessage(messageId: string): Promise<void> {
    const message = await this.data.call<CanonicalChannelMessage | undefined>('getChannelMessage', messageId);
    if (!message || message.direction !== 'outbound') throw new Error(`Outbound Channel message not found: ${messageId}`);
    const timer = this.retryTimers.get(message.id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(message.id);
    await this.serializeDelivery(message.id, () => this.deliver(message));
  }

  /**
   * Admit a completed scheduled turn into the same durable outbound pipeline
   * used by Channel replies. Delivery retries and dead letters therefore stay
   * canonical and independent of either kernel runtime.
   */
  async deliverScheduledRun(input: {
    jobId: string;
    admissionId: string;
    scheduledFor: string;
    delivery: CanonicalCronDelivery;
    conversationId: ConversationId;
    runId: RunId;
    turnId: TurnId;
  }): Promise<string | undefined> {
    if (this.stopped) throw new Error('Channel Orchestrator is stopped');
    if (!input.delivery.targetId.trim()) throw new Error('Scheduled delivery target is required');
    const accountId = input.delivery.channel && !input.delivery.accountId.includes(':')
      ? canonicalChannelAccountKey(input.delivery.channel, input.delivery.accountId || 'default')
      : input.delivery.accountId;
    const account = await this.data.call<unknown>('getChannelAccount', accountId, {
      now: this.now().toISOString(),
    });
    if (!account) throw new Error(`Scheduled delivery account is unavailable: ${accountId}`);
    const exported = await this.data.call<ConversationExport>('exportConversation', input.conversationId);
    const run = exported.runs.find(candidate => candidate.id === input.runId);
    const assistantTurn = run?.assistantTurnId
      ? exported.turns.find(candidate => candidate.id === run.assistantTurnId)
      : undefined;
    if (!assistantTurn) throw new Error(`Scheduled run has no durable assistant turn: ${input.runId}`);
    const text = assistantTurn.blocks
      .filter(block => block.visibility === 'portable' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!.trim())
      .filter(Boolean)
      .join('\n\n');
    const fileNames = attachmentFileNames(assistantTurn.blocks);
    const attachments: CanonicalChannelAttachment[] = [];
    for (const block of assistantTurn.blocks) {
      if (block.visibility !== 'portable' || !block.blobHash || !block.mimeType) continue;
      const blob = await this.data.call<{ size: number; mimeType: string }>('readConversationBlob', {
        conversationId: input.conversationId,
        blobHash: block.blobHash,
      });
      attachments.push({
        blobHash: block.blobHash,
        mimeType: blob.mimeType,
        ...(fileNames.get(block.id) ? { fileName: fileNames.get(block.id) } : {}),
        byteLength: blob.size,
      });
    }
    if (!text && attachments.length === 0) return undefined;
    const externalMessageId = `cron:${input.jobId}:${input.scheduledFor}`;
    const admission = await this.data.call<ChannelMessageAdmissionResult>('admitChannelMessage', {
      messageId: `cron-outbound:${input.admissionId}`,
      accountId,
      externalConversationId: input.delivery.targetId,
      externalMessageId,
      direction: 'outbound',
      targetId: input.delivery.targetId,
      ...(text ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      payload: {
        source: 'cron',
        jobId: input.jobId,
        admissionId: input.admissionId,
        scheduledFor: input.scheduledFor,
      },
      status: 'pending-delivery',
      conversationPolicy: 'reuse',
      bindingConversationId: input.conversationId,
      proposedConversationId: input.conversationId,
      createdAt: this.now().toISOString(),
    });
    await this.data.call('updateChannelMessage', {
      id: admission.message.id,
      status: admission.message.status,
      updatedAt: this.now().toISOString(),
      turnId: input.turnId,
      runId: input.runId,
    });
    const message = await this.data.call<CanonicalChannelMessage | undefined>(
      'getChannelMessage',
      admission.message.id,
    ) ?? admission.message;
    await this.serializeDelivery(message.id, () => this.deliver(message));
    return message.id;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async executeInbound(
    message: CanonicalChannelMessage,
    binding: CanonicalChannelBinding,
    blocks: CanonicalContentBlock[],
    grants: Array<{ blockId: string; blobHash: string; accessGrantId: string }>,
  ): Promise<CanonicalChannelMessage> {
    const turnId = asTurnId(this.id());
    const runId = asRunId(this.id());
    await this.data.call('updateChannelMessage', {
      id: message.id,
      status: 'processing',
      updatedAt: this.now().toISOString(),
    });
    try {
      const acceptance = await this.router.prompt({
        conversationId: message.conversationId,
        turnId,
        runId,
        kernelId: binding.kernelId,
        agentId: binding.agentId,
        // The canonical Agent service is authoritative; ConversationRouter
        // resolves and replaces this placeholder with its workspace snapshot.
        workspaceUri: 'file:///',
        permissionMode: 'deny',
        blocks,
        attachments: grants,
      });
      await this.data.call('updateChannelMessage', {
        id: message.id,
        status: 'processed',
        updatedAt: this.now().toISOString(),
        turnId: acceptance.turnId,
        runId: acceptance.runId,
      });
      const outbound = await this.createOutbound(message, acceptance.runId, acceptance.turnId);
      if (outbound) await this.serializeDelivery(outbound.id, () => this.deliver(outbound));
      return (await this.data.call<CanonicalChannelMessage>('getChannelMessage', message.id)) ?? message;
    } catch (error) {
      await this.data.call('updateChannelMessage', {
        id: message.id,
        status: 'failed',
        updatedAt: this.now().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  private async createOutbound(
    inbound: CanonicalChannelMessage,
    runId: RunId,
    turnId: TurnId,
  ): Promise<CanonicalChannelMessage | undefined> {
    const exported = await this.data.call<ConversationExport>('exportConversation', inbound.conversationId);
    const run = exported.runs.find(candidate => candidate.id === runId);
    const assistantTurn = run?.assistantTurnId
      ? exported.turns.find(candidate => candidate.id === run.assistantTurnId)
      : undefined;
    if (!assistantTurn) throw new Error(`Channel run has no durable assistant turn: ${runId}`);
    const text = assistantTurn.blocks
      .filter(block => block.visibility === 'portable' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!.trim())
      .filter(Boolean)
      .join('\n\n');
    const fileNames = attachmentFileNames(assistantTurn.blocks);
    const attachments: CanonicalChannelAttachment[] = [];
    for (const block of assistantTurn.blocks) {
      if (block.visibility !== 'portable' || !block.blobHash || !block.mimeType) continue;
      const blob = await this.data.call<{ size: number; mimeType: string }>('readConversationBlob', {
        conversationId: inbound.conversationId,
        blobHash: block.blobHash,
      });
      attachments.push({
        blobHash: block.blobHash,
        mimeType: blob.mimeType,
        ...(fileNames.get(block.id) ? { fileName: fileNames.get(block.id) } : {}),
        byteLength: blob.size,
      });
    }
    if (!text && attachments.length === 0) return undefined;
    const admission = await this.data.call<ChannelMessageAdmissionResult>('admitChannelMessage', {
      messageId: `outbound:${inbound.id}`,
      accountId: inbound.accountId,
      externalConversationId: inbound.externalConversationId,
      externalMessageId: `${inbound.externalMessageId}:reply`,
      direction: 'outbound',
      targetId: inbound.targetId,
      ...(text ? { text } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      payload: { replyToExternalMessageId: inbound.externalMessageId },
      status: 'pending-delivery',
      conversationPolicy: 'reuse',
      bindingConversationId: inbound.conversationId,
      proposedConversationId: inbound.conversationId,
      createdAt: this.now().toISOString(),
    });
    await this.data.call('updateChannelMessage', {
      id: admission.message.id,
      status: admission.message.status,
      updatedAt: this.now().toISOString(),
      turnId,
      runId,
    });
    return (await this.data.call<CanonicalChannelMessage>('getChannelMessage', admission.message.id)) ?? admission.message;
  }

  private async deliver(message: CanonicalChannelMessage): Promise<void> {
    // Callers may have captured the message before a prior serialized delivery
    // completed. Reload here so stale `pending-delivery` state cannot resend a
    // message that is already terminal.
    const deliverable = await this.data.call<CanonicalChannelMessage | undefined>(
      'getChannelMessage',
      message.id,
    ) ?? message;
    if (this.stopped || deliverable.status === 'delivered' || deliverable.status === 'dead-letter') return;
    const attempts = await this.data.call<CanonicalChannelDeliveryAttempt[]>(
      'listChannelDeliveryAttempts',
      deliverable.id,
    );
    const attempt = attempts.length + 1;
    const lease = await this.data.call<ChannelOwnerLease | undefined>(
      'getChannelOwnerLease',
      deliverable.accountId,
      this.now().toISOString(),
    );
    try {
      if (!lease) throw new Error(`Channel account has no active owner: ${deliverable.accountId}`);
      await this.data.call('recordChannelDeliveryAttempt', {
        id: this.id(),
        messageId: deliverable.id,
        attempt,
        status: 'sending',
        attemptedAt: this.now().toISOString(),
      } satisfies CanonicalChannelDeliveryAttempt);
      await this.owners.send(lease.kernelId, await this.hydrateOutbound(deliverable));
      await this.data.call('recordChannelDeliveryAttempt', {
        id: this.id(),
        messageId: deliverable.id,
        attempt,
        status: 'sent',
        attemptedAt: this.now().toISOString(),
      } satisfies CanonicalChannelDeliveryAttempt);
    } catch (error) {
      const terminal = attempt >= this.maxDeliveryAttempts();
      const attemptedAt = this.now();
      const nextRetryAt = new Date(
        attemptedAt.getTime() + this.retryBaseMs() * (2 ** Math.max(attempt - 1, 0)),
      ).toISOString();
      await this.data.call('recordChannelDeliveryAttempt', {
        id: this.id(),
        messageId: deliverable.id,
        attempt,
        status: terminal ? 'dead-letter' : 'retry',
        error: safeConnectorError(error),
        ...(!terminal ? { nextRetryAt } : {}),
        attemptedAt: attemptedAt.toISOString(),
      } satisfies CanonicalChannelDeliveryAttempt);
      if (!terminal) this.schedule(deliverable.id, nextRetryAt);
    }
  }

  private async hydrateOutbound(message: CanonicalChannelMessage): Promise<ChannelOutboundEnvelope> {
    const attachments: ChannelOutboundAttachment[] = [];
    for (const attachment of message.attachments) {
      const blob = await this.data.call<{ data: Uint8Array; mimeType: string }>('readConversationBlob', {
        conversationId: message.conversationId,
        blobHash: attachment.blobHash,
      });
      attachments.push({
        data: blob.data,
        mimeType: blob.mimeType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      });
    }
    return {
      accountId: message.accountId,
      channelType: message.accountId.split(':', 1)[0],
      externalConversationId: message.externalConversationId,
      externalMessageId: message.externalMessageId,
      targetId: message.targetId,
      ...(message.text ? { text: message.text } : {}),
      attachments,
      ...(typeof message.payload.replyToExternalMessageId === 'string'
        ? { replyToExternalMessageId: message.payload.replyToExternalMessageId }
        : {}),
    };
  }

  private async scheduleOrDeliver(message: CanonicalChannelMessage): Promise<void> {
    const attempts = await this.data.call<CanonicalChannelDeliveryAttempt[]>('listChannelDeliveryAttempts', message.id);
    const last = attempts.at(-1);
    if (last?.status === 'sent' || last?.status === 'dead-letter') return;
    if (attempts.length >= this.maxDeliveryAttempts()) {
      await this.data.call('recordChannelDeliveryAttempt', {
        id: this.id(),
        messageId: message.id,
        attempt: attempts.length + 1,
        status: 'dead-letter',
        error: 'Delivery retry budget exhausted during recovery',
        attemptedAt: this.now().toISOString(),
      } satisfies CanonicalChannelDeliveryAttempt);
      return;
    }
    if (last?.nextRetryAt && last.nextRetryAt > this.now().toISOString()) {
      this.schedule(message.id, last.nextRetryAt);
      return;
    }
    await this.serializeDelivery(message.id, () => this.deliver(message));
  }

  private schedule(messageId: string, nextRetryAt: string): void {
    const existing = this.retryTimers.get(messageId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(Date.parse(nextRetryAt) - this.now().getTime(), 0);
    const timer = setTimeout(() => {
      this.retryTimers.delete(messageId);
      void this.retryMessage(messageId).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    timer.unref?.();
    this.retryTimers.set(messageId, timer);
  }

  private async stageInboundAttachments(input: ChannelInboundAttachment[]): Promise<{
    attachments: CanonicalChannelAttachment[];
    blocks: CanonicalContentBlock[];
    grants: Array<{ blockId: string; blobHash: string; accessGrantId: string }>;
  }> {
    let total = 0;
    const attachments: CanonicalChannelAttachment[] = [];
    const blocks: CanonicalContentBlock[] = [];
    const grants: Array<{ blockId: string; blobHash: string; accessGrantId: string }> = [];
    for (const attachment of input) {
      if (!(attachment.data instanceof Uint8Array) || attachment.data.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Channel attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      total += attachment.data.byteLength;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Channel attachment batch exceeds the admission limit');
      const stored = await this.data.call<StoredBlob>('putBlob', {
        data: attachment.data,
        mimeType: normalizedMimeType(attachment.mimeType),
        createdAt: this.now().toISOString(),
      });
      const blockId = this.id();
      const fileName = normalizedFileName(attachment.fileName);
      attachments.push({
        blobHash: stored.hash,
        mimeType: stored.mimeType,
        ...(fileName ? { fileName } : {}),
        byteLength: stored.byteLength,
      });
      blocks.push({
        id: blockId,
        type: stored.mimeType.startsWith('image/') ? 'image' : 'resource-link',
        visibility: 'portable',
        mimeType: stored.mimeType,
        blobHash: stored.hash,
      });
      if (fileName) {
        blocks.push({
          id: this.id(),
          type: 'metadata',
          visibility: 'portable',
          json: { attachment: { blockId, fileName } },
        });
      }
      grants.push({ blockId, blobHash: stored.hash, accessGrantId: this.id() });
    }
    return { attachments, blocks, grants };
  }

  private serializeConversation<T>(conversationId: ConversationId, task: () => Promise<T>): Promise<T> {
    return serialize(this.conversationTails, conversationId, task);
  }

  private serializeDelivery<T>(messageId: string, task: () => Promise<T>): Promise<T> {
    return serialize(this.deliveryTails, messageId, task);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(): string {
    return this.options.id?.() ?? randomUUID();
  }

  private maxDeliveryAttempts(): number {
    return Math.max(this.options.maxDeliveryAttempts ?? 3, 1);
  }

  private retryBaseMs(): number {
    return Math.max(this.options.retryBaseMs ?? 2_000, 100);
  }
}

function serialize<K, T>(tails: Map<K, Promise<unknown>>, key: K, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(key, tail);
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

function validateInbound(envelope: ChannelInboundEnvelope): void {
  if (!envelope.accountId || !envelope.channelType.trim() || !envelope.externalConversationId.trim()
    || !envelope.externalMessageId.trim() || !envelope.targetId.trim()) {
    throw new Error('Channel inbound account, channel, conversation, message and target identities are required');
  }
  if (!envelope.text?.trim() && (envelope.attachments?.length ?? 0) === 0) {
    throw new Error('Channel inbound message has no portable content');
  }
  if (!Number.isFinite(Date.parse(envelope.receivedAt))) throw new Error('Channel inbound timestamp is invalid');
}

function normalizedMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized) ? normalized : 'application/octet-stream';
}

function normalizedFileName(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/\\/g, '/')
    .split('/')
    .at(-1)
    ?.split('')
    .filter(character => character.charCodeAt(0) > 31)
    .join('')
    .trim();
  return normalized ? normalized.slice(0, 255) : undefined;
}

function attachmentFileNames(blocks: CanonicalContentBlock[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'metadata' || !block.json || typeof block.json !== 'object') continue;
    const attachment = (block.json as { attachment?: { blockId?: unknown; fileName?: unknown } }).attachment;
    if (typeof attachment?.blockId === 'string' && typeof attachment.fileName === 'string') {
      result.set(attachment.blockId, normalizedFileName(attachment.fileName) ?? 'attachment');
    }
  }
  return result;
}

function safeConnectorError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}
