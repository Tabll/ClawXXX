import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { RawMessage } from '@shared/chat/types';
import type { ConversationExport, ConversationPage, ConversationSummary } from '../data/clawx-data-store';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import { asConversationId } from '@shared/conversations/contracts';

type CanonicalDataClient = Pick<RemoteDataServiceClient, 'call'>;

type SessionPayload = {
  id?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  title?: unknown;
  label?: unknown;
  pinned?: unknown;
  sessionKeys?: unknown;
  limit?: unknown;
};

function body(value: unknown): SessionPayload {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SessionPayload : {};
}

function requireDataClient(client?: CanonicalDataClient): CanonicalDataClient {
  if (!client) throw new Error('Canonical Conversation DataService is unavailable');
  return client;
}

function conversationId(value: unknown): string {
  const input = body(value);
  const candidate = input.id ?? input.sessionKey;
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('conversationId is required');
  return candidate.trim();
}

function limitOf(value: unknown, fallback = 1_000): number {
  const raw = body(value).limit;
  const parsed = typeof raw === 'number' ? raw : Number(raw ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 5_000) : fallback;
}

function blockContent(blocks: ConversationExport['turns'][number]['blocks']): RawMessage['content'] {
  const rendered = blocks
    .filter(block => block.visibility !== 'secret' && !block.revoked)
    .map(block => {
      if (block.type === 'image') {
        return {
          type: 'image',
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
          ...(block.blobHash ? { url: `clawx-blob://${block.blobHash}` } : {}),
        };
      }
      if (block.type === 'tool-call') {
        return { type: 'toolCall', id: block.id, name: 'tool', input: block.json };
      }
      if (block.type === 'tool-result') {
        return { type: 'toolResult', id: block.id, content: block.json ?? block.text ?? '' };
      }
      const text = block.text ?? (block.json === undefined ? '' : JSON.stringify(block.json));
      return { type: 'text', text };
    });
  if (rendered.length === 1 && rendered[0]?.type === 'text') return rendered[0].text ?? '';
  return rendered;
}

function exportedHistory(exported: ConversationExport, limit: number): RawMessage[] {
  return exported.turns.slice(-limit).map(turn => ({
    role: turn.role === 'tool' ? 'toolresult' : turn.role as RawMessage['role'],
    id: turn.id,
    timestamp: Date.parse(turn.createdAt),
    content: blockContent(turn.blocks),
  }));
}

function firstUserText(exported: ConversationExport): string | null {
  if (exported.conversation.title?.trim()) return exported.conversation.title.trim();
  const turn = exported.turns.find(candidate => candidate.role === 'user');
  if (!turn) return null;
  const text = turn.blocks
    .filter(block => block.type === 'text' && block.visibility === 'portable' && !block.revoked)
    .map(block => block.text ?? '')
    .join('\n')
    .trim();
  return text || null;
}

function extractText(message: RawMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(value => value && typeof value === 'object' && 'text' in value ? String((value as { text?: unknown }).text ?? '') : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function turnTimings(exported: ConversationExport, limit: number) {
  const runs = exported.runs
    .map(run => ({
      createdAt: typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : Number.NaN,
      completedAt: typeof run.completedAt === 'string' ? Date.parse(run.completedAt) : Number.NaN,
    }))
    .filter(run => Number.isFinite(run.createdAt) && Number.isFinite(run.completedAt) && run.completedAt >= run.createdAt);
  const users = exportedHistory(exported, Number.MAX_SAFE_INTEGER).filter(message => message.role === 'user');
  const rows = users.slice(-limit).map((message, index) => ({
    normalizedUserText: extractText(message),
    durationMs: runs[index]?.completedAt !== undefined ? runs[index]!.completedAt - runs[index]!.createdAt : undefined,
  }));
  const occurrences = new Map<string, number>();
  return rows.reverse().map(row => {
    const occurrence = (occurrences.get(row.normalizedUserText) ?? 0) + 1;
    occurrences.set(row.normalizedUserText, occurrence);
    return row.durationMs === undefined ? null : {
      normalizedUserText: row.normalizedUserText,
      userOccurrenceFromTail: occurrence,
      durationMs: row.durationMs,
    };
  }).filter((row): row is NonNullable<typeof row> => row !== null).reverse();
}

async function getExport(client: CanonicalDataClient, id: string): Promise<ConversationExport | undefined> {
  try {
    return await client.call<ConversationExport>('exportConversation', asConversationId(id));
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return undefined;
    throw error;
  }
}

/**
 * Legacy `sessions` Host API compatibility over the canonical Conversation
 * repository. It intentionally contains no filesystem or runtime protocol
 * fallback; M7's Conversation API can replace the names without changing the
 * durable authority.
 */
export function createSessionsApi(options: { dataClient?: CanonicalDataClient } = {}): CompleteHostServiceRegistry['sessions'] {
  return {
    delete: async payload => {
      const client = requireDataClient(options.dataClient);
      await client.call('deleteConversation', asConversationId(conversationId(payload)), new Date().toISOString(), true);
      return { success: true };
    },
    rename: async payload => {
      const client = requireDataClient(options.dataClient);
      const input = body(payload);
      const title = typeof input.title === 'string' ? input.title : typeof input.label === 'string' ? input.label : '';
      await client.call('renameConversation', asConversationId(conversationId(payload)), title, new Date().toISOString());
      return { success: true };
    },
    pin: async payload => {
      const client = requireDataClient(options.dataClient);
      const pinned = body(payload).pinned === true;
      const now = new Date().toISOString();
      await client.call('pinConversation', asConversationId(conversationId(payload)), pinned ? now : undefined, now);
      return { success: true };
    },
    summaries: async payload => {
      const client = requireDataClient(options.dataClient);
      const requested = body(payload).sessionKeys;
      const ids = Array.isArray(requested)
        ? requested.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        : [];
      const summaries: ConversationSummary[] = ids.length > 0
        ? (await Promise.all(ids.map(id => client.call<ConversationSummary | undefined>('getConversation', asConversationId(id)))))
          .filter((item): item is ConversationSummary => Boolean(item))
        : (await client.call<ConversationPage>('listConversations', { limit: limitOf(payload, 200) })).items;
      const exports = await Promise.all(summaries.map(summary => getExport(client, summary.id)));
      return {
        success: true,
        summaries: summaries.map((summary, index) => ({
          sessionKey: summary.id,
          firstUserText: exports[index] ? firstUserText(exports[index]!) : summary.title ?? null,
          lastTimestamp: Date.parse(summary.updatedAt),
          workspacePath: null,
          pinned: Boolean(summary.pinnedAt),
        })),
      };
    },
    history: async payload => {
      const client = requireDataClient(options.dataClient);
      const sessionKey = body(payload).sessionKey;
      const id = typeof sessionKey === 'string'
        ? sessionKey.trim()
        : conversationId(payload);
      const exported = await getExport(client, id);
      return exported
        ? { success: true, messages: exportedHistory(exported, limitOf(payload)) }
        : { success: false, error: 'Conversation not found' };
    },
    turnTimings: async payload => {
      const client = requireDataClient(options.dataClient);
      const exported = await getExport(client, conversationId(payload));
      return exported
        ? { success: true, timings: turnTimings(exported, limitOf(payload)) }
        : { success: false, error: 'Conversation not found' };
    },
  };
}
