/**
 * Zustand Stores Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { useKernelStore } from '@/stores/kernels';

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
  settings: {
    getAll: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    setMany: vi.fn(),
    reset: vi.fn(),
  },
  logs: {
    recent: vi.fn(),
    dir: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: hostApiMock,
}));
vi.mock('@/lib/host-events', () => ({
  hostEvents: {
    onKernelStatusChanged: vi.fn(() => () => {}),
    onKernelPackageProgress: vi.fn(() => () => {}),
    onKernelCatalogChanged: vi.fn(() => () => {}),
  },
}));

describe('Settings Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiMock.settings.set.mockResolvedValue({ success: true });
    // Reset store to default state
    useSettingsStore.setState({
      theme: 'system',
      language: 'en',
      sidebarCollapsed: false,
      sidebarWidth: 280,
      devModeUnlocked: false,
      kernelAutoStartPolicies: {},
      autoCheckUpdate: true,
      startMinimized: false,
      launchAtStartup: false,
      updateChannel: 'stable',
    });
  });
  
  it('should have default values', () => {
    const state = useSettingsStore.getState();
    expect(state.theme).toBe('system');
    expect(state.sidebarCollapsed).toBe(false);
    expect(state.kernelAutoStartPolicies).toEqual({});
  });
  
  it('should update theme', () => {
    const { setTheme } = useSettingsStore.getState();
    setTheme('dark');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });
  
  it('should toggle sidebar collapsed state', () => {
    const { setSidebarCollapsed } = useSettingsStore.getState();
    setSidebarCollapsed(true);
    expect(useSettingsStore.getState().sidebarCollapsed).toBe(true);
  });

  it('should clamp sidebar width', () => {
    const { setSidebarWidth } = useSettingsStore.getState();

    setSidebarWidth(320);
    expect(useSettingsStore.getState().sidebarWidth).toBe(320);

    setSidebarWidth(100);
    expect(useSettingsStore.getState().sidebarWidth).toBe(220);

    setSidebarWidth(600);
    expect(useSettingsStore.getState().sidebarWidth).toBe(420);
  });
  
  it('should unlock dev mode', () => {
    hostApiMock.settings.set.mockResolvedValueOnce({ success: true });

    const { setDevModeUnlocked } = useSettingsStore.getState();
    setDevModeUnlocked(true);

    expect(useSettingsStore.getState().devModeUnlocked).toBe(true);
    expect(hostApiMock.settings.set).toHaveBeenCalledWith('devModeUnlocked', true);
  });

  it('should persist launch-at-startup setting through host api', () => {
    hostApiMock.settings.set.mockResolvedValueOnce({ success: true });

    const { setLaunchAtStartup } = useSettingsStore.getState();
    setLaunchAtStartup(true);

    expect(useSettingsStore.getState().launchAtStartup).toBe(true);
    expect(hostApiMock.settings.set).toHaveBeenCalledWith('launchAtStartup', true);
  });
});

describe('Kernel Store', () => {
  const openClawRuntime = {
    kernelId: 'openclaw',
    state: 'ready',
    generation: 2,
    diagnostics: [],
  } as const;
  const catalog = {
    entries: [{
      kernelId: 'openclaw',
      displayName: 'OpenClaw',
      installation: {
        kernelId: 'openclaw',
        state: 'installed',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      runtime: openClawRuntime,
      updateAvailable: false,
      installAllowed: true,
      compatibilityFailures: [],
    }],
    source: 'cache',
    stale: false,
    refreshedAt: '2026-08-24T00:00:00.000Z',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    hostApiMock.kernels.catalog.mockResolvedValue(catalog);
    hostApiMock.kernels.list.mockResolvedValue([openClawRuntime]);
    hostApiMock.kernels.start.mockResolvedValue(openClawRuntime);
    useKernelStore.setState({
      catalog: null,
      runtimes: {},
      progress: {},
      pending: {},
      restartRequired: {},
      errors: {},
      initialized: false,
    });
  });
  
  it('hydrates the catalog and runtime snapshots together', async () => {
    await useKernelStore.getState().refresh();

    expect(useKernelStore.getState().catalog?.source).toBe('cache');
    expect(useKernelStore.getState().runtimes.openclaw).toMatchObject({
      state: 'ready',
      generation: 2,
    });
  });

  it('routes lifecycle actions by kernel id', async () => {
    await expect(useKernelStore.getState().start('openclaw')).resolves.toBe(true);

    expect(hostApiMock.kernels.start).toHaveBeenCalledWith('openclaw');
    expect(useKernelStore.getState().runtimes.openclaw?.state).toBe('ready');
    expect(useKernelStore.getState().pending.openclaw).toBeUndefined();
  });
});
