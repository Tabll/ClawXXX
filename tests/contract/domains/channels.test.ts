// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CanonicalChannelAccountService } from '@electron/channels/channel-account-service';
import { MemoryChannelSecretStore } from '@electron/channels/channel-secret-store';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { CanonicalAgentService } from '@electron/domains/agents/agent-service';
import { asConversationId } from '@shared/conversations/contracts';
import {
  canonicalChannelAccountKey,
  channelBindingKey,
  type CanonicalChannelBinding,
} from '@shared/domains/channels';

function callClient(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const operation = (client as unknown as Record<string, unknown>)[method];
      if (typeof operation !== 'function') return Promise.reject(new Error(`Unknown DataService method: ${method}`));
      return Reflect.apply(operation, client, args) as Promise<T>;
    },
  };
}

async function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `clawx-channels-${name}-`));
  const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
  const main = service.connect({ role: 'main' });
  const data = callClient(main);
  const secrets = new MemoryChannelSecretStore();
  const accounts = new CanonicalChannelAccountService(
    data,
    secrets,
    () => new Date('2026-08-24T00:00:00.000Z'),
  );
  const agents = new CanonicalAgentService(
    data,
    id => `file://${join(root, 'workspaces', id)}`,
    () => new Date('2026-08-24T00:00:00.000Z'),
  );
  const agent = await agents.create({
    displayName: 'Channel Agent',
    supportedKernels: ['openclaw', 'deepseek-harness'],
  });
  return { root, service, main, data, secrets, accounts, agent };
}

