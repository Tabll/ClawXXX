import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asConversationId, asRunId, asTurnId, type ConversationExport } from '@shared/conversations/contracts';
import type { KernelEventEnvelopeV1 } from '@shared/kernels/contracts';

const hostApiMock = vi.hoisted(() => ({
  selectConversationKernel: vi.fn(),
  deprecatedLoadAcpSession: vi.fn(),
  conversationsGet: vi.fn(),
  sendAcpPrompt: vi.fn(),
  cancelAcpSession: vi.fn(),
  setAcpSessionConfigOption: vi.fn(),
  respondAcpPermission: vi.fn(),
  mediaThumbnails: vi.fn(),
  recordAcpTrace: vi.fn(),
  resolveAttachment: vi.fn(),
}));

const hostEventsMock = vi.hoisted(() => ({
  kernelListener: null as ((payload: KernelEventEnvelopeV1) => void) | null,
  gatewayListener: null as ((payload: unknown) => void) | null,
  runtimeListener: null as ((payload: unknown) => void) | null,
  onKernelEvent: vi.fn((listener: (payload: KernelEventEnvelopeV1) => void) => {
    hostEventsMock.kernelListener = listener;
    return () => { hostEventsMock.kernelListener = null; };
  }),
  onGatewayChatMessage: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.gatewayListener = listener;
    return () => { hostEventsMock.gatewayListener = null; };
  }),
  onChatRuntimeEvent: vi.fn((listener: (payload: unknown) => void) => {
    hostEventsMock.runtimeListener = listener;
    return () => { hostEventsMock.runtimeListener = null; };
  }),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    conversations: { get: hostApiMock.conversationsGet },
    chat: {
      selectConversationKernel: hostApiMock.selectConversationKernel,
      loadAcpSession: hostApiMock.deprecatedLoadAcpSession,
      sendAcpPrompt: hostApiMock.sendAcpPrompt,
      cancelAcpSession: hostApiMock.cancelAcpSession,
      setAcpSessionConfigOption: hostApiMock.setAcpSessionConfigOption,
      respondAcpPermission: hostApiMock.respondAcpPermission,
    },
    media: { thumbnails: hostApiMock.mediaThumbnails },
    diagnostics: { recordAcpTrace: hostApiMock.recordAcpTrace },
    files: { resolveAttachment: hostApiMock.resolveAttachment },
  },
}));

vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onKernelEvent: hostEventsMock.onKernelEvent,
    onGatewayChatMessage: hostEventsMock.onGatewayChatMessage,
    onChatRuntimeEvent: hostEventsMock.onChatRuntimeEvent,
  },
}));

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function canonicalHistory(conversationId = 'conversation-one'): ConversationExport {
  return {
    schema: 'clawx.conversation-export/v1',
    conversation: {
      id: asConversationId(conversationId),
      title: 'Canonical history',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:04.000Z',
      lastKernelId: 'deepseek-harness',
    },
    turns: [
      {
        id: 'turn-user',
        role: 'user',
        position: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
        blocks: [
          { id: 'prompt', type: 'text', visibility: 'portable', text: 'Hello' },
          {
            id: 'attachment',
            type: 'resource-link',
            visibility: 'portable',
            mimeType: 'text/plain',
            blobHash: 'a'.repeat(64),
          },
          {
            id: 'attachment-name',
            type: 'metadata',
            visibility: 'portable',
            json: { attachment: { blockId: 'attachment', fileName: 'notes.txt' } },
          },
        ],
      },
      {
        id: 'turn-assistant',
        role: 'assistant',
        position: 1,
        createdAt: '2026-08-24T00:00:04.000Z',
        blocks: [{ id: 'answer', type: 'text', visibility: 'portable', text: 'World' }],
      },
    ],
    runs: [{
      id: asRunId('run-history'),
      turnId: asTurnId('turn-user'),
      assistantTurnId: asTurnId('turn-assistant'),
      kernelId: 'deepseek-harness',
      kernelVersion: '0.0.1+clawx.1',
      generation: 2,
      agentId: 'main',
      agentSnapshot: {
        agentId: 'main' as ConversationExport['runs'][number]['agentSnapshot']['agentId'],
        displayName: 'Main Agent',
        kernelId: 'deepseek-harness',
        workspaceUri: 'file:///repo',
        model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        canonicalVersion: 1,
      },
      workspaceUri: 'file:///repo',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      status: 'completed',
      createdAt: '2026-08-24T00:00:00.000Z',
      startedAt: '2026-08-24T00:00:01.000Z',
      completedAt: '2026-08-24T00:00:04.000Z',
      events: [
        {
          eventSeq: 1,
          kind: 'tool.start',
          payload: { toolCallId: 'tool-history', title: 'Read', status: 'in_progress' },
          emittedAt: '2026-08-24T00:00:02.000Z',
        },
        {
          eventSeq: 2,
          kind: 'tool.result',
          payload: { toolCallId: 'tool-history', status: 'completed', content: [] },
          emittedAt: '2026-08-24T00:00:03.000Z',
        },
      ],
    }],
    usage: [{ runId: 'run-history', inputTokens: 10, outputTokens: 5 }],
  };
}

