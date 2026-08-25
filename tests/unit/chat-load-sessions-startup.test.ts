import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationsMock = vi.hoisted(() => ({
  list: vi.fn(),
  delete: vi.fn(),
  rename: vi.fn(),
  pin: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: { conversations: conversationsMock },
}));

function row(input: {
  id: string;
  title?: string;
  updatedAt?: string;
  pinnedAt?: string;
  workspaceUri?: string;
  lastKernelId?: string;
  hasActiveRun?: boolean;
}) {
  return {
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-08-23T00:00:00.000Z',
    ...input,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

describe('canonical Conversation catalog startup', () => {
  beforeEach(() => {
    vi.resetModules();
    conversationsMock.list.mockReset().mockResolvedValue({ items: [] });
    conversationsMock.delete.mockReset().mockResolvedValue({ success: true });
    conversationsMock.rename.mockReset().mockResolvedValue({ success: true });
    conversationsMock.pin.mockReset().mockResolvedValue({ success: true });
  });

  it('exposes only catalog and selection state', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const state = useChatStore.getState();

    expect(state).not.toHaveProperty('messages');
    expect(state).not.toHaveProperty('loadHistory');
    expect(state).not.toHaveProperty('sendMessage');
    expect(state).toMatchObject({
      sessions: expect.any(Array),
      currentSessionKey: expect.any(String),
      currentAgentId: expect.any(String),
      sessionLabels: expect.any(Object),
      sessionLastActivity: expect.any(Object),
    });
  });

  it('loads titles, activity, workspace, kernel, pin and active-run state from SQLite summaries', async () => {
    conversationsMock.list.mockResolvedValue({
      items: [row({
        id: 'conversation-a',
        title: 'Summarize this workspace',
        updatedAt: '2026-08-23T10:30:00.000Z',
        pinnedAt: '2026-08-23T10:31:00.000Z',
        workspaceUri: 'file:///Users/alex/workspace/ClawX',
        lastKernelId: 'deepseek-harness',
        hasActiveRun: true,
      })],
    });

    const { useChatStore } = await import('@/stores/chat');
    await useChatStore.getState().loadSessions();

    expect(conversationsMock.list).toHaveBeenCalledWith({ limit: 100 });
    expect(useChatStore.getState().sessions).toEqual([expect.objectContaining({
      key: 'conversation-a',
      displayName: 'Summarize this workspace',
      label: 'Summarize this workspace',
      workspacePath: '/Users/alex/workspace/ClawX',
      kernelId: 'deepseek-harness',
      pinned: true,
      hasActiveRun: true,
      status: 'running',
    })]);
    expect(useChatStore.getState().sessionLabels).toEqual({
      'conversation-a': 'Summarize this workspace',
    });
    expect(useChatStore.getState().sessionLastActivity['conversation-a'])
      .toBe(Date.parse('2026-08-23T10:30:00.000Z'));
    expect(useChatStore.getState().currentSessionKey).toBe('conversation-a');
    expect(useChatStore.getState().sessionCatalogReady).toBe(true);
  });

  it('selects a pinned row before a more recently updated row', async () => {
    conversationsMock.list.mockResolvedValue({
      items: [
        row({ id: 'conversation-new', updatedAt: '2026-08-23T12:00:00.000Z' }),
        row({
          id: 'conversation-pinned',
          updatedAt: '2026-08-23T09:00:00.000Z',
          pinnedAt: '2026-08-23T09:01:00.000Z',
        }),
      ],
    });
    const { useChatStore } = await import('@/stores/chat');
    await useChatStore.getState().loadSessions();
    expect(useChatStore.getState().currentSessionKey).toBe('conversation-pinned');
  });

  it('keeps the current canonical selection across catalog refreshes', async () => {
    conversationsMock.list.mockResolvedValue({
      items: [row({ id: 'conversation-a' }), row({ id: 'conversation-b' })],
    });
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({ currentSessionKey: 'conversation-b' });
    await useChatStore.getState().loadSessions();
    expect(useChatStore.getState().currentSessionKey).toBe('conversation-b');
  });

  it('preserves an unsent local draft while replacing persisted rows from the canonical page', async () => {
    conversationsMock.list.mockResolvedValue({ items: [row({ id: 'conversation-canonical' })] });
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'conversation-local',
      sessions: [
        { key: 'conversation-stale', label: 'stale' },
        { key: 'conversation-local', createdLocally: true, workspacePath: '/repo' },
      ],
    });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'conversation-canonical' }),
      expect.objectContaining({ key: 'conversation-local', createdLocally: true }),
    ]));
    expect(useChatStore.getState().sessions.some((item) => item.key === 'conversation-stale')).toBe(false);
    expect(useChatStore.getState().currentSessionKey).toBe('conversation-local');
  });

  it('queues exactly one forced reload behind an in-flight catalog read', async () => {
    const first = deferred<{ items: ReturnType<typeof row>[] }>();
    conversationsMock.list
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ items: [row({ id: 'conversation-new' })] });
    const { useChatStore } = await import('@/stores/chat');

    const initial = useChatStore.getState().loadSessions();
    const forced = useChatStore.getState().loadSessions({ force: true });
    expect(conversationsMock.list).toHaveBeenCalledTimes(1);
    first.resolve({ items: [row({ id: 'conversation-old' })] });
    await Promise.all([initial, forced]);

    expect(conversationsMock.list).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().sessions).toEqual([
      expect.objectContaining({ key: 'conversation-new' }),
    ]);
  });

  it('fails closed without publishing a runtime transcript catalog', async () => {
    conversationsMock.list.mockRejectedValue(new Error('DataService unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({ sessions: [{ key: 'local', createdLocally: true }] });

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessionCatalogReady).toBe(false);
    expect(useChatStore.getState().sessions).toEqual([{ key: 'local', createdLocally: true }]);
    expect(warn).toHaveBeenCalledWith(
      'Failed to load canonical Conversation catalog:',
      expect.any(Error),
    );
  });
});
