import { create } from 'zustand';
import type { KernelId, KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import type {
  KernelCatalogEntry,
  KernelCatalogSnapshot,
  KernelDirectoryKind,
  KernelPackageProgressEvent,
} from '@shared/host-api/kernels';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';

const KERNEL_NAMES: Readonly<Record<string, string>> = {
  openclaw: 'OpenClaw',
  'deepseek-harness': 'DeepSeek Harness',
};

export type KernelOption = { id: KernelId; label: string };

type KernelAction = 'install' | 'update' | 'repair' | 'rollback' | 'uninstall' | 'start' | 'stop' | 'restart';

type KernelStore = {
  catalog: KernelCatalogSnapshot | null;
  runtimes: Record<string, KernelRuntimeSnapshot>;
  progress: Record<string, KernelPackageProgressEvent>;
  pending: Record<string, KernelAction | undefined>;
  restartRequired: Record<string, boolean | undefined>;
  errors: Record<string, string | undefined>;
  initialized: boolean;
  init(): Promise<void>;
  refresh(refreshRemote?: boolean): Promise<void>;
  install(kernelId: KernelId): Promise<boolean>;
  update(kernelId: KernelId): Promise<boolean>;
  repair(kernelId: KernelId): Promise<boolean>;
  rollback(kernelId: KernelId): Promise<boolean>;
  uninstall(kernelId: KernelId): Promise<boolean>;
  start(kernelId: KernelId): Promise<boolean>;
  stop(kernelId: KernelId): Promise<boolean>;
  restart(kernelId: KernelId): Promise<boolean>;
  setAutoStart(kernelId: KernelId, enabled: boolean): Promise<boolean>;
  openDirectory(kernelId: KernelId, kind: KernelDirectoryKind): Promise<boolean>;
  exportLogs(kernelId: KernelId): Promise<boolean>;
  clearError(kernelId: KernelId): void;
};

let initPromise: Promise<void> | undefined;
let subscriptions: Array<() => void> | undefined;

export const useKernelStore = create<KernelStore>((set, get) => {
  const updateRuntime = (snapshot: KernelRuntimeSnapshot) => {
    set(state => ({ runtimes: { ...state.runtimes, [snapshot.kernelId]: snapshot } }));
  };

  const run = async (
    kernelId: KernelId,
    action: KernelAction,
    operation: () => Promise<unknown>,
  ): Promise<boolean> => {
    set(state => ({
      pending: { ...state.pending, [kernelId]: action },
      errors: { ...state.errors, [kernelId]: undefined },
    }));
    try {
      const result = await operation();
      if (result && typeof result === 'object' && 'runtime' in result) {
        updateRuntime((result as { runtime: KernelRuntimeSnapshot }).runtime);
        if ((result as { restartRequired?: boolean }).restartRequired) {
          set(state => ({
            restartRequired: { ...state.restartRequired, [kernelId]: true },
          }));
        }
      } else if (result && typeof result === 'object' && 'kernelId' in result && 'state' in result) {
        updateRuntime(result as KernelRuntimeSnapshot);
      }
      await get().refresh(false);
      return true;
    } catch (error) {
      set(state => ({
        errors: { ...state.errors, [kernelId]: errorMessage(error) },
      }));
      return false;
    } finally {
      set(state => ({ pending: { ...state.pending, [kernelId]: undefined } }));
    }
  };

  return {
    catalog: null,
    runtimes: {},
    progress: {},
    pending: {},
    restartRequired: {},
    errors: {},
    initialized: false,

    init: async () => {
      if (get().initialized) return;
      if (initPromise) return initPromise;
      initPromise = (async () => {
        if (!subscriptions) {
          subscriptions = [
            hostEvents.onKernelStatusChanged(updateRuntime),
            hostEvents.onKernelPackageProgress(progress => {
              set(state => ({ progress: { ...state.progress, [progress.kernelId]: progress } }));
            }),
            hostEvents.onKernelCatalogChanged(() => { void get().refresh(false); }),
          ];
        }
        await get().refresh(false);
        set({ initialized: true });
      })().finally(() => { initPromise = undefined; });
      return initPromise;
    },

    refresh: async (refreshRemote = false) => {
      const [catalogResult, runtimeResult] = await Promise.allSettled([
        hostApi.kernels.catalog(refreshRemote),
        hostApi.kernels.list(),
      ]);
      const runtimeList = runtimeResult.status === 'fulfilled' ? runtimeResult.value : [];
      const runtimes = Object.fromEntries(runtimeList.map(runtime => [runtime.kernelId, runtime]));
      const catalog = catalogResult.status === 'fulfilled'
        ? catalogResult.value
        : fallbackCatalog(runtimeList, errorMessage(catalogResult.reason));
      set({ catalog, runtimes });
    },

    install: kernelId => run(kernelId, 'install', () => hostApi.kernels.install(kernelId)),
    update: kernelId => run(kernelId, 'update', () => hostApi.kernels.update(kernelId)),
    repair: kernelId => run(kernelId, 'repair', () => hostApi.kernels.repair(kernelId)),
    rollback: kernelId => run(kernelId, 'rollback', () => hostApi.kernels.rollback(kernelId)),
    uninstall: kernelId => run(kernelId, 'uninstall', () => hostApi.kernels.uninstall(kernelId)),
    start: kernelId => run(kernelId, 'start', () => hostApi.kernels.start(kernelId)),
    stop: kernelId => run(kernelId, 'stop', () => hostApi.kernels.stop(kernelId)),
    restart: kernelId => run(kernelId, 'restart', () => hostApi.kernels.restart(kernelId)),
    setAutoStart: (kernelId, enabled) => run(
      kernelId,
      enabled ? 'start' : 'stop',
      () => hostApi.kernels.setAutoStart(kernelId, enabled),
    ),
    openDirectory: async (kernelId, kind) => {
      try {
        await hostApi.kernels.openDirectory(kernelId, kind);
        return true;
      } catch (error) {
        set(state => ({ errors: { ...state.errors, [kernelId]: errorMessage(error) } }));
        return false;
      }
    },
    exportLogs: async (kernelId) => {
      try {
        const exported = await hostApi.kernels.exportLogs(kernelId);
        const blob = new Blob([exported.content], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = exported.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
        return true;
      } catch (error) {
        set(state => ({ errors: { ...state.errors, [kernelId]: errorMessage(error) } }));
        return false;
      }
    },
    clearError: kernelId => set(state => ({
      errors: { ...state.errors, [kernelId]: undefined },
    })),
  };
});

export function kernelDisplayName(kernelId: KernelId): string {
  return KERNEL_NAMES[kernelId] ?? kernelId;
}

/**
 * Builds a renderer option list from the host-owned catalog plus IDs observed
 * in canonical data. Built-in IDs are only a bootstrap fallback while the
 * catalog is unavailable; pages never need kernel-specific branches.
 */
export function kernelOptionsFor(
  catalog: KernelCatalogSnapshot | null,
  observedIds: Iterable<KernelId> = [],
): KernelOption[] {
  const ids = new Set<KernelId>(catalog?.entries.map(entry => entry.kernelId) ?? []);
  for (const id of observedIds) ids.add(id);
  if (ids.size === 0) {
    for (const id of Object.keys(KERNEL_NAMES)) ids.add(id);
  }
  const names = new Map(catalog?.entries.map(entry => [entry.kernelId, entry.displayName]) ?? []);
  return [...ids].map(id => ({ id, label: names.get(id) ?? kernelDisplayName(id) }));
}

export function isKernelUsable(snapshot: KernelRuntimeSnapshot | undefined): boolean {
  return snapshot?.state === 'ready';
}

function fallbackCatalog(
  runtimes: KernelRuntimeSnapshot[],
  warning: string,
): KernelCatalogSnapshot {
  const runtimeMap = new Map(runtimes.map(runtime => [runtime.kernelId, runtime]));
  const entries: KernelCatalogEntry[] = Object.keys(KERNEL_NAMES).map(kernelId => {
    const runtime = runtimeMap.get(kernelId) ?? {
      kernelId,
      state: 'not-installed' as const,
      generation: 0,
      diagnostics: [],
    };
    const installed = runtime.state !== 'not-installed';
    return {
      kernelId,
      displayName: kernelDisplayName(kernelId),
      installation: {
        kernelId,
        state: installed ? 'installed' : 'not-installed',
        ...(runtime.artifactVersion ? { activeVersion: runtime.artifactVersion } : {}),
        updatedAt: new Date(0).toISOString(),
      },
      runtime,
      updateAvailable: false,
      installAllowed: false,
      compatibilityFailures: [],
    };
  });
  return { entries, source: 'builtin', stale: false, warning, refreshedAt: new Date().toISOString() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
