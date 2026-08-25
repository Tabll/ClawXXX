import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  conversationList: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    conversations: {
      list: mocks.conversationList,
      delete: vi.fn(),
      rename: vi.fn(),
      pin: vi.fn(),
    },
  },
}));

function row(id: string, title?: string, updatedAt = '2026-08-23T00:00:00.000Z') {
  return {
    id,
    ...(title === undefined ? {} : { title }),
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt,
  };
}

describe('chat catalog canonical title hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.conversationList.mockReset().mockResolvedValue({ items: [] });
  });

  it('uses the canonical Conversation title directly and never asks a runtime transcript for a label', async () => {
    mocks.conversationList.mockResolvedValue({
      items: [row('conversation-a', '用浏览器打开B站', '2026-08-23T08:30:00.000Z')],
    });
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessionLabels).toEqual({
      'conversation-a': '用浏览器打开B站',
    });
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      displayName: '用浏览器打开B站',
      derivedTitle: '用浏览器打开B站',
    });
  });

  it('does not synthesize a transcript-derived title when SQLite has no title', async () => {
    mocks.conversationList.mockResolvedValue({ items: [row('conversation-untitled')] });
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions[0]).toEqual(expect.objectContaining({
      key: 'conversation-untitled',
      displayName: 'conversation-untitled',
    }));
    expect(useChatStore.getState().sessions[0]).not.toHaveProperty('label');
    expect(useChatStore.getState().sessionLabels).toEqual({});
  });

  it('replaces title and activity atomically on a later canonical snapshot', async () => {
    mocks.conversationList
      .mockResolvedValueOnce({
        items: [row('conversation-a', 'First title', '2026-08-23T08:00:00.000Z')],
      })
      .mockResolvedValueOnce({
        items: [row('conversation-a', 'Renamed title', '2026-08-23T09:00:00.000Z')],
      });
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();
    await useChatStore.getState().loadSessions({ force: true });

    expect(useChatStore.getState().sessionLabels).toEqual({ 'conversation-a': 'Renamed title' });
    expect(useChatStore.getState().sessionLastActivity).toEqual({
      'conversation-a': Date.parse('2026-08-23T09:00:00.000Z'),
    });
  });

  it('decodes portable file workspace URIs without involving a kernel', async () => {
    mocks.conversationList.mockResolvedValue({
      items: [{
        ...row('conversation-a', 'Workspace'),
        workspaceUri: 'file:///Users/alex/My%20Project/%E6%B5%8B%E8%AF%95',
      }],
    });
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();

    expect(useChatStore.getState().sessions[0]?.workspacePath)
      .toBe('/Users/alex/My Project/测试');
  });

  it('loads one bounded page, then appends the next page and de-duplicates defensively', async () => {
    mocks.conversationList
      .mockResolvedValueOnce({
        items: [row('conversation-a', 'A')],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        items: [row('conversation-a', 'A'), row('conversation-b', 'B')],
      });
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();
    expect(useChatStore.getState().sessions.map((item) => item.key)).toEqual(['conversation-a']);
    expect(useChatStore.getState().sessionNextCursor).toBe('cursor-2');
    await useChatStore.getState().loadMoreSessions();

    expect(mocks.conversationList).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(mocks.conversationList).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cursor: 'cursor-2',
    });
    expect(useChatStore.getState().sessions.map((item) => item.key))
      .toEqual(['conversation-a', 'conversation-b']);
  });

  it('fails closed on a repeated page cursor instead of offering an endless load-more loop', async () => {
    mocks.conversationList
      .mockResolvedValueOnce({ items: [row('conversation-a')], nextCursor: 'same' })
      .mockResolvedValueOnce({ items: [row('conversation-b')], nextCursor: 'same' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useChatStore } = await import('@/stores/chat');

    await useChatStore.getState().loadSessions();
    await useChatStore.getState().loadMoreSessions();

    expect(mocks.conversationList).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().sessionCatalogReady).toBe(true);
    expect(useChatStore.getState().sessionNextCursor).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Failed to load more Conversations:',
      expect.objectContaining({ message: 'Repeated Conversation page cursor' }),
    );
  });
});
