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

describe('canonical Conversation session management', () => {
  beforeEach(() => {
    vi.resetModules();
    conversationsMock.list.mockReset().mockResolvedValue({ items: [] });
    conversationsMock.delete.mockReset().mockResolvedValue({ success: true });
    conversationsMock.rename.mockReset().mockResolvedValue({ success: true });
    conversationsMock.pin.mockReset().mockResolvedValue({ success: true });
  });

  it('selects a catalog row and derives its agent identity without a Gateway RPC', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'conversation-a',
      currentAgentId: 'main',
      sessions: [{ key: 'conversation-a' }, { key: 'agent:research:conversation-b' }],
    });

    useChatStore.getState().switchSession('agent:research:conversation-b');

    expect(useChatStore.getState().currentSessionKey).toBe('agent:research:conversation-b');
    expect(useChatStore.getState().currentAgentId).toBe('research');
  });

  it('creates only one unsent local draft at a time', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentAgentId: 'research',
      sessions: [
        { key: 'conversation-persisted' },
        { key: 'conversation-old-draft', createdLocally: true },
      ],
    });

    useChatStore.getState().newSession();

    const state = useChatStore.getState();
    expect(state.sessions.filter((item) => item.createdLocally)).toHaveLength(1);
    expect(state.sessions).toContainEqual(expect.objectContaining({ key: 'conversation-persisted' }));
    expect(state.currentSessionKey).toMatch(/^agent:research:conversation-/);
  });

  it('acknowledges a Router-created conversation with workspace and initial title', async () => {
    const key = 'agent:research:conversation-created';
    conversationsMock.list.mockResolvedValue({
      items: [{
        id: key,
        title: 'Investigate issue',
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:01.000Z',
        workspaceUri: 'file:///workspace/research',
      }],
    });
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: key,
      currentAgentId: 'research',
      sessions: [{ key, createdLocally: true }],
    });

    useChatStore.getState().acknowledgeAcpSessionCreated(key, '/workspace/research', 'Investigate issue');
    await vi.waitFor(() => expect(conversationsMock.list).toHaveBeenCalled());

    expect(useChatStore.getState().sessions.find((item) => item.key === key)).toMatchObject({
      label: 'Investigate issue',
      workspacePath: '/workspace/research',
    });
    expect(useChatStore.getState().sessions.find((item) => item.key === key))
      .not.toHaveProperty('createdLocally');
  });

  it('projects Main-owned run lifecycle changes without a Gateway session event', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { useSessionAttentionStore } = await import('@/stores/session-attention');
    useSessionAttentionStore.setState({ bySessionKey: {}, visibleSessionKey: null });
    useChatStore.setState({
      sessions: [{ key: 'conversation-live', label: 'Live run', kernelIds: [] }],
      sessionLastActivity: {},
    });

    useChatStore.getState().handleConversationCatalogChanged({
      conversationId: 'conversation-live',
      kernelId: 'deepseek-harness',
      hasActiveRun: true,
      updatedAt: '2026-08-24T00:00:01.000Z',
    });
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      kernelId: 'deepseek-harness',
      kernelIds: ['deepseek-harness'],
      hasActiveRun: true,
      status: 'running',
    });

    useChatStore.getState().handleConversationCatalogChanged({
      conversationId: 'conversation-live',
      kernelId: 'deepseek-harness',
      hasActiveRun: false,
      updatedAt: '2026-08-24T00:00:02.000Z',
    });
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: 'done',
    });
    expect(useSessionAttentionStore.getState().bySessionKey['conversation-live']).toEqual({
      observedBusy: false,
      unread: true,
    });
  });

  it('hard-deletes a canonical conversation and removes its local metadata', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'conversation-a',
      sessions: [{ key: 'conversation-a' }, { key: 'conversation-b' }],
      sessionLabels: { 'conversation-a': 'A', 'conversation-b': 'B' },
      sessionLastActivity: { 'conversation-a': 1, 'conversation-b': 2 },
    });

    await expect(useChatStore.getState().deleteSession('conversation-a'))
      .resolves.toEqual({ success: true });

    expect(conversationsMock.delete).toHaveBeenCalledWith('conversation-a', true);
    expect(useChatStore.getState()).toMatchObject({
      currentSessionKey: 'conversation-b',
      sessions: [{ key: 'conversation-b' }],
      sessionLabels: { 'conversation-b': 'B' },
      sessionLastActivity: { 'conversation-b': 2 },
    });
  });

  it('keeps local state when hard delete fails', async () => {
    conversationsMock.delete.mockResolvedValue({ success: false, error: 'has branches' });
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'conversation-a',
      sessions: [{ key: 'conversation-a' }],
    });

    await expect(useChatStore.getState().deleteSession('conversation-a'))
      .resolves.toEqual({ success: false, error: 'has branches' });
    expect(useChatStore.getState().sessions).toEqual([{ key: 'conversation-a' }]);
  });

  it('reports partial results for a multi-delete and removes only successful rows', async () => {
    conversationsMock.delete.mockImplementation(async (id: string) => (
      id === 'conversation-b'
        ? { success: false, error: 'locked' }
        : { success: true }
    ));
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'conversation-a',
      sessions: [
        { key: 'conversation-a' },
        { key: 'conversation-b' },
        { key: 'conversation-c' },
      ],
    });

    await expect(useChatStore.getState().deleteSessions(['conversation-a', 'conversation-b']))
      .resolves.toEqual({
        deletedKeys: ['conversation-a'],
        failedKeys: ['conversation-b'],
      });
    expect(useChatStore.getState().sessions.map((item) => item.key))
      .toEqual(['conversation-b', 'conversation-c']);
  });

  it('renames and pins through the canonical API before updating renderer state', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      sessions: [{ key: 'conversation-a', label: 'Old', displayName: 'Old' }],
      sessionLabels: { 'conversation-a': 'Old' },
    });

    await useChatStore.getState().renameSession('conversation-a', '  New title  ');
    await useChatStore.getState().setSessionPinned('conversation-a', true);

    expect(conversationsMock.rename).toHaveBeenCalledWith('conversation-a', 'New title');
    expect(conversationsMock.pin).toHaveBeenCalledWith('conversation-a', true);
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      label: 'New title',
      displayName: 'New title',
      derivedTitle: 'New title',
      pinned: true,
    });
    expect(useChatStore.getState().sessionLabels).toEqual({ 'conversation-a': 'New title' });
  });

  it('rejects an empty title without mutating persistence', async () => {
    const { useChatStore } = await import('@/stores/chat');
    await expect(useChatStore.getState().renameSession('conversation-a', '   '))
      .rejects.toThrow('Conversation title cannot be empty');
    expect(conversationsMock.rename).not.toHaveBeenCalled();
  });
});
