import type { ConversationStoreProtocolClient } from '@shared/conversations/store-protocol';
import {
  CONVERSATION_STORE_PROTOCOL,
  NATIVE_HISTORY_FALLBACK_ALLOWED,
} from '@shared/conversations/store-protocol';
import type { KernelId } from '@shared/kernels/contracts';

export type DataServiceCallClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

/** Authenticated kernel-scoped view of the Main-owned Conversation Store. */
export class RemoteConversationStoreProtocolClient implements ConversationStoreProtocolClient {
  readonly protocol = CONVERSATION_STORE_PROTOCOL;
  readonly nativeHistoryFallback = NATIVE_HISTORY_FALLBACK_ALLOWED;

  constructor(
    private readonly client: DataServiceCallClient,
    private readonly kernelId: KernelId,
  ) {}

  compileContext(input: Parameters<ConversationStoreProtocolClient['compileContext']>[0]) {
    this.assertKernel(input.kernelId);
    return this.client.call<Awaited<ReturnType<ConversationStoreProtocolClient['compileContext']>>>(
      'compileContext',
      {
        conversationId: input.conversationId,
        runId: input.runId,
        maxBlocks: input.budget.maxBlocks,
        maxTextCharacters: input.budget.maxTextCharacters,
      },
    );
  }

  appendEvents(events: Parameters<ConversationStoreProtocolClient['appendEvents']>[0]) {
    for (const event of events) this.assertKernel(event.kernelId);
    return this.client.call<Awaited<ReturnType<ConversationStoreProtocolClient['appendEvents']>>>(
      'appendEvents',
      events,
    );
  }

  readAttachment(input: Parameters<ConversationStoreProtocolClient['readAttachment']>[0]) {
    return this.client.call<Uint8Array>('readBlob', {
      grantId: input.grantId,
      blobHash: input.blobHash,
      runId: input.runId,
      now: new Date().toISOString(),
    });
  }

  putCheckpoint(input: Parameters<ConversationStoreProtocolClient['putCheckpoint']>[0]) {
    this.assertKernel(input.kernelId);
    return this.client.call<void>('putCheckpoint', {
      runId: input.runId,
      codec: input.codec,
      schemaVersion: input.schemaVersion,
      checkpoint: input.checkpoint,
      createdAt: input.createdAt,
    });
  }

  getLatestCheckpoint(input: Parameters<ConversationStoreProtocolClient['getLatestCheckpoint']>[0]) {
    this.assertKernel(input.kernelId);
    return this.client.call<Awaited<ReturnType<ConversationStoreProtocolClient['getLatestCheckpoint']>>>(
      'getLatestConversationCheckpoint',
      {
        conversationId: input.conversationId,
        codec: input.codec,
        schemaVersion: input.schemaVersion,
        beforeRunId: input.beforeRunId,
      },
    );
  }

  private assertKernel(kernelId: KernelId): void {
    if (kernelId !== this.kernelId) {
      throw new Error(`Conversation Store client is scoped to ${this.kernelId}, received ${kernelId}`);
    }
  }
}