describe('canonical multi-kernel Channels domain', () => {
  it('uses global account identities and keeps credentials outside SQLite', async () => {
    const { service, main, secrets, accounts } = await fixture('account');
    try {
      const telegram = await accounts.upsert({
        channelType: 'telegram',
        nativeAccountId: 'default',
        displayName: 'Telegram bot',
        config: { botToken: 'tg-secret', allowedUsers: '42' },
      });
      const discord = await accounts.upsert({
        channelType: 'discord',
        nativeAccountId: 'default',
        config: { token: 'discord-secret', guildId: 'guild-1' },
      });

      expect(telegram.id).toBe('telegram:default');
      expect(discord.id).toBe('discord:default');
      expect(telegram.id).not.toBe(discord.id);
      expect(telegram.config).toEqual({ allowedUsers: '42' });
      expect(telegram.credentialRef).toMatch(/^channel-credential:\/\//);
      expect(await secrets.get(telegram.id)).toEqual(expect.objectContaining({
        values: { botToken: 'tg-secret' },
      }));
      expect(await accounts.getPublicFormValues(telegram)).toEqual({
        values: { allowedUsers: '42' },
        configuredSecretFields: ['botToken'],
      });

      await expect(main.putChannelAccount({
        ...telegram,
        config: { ...telegram.config, botToken: 'must-not-reach-sqlite' },
        revision: telegram.revision + 1,
      })).rejects.toThrow(/secrets cannot be persisted in SQLite/i);
    } finally {
      await service.close();
    }
  });

  it('extends adapter compatibility monotonically for future kernels', async () => {
    const { service, accounts } = await fixture('capabilities');
    try {
      const account = await accounts.upsert({
        channelType: 'telegram',
        nativeAccountId: 'main',
        config: { botToken: 'secret' },
        supportedKernels: ['openclaw'],
      });
      expect(account.supportedKernels).toEqual(['openclaw']);
      expect(await accounts.extendSupportedKernels(candidate => (
        candidate.channelType === 'telegram' ? ['deepseek-harness', 'future-kernel'] : []
      ))).toBe(1);
      expect((await accounts.getById(account.id))?.supportedKernels).toEqual([
        'openclaw',
        'deepseek-harness',
        'future-kernel',
      ]);
      expect(await accounts.extendSupportedKernels(() => [])).toBe(0);
      expect((await accounts.getById(account.id))?.supportedKernels).toContain('future-kernel');
    } finally {
      await service.close();
    }
  });

  it('enforces a single live connection owner and one owner kernel per account', async () => {
    const { service, main, accounts, agent } = await fixture('ownership');
    try {
      const account = await accounts.upsert({
        channelType: 'telegram',
        nativeAccountId: 'main',
        config: { botToken: 'secret', allowedUsers: '*' },
      });
      const binding: CanonicalChannelBinding = {
        id: channelBindingKey(account.id),
        accountId: account.id,
        targetId: '*',
        kernelId: 'openclaw',
        agentId: agent.id,
        conversationPolicy: 'per-thread',
        revision: 1,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      };
      await main.putChannelBinding(binding);
      await expect(main.putChannelBinding({
        ...binding,
        id: channelBindingKey(account.id, 'room-2'),
        targetId: 'room-2',
        kernelId: 'deepseek-harness',
      })).rejects.toThrow(/one connection owner kernel/i);

      const first = await main.acquireChannelOwnerLease({
        accountId: account.id,
        ownerId: 'openclaw-native-adapter',
        kernelId: 'openclaw',
        generation: 1,
        now: '2026-08-24T00:00:00.000Z',
        leaseExpiresAt: '2026-08-24T00:01:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      });
      expect(first.acquired).toBe(true);
      const contested = await main.acquireChannelOwnerLease({
        accountId: account.id,
        ownerId: 'clawx-relay',
        kernelId: 'deepseek-harness',
        generation: 1,
        now: '2026-08-24T00:00:30.000Z',
        leaseExpiresAt: '2026-08-24T00:02:00.000Z',
        updatedAt: '2026-08-24T00:00:30.000Z',
      });
      expect(contested).toEqual(expect.objectContaining({
        acquired: false,
        lease: expect.objectContaining({ kernelId: 'openclaw' }),
      }));
      const takeover = await main.acquireChannelOwnerLease({
        accountId: account.id,
        ownerId: 'clawx-relay',
        kernelId: 'deepseek-harness',
        generation: 2,
        now: '2026-08-24T00:01:00.001Z',
        leaseExpiresAt: '2026-08-24T00:02:00.000Z',
        updatedAt: '2026-08-24T00:01:00.001Z',
      });
      expect(takeover).toEqual(expect.objectContaining({
        acquired: true,
        lease: expect.objectContaining({ kernelId: 'deepseek-harness', generation: 2 }),
      }));
    } finally {
      await service.close();
    }
  });

  it('admits each external message once, maps threads to unified Conversations, and records delivery history', async () => {
    const { service, main, accounts } = await fixture('messages');
    try {
      const account = await accounts.upsert({
        channelType: 'telegram',
        nativeAccountId: 'main',
        config: { botToken: 'secret', allowedUsers: '*' },
      });
      const blob = await main.putBlob({
        data: new TextEncoder().encode('channel attachment'),
        mimeType: 'text/plain',
        createdAt: '2026-08-24T00:00:00.000Z',
      });
      const base = {
        accountId: account.id,
        externalConversationId: 'chat-42',
        direction: 'inbound' as const,
        targetId: 'chat-42',
        text: 'hello',
        attachments: [{
          blobHash: blob.hash,
          mimeType: blob.mimeType,
          fileName: 'hello.txt',
          byteLength: blob.byteLength,
        }],
        payload: { senderId: '42' },
        conversationPolicy: 'per-thread' as const,
        createdAt: '2026-08-24T00:00:00.000Z',
      };
      const first = await main.admitChannelMessage({
        ...base,
        messageId: 'channel-message-1',
        externalMessageId: 'external-1',
        proposedConversationId: asConversationId('conversation-1'),
      });
      const duplicate = await main.admitChannelMessage({
        ...base,
        messageId: 'channel-message-duplicate',
        externalMessageId: 'external-1',
        proposedConversationId: asConversationId('conversation-duplicate'),
      });
      const next = await main.admitChannelMessage({
        ...base,
        messageId: 'channel-message-2',
        externalMessageId: 'external-2',
        proposedConversationId: asConversationId('conversation-2'),
      });

      expect(first.inserted).toBe(true);
      expect(duplicate).toEqual(expect.objectContaining({
        inserted: false,
        message: expect.objectContaining({ id: 'channel-message-1' }),
      }));
      expect(next.message.conversationId).toBe(first.message.conversationId);
      expect((await main.listConversations()).items).toHaveLength(1);
      expect(await main.getConversation(first.message.conversationId)).toEqual(expect.objectContaining({
        sourceChannel: 'telegram',
      }));
      expect((await main.listConversations({ sourceChannel: 'telegram' })).items.map(row => row.id))
        .toEqual([first.message.conversationId]);
      expect((await main.listConversations({ sourceChannel: 'wechat' })).items).toEqual([]);

      const outbound = await main.admitChannelMessage({
        messageId: 'channel-message-out-1',
        accountId: account.id,
        externalConversationId: 'chat-42',
        externalMessageId: 'external-1:reply',
        direction: 'outbound',
        targetId: 'chat-42',
        text: 'world',
        conversationPolicy: 'reuse',
        bindingConversationId: first.message.conversationId,
        proposedConversationId: first.message.conversationId,
        createdAt: '2026-08-24T00:00:01.000Z',
      });
      await main.recordChannelDeliveryAttempt({
        id: 'delivery-1',
        messageId: outbound.message.id,
        attempt: 1,
        status: 'retry',
        error: 'network unavailable',
        nextRetryAt: '2026-08-24T00:00:03.000Z',
        attemptedAt: '2026-08-24T00:00:02.000Z',
      });
      await main.recordChannelDeliveryAttempt({
        id: 'delivery-2',
        messageId: outbound.message.id,
        attempt: 2,
        status: 'sent',
        attemptedAt: '2026-08-24T00:00:03.000Z',
      });
      expect(await main.getChannelMessage(outbound.message.id)).toEqual(expect.objectContaining({
        status: 'delivered',
        conversationId: first.message.conversationId,
      }));
      expect(await main.listChannelDeliveryAttempts(outbound.message.id)).toEqual([
        expect.objectContaining({ attempt: 1, status: 'retry' }),
        expect.objectContaining({ attempt: 2, status: 'sent' }),
      ]);

      expect(await accounts.delete('telegram', 'main')).toBe(true);
      expect(await main.getChannelMessage(first.message.id)).toEqual(expect.objectContaining({
        conversationId: first.message.conversationId,
      }));
      expect(await main.getConversation(first.message.conversationId)).toBeDefined();
    } finally {
      await service.close();
    }
  });

  it('rolls back Conversation admission when attachment staging is incomplete', async () => {
    const { service, main, accounts } = await fixture('rollback');
    try {
      const account = await accounts.upsert({
        channelType: 'telegram',
        nativeAccountId: 'main',
        config: { botToken: 'secret', allowedUsers: '*' },
      });
      await expect(main.admitChannelMessage({
        messageId: 'bad-attachment-message',
        accountId: account.id,
        externalConversationId: 'chat-1',
        externalMessageId: 'external-1',
        direction: 'inbound',
        targetId: 'chat-1',
        attachments: [{
          blobHash: 'missing',
          mimeType: 'text/plain',
          byteLength: 1,
        }],
        conversationPolicy: 'per-thread',
        proposedConversationId: asConversationId('must-rollback'),
        createdAt: '2026-08-24T00:00:00.000Z',
      })).rejects.toThrow(/attachment blob is missing/i);
      expect(await main.getConversation(asConversationId('must-rollback'))).toBeUndefined();
      expect(await main.getChannelMessage('bad-attachment-message')).toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it('does not collide accounts whose native ids contain separators', () => {
    expect(canonicalChannelAccountKey('telegram', 'a:b')).toBe('telegram:a%3Ab');
    expect(canonicalChannelAccountKey('telegram:a', 'b')).toBe('telegram%3Aa:b');
  });
});
