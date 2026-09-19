import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { hostApi } from '@/lib/host-api';
import type { ComputerUseStatus } from '@shared/kernels/computer-use';
import type { KernelId } from '@shared/kernels/contracts';

export function ComputerUseSettings() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void hostApi.computerUse.status().then(value => { if (!disposed) setStatus(value); }).catch(() => { if (!disposed) setError(true); }); };
    refresh(); const timer = setInterval(refresh, 2_000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const mutate = async (operation: () => Promise<ComputerUseStatus>) => {
    setBusy(true); setError(false);
    try { setStatus(await operation()); } catch { setError(true); } finally { setBusy(false); }
  };
  return <section className="space-y-4" data-testid="computer-use-settings">
    <div>
      <h2 className="text-2xl font-serif font-normal tracking-tight">{t('computerUse.title')}</h2>
      <p className="text-sm text-muted-foreground mt-2">{t('computerUse.description')}</p>
    </div>
    <div className="space-y-2">
      <Label htmlFor="computer-use-kernel">{t('computerUse.kernel')}</Label>
      <select id="computer-use-kernel" data-testid="computer-use-kernel" className="block rounded-md border border-input bg-surface-input px-3 py-2 text-sm"
        value={status?.kernelId ?? ''} disabled={busy || !status || (!status.supported && !status.kernelId)}
        onChange={event => { const value = event.target.value as KernelId | ''; void mutate(() => hostApi.computerUse.select(value || null)); }}>
        <option value="">{t('computerUse.disabled')}</option>
        <option value="openclaw" disabled={!status?.supported}>{t('computerUse.openclaw')}</option>
        <option value="deepseek-harness" disabled={!status?.supported}>{t('computerUse.deepseek')}</option>
      </select>
    </div>
    {status && <p className="text-sm text-muted-foreground" data-testid="computer-use-status">{t(`computerUse.states.${status.state}`)}</p>}
    {status?.state === 'permissions' && <Button variant="outline" disabled={busy}
      data-testid="computer-use-permissions" onClick={() => void mutate(() => hostApi.computerUse.requestPermissions())}>{t('computerUse.permissions')}</Button>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t('computerUse.error')}</p>}
  </section>;
}
