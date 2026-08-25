import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = (kernelId: string, state = 'ready', generation = 1) => ({
  kernelId,
  state,
  generation,
  diagnostics: [],
});

const catalog = (entries = [
  {
    kernelId: 'openclaw',
    displayName: 'OpenClaw',
    installation: { kernelId: 'openclaw', state: 'installed', updatedAt: '2026-08-24T00:00:00.000Z' },
    runtime: runtime('openclaw'),
    updateAvailable: false,
    installAllowed: true,
    compatibilityFailures: [],
  },
]) => ({
  entries,
  source: 'cache',
  stale: false,
  refreshedAt: '2026-08-24T00:00:00.000Z',
});

const hostApiMock = vi.hoisted(() => ({
  kernels: {
    catalog: vi.fn(),
    list: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    repair: vi.fn(),
    rollback: vi.fn(),
    uninstall: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    setAutoStart: vi.fn(),
    openDirectory: vi.fn(),
    exportLogs: vi.fn(),
  },
}));

const subscriptions = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock('@/lib/host-api', () => ({ hostApi: hostApiMock }));
vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onKernelStatusChanged: (handler: (payload: unknown) => void) => subscribe('kernels:status-changed', handler),
    onKernelPackageProgress: (handler: (payload: unknown) => void) => subscribe('kernels:package-progress', handler),
    onKernelCatalogChanged: (handler: (payload: unknown) => void) => subscribe('kernels:catalog-changed', handler),
  },
}));

function subscribe(name: string, handler: (payload: unknown) => void): () => void {
  subscriptions.set(name, handler);
  return () => subscriptions.delete(name);
}

describe('Kernel lifecycle event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    subscriptions.clear();
    hostApiMock.kernels.catalog.mockResolvedValue(catalog());
    hostApiMock.kernels.list.mockResolvedValue([runtime('openclaw')]);
  });

  it('subscribes only to canonical kernel lifecycle channels and hydrates both snapshots', async () => {
    hostApiMock.kernels.list.mockResolvedValue([
      runtime('openclaw', 'ready', 4),
      runtime('deepseek-harness', 'stopped', 2),
    ]);
    const { useKernelStore } = await import('@/stores/kernels');
    await useKernelStore.getState().init();

    expect([...subscriptions.keys()]).toEqual([
      'kernels:status-changed',
      'kernels:package-progress',
      'kernels:catalog-changed',
    ]);
    expect(useKernelStore.getState().runtimes.openclaw?.generation).toBe(4);
    expect(useKernelStore.getState().runtimes['deepseek-harness']?.state).toBe('stopped');
  });

  it('updates one runtime without mutating the other kernel', async () => {
    hostApiMock.kernels.list.mockResolvedValue([
      runtime('openclaw', 'ready', 4),
      runtime('deepseek-harness', 'ready', 7),
    ]);
    const { useKernelStore } = await import('@/stores/kernels');
    await useKernelStore.getState().init();

    subscriptions.get('kernels:status-changed')?.(runtime('openclaw', 'crash-loop', 5));

    expect(useKernelStore.getState().runtimes.openclaw).toMatchObject({ state: 'crash-loop', generation: 5 });
    expect(useKernelStore.getState().runtimes['deepseek-harness']).toMatchObject({ state: 'ready', generation: 7 });
  });

  it('keeps package progress kernel-scoped', async () => {
    const { useKernelStore } = await import('@/stores/kernels');
    await useKernelStore.getState().init();
    subscriptions.get('kernels:package-progress')?.({
      kernelId: 'deepseek-harness',
      artifactVersion: '0.1.0-clawx.1',
      phase: 'downloading',
      receivedBytes: 50,
      totalBytes: 100,
      resumed: false,
    });

    expect(useKernelStore.getState().progress['deepseek-harness']).toMatchObject({
      phase: 'downloading',
      receivedBytes: 50,
    });
    expect(useKernelStore.getState().progress.openclaw).toBeUndefined();
  });

  it('refreshes catalog and runtimes after a canonical catalog change', async () => {
    const { useKernelStore } = await import('@/stores/kernels');
    await useKernelStore.getState().init();
    hostApiMock.kernels.catalog.mockClear();
    hostApiMock.kernels.list.mockClear();

    subscriptions.get('kernels:catalog-changed')?.({ reason: 'installed', kernelId: 'openclaw' });

    await vi.waitFor(() => expect(hostApiMock.kernels.catalog).toHaveBeenCalledWith(false));
    expect(hostApiMock.kernels.list).toHaveBeenCalledTimes(1);
  });
});
