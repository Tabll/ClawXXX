import { useEffect, useState } from 'react';
import {
  Download,
  FileDown,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KernelCatalogEntry } from '@shared/host-api/kernels';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { useKernelStore } from '@/stores/kernels';

export function KernelSettings() {
  const { t } = useTranslation('settings');
  const [uninstallTarget, setUninstallTarget] = useState<KernelCatalogEntry | null>(null);
  const init = useKernelStore(state => state.init);
  const refresh = useKernelStore(state => state.refresh);
  const catalog = useKernelStore(state => state.catalog);
  const runtimes = useKernelStore(state => state.runtimes);
  const pending = useKernelStore(state => state.pending);
  const errors = useKernelStore(state => state.errors);
  const progress = useKernelStore(state => state.progress);
  const install = useKernelStore(state => state.install);
  const update = useKernelStore(state => state.update);
  const repair = useKernelStore(state => state.repair);
  const rollback = useKernelStore(state => state.rollback);
  const uninstall = useKernelStore(state => state.uninstall);
  const start = useKernelStore(state => state.start);
  const stop = useKernelStore(state => state.stop);
  const restart = useKernelStore(state => state.restart);
  const setAutoStart = useKernelStore(state => state.setAutoStart);
  const openDirectory = useKernelStore(state => state.openDirectory);
  const exportLogs = useKernelStore(state => state.exportLogs);

  useEffect(() => { void init(); }, [init]);

  return (
    <section id="kernels" data-testid="settings-kernels-section">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-3xl font-normal tracking-tight text-foreground">{t('kernels.title')}</h2>
          <p className="mt-2 text-meta text-muted-foreground">{t('kernels.description')}</p>
        </div>
        <Button data-testid="settings-kernels-refresh" variant="outline" size="sm" onClick={() => void refresh(true)}>
          <RefreshCw className="mr-2 h-4 w-4" />{t('common:actions.refresh')}
        </Button>
      </div>

      {catalog?.warning && (
        <p className="mb-4 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400">
          {catalog.warning}
        </p>
      )}

      <div className="space-y-4">
        {(catalog?.entries ?? []).map(entry => {
          const runtime = runtimes[entry.kernelId] ?? entry.runtime;
          return (
            <article key={entry.kernelId} data-testid={`settings-kernel-${entry.kernelId}`} className="rounded-2xl border border-black/10 bg-surface-modal p-5 dark:border-white/10">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold">{entry.displayName}</h3>
                    <Badge variant="outline">{t(`common:kernels.states.${runtime.state}`)}</Badge>
                    {entry.updateAvailable && <Badge variant="secondary">{t('kernels.updateAvailable')}</Badge>}
                  </div>
                  <dl className="mt-3 grid gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="flex justify-between gap-2"><dt>{t('kernels.activeVersion')}</dt><dd className="truncate font-mono">{entry.installation.activeVersion ?? '—'}</dd></div>
                    <div className="flex justify-between gap-2"><dt>{t('kernels.availableVersion')}</dt><dd className="truncate font-mono">{entry.availableVersion ?? '—'}</dd></div>
                    <div className="flex justify-between gap-2"><dt>{t('kernels.generation')}</dt><dd>{runtime.generation}</dd></div>
                    <div className="flex justify-between gap-2"><dt>{t('kernels.memory')}</dt><dd>{formatBytes(runtime.rssBytes)}</dd></div>
                  </dl>
                  {progress[entry.kernelId] && pending[entry.kernelId] && (
                    <KernelProgress progress={progress[entry.kernelId]!} />
                  )}
                  {(errors[entry.kernelId] || runtime.lastError) && (
                    <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">
                      {errors[entry.kernelId] ?? runtime.lastError}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-stretch gap-3 lg:w-80">
                  <div className="flex flex-wrap justify-end gap-2">
                    {entry.installation.state !== 'installed' ? (
                      <ActionButton
                        testId={`settings-kernel-install-${entry.kernelId}`}
                        icon={Download}
                        label={t('kernels.install')}
                        pending={Boolean(pending[entry.kernelId])}
                        disabled={!entry.installAllowed}
                        onClick={() => void install(entry.kernelId)}
                      />
                    ) : (
                      <>
                        {runtime.state === 'ready' || runtime.state === 'starting' ? (
                          <ActionButton testId={`settings-kernel-stop-${entry.kernelId}`} icon={Square} label={t('kernels.stop')} pending={pending[entry.kernelId] === 'stop'} onClick={() => void stop(entry.kernelId)} />
                        ) : (
                          <ActionButton testId={`settings-kernel-start-${entry.kernelId}`} icon={Play} label={t('kernels.start')} pending={pending[entry.kernelId] === 'start'} onClick={() => void start(entry.kernelId)} />
                        )}
                        <ActionButton testId={`settings-kernel-restart-${entry.kernelId}`} icon={RefreshCw} label={t('kernels.restart')} pending={pending[entry.kernelId] === 'restart'} disabled={runtime.state !== 'ready'} onClick={() => void restart(entry.kernelId)} />
                        {entry.updateAvailable && <ActionButton testId={`settings-kernel-update-${entry.kernelId}`} icon={Download} label={t('kernels.update')} pending={pending[entry.kernelId] === 'update'} onClick={() => void update(entry.kernelId)} />}
                      </>
                    )}
                  </div>
                  {entry.installation.state === 'installed' && (
                    <div className="flex items-center justify-between rounded-lg bg-black/[0.04] px-3 py-2 text-sm dark:bg-white/[0.08]">
                      <span>{t('kernels.autoStart')}</span>
                      <Switch data-testid={`settings-kernel-autostart-${entry.kernelId}`} checked={runtime.autoStart === true} disabled={Boolean(pending[entry.kernelId])} onCheckedChange={enabled => void setAutoStart(entry.kernelId, enabled)} />
                    </div>
                  )}
                </div>
              </div>

              {entry.installation.state === 'installed' && (
                <div className="mt-5 flex flex-wrap gap-2 border-t border-black/5 pt-4 dark:border-white/5">
                  <SmallAction testId={`settings-kernel-repair-${entry.kernelId}`} icon={Wrench} label={t('kernels.repair')} onClick={() => void repair(entry.kernelId)} disabled={Boolean(pending[entry.kernelId])} />
                  <SmallAction testId={`settings-kernel-rollback-${entry.kernelId}`} icon={RotateCcw} label={t('kernels.rollback')} onClick={() => void rollback(entry.kernelId)} disabled={!entry.installation.lastKnownGoodVersion || entry.installation.lastKnownGoodVersion === entry.installation.activeVersion || Boolean(pending[entry.kernelId])} />
                  <SmallAction testId={`settings-kernel-data-${entry.kernelId}`} icon={FolderOpen} label={t('kernels.openData')} onClick={() => void openDirectory(entry.kernelId, 'data')} />
                  <SmallAction testId={`settings-kernel-logs-${entry.kernelId}`} icon={FolderOpen} label={t('kernels.openLogs')} onClick={() => void openDirectory(entry.kernelId, 'logs')} />
                  <SmallAction testId={`settings-kernel-export-${entry.kernelId}`} icon={FileDown} label={t('kernels.exportLogs')} onClick={() => void exportLogs(entry.kernelId)} />
                  <SmallAction testId={`settings-kernel-uninstall-${entry.kernelId}`} destructive icon={Trash2} label={t('kernels.uninstall')} onClick={() => setUninstallTarget(entry)} disabled={Boolean(pending[entry.kernelId])} />
                </div>
              )}
            </article>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(uninstallTarget)}
        title={t('kernels.uninstallTitle', { name: uninstallTarget?.displayName ?? '' })}
        message={t('kernels.uninstallMessage')}
        confirmLabel={t('kernels.uninstall')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onCancel={() => setUninstallTarget(null)}
        onConfirm={async () => {
          if (!uninstallTarget) return;
          const ok = await uninstall(uninstallTarget.kernelId);
          if (ok) setUninstallTarget(null);
        }}
      />
    </section>
  );
}

function ActionButton({ icon: Icon, label, pending, disabled, onClick, testId }: {
  icon: typeof Play;
  label: string;
  pending: boolean;
  disabled?: boolean;
  onClick(): void;
  testId?: string;
}) {
  return <Button data-testid={testId} size="sm" variant="outline" disabled={disabled || pending} onClick={onClick}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}{label}</Button>;
}

function SmallAction({ icon: Icon, label, onClick, disabled, destructive = false, testId }: {
  icon: typeof Play;
  label: string;
  onClick(): void;
  disabled?: boolean;
  destructive?: boolean;
  testId?: string;
}) {
  return <Button data-testid={testId} size="sm" variant="ghost" disabled={disabled} onClick={onClick} className={cn('h-8 text-xs', destructive && 'text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-400')}><Icon className="mr-1.5 h-3.5 w-3.5" />{label}</Button>;
}

function KernelProgress({ progress }: { progress: { phase: string; receivedBytes: number; totalBytes: number } }) {
  const percent = progress.totalBytes > 0 ? Math.min(100, Math.round(progress.receivedBytes / progress.totalBytes * 100)) : 0;
  return <div className="mt-3"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{progress.phase}</span><span>{percent}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.max(percent, 4)}%` }} /></div></div>;
}

function formatBytes(value: number | undefined): string {
  if (!value) return '—';
  return `${Math.round(value / 1024 / 1024)} MB`;
}
