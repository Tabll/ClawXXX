// @vitest-environment node

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Agent } from 'openclaw/plugin-sdk/agent-core';
import { SessionManager } from 'openclaw/plugin-sdk/agent-sessions';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from 'openclaw/plugin-sdk/llm';
import { afterEach, describe, expect, it } from 'vitest';
import { testAgentRouting } from '../../helpers/canonical-agent';
import { ClawXDataService } from '@electron/data/clawx-data-service';
import {
  OPENCLAW_CHECKPOINT_CODEC,
  OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
  OpenClawConversationSession,
  assertInMemoryOpenClawSessionManager,
  type OpenClawSessionManagerFactory,
} from '@electron/kernels/openclaw/conversation-store-adapter';
import {
  OPENCLAW_CONVERSATION_STORE_PACKAGE,
  OpenClawConversationStore,
} from '@electron/kernels/openclaw/conversation-store';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';

const services: ClawXDataService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function factory(): OpenClawSessionManagerFactory {
  return {
    inMemory: (cwd?: string) => SessionManager.inMemory(cwd) as unknown as ReturnType<OpenClawSessionManagerFactory['inMemory']>,
  };
}

function forbiddenHistoryFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (
        name.endsWith('.jsonl')
        || name === 'sessions.json'
        || name.endsWith('.trajectory-path.json')
      ) result.push(path);
    }
  };
  visit(root);
  return result;
}

function admit(
  service: ClawXDataService,
  conversationId: ReturnType<typeof asConversationId>,
  run: number,
) {
  const main = service.connect({ role: 'main' });
  const kernel = service.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
  const runId = asRunId(`run-${run}`);
  const turnId = asTurnId(`user-${run}`);
  return { main, kernel, runId, turnId };
}

