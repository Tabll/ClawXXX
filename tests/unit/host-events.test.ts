import { beforeEach, describe, expect, it, vi } from 'vitest';

const on = vi.fn();
const off = vi.fn();

beforeEach(() => {
  on.mockReset();
  off.mockReset();
  vi.resetModules();
  vi.stubGlobal('window', {
    electron: { ipcRenderer: { on, off } },
  });
});

describe('hostEvents', () => {
  it('subscribes to canonical Conversation catalog changes over IPC', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onConversationCatalogChanged(handler);
    const callback = on.mock.calls[0]?.[1] as ((payload: unknown) => void) | undefined;
    callback?.({
      conversationId: 'conversation-one',
      kernelId: 'openclaw',
      hasActiveRun: true,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });

    expect(on).toHaveBeenCalledWith('conversations:catalog-changed', expect.any(Function));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-one',
      hasActiveRun: true,
    }));
  });

  it('subscribes to canonical kernel status over IPC', async () => {
    on.mockReturnValueOnce(() => undefined);
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onKernelStatusChanged(handler);

    expect(on).toHaveBeenCalledWith('kernels:status-changed', expect.any(Function));
  });

  it('passes typed payloads from IPC callbacks', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onUpdateStatusChanged(handler);
    const callback = on.mock.calls[0]?.[1] as ((payload: unknown) => void) | undefined;
    callback?.({ status: 'available', info: { version: '1.2.3' } });

    expect(on).toHaveBeenCalledWith('update:status-changed', expect.any(Function));
    expect(handler).toHaveBeenCalledWith({ status: 'available', info: { version: '1.2.3' } });
  });

  it('subscribes to chat runtime events over IPC', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onChatRuntimeEvent(handler);
    const callback = on.mock.calls[0]?.[1] as ((payload: unknown) => void) | undefined;
    callback?.({ type: 'run.started', runId: 'run-1' });

    expect(on).toHaveBeenCalledWith('chat:runtime-event', expect.any(Function));
    expect(handler).toHaveBeenCalledWith({ type: 'run.started', runId: 'run-1' });
  });

  it('subscribes to ACP session update events over IPC', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onAcpSessionUpdate(handler);

    expect(on).toHaveBeenCalledWith('chat:acp-session-update', expect.any(Function));
  });

  it('subscribes to ACP permission request events over IPC', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onAcpPermissionRequest(handler);

    expect(on).toHaveBeenCalledWith('chat:acp-permission-request', expect.any(Function));
  });

  it('subscribes to dynamic channel QR events', async () => {
    const { hostEvents } = await import('@/lib/host-events');
    const handler = vi.fn();

    hostEvents.onChannelQr('wechat', handler);

    expect(on).toHaveBeenCalledWith('channel:wechat-qr', expect.any(Function));
  });

  it('does not create EventSource fallback', async () => {
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    on.mockReturnValueOnce(() => undefined);
    const { hostEvents } = await import('@/lib/host-events');

    hostEvents.onKernelCatalogChanged(vi.fn());

    expect(eventSource).not.toHaveBeenCalled();
  });
});
