import { randomUUID } from 'node:crypto';
import { asConversationId } from '@shared/conversations/contracts';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';

function requireDataClient(client: RemoteDataServiceClient | undefined): RemoteDataServiceClient {
  if (!client) throw new Error('ClawX DataService is not available');
  return client;
}

function idOf(payload: { id: string }) {
  const id = payload.id?.trim();
  if (!id) throw new Error('Conversation id is required');
  return asConversationId(id);
}

/** Canonical renderer boundary. No action in this service contacts a runtime. */
export function createConversationsApi(
  dataClient?: RemoteDataServiceClient,
): CompleteHostServiceRegistry['conversations'] {
  const data = () => requireDataClient(dataClient);
  return {
    list: payload => data().call('listConversations', {
      limit: payload?.limit,
      cursor: payload?.cursor,
      lastKernelId: payload?.lastKernelId,
      participatedKernelId: payload?.participatedKernelId,
      agentId: payload?.agentId,
      sourceChannel: payload?.sourceChannel,
      workspaceUri: payload?.workspaceUri,
      pinned: payload?.pinned,
    }),
    search: payload => {
      const query = payload.query?.trim();
      if (!query) return Promise.resolve([]);
      return data().call('searchConversations', query, payload.limit, {
        lastKernelId: payload.lastKernelId,
        participatedKernelId: payload.participatedKernelId,
        agentId: payload.agentId,
        sourceChannel: payload.sourceChannel,
        workspaceUri: payload.workspaceUri,
        pinned: payload.pinned,
      });
    },
    get: async payload => {
      const id = idOf(payload);
      const summary = await data().call('getConversation', id);
      if (!summary) return null;
      return data().call('exportConversation', id);
    },
    rename: async payload => {
      const title = payload.title?.trim();
      if (!title) throw new Error('Conversation title is required');
      await data().call('renameConversation', idOf(payload), title, new Date().toISOString());
      return { success: true };
    },
    pin: async payload => {
      const now = new Date().toISOString();
      await data().call('pinConversation', idOf(payload), payload.pinned ? now : undefined, now);
      return { success: true };
    },
    delete: async payload => {
      await data().call(
        'deleteConversation',
        idOf(payload),
        new Date().toISOString(),
        payload.hard === true,
      );
      return { success: true };
    },
    branch: payload => data().call('branchConversation', {
      sourceConversationId: payload.sourceConversationId,
      sourceTurnId: payload.sourceTurnId,
      branchConversationId: payload.branchConversationId ?? asConversationId(randomUUID()),
      ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
      createdAt: new Date().toISOString(),
    }),
    export: payload => data().call('exportConversation', idOf(payload)),
  };
}