describe('OpenClaw unified conversation store spike', () => {
  it('runs a real OpenClaw Agent prompt and cancels the live run without killing the runtime', async () => {
    const started = Promise.withResolvers<void>();
    const model: Model = {
      id: 'clawx-cancel-spike',
      name: 'ClawX cancellation spike',
      api: 'openai-completions',
      provider: 'clawx-spike',
      baseUrl: 'http://127.0.0.1.invalid',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const partial = (stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    });
    const agent = new Agent({
      initialState: { model, systemPrompt: '', tools: [], messages: [] },
      streamFn: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'start', partial: partial('stop') });
        started.resolve();
        options?.signal?.addEventListener('abort', () => {
          const error = { ...partial('aborted'), errorMessage: 'cancelled by ClawX' };
          stream.push({ type: 'error', reason: 'aborted', error });
        }, { once: true });
        return stream;
      },
    });

    const prompt = agent.prompt('cancel this prompt');
    await started.promise;
    expect(agent.signal?.aborted).toBe(false);
    agent.abort();
    await prompt;

    expect(agent.signal).toBeUndefined();
    // September adds a hidden turn-aborted control marker after the cancelled
    // assistant. It is not an answer and must not become the terminal selector.
    const assistantIndex = agent.state.messages.findLastIndex(message => message.role === 'assistant');
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(agent.state.messages[assistantIndex]).toMatchObject({
      role: 'assistant',
      stopReason: 'aborted',
      errorMessage: 'cancelled by ClawX',
    });
    for (const message of agent.state.messages.slice(assistantIndex + 1)) {
      expect(message).toMatchObject({
        role: 'custom', customType: 'openclaw:turn-aborted', display: false,
      });
    }

    // The same runtime object remains usable after a run-level cancellation.
    agent.reset();
    expect(agent.state.messages).toEqual([]);
  });

  it('hydrates, compacts, branches and restarts solely from ClawX SQLite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-store-'));
    const databasePath = join(root, 'state', 'clawx.sqlite');
    const cwd = join(root, 'workspace');
    const conversationId = asConversationId('conversation-openclaw');
    const createdAt = '2026-08-23T10:00:00.000Z';

    let service = new ClawXDataService(databasePath);
    services.push(service);
    let { main, kernel, runId, turnId } = admit(service, conversationId, 1);
    await main.createConversation({ id: conversationId, title: 'portable', createdAt });
    await main.admitRun({
      conversationId,
      turnId,
      runId,
      routing: {
        kernelId: 'openclaw',
        kernelVersion: '2026.7.1-2+clawx.1',
        generation: 1,
        ...testAgentRouting('openclaw', { agentId: 'default' }),
        contextCompilerVersion: 'portable-v1',
      },
      userBlocks: [{ id: 'block-user-1', type: 'text', visibility: 'portable', text: 'first prompt' }],
      createdAt,
    });
    const snapshot = await kernel.compileContext({ conversationId, runId });
    const session = OpenClawConversationSession.hydrate({ factory: factory(), cwd, snapshot });
    expect(session.manager.isPersisted()).toBe(false);
    expect(() => assertInMemoryOpenClawSessionManager(session.manager)).not.toThrow();
    expect(session.manager.buildSessionContext().messages).toHaveLength(1);

    const firstEntry = session.manager.getEntries()[0]!;
    session.manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
      api: 'openai-completions',
      provider: 'spike',
      model: 'fake',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    session.manager.appendCompaction('summary before branch', firstEntry.id, 128);
    session.manager.branch(firstEntry.id);
    session.manager.appendMessage({ role: 'user', content: 'alternate path', timestamp: Date.now() });

    const assistantTurnId = asTurnId('assistant-1');
    await kernel.commitTerminalRun({
      conversationId,
      userTurnId: turnId,
      assistantTurnId,
      runId,
      kernelId: 'openclaw',
      generation: 1,
      outcome: 'completed',
      assistantBlocks: [{ id: 'block-assistant-1', type: 'text', visibility: 'portable', text: 'first answer' }],
      completedAt: '2026-08-23T10:00:01.000Z',
    });
    session.markCanonicalTurnIncluded(assistantTurnId);
    await kernel.putCheckpoint({
      runId,
      codec: OPENCLAW_CHECKPOINT_CODEC,
      schemaVersion: OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
      checkpoint: session.checkpoint(),
      createdAt: '2026-08-23T10:00:01.100Z',
    });
    expect(forbiddenHistoryFiles(root)).toEqual([]);

    await service.close();
    services.splice(services.indexOf(service), 1);
    service = new ClawXDataService(databasePath);
    services.push(service);
    ({ main, kernel, runId, turnId } = admit(service, conversationId, 2));
    await main.admitRun({
      conversationId,
      turnId,
      runId,
      routing: {
        kernelId: 'openclaw',
        kernelVersion: '2026.7.1-2+clawx.1',
        generation: 1,
        ...testAgentRouting('openclaw', { agentId: 'default' }),
        contextCompilerVersion: 'portable-v1',
      },
      userBlocks: [{ id: 'block-user-2', type: 'text', visibility: 'portable', text: 'second prompt' }],
      createdAt: '2026-08-23T10:01:00.000Z',
    });
    const restoredCheckpoint = await kernel.getLatestConversationCheckpoint({
      conversationId,
      codec: OPENCLAW_CHECKPOINT_CODEC,
      schemaVersion: OPENCLAW_CHECKPOINT_SCHEMA_VERSION,
      beforeRunId: runId,
    });
    expect(restoredCheckpoint?.runId).toBe(asRunId('run-1'));
    const restoredSnapshot = await kernel.compileContext({ conversationId, runId });
    const restored = OpenClawConversationSession.hydrate({
      factory: factory(),
      cwd,
      snapshot: restoredSnapshot,
      checkpoint: restoredCheckpoint?.checkpoint,
    });

    expect(restored.manager.isPersisted()).toBe(false);
    expect(() => assertInMemoryOpenClawSessionManager(restored.manager)).not.toThrow();
    expect(restored.manager.getEntries().some((entry) => entry.type === 'compaction')).toBe(true);
    expect(restored.manager.getTree().length).toBeGreaterThanOrEqual(1);
    const contextText = JSON.stringify(restored.manager.buildSessionContext().messages);
    expect(contextText).toContain('alternate path');
    expect(contextText).toContain('second prompt');
    expect(forbiddenHistoryFiles(root)).toEqual([]);
  });

  it('exposes metadata, compaction, fork/reset, checkpoint and canonical memory search without native files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-openclaw-package-'));
    const service = new ClawXDataService(join(root, 'state', 'clawx.sqlite'));
    services.push(service);
    const conversationId = asConversationId('conversation-package');
    const { main, kernel, runId, turnId } = admit(service, conversationId, 1);
    await main.createConversation({ id: conversationId, createdAt: '2026-08-23T12:00:00.000Z' });
    await main.admitRun({
      conversationId,
      turnId,
      runId,
      routing: {
        kernelId: 'openclaw', kernelVersion: 'test', generation: 1,
        ...testAgentRouting('openclaw'), contextCompilerVersion: 'v1',
      },
      userBlocks: [{ id: 'prompt', type: 'text', visibility: 'portable', text: 'find this memory' }],
      createdAt: '2026-08-23T12:00:01.000Z',
    });
    const protocol = {
      protocol: 'clawx.conversation-store/v1' as const,
      nativeHistoryFallback: false as const,
      readAttachment: async () => new Uint8Array(),
      compileContext: async (input: Parameters<typeof kernel.compileContext>[0] & { kernelId: string; budget: unknown }) => (
        kernel.compileContext({ conversationId: input.conversationId, runId: input.runId })
      ),
      appendEvents: kernel.appendEvents.bind(kernel),
      putCheckpoint: async (input: { runId: ReturnType<typeof asRunId>; codec: string; schemaVersion: number; checkpoint: unknown; createdAt: string }) => {
        await kernel.putCheckpoint(input);
      },
      getLatestCheckpoint: async (input: { conversationId: ReturnType<typeof asConversationId>; codec: string; schemaVersion: number; beforeRunId?: ReturnType<typeof asRunId> }) => (
        kernel.getLatestConversationCheckpoint(input)
      ),
    };
    const memorySearch = async (query: string, limit: number) => (
      (await main.searchConversations(query, limit)).map(item => ({
        conversationId: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
      }))
    );
    const store = new OpenClawConversationStore(protocol, factory(), { search: memorySearch });
    expect(OPENCLAW_CONVERSATION_STORE_PACKAGE).toBe('@clawx/openclaw-conversation-store');
    const session = await store.hydrate({ conversationId, runId, cwd: join(root, 'workspace') });
    const firstEntry = session.manager.getEntries()[0]!;
    expect(store.setMetadata(session, { label: 'canonical' })).toBeTruthy();
    expect(store.compact(session, {
      summary: 'compact summary', firstKeptEntryId: firstEntry.id, tokensBefore: 64,
    })).toBeTruthy();
    const checkpoint = store.fork(session, firstEntry.id);
    expect(checkpoint.protocol).toBe(OPENCLAW_CHECKPOINT_CODEC);
    store.reset(session);
    await store.save(runId, session, '2026-08-23T12:00:02.000Z');
    expect((await store.searchMemory('find this memory'))[0]?.conversationId).toBe(conversationId);
    expect(forbiddenHistoryFiles(root)).toEqual([]);
  });
});