function kernelEvent(input: {
  conversationId: string;
  runId: string;
  turnId?: string;
  kernelId?: 'openclaw' | 'deepseek-harness';
  generation?: number;
  eventSeq: number;
  kind: KernelEventEnvelopeV1['event']['kind'];
  payload: unknown;
}): KernelEventEnvelopeV1 {
  return {
    protocol: 'clawx.kernel/v1',
    conversationId: input.conversationId,
    turnId: input.turnId ?? 'turn-live',
    runId: input.runId,
    kernelId: input.kernelId ?? 'openclaw',
    generation: input.generation ?? 1,
    eventSeq: input.eventSeq,
    emittedAt: '2026-08-24T00:00:00.000Z',
    event: { kind: input.kind, payload: input.payload },
  };
}

async function importStore() {
  return import('@/stores/acp-chat-session');
}

describe('canonical multi-kernel Chat store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiMock.selectConversationKernel.mockReset().mockResolvedValue({
      success: true,
      generation: 1,
      kernelId: 'openclaw',
    });
    hostApiMock.deprecatedLoadAcpSession.mockReset();
    hostApiMock.conversationsGet.mockReset().mockResolvedValue(canonicalHistory());
    hostApiMock.sendAcpPrompt.mockReset().mockResolvedValue({
      success: true,
      generation: 1,
      kernelId: 'openclaw',
    });
    hostApiMock.cancelAcpSession.mockReset().mockResolvedValue({ success: true, generation: 1 });
    hostApiMock.setAcpSessionConfigOption.mockReset().mockResolvedValue({
      success: true,
      generation: 1,
      configOptions: [],
    });
    hostApiMock.respondAcpPermission.mockReset().mockResolvedValue({ success: true, generation: 1 });
    hostApiMock.mediaThumbnails.mockReset().mockResolvedValue({});
    hostApiMock.recordAcpTrace.mockReset().mockResolvedValue({ success: true });
    hostApiMock.resolveAttachment.mockReset().mockImplementation(async (payload: {
      ref: { uri: string };
      name?: string;
      mimeType?: string;
    }) => ({
      ok: true,
      identity: 'b'.repeat(64),
      displayName: payload.name ?? 'notes.txt',
      mimeType: payload.mimeType ?? 'text/plain',
      size: 8,
      target: { kind: 'local', scope: 'canonical-blob', entryKind: 'file', ref: payload.ref },
    }));
    hostEventsMock.kernelListener = null;
    hostEventsMock.gatewayListener = null;
    hostEventsMock.runtimeListener = null;
    hostEventsMock.onKernelEvent.mockClear();
    hostEventsMock.onGatewayChatMessage.mockClear();
    hostEventsMock.onChatRuntimeEvent.mockClear();
  });

  it('loads catalog history only from the canonical Conversation API', async () => {
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await expect(useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-one',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'deepseek-harness',
    })).resolves.toBe(true);

    const state = useAcpChatSessionStore.getState();
    expect(state.timeline.itemOrder).toEqual([
      'turn-user:0',
      'tool:tool-history',
      'turn-assistant:0',
    ]);
    expect(state.timeline.itemsById['turn-assistant:0']).toMatchObject({
      role: 'assistant',
      parts: [{ kind: 'markdown', text: 'World' }],
      assistantMetadata: {
        kernelId: 'deepseek-harness',
        runId: 'run-history',
        model: 'deepseek-chat',
      },
    });
    expect(state.turnTimingsByUserMessageId['turn-user']).toEqual({
      source: 'transcript',
      status: 'complete',
      durationMs: 3_000,
    });
    expect(hostApiMock.conversationsGet).toHaveBeenCalledWith('conversation-one');
    expect(hostApiMock.deprecatedLoadAcpSession).not.toHaveBeenCalled();
    expect(hostApiMock.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({
      ref: expect.objectContaining({ uri: `clawx-blob://${'a'.repeat(64)}` }),
    }));
  });

  it('projects canonical history offline without selecting or loading a runtime', async () => {
    const { useAcpChatSessionStore } = await importStore();

    await expect(useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-one',
      workspaceRoot: '/repo',
      cwd: '/repo',
    })).resolves.toBe(true);

    expect(hostApiMock.selectConversationKernel).not.toHaveBeenCalled();
    expect(hostApiMock.deprecatedLoadAcpSession).not.toHaveBeenCalled();
    expect(hostApiMock.conversationsGet).toHaveBeenCalledWith('conversation-one');
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'conversation-one',
      activeKernelId: null,
      loading: false,
    });
    expect(JSON.stringify(useAcpChatSessionStore.getState().timeline)).toContain('World');
  });

  it('drops a stale selection completion after a newer Conversation wins', async () => {
    const first = deferred<{ success: boolean; generation: number; kernelId: 'openclaw' }>();
    hostApiMock.selectConversationKernel
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ success: true, generation: 4, kernelId: 'deepseek-harness' });
    hostApiMock.conversationsGet.mockImplementation(async (id: string) => canonicalHistory(id));
    const { useAcpChatSessionStore } = await importStore();

    const stale = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-stale',
      workspaceRoot: '/old',
      cwd: '/old',
      kernelId: 'openclaw',
    });
    const current = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-current',
      workspaceRoot: '/new',
      cwd: '/new',
      kernelId: 'deepseek-harness',
    });
    await expect(current).resolves.toBe(true);
    first.resolve({ success: true, generation: 1, kernelId: 'openclaw' });
    await expect(stale).resolves.toBe(false);

    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeSessionKey: 'conversation-current',
      activeKernelId: 'deepseek-harness',
      generation: 4,
      workspaceRoot: '/new',
      loading: false,
    });
  });

  it('drops an event from a stale run that arrives during same-generation selection', async () => {
    const selection = deferred<{
      success: boolean;
      generation: number;
      kernelId: 'openclaw';
      runId: string;
      turnId: string;
      resumedActivePrompt: boolean;
    }>();
    hostApiMock.selectConversationKernel.mockReturnValueOnce(selection.promise);
    hostApiMock.conversationsGet.mockResolvedValue(null);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();

    const loading = useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-selection-run',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
    });
    await vi.waitFor(() => expect(hostApiMock.selectConversationKernel).toHaveBeenCalledOnce());
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-selection-run',
      runId: 'run-stale',
      generation: 1,
      eventSeq: 1,
      kind: 'assistant.delta',
      payload: { text: 'stale selection stream' },
    }));
    selection.resolve({
      success: true,
      generation: 1,
      kernelId: 'openclaw',
      runId: 'run-current',
      turnId: 'turn-current',
      resumedActivePrompt: true,
    });

    await expect(loading).resolves.toBe(true);
    expect(JSON.stringify(useAcpChatSessionStore.getState().timeline))
      .not.toContain('stale selection stream');
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeRunId: 'run-current',
      activeTurnId: 'turn-current',
      activeKernelId: 'openclaw',
      generation: 1,
      sending: true,
    });
  });

  it('sends full run identity and rejects a late event from another run', async () => {
    hostApiMock.conversationsGet.mockResolvedValue(null);
    const prompt = deferred<{ success: boolean; generation: number; kernelId: 'openclaw' }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-live',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
      createIfMissing: true,
    });
    const sending = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'conversation-live',
      cwd: '/repo',
      message: 'Stream',
      messageId: 'run-live',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledTimes(1));
    expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'conversation-live',
      conversationId: 'conversation-live',
      runId: 'run-live',
      turnId: expect.stringMatching(/^turn:/),
      kernelId: 'openclaw',
      generation: 1,
    }));

    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-live',
      runId: 'stale-run',
      eventSeq: 1,
      kind: 'assistant.delta',
      payload: { text: 'must not appear' },
    }));
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-live',
      runId: 'run-live',
      eventSeq: 1,
      kind: 'assistant.delta',
      payload: { text: 'accepted stream' },
    }));
    expect(JSON.stringify(useAcpChatSessionStore.getState().timeline)).not.toContain('must not appear');
    expect(JSON.stringify(useAcpChatSessionStore.getState().timeline)).toContain('accepted stream');

    prompt.resolve({ success: true, generation: 1, kernelId: 'openclaw' });
    await expect(sending).resolves.toBe(true);
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeRunId: null,
      activeTurnId: null,
      activeKernelId: 'openclaw',
      sending: false,
    });
  });

  it('applies an ordered canonical tool start/result burst to one completed tool', async () => {
    hostApiMock.conversationsGet.mockResolvedValue(null);
    const prompt = deferred<{ success: boolean; generation: number; kernelId: 'openclaw' }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-tool-burst',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
      createIfMissing: true,
    });
    const sending = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'conversation-tool-burst',
      cwd: '/repo',
      message: 'Write the file',
      messageId: 'run-tool-burst',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalledOnce());
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-tool-burst',
      runId: 'run-tool-burst',
      eventSeq: 1,
      kind: 'tool.start',
      payload: {
        toolCallId: 'write-one',
        title: 'Write: src/live.ts',
        status: 'in_progress',
        rawInput: { path: 'src/live.ts', content: 'one\ntwo\n' },
      },
    }));
    prompt.resolve({ success: true, generation: 1, kernelId: 'openclaw' });
    await sending;
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-tool-burst',
      runId: 'run-tool-burst',
      eventSeq: 2,
      kind: 'tool.result',
      payload: { toolCallId: 'write-one', status: 'completed' },
    }));

    expect(useAcpChatSessionStore.getState().timeline.itemsById['tool:write-one']).toMatchObject({
      status: 'completed',
      input: { path: 'src/live.ts', content: 'one\ntwo\n' },
    });
    expect(useAcpChatSessionStore.getState().activeRunId).toBeNull();
  });

  it('keeps a run streaming in the background and restores it after navigation', async () => {
    hostApiMock.conversationsGet.mockResolvedValue(null);
    const prompt = deferred<{ success: boolean; generation: number; kernelId: 'openclaw' }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-background',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
      createIfMissing: true,
    });
    const sending = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'conversation-background',
      cwd: '/repo',
      message: 'Background',
      messageId: 'run-background',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalled());

    useAcpChatSessionStore.getState().prepareLocalSession({
      sessionKey: 'conversation-other',
      workspaceRoot: '/other',
      cwd: '/other',
      kernelId: 'deepseek-harness',
    });
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-background',
      runId: 'run-background',
      eventSeq: 1,
      kind: 'assistant.delta',
      payload: { text: 'background stream' },
    }));

    hostApiMock.selectConversationKernel.mockResolvedValueOnce({
      success: true,
      generation: 1,
      kernelId: 'openclaw',
      runId: 'run-background',
      turnId: 'turn-background',
      resumedActivePrompt: true,
    });
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-background',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
    });
    expect(JSON.stringify(useAcpChatSessionStore.getState().timeline)).toContain('background stream');
    expect(useAcpChatSessionStore.getState()).toMatchObject({
      activeRunId: 'run-background',
      sending: true,
    });

    prompt.resolve({ success: true, generation: 1, kernelId: 'openclaw' });
    await sending;
  });

  it('keeps simultaneous permission cards independent and resolves by canonical event', async () => {
    hostApiMock.conversationsGet.mockResolvedValue(null);
    const prompt = deferred<{ success: boolean; generation: number; kernelId: 'openclaw' }>();
    hostApiMock.sendAcpPrompt.mockReturnValueOnce(prompt.promise);
    const { ensureAcpChatSubscriptions, useAcpChatSessionStore } = await importStore();
    ensureAcpChatSubscriptions();
    await useAcpChatSessionStore.getState().loadSession({
      sessionKey: 'conversation-permissions',
      workspaceRoot: '/repo',
      cwd: '/repo',
      kernelId: 'openclaw',
      createIfMissing: true,
    });
    const sending = useAcpChatSessionStore.getState().sendPrompt({
      sessionKey: 'conversation-permissions',
      cwd: '/repo',
      message: 'Permissions',
      messageId: 'run-permissions',
    });
    await vi.waitFor(() => expect(hostApiMock.sendAcpPrompt).toHaveBeenCalled());
    for (const [eventSeq, requestId] of [[1, 'permission-a'], [2, 'permission-b']] as const) {
      hostEventsMock.kernelListener?.(kernelEvent({
        conversationId: 'conversation-permissions',
        runId: 'run-permissions',
        eventSeq,
        kind: 'permission.request',
        payload: {
          requestId,
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        },
      }));
    }
    hostEventsMock.kernelListener?.(kernelEvent({
      conversationId: 'conversation-permissions',
      runId: 'run-permissions',
      eventSeq: 3,
      kind: 'permission.resolved',
      payload: { requestId: 'permission-a', decision: 'allow-once' },
    }));

    expect(useAcpChatSessionStore.getState().timeline.itemsById).toMatchObject({
      'permission:permission-a': { status: 'selected' },
      'permission:permission-b': { status: 'pending' },
    });
    prompt.resolve({ success: true, generation: 1, kernelId: 'openclaw' });
    await sending;
  });

  it('cancels with the complete active run identity', async () => {
    const { useAcpChatSessionStore } = await importStore();
    useAcpChatSessionStore.setState({
      activeSessionKey: 'conversation-cancel',
      activeRunId: 'run-cancel',
      activeTurnId: 'turn-cancel',
      activeKernelId: 'deepseek-harness',
      generation: 9,
      sending: true,
    });
    await useAcpChatSessionStore.getState().cancel();
    expect(hostApiMock.cancelAcpSession).toHaveBeenCalledWith({
      sessionKey: 'conversation-cancel',
      conversationId: 'conversation-cancel',
      runId: 'run-cancel',
      turnId: 'turn-cancel',
      kernelId: 'deepseek-harness',
      generation: 9,
    });
  });
});
