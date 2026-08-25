import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KernelLifecycleState, KernelRuntimeSnapshot } from '@shared/kernels/contracts';
import { cn } from '@/lib/utils';
import { kernelDisplayName, kernelOptionsFor, useKernelStore } from '@/stores/kernels';

const STATE_STYLE: Record<KernelLifecycleState, string> = {
  ready: 'bg-green-600 dark:bg-green-400',
  starting: 'bg-blue-600 dark:bg-blue-400 animate-pulse',
  stopping: 'bg-blue-600 dark:bg-blue-400 animate-pulse',
  degraded: 'bg-yellow-600 dark:bg-yellow-400',
  'crash-loop': 'bg-red-600 dark:bg-red-400',
  failed: 'bg-red-600 dark:bg-red-400',
  incompatible: 'bg-red-600 dark:bg-red-400',
  installed: 'bg-muted-foreground',
  stopped: 'bg-muted-foreground',
  'not-installed': 'bg-muted-foreground/40',
};

export function KernelStatusStrip({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const catalog = useKernelStore(state => state.catalog);
  const runtimes = useKernelStore(state => state.runtimes);
  const entries = useMemo(() => {
    return kernelOptionsFor(catalog, Object.keys(runtimes)).map(({ id: kernelId }) => runtimes[kernelId] ?? catalog?.entries.find(entry => entry.kernelId === kernelId)?.runtime ?? {
      kernelId,
      state: 'not-installed',
      generation: 0,
      diagnostics: [],
    } satisfies KernelRuntimeSnapshot);
  }, [catalog, runtimes]);

  return (
    <button
      type="button"
      data-testid="sidebar-kernel-status"
      className={cn(
        'sidebar-nav-text flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        'text-foreground/80 hover:bg-black/5 dark:hover:bg-white/5',
        collapsed && 'justify-center px-0',
      )}
      title={entries.map(entry => `${kernelDisplayName(entry.kernelId)}: ${t(`kernels.states.${entry.state}`)}`).join('\n')}
      onClick={() => navigate('/settings/kernels')}
    >
      <Cpu className="h-4 w-4 shrink-0" />
      {collapsed ? (
        <span className="absolute ml-4 mt-4 flex gap-0.5">
          {entries.map(entry => <StateDot key={entry.kernelId} snapshot={entry} />)}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          {entries.map(entry => (
            <span key={entry.kernelId} data-testid={`sidebar-kernel-status-${entry.kernelId}`} className="flex items-center gap-2 text-xs">
              <StateDot snapshot={entry} />
              <span className="min-w-0 flex-1 truncate">{kernelDisplayName(entry.kernelId)}</span>
              <span className="truncate text-muted-foreground">{t(`kernels.states.${entry.state}`)}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function KernelTitleStatus() {
  const { t } = useTranslation('common');
  const runtimes = useKernelStore(state => state.runtimes);
  const snapshots = Object.values(runtimes);
  const ready = snapshots.filter(snapshot => snapshot.state === 'ready').length;
  const active = snapshots.filter(snapshot => snapshot.state === 'starting' || snapshot.state === 'stopping').length;
  return (
    <div
      data-testid="titlebar-kernel-status"
      className="no-drag pointer-events-none flex items-center gap-2 rounded-full border bg-background/80 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur"
      title={t('kernels.titleStatus', { ready, total: snapshots.length })}
    >
      <span className={cn('h-2 w-2 rounded-full', active ? 'animate-pulse bg-blue-600 dark:bg-blue-400' : ready ? 'bg-green-600 dark:bg-green-400' : 'bg-muted-foreground/40')} />
      <span>{t('kernels.readyCount', { ready, total: snapshots.length })}</span>
    </div>
  );
}

function StateDot({ snapshot }: { snapshot: KernelRuntimeSnapshot }) {
  return <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', STATE_STYLE[snapshot.state])} />;
}
