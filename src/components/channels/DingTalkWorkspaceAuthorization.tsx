import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { hostApi } from '@/lib/host-api';
import type { DingTalkWorkspaceStatus } from '@shared/domains/dingtalk-workspace';

export function DingTalkWorkspaceAuthorization({ accountId, kernelId }: { accountId: string; kernelId?: string }) {
  const { t } = useTranslation('channels');
  const [status, setStatus] = useState<DingTalkWorkspaceStatus>({ status: 'starting' });
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const ownedAuthorization = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = ++generation.current;
    const poll = async () => {
      try {
        const next = await hostApi.channels.dingtalkWorkspace(accountId, 'status');
        if (generation.current !== current) return;
        setStatus(next);
      } catch { if (generation.current === current) setStatus({ status: 'error', error: 'failed' }); }
    };
    setBusy(false); void poll();
    return () => {
      // This numeric generation intentionally invalidates every in-flight request.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      const id = ownedAuthorization.current;
      ownedAuthorization.current = undefined;
      if (id) void hostApi.channels.dingtalkWorkspace(accountId, 'cancel', id).catch(() => undefined);
    };
  }, [accountId, kernelId]);

  useEffect(() => {
    if (busy || (status.status !== 'pending' && status.status !== 'starting')) return;
    const current = generation.current;
    const timer = setTimeout(async () => {
      const next = await hostApi.channels.dingtalkWorkspace(accountId, 'status').catch(() => ({ status: 'error', error: 'failed' } as const));
      if (generation.current === current) setStatus(next);
    }, 1500);
    return () => clearTimeout(timer);
  }, [accountId, status, busy]);

  const act = async (operation: 'start' | 'cancel' | 'reset') => {
    const current = ++generation.current;
    setBusy(true);
    try {
      const next = await hostApi.channels.dingtalkWorkspace(accountId, operation, operation === 'cancel' ? status.authorizationId : undefined);
      if (current !== generation.current) {
        if (operation === 'start' && next.authorizationId) void hostApi.channels.dingtalkWorkspace(accountId, 'cancel', next.authorizationId);
        return;
      }
      ownedAuthorization.current = operation === 'start' ? next.authorizationId : undefined;
      setStatus(next);
    } catch { if (current === generation.current) setStatus({ status: 'error', error: 'failed' }); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const pending = status.status === 'starting' || status.status === 'pending';
  return (
    <div className="mt-3 space-y-2 border-t border-border/50 pt-3 text-sm" data-testid={`dingtalk-workspace-${accountId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t('workspace.title')}</p>
          <p className="text-xs text-muted-foreground" role="status">{t(`workspace.status.${status.status}`)}</p>
        </div>
        <div className="flex gap-2">
          {pending && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('cancel')}>{t('workspace.cancel')}</Button>}
          {status.status === 'authorized'
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('reset')}>{t('workspace.reset')}</Button>
            : <Button size="sm" variant="outline" disabled={busy || pending || status.status === 'unavailable'} onClick={() => void act('start')}>{t('workspace.authorize')}</Button>}
        </div>
      </div>
      {status.error && <p className="text-xs text-red-700 dark:text-red-400" role="alert">{t(`workspace.errors.${status.error}`)}</p>}
      {status.verificationUri && status.status === 'pending' && (
        <div className="flex items-center gap-3">
          <Button variant="link" className="h-auto p-0" onClick={() => void hostApi.shell.openExternal(status.verificationUri!)}>{t('workspace.openAuthorization')}</Button>
          {status.userCode && <code className="select-all rounded bg-surface-input px-2 py-1">{status.userCode}</code>}
        </div>
      )}
    </div>
  );
}
