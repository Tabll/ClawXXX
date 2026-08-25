import type { ConversationId, RunId } from '@shared/conversations/contracts';
import type {
  ConversationStoreProtocolClient,
  KernelContextBudget,
} from '@shared/conversations/store-protocol';
import {
  OPENCLAW_CHECKPOINT_CODEC,
  OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
  OpenClawConversationSession,
  type OpenClawSessionCheckpointV1,
  type OpenClawSessionManagerFactory,
} from './conversation-store-adapter';

export const OPENCLAW_CONVERSATION_STORE_PACKAGE = '@clawx/openclaw-conversation-store' as const;

export type OpenClawConversationMemoryHit = {
  conversationId: string;
  title?: string;
  snippet?: string;
  updatedAt?: string;
};

export type OpenClawConversationMemorySource = {
  search(query: string, limit: number): Promise<OpenClawConversationMemoryHit[]>;
};

/**
 * SQLite-backed OpenClaw session facade. SessionManager is always in-memory;
 * only canonical context and opaque checkpoints cross a process restart.
 */
export class OpenClawConversationStore {
  constructor(
    private readonly store: ConversationStoreProtocolClient,
    private readonly factory: OpenClawSessionManagerFactory,
    private readonly memory?: OpenClawConversationMemorySource,
  ) {
    if (store.nativeHistoryFallback !== false) {
      throw new Error('OpenClaw Conversation Store requires native history fallback to be disabled');
    }
  }

  async hydrate(input: {
    conversationId: ConversationId;
    runId: RunId;
    cwd: string;
    budget?: Partial<KernelContextBudget>;
    beforeRunId?: RunId;
  }): Promise<OpenClawConversationSession> {
    const [snapshot, checkpoint] = await Promise.all([
      this.store.compileContext({
        conversationId: input.conversationId,
        runId: input.runId,
        kernelId: 'openclaw',
        budget: {
          maxBlocks: input.budget?.maxBlocks ?? 2_000,
          maxTextCharacters: input.budget?.maxTextCharacters ?? 1_000_000,
          maxAttachmentBytes: input.budget?.maxAttachmentBytes,
        },
      }),
      this.store.getLatestCheckpoint({
        conversationId: input.conversationId,
        kernelId: 'openclaw',
        codec: OPENCLAW_CHECKPOINT_CODEC,
        schemaVersion: OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
        beforeRunId: input.beforeRunId,
      }),
    ]);
    return OpenClawConversationSession.hydrate({
      factory: this.factory,
      cwd: input.cwd,
      snapshot,
      checkpoint: checkpoint?.checkpoint,
    });
  }

  save(runId: RunId, session: OpenClawConversationSession, createdAt = new Date().toISOString()): Promise<void> {
    return this.store.putCheckpoint({
      runId,
      kernelId: 'openclaw',
      codec: OPENCLAW_CHECKPOINT_CODEC,
      schemaVersion: OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
      checkpoint: session.checkpoint(),
      createdAt,
    });
  }

  setMetadata(session: OpenClawConversationSession, metadata: Record<string, unknown>): string {
    return session.manager.appendCustomEntry('clawx.conversation-metadata/v1', structuredClone(metadata));
  }

  compact(session: OpenClawConversationSession, input: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  }): string {
    return session.manager.appendCompaction(
      input.summary,
      input.firstKeptEntryId,
      input.tokensBefore,
      structuredClone(input.details),
    );
  }

  branch(session: OpenClawConversationSession, entryId: string): void {
    session.manager.branch(entryId);
  }

  fork(session: OpenClawConversationSession, entryId: string): OpenClawSessionCheckpointV1 {
    session.manager.branch(entryId);
    return session.checkpoint();
  }

  reset(session: OpenClawConversationSession): void {
    session.manager.resetLeaf();
    session.manager.appendCustomEntry('clawx.session-reset/v1', { resetAt: new Date().toISOString() });
  }

  searchMemory(query: string, limit = 20): Promise<OpenClawConversationMemoryHit[]> {
    if (!this.memory) return Promise.resolve([]);
    return this.memory.search(query, Math.min(100, Math.max(1, limit)));
  }
}
