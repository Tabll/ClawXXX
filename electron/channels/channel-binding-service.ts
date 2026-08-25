import { randomUUID } from 'node:crypto';
import {
  channelBindingKey,
  type CanonicalChannelBinding,
  type ChannelConversationPolicy,
  type ChannelRebindResult,
} from '@shared/domains/channels';
import { asAgentId, asChannelAccountId } from '@shared/domains/identity';
import type { KernelId } from '@shared/kernels/contracts';
import type { ChannelDataClient } from './channel-account-service';
import type { ChannelOwnerCoordinator } from './channel-owner-coordinator';

export class ChannelBindingService {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly data: ChannelDataClient,
    private readonly owners: ChannelOwnerCoordinator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  rebind(input: {
    accountId: string;
    targetId?: string;
    kernelId: KernelId;
    agentId: string;
    conversationPolicy?: ChannelConversationPolicy;
  }): Promise<ChannelRebindResult> {
    return this.serialized(input.accountId, () => this.performRebind(input));
  }

  async remove(accountId: string, targetId = '*'): Promise<boolean> {
    return this.serialized(accountId, async () => {
      await this.owners.deactivate(asChannelAccountId(accountId));
      const deleted = await this.data.call<boolean>('deleteChannelBinding', accountId, targetId);
      const remaining = await this.data.call<CanonicalChannelBinding[]>('listChannelBindings', accountId);
      if (remaining.length > 0) await this.owners.activate(asChannelAccountId(accountId), remaining[0].kernelId);
      return deleted;
    });
  }

  private async performRebind(input: {
    accountId: string;
    targetId?: string;
    kernelId: KernelId;
    agentId: string;
    conversationPolicy?: ChannelConversationPolicy;
  }): Promise<ChannelRebindResult> {
    const targetId = input.targetId?.trim() || '*';
    const previous = await this.data.call<CanonicalChannelBinding | undefined>(
      'getChannelBinding',
      input.accountId,
      targetId,
    );
    const timestamp = this.now().toISOString();
    const operationId = randomUUID();
    const next: CanonicalChannelBinding = {
      id: channelBindingKey(asChannelAccountId(input.accountId), targetId),
      accountId: asChannelAccountId(input.accountId),
      targetId,
      kernelId: input.kernelId,
      agentId: asAgentId(input.agentId),
      conversationPolicy: input.conversationPolicy ?? previous?.conversationPolicy ?? 'per-thread',
      ...(previous?.conversationId ? { conversationId: previous.conversationId } : {}),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.data.call('putOperation', {
      id: operationId,
      kind: 'channel.rebind',
      targetType: 'channel-binding',
      targetId: next.id,
      desiredState: next,
      createdAt: timestamp,
    });
    await this.owners.deactivate(next.accountId);
    try {
      await this.data.call('putChannelBinding', next);
      await this.owners.activate(next.accountId, next.kernelId);
      await this.data.call('completeOperation', { id: operationId, ok: true, updatedAt: this.now().toISOString() });
      return { ok: true, rolledBack: false, binding: next };
    } catch (error) {
      let rollbackError: unknown;
      try {
        if (previous) {
          const restored: CanonicalChannelBinding = {
            ...previous,
            revision: next.revision + 1,
            updatedAt: this.now().toISOString(),
          };
          await this.data.call('putChannelBinding', restored);
          await this.owners.activate(restored.accountId, restored.kernelId);
        } else {
          await this.data.call('deleteChannelBinding', next.accountId, targetId);
        }
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      const message = safeError(error);
      await this.data.call('completeOperation', {
        id: operationId,
        ok: false,
        error: rollbackError ? `${message}; rollback activation failed: ${safeError(rollbackError)}` : message,
        updatedAt: this.now().toISOString(),
      });
      return {
        ok: false,
        rolledBack: rollbackError === undefined,
        ...(previous ? { binding: previous } : {}),
        error: rollbackError ? `${message}; ${safeError(rollbackError)}` : message,
      };
    }
  }

  private serialized<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(accountId, tail);
    void tail.finally(() => {
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    });
    return result;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
