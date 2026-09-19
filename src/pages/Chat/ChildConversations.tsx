import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { asConversationId, type ChildRunSummary, type ConversationExport } from '@shared/conversations/contracts';
import { hostApi } from '@/lib/host-api';
import { hostEvents } from '@/lib/host-events';
import { useChatStore } from '@/stores/chat';
import { applyAcpSessionUpdate, createEmptyAcpTimeline } from '@/lib/acp/reducer';
import { projectConversationHistory } from '@/lib/conversations/acp-projection';
import { Button } from '@/components/ui/button';
import { AcpTimeline } from './AcpTimeline';

export function ChildConversations({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat');
  const [catalog, setCatalog] = useState<{ id: string; rows: ChildRunSummary[] }>({ id: '', rows: [] });
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<ConversationExport | null>(null);
  const rows = catalog.id === conversationId ? catalog.rows : [];
  const active = rows.find(row => row.conversationId === selected);
  useEffect(() => {
    let disposed = false; let busy = false;
    const refresh = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const children = await hostApi.conversations.children(asConversationId(conversationId));
        if (!disposed) setCatalog({ id: conversationId, rows: Array.isArray(children) ? children : [] });
      } catch { /* A stopped host cannot publish a foreign catalog. */ }
      finally { busy = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    const off = hostEvents.onConversationCatalogChanged(() => void refresh());
    return () => { disposed = true; clearInterval(timer); off(); };
  }, [conversationId]);
  useEffect(() => {
    if (!active) return;
    let disposed = false; let busy = false; let queued = false;
    const refresh = async () => {
      if (disposed) return;
      if (busy) { queued = true; return; }
      busy = true;
      try {
        const value = await hostApi.conversations.get(active.conversationId);
        if (!disposed) setHistory(value);
      } catch { /* Keep the last canonical snapshot during a transient failure. */ }
      finally { busy = false; if (queued && !disposed) { queued = false; void refresh(); } }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    const off = hostEvents.onKernelEvent(event => { if (event.conversationId === active.conversationId) void refresh(); });
    return () => { disposed = true; clearInterval(timer); off(); };
  }, [active?.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps -- identity owns this subscription
  const visible = history?.conversation.id === active?.conversationId ? history : null;
  const projection = useMemo(() => projectConversationHistory(visible), [visible]);
  const timeline = useMemo(() => {
    let snapshot = createEmptyAcpTimeline(active?.conversationId ?? '', 0);
    for (const step of projection.steps) if (step.kind === 'update') snapshot = applyAcpSessionUpdate(snapshot, step.event.notification, { historical: true });
    return snapshot;
  }, [active?.conversationId, projection]);
  if (!rows.length) return null;
  return <section className="rounded-xl border border-border p-3 space-y-2" data-testid="child-conversations">
    <h2 className="font-serif font-normal tracking-tight">{t('children.title')}</h2>
    {rows.map(row => <div key={row.runId} className="flex items-center gap-2 text-sm">
      <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start truncate" data-testid={`child-expand-${row.conversationId}`}
        aria-expanded={selected === row.conversationId} onClick={() => setSelected(selected === row.conversationId ? undefined : row.conversationId)}>
        {row.title || row.agentId}
      </Button>
      <span className="text-xs text-muted-foreground" data-testid={`child-status-${row.conversationId}`}>{t(`children.status.${row.status}`)}</span>
      <Button variant="outline" size="sm" data-testid={`child-open-${row.conversationId}`}
        onClick={() => useChatStore.getState().switchSession(row.conversationId)}>{t('children.open')}</Button>
    </div>)}
    {active && <div className="max-h-96 overflow-y-auto rounded-lg bg-surface-input p-3" data-testid="child-conversation-preview">
      <p className="mb-2 text-xs text-muted-foreground">{t('children.hint')}</p>
      <AcpTimeline snapshot={timeline} isStreaming={active.status === 'running'} workspaceRoot={visible?.conversation.workspaceUri}
        turnTimingsByUserMessageId={projection.turnTimingsByUserMessageId} />
    </div>}
  </section>;
}
