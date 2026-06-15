import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Coins,
  Database,
  Download,
  Layers3,
  RefreshCw,
  Search,
  Sigma,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useSettingsStore } from '@/stores/settings';
import { hostApi } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
  resolveStableUsageHistory,
  resolveVisibleUsageHistory,
  type UsageGroup,
  type UsageGroupBy,
  type UsageHistoryEntry,
  type UsageWindow,
} from '@/lib/usage-history';
import { cn } from '@/lib/utils';

const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;
const USAGE_FETCH_RETRY_DELAY_MS = 1500;
const USAGE_AUTO_REFRESH_INTERVAL_MS = 15_000;
const USAGE_PAGE_SIZE = 8;
const HIDDEN_USAGE_MARKERS = ['gateway-injected', 'delivery-mirror'];

type FetchState = {
  status: 'idle' | 'loading' | 'done';
  data: UsageHistoryEntry[];
  stableData: UsageHistoryEntry[];
};

type FetchAction =
  | { type: 'start' }
  | { type: 'done'; data: UsageHistoryEntry[] }
  | { type: 'failed' }
  | { type: 'reset' };

type UsageTotals = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  costUsd: number;
  entries: number;
  sessions: number;
  models: number;
  providers: number;
  missingEntries: number;
  errorEntries: number;
};

function isHiddenUsageSource(source?: string): boolean {
  if (!source) return false;
  const normalizedSource = source.trim().toLowerCase();
  return HIDDEN_USAGE_MARKERS.some((marker) => normalizedSource.includes(marker));
}

function shouldHideUsageEntry(entry: UsageHistoryEntry): boolean {
  return isHiddenUsageSource(entry.provider) || isHiddenUsageSource(entry.model);
}

function formatUsageSource(source?: string): string | undefined {
  if (!source || isHiddenUsageSource(source)) return undefined;
  return source;
}

function formatTokenCount(value: number): string {
  return Intl.NumberFormat().format(Math.round(value));
}

function formatCompactNumber(value: number): string {
  return Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 1000 ? 'compact' : 'standard',
  }).format(value);
}

function formatUsd(value: number): string {
  return Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

function formatUsageTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function buildTotals(entries: UsageHistoryEntry[]): UsageTotals {
  const sessionIds = new Set<string>();
  const models = new Set<string>();
  const providers = new Set<string>();
  const totals: UsageTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    entries: entries.length,
    sessions: 0,
    models: 0,
    providers: 0,
    missingEntries: 0,
    errorEntries: 0,
  };

  for (const entry of entries) {
    totals.totalTokens += entry.totalTokens;
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheWriteTokens += entry.cacheWriteTokens;
    totals.costUsd += typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
    if (entry.usageStatus === 'missing') totals.missingEntries += 1;
    if (entry.usageStatus === 'error') totals.errorEntries += 1;
    if (entry.sessionId) sessionIds.add(entry.sessionId);
    if (entry.model && !isHiddenUsageSource(entry.model)) models.add(entry.model);
    if (entry.provider && !isHiddenUsageSource(entry.provider)) providers.add(entry.provider);
  }

  totals.cacheTokens = totals.cacheReadTokens + totals.cacheWriteTokens;
  totals.sessions = sessionIds.size;
  totals.models = models.size;
  totals.providers = providers.size;
  return totals;
}

function matchesQuery(entry: UsageHistoryEntry, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    entry.model,
    entry.provider,
    entry.agentId,
    entry.sessionId,
    entry.content,
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}

function exportUsageJson(entries: UsageHistoryEntry[], fileName: string): void {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function getUsageTotalClass(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return 'text-sm font-semibold text-red-600 dark:text-red-400';
  if (entry.usageStatus === 'missing') return 'text-sm font-semibold text-muted-foreground';
  return 'text-sm font-semibold text-foreground';
}

function formatUsageTotal(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return '!';
  if (entry.usageStatus === 'missing') return '-';
  return formatTokenCount(entry.totalTokens);
}

export function TokenUsageSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const usageFetchMaxAttempts = window.electron.platform === 'win32'
    ? WINDOWS_USAGE_FETCH_MAX_ATTEMPTS
    : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;

  const [usageWindow, setUsageWindow] = useState<UsageWindow>('7d');
  const [usageGroupBy, setUsageGroupBy] = useState<UsageGroupBy>('model');
  const [query, setQuery] = useState('');
  const [usagePage, setUsagePage] = useState(1);
  const [selectedUsageEntry, setSelectedUsageEntry] = useState<UsageHistoryEntry | null>(null);
  const [usageRefreshNonce, setUsageRefreshNonce] = useState(0);

  const [fetchState, dispatchFetch] = useReducer(
    (state: FetchState, action: FetchAction): FetchState => {
      switch (action.type) {
        case 'start':
          return { ...state, status: 'loading' };
        case 'done':
          return {
            status: 'done',
            data: action.data,
            stableData: resolveStableUsageHistory(state.stableData, action.data),
          };
        case 'failed':
          return { ...state, status: 'done' };
        case 'reset':
          return { status: 'idle', data: [], stableData: [] };
        default:
          return state;
      }
    },
    { status: 'idle', data: [], stableData: [] },
  );

  const usageFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usageFetchGenerationRef = useRef(0);
  const usageFetchStatusRef = useRef<FetchState['status']>('idle');

  useEffect(() => {
    usageFetchStatusRef.current = fetchState.status;
  }, [fetchState.status]);

  useEffect(() => {
    trackUiEvent('settings.token_usage_viewed');
  }, []);

  useEffect(() => {
    const requestRefresh = () => {
      if (usageFetchStatusRef.current === 'loading') return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setUsageRefreshNonce((value) => value + 1);
    };

    const intervalId = window.setInterval(requestRefresh, USAGE_AUTO_REFRESH_INTERVAL_MS);
    const handleFocus = () => requestRefresh();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestRefresh();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (usageFetchTimerRef.current) {
      clearTimeout(usageFetchTimerRef.current);
      usageFetchTimerRef.current = null;
    }

    dispatchFetch({ type: 'start' });
    const generation = usageFetchGenerationRef.current + 1;
    usageFetchGenerationRef.current = generation;
    const restartMarker = `local-transcripts:${generation}`;
    trackUiEvent('settings.token_usage_fetch_started', { generation, restartMarker });

    const safetyTimeout = setTimeout(() => {
      if (usageFetchGenerationRef.current !== generation) return;
      trackUiEvent('settings.token_usage_fetch_safety_timeout', { generation, restartMarker });
      dispatchFetch({ type: 'failed' });
    }, 30_000);

    const fetchUsageHistoryWithRetry = async (attempt: number) => {
      trackUiEvent('settings.token_usage_fetch_attempt', { generation, attempt, restartMarker });
      try {
        const entries = await hostApi.usage.recentTokenHistory();
        if (usageFetchGenerationRef.current !== generation) return;

        const normalized = Array.isArray(entries) ? entries : [];
        setUsagePage(1);
        trackUiEvent('settings.token_usage_fetch_succeeded', {
          generation,
          attempt,
          records: normalized.length,
          restartMarker,
        });

        if (normalized.length === 0 && attempt < usageFetchMaxAttempts) {
          usageFetchTimerRef.current = setTimeout(() => {
            void fetchUsageHistoryWithRetry(attempt + 1);
          }, USAGE_FETCH_RETRY_DELAY_MS);
          return;
        }

        dispatchFetch({ type: 'done', data: normalized });
      } catch (error) {
        if (usageFetchGenerationRef.current !== generation) return;
        trackUiEvent('settings.token_usage_fetch_failed_attempt', {
          generation,
          attempt,
          restartMarker,
          message: error instanceof Error ? error.message : String(error),
        });
        if (attempt < usageFetchMaxAttempts) {
          usageFetchTimerRef.current = setTimeout(() => {
            void fetchUsageHistoryWithRetry(attempt + 1);
          }, USAGE_FETCH_RETRY_DELAY_MS);
          return;
        }
        dispatchFetch({ type: 'failed' });
      }
    };

    void fetchUsageHistoryWithRetry(1);

    return () => {
      clearTimeout(safetyTimeout);
      if (usageFetchTimerRef.current) {
        clearTimeout(usageFetchTimerRef.current);
        usageFetchTimerRef.current = null;
      }
    };
  }, [usageFetchMaxAttempts, usageRefreshNonce]);

  const visibleUsageHistory = useMemo(() => {
    const usageHistory = fetchState.data.filter((entry) => !shouldHideUsageEntry(entry));
    const stableUsageHistory = fetchState.stableData.filter((entry) => !shouldHideUsageEntry(entry));
    return resolveVisibleUsageHistory(usageHistory, stableUsageHistory, {
      preferStableOnEmpty: fetchState.status === 'loading',
    });
  }, [fetchState.data, fetchState.stableData, fetchState.status]);

  const windowedUsageHistory = useMemo(
    () => filterUsageHistoryByWindow(visibleUsageHistory, usageWindow),
    [usageWindow, visibleUsageHistory],
  );
  const filteredUsageHistory = useMemo(
    () => windowedUsageHistory.filter((entry) => matchesQuery(entry, query)),
    [query, windowedUsageHistory],
  );
  const usageGroups = useMemo(
    () => groupUsageHistory(filteredUsageHistory, usageGroupBy),
    [filteredUsageHistory, usageGroupBy],
  );
  const dailyGroups = useMemo(
    () => groupUsageHistory(filteredUsageHistory, 'day'),
    [filteredUsageHistory],
  );
  const totals = useMemo(() => buildTotals(filteredUsageHistory), [filteredUsageHistory]);
  const usageTotalPages = Math.max(1, Math.ceil(filteredUsageHistory.length / USAGE_PAGE_SIZE));
  const safeUsagePage = Math.min(usagePage, usageTotalPages);
  const pagedUsageHistory = filteredUsageHistory.slice(
    (safeUsagePage - 1) * USAGE_PAGE_SIZE,
    safeUsagePage * USAGE_PAGE_SIZE,
  );
  const usageLoading = fetchState.status === 'loading' && visibleUsageHistory.length === 0;
  const usageRefreshing = fetchState.status === 'loading' && visibleUsageHistory.length > 0;
  const averageTokensPerSession = totals.sessions > 0 ? totals.totalTokens / totals.sessions : 0;

  return (
    <div data-testid="settings-token-usage-section" className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="clawx-section-title flex items-center gap-2" data-testid="token-usage-title">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            {t('tokenUsage.title')}
          </h2>
          <p className="mt-2 max-w-2xl text-meta text-muted-foreground">
            {t('tokenUsage.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-lg"
            onClick={() => setUsageRefreshNonce((value) => value + 1)}
            disabled={fetchState.status === 'loading'}
            data-testid="token-usage-refresh"
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', fetchState.status === 'loading' && 'animate-spin')} />
            {usageRefreshing ? t('tokenUsage.refreshing') : t('tokenUsage.refresh')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-lg"
            onClick={() => exportUsageJson(filteredUsageHistory, 'clawx-token-usage.json')}
            disabled={filteredUsageHistory.length === 0}
          >
            <Download className="mr-2 h-4 w-4" />
            {t('tokenUsage.exportJson')}
          </Button>
        </div>
      </div>

      <div className="clawx-settings-panel space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {(['7d', '30d', 'all'] as UsageWindow[]).map((windowId) => (
              <Button
                key={windowId}
                variant={usageWindow === windowId ? 'secondary' : 'outline'}
                size="sm"
                className={cn(
                  'h-8 rounded-lg text-meta',
                  usageWindow === windowId
                    ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                    : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
                )}
                onClick={() => {
                  setUsageWindow(windowId);
                  setUsagePage(1);
                }}
              >
                {t(`tokenUsage.windows.${windowId}`)}
              </Button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row lg:max-w-xl">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setUsagePage(1);
                }}
                placeholder={t('tokenUsage.searchPlaceholder')}
                className="pl-9"
                data-testid="token-usage-search"
              />
            </div>
            <Select
              value={usageGroupBy}
              onChange={(event) => setUsageGroupBy(event.target.value as UsageGroupBy)}
              className="sm:w-40"
              data-testid="token-usage-group-by"
            >
              <option value="model">{t('tokenUsage.groupBy.model')}</option>
              <option value="provider">{t('tokenUsage.groupBy.provider')}</option>
              <option value="agent">{t('tokenUsage.groupBy.agent')}</option>
              <option value="day">{t('tokenUsage.groupBy.day')}</option>
            </Select>
          </div>
        </div>

        <p className="text-meta text-muted-foreground">
          {usageRefreshing
            ? t('tokenUsage.refreshing')
            : t('tokenUsage.showing', { shown: filteredUsageHistory.length, total: windowedUsageHistory.length })}
        </p>
      </div>

      {usageLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/55 bg-surface-input/70 py-12 text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          {t('tokenUsage.loading')}
        </div>
      ) : visibleUsageHistory.length === 0 ? (
        <EmptyUsageState title={t('tokenUsage.emptyTitle')} description={t('tokenUsage.emptyDescription')} />
      ) : filteredUsageHistory.length === 0 ? (
        <EmptyUsageState title={t('tokenUsage.emptyFilteredTitle')} description={t('tokenUsage.emptyFilteredDescription')} />
      ) : (
        <>
          <UsageMetricGrid totals={totals} labels={{
            totalTokens: t('tokenUsage.metrics.totalTokens'),
            cost: t('tokenUsage.metrics.cost'),
            sessions: t('tokenUsage.metrics.sessions'),
            entries: t('tokenUsage.metrics.entries'),
            input: t('tokenUsage.metrics.input'),
            output: t('tokenUsage.metrics.output'),
            cacheRead: t('tokenUsage.metrics.cacheRead'),
            cacheWrite: t('tokenUsage.metrics.cacheWrite'),
            models: t('tokenUsage.metrics.models'),
            providers: t('tokenUsage.metrics.providers'),
            rawTokensDetail: t('tokenUsage.metrics.rawTokensDetail', { value: formatTokenCount(totals.totalTokens) }),
            unpricedError: t('tokenUsage.metrics.unpricedError', { count: totals.missingEntries + totals.errorEntries }),
            averageSession: t('tokenUsage.metrics.averageSession', { value: formatCompactNumber(averageTokensPerSession) }),
            modelProviderDetail: t('tokenUsage.metrics.modelProviderDetail', {
              models: totals.models,
              providers: totals.providers,
            }),
          }} />

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <UsageTrendChart
              groups={dailyGroups}
              title={t('tokenUsage.charts.trendTitle')}
              subtitle={t('tokenUsage.charts.trendSubtitle')}
              emptyLabel={t('tokenUsage.emptyTitle')}
            />
            <UsageCompositionCard
              totals={totals}
              title={t('tokenUsage.charts.compositionTitle')}
              labels={{
                input: t('tokenUsage.metrics.input'),
                output: t('tokenUsage.metrics.output'),
                cacheRead: t('tokenUsage.metrics.cacheRead'),
                cacheWrite: t('tokenUsage.metrics.cacheWrite'),
              }}
            />
          </div>

          <UsageBreakdown
            groups={usageGroups}
            title={t('tokenUsage.breakdown.title', { group: t(`tokenUsage.groupBy.${usageGroupBy}`) })}
            totalLabel={t('tokenUsage.metrics.totalTokens')}
            costLabel={t('tokenUsage.metrics.cost')}
            countLabel={t('tokenUsage.breakdown.records')}
            inputLabel={t('tokenUsage.breakdown.inputShort')}
            outputLabel={t('tokenUsage.breakdown.outputShort')}
            cacheLabel={t('tokenUsage.breakdown.cacheShort')}
            unknownLabel={t('tokenUsage.unknown')}
          />

          <UsageEntryList
            entries={pagedUsageHistory}
            page={safeUsagePage}
            totalPages={usageTotalPages}
            devModeUnlocked={devModeUnlocked}
            onPrev={() => setUsagePage((page) => Math.max(1, page - 1))}
            onNext={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
            onSelect={setSelectedUsageEntry}
            labels={{
              title: t('tokenUsage.entries.title'),
              page: t('tokenUsage.entries.page', { current: safeUsagePage, total: usageTotalPages }),
              prev: t('tokenUsage.entries.prev'),
              next: t('tokenUsage.entries.next'),
              input: t('tokenUsage.metrics.input'),
              output: t('tokenUsage.metrics.output'),
              cacheRead: t('tokenUsage.metrics.cacheRead'),
              cacheWrite: t('tokenUsage.metrics.cacheWrite'),
              cost: t('tokenUsage.metrics.cost'),
              viewContent: t('tokenUsage.entries.viewContent'),
              noUsage: t('tokenUsage.entries.noUsage'),
              usageParseError: t('tokenUsage.entries.usageParseError'),
              unknown: t('tokenUsage.unknown'),
            }}
          />
        </>
      )}

      {devModeUnlocked && selectedUsageEntry && (
        <UsageContentPopup
          entry={selectedUsageEntry}
          onClose={() => setSelectedUsageEntry(null)}
          title={t('tokenUsage.contentDialog.title')}
          closeLabel={t('common:actions.close')}
          unknownLabel={t('tokenUsage.unknown')}
        />
      )}
    </div>
  );
}

function EmptyUsageState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/55 bg-surface-input/70 px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-modal text-muted-foreground shadow-sm">
        <BarChart3 className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-meta text-muted-foreground">{description}</p>
    </div>
  );
}

function UsageMetricGrid({
  totals,
  labels,
}: {
  totals: UsageTotals;
  labels: Record<string, string>;
}) {
  const cards = [
    {
      key: 'total',
      label: labels.totalTokens,
      value: formatCompactNumber(totals.totalTokens),
      detail: labels.rawTokensDetail,
      icon: Sigma,
      className: 'from-cyan-500/18 via-blue-500/10 to-transparent',
    },
    {
      key: 'cost',
      label: labels.cost,
      value: formatUsd(totals.costUsd),
      detail: labels.unpricedError,
      icon: Coins,
      className: 'from-emerald-500/18 via-teal-500/10 to-transparent',
    },
    {
      key: 'sessions',
      label: labels.sessions,
      value: formatTokenCount(totals.sessions),
      detail: labels.averageSession,
      icon: Layers3,
      className: 'from-violet-500/16 via-fuchsia-500/10 to-transparent',
    },
    {
      key: 'entries',
      label: labels.entries,
      value: formatTokenCount(totals.entries),
      detail: labels.modelProviderDetail,
      icon: Database,
      className: 'from-amber-500/18 via-orange-500/10 to-transparent',
    },
    {
      key: 'input',
      label: labels.input,
      value: formatCompactNumber(totals.inputTokens),
      detail: formatTokenCount(totals.inputTokens),
      icon: TrendingUp,
      className: 'from-sky-500/18 via-cyan-500/10 to-transparent',
    },
    {
      key: 'output',
      label: labels.output,
      value: formatCompactNumber(totals.outputTokens),
      detail: formatTokenCount(totals.outputTokens),
      icon: Zap,
      className: 'from-rose-500/16 via-pink-500/10 to-transparent',
    },
    {
      key: 'cacheRead',
      label: labels.cacheRead,
      value: formatCompactNumber(totals.cacheReadTokens),
      detail: formatTokenCount(totals.cacheReadTokens),
      icon: Database,
      className: 'from-lime-500/16 via-emerald-500/10 to-transparent',
    },
    {
      key: 'cacheWrite',
      label: labels.cacheWrite,
      value: formatCompactNumber(totals.cacheWriteTokens),
      detail: formatTokenCount(totals.cacheWriteTokens),
      icon: Database,
      className: 'from-indigo-500/16 via-blue-500/10 to-transparent',
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.key}
            className={cn(
              'rounded-lg border border-border/65 bg-surface-modal/90 bg-gradient-to-br p-4 shadow-sm shadow-black/5 dark:shadow-black/20',
              card.className,
            )}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="text-meta font-medium text-muted-foreground">{card.label}</p>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-semibold text-foreground">{card.value}</p>
            <p className="mt-1 truncate text-tiny font-medium text-muted-foreground">{card.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function UsageTrendChart({
  groups,
  title,
  subtitle,
  emptyLabel,
}: {
  groups: UsageGroup[];
  title: string;
  subtitle: string;
  emptyLabel: string;
}) {
  const width = 720;
  const height = 260;
  const padding = { top: 20, right: 18, bottom: 36, left: 18 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);
  const barGap = 6;
  const barWidth = groups.length > 0
    ? Math.max(8, (chartWidth - barGap * Math.max(groups.length - 1, 0)) / groups.length)
    : 0;

  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/90 p-5 shadow-sm shadow-black/5 dark:shadow-black/20">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-meta text-muted-foreground">{subtitle}</p>
        </div>
        <BarChart3 className="h-5 w-5 text-muted-foreground" />
      </div>
      {groups.length === 0 ? (
        <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border/60 text-meta text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full overflow-visible" role="img">
          <defs>
            <linearGradient id="usageInputGradient" x1="0" x2="0" y1="1" y2="0">
              <stop offset="0%" stopColor="hsl(var(--usage-input))" stopOpacity="0.74" />
              <stop offset="100%" stopColor="hsl(var(--usage-input))" stopOpacity="1" />
            </linearGradient>
            <linearGradient id="usageOutputGradient" x1="0" x2="0" y1="1" y2="0">
              <stop offset="0%" stopColor="hsl(var(--usage-output))" stopOpacity="0.72" />
              <stop offset="100%" stopColor="hsl(var(--usage-output))" stopOpacity="1" />
            </linearGradient>
            <linearGradient id="usageCacheGradient" x1="0" x2="0" y1="1" y2="0">
              <stop offset="0%" stopColor="hsl(var(--usage-cache))" stopOpacity="0.68" />
              <stop offset="100%" stopColor="hsl(var(--usage-cache))" stopOpacity="1" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const y = padding.top + chartHeight - chartHeight * tick;
            return (
              <line
                key={tick}
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="hsl(var(--border))"
                strokeOpacity="0.42"
              />
            );
          })}
          {groups.map((group, index) => {
            const x = padding.left + index * (barWidth + barGap);
            const totalHeight = (group.totalTokens / maxTokens) * chartHeight;
            const inputHeight = group.totalTokens > 0 ? (group.inputTokens / group.totalTokens) * totalHeight : 0;
            const outputHeight = group.totalTokens > 0 ? (group.outputTokens / group.totalTokens) * totalHeight : 0;
            const cacheHeight = group.totalTokens > 0 ? (group.cacheTokens / group.totalTokens) * totalHeight : 0;
            const yBase = padding.top + chartHeight;
            const yCache = yBase - cacheHeight;
            const yInput = yCache - inputHeight;
            const yOutput = yInput - outputHeight;
            return (
              <g key={`${group.label}-${index}`}>
                <title>{`${group.label}: ${formatTokenCount(group.totalTokens)}`}</title>
                <rect x={x} y={yOutput} width={barWidth} height={outputHeight} rx="3" fill="url(#usageOutputGradient)" />
                <rect x={x} y={yInput} width={barWidth} height={inputHeight} rx="3" fill="url(#usageInputGradient)" />
                <rect x={x} y={yCache} width={barWidth} height={cacheHeight} rx="3" fill="url(#usageCacheGradient)" />
                <text
                  x={x + barWidth / 2}
                  y={height - 14}
                  textAnchor="middle"
                  fill="hsl(var(--muted-foreground))"
                  fontSize="11"
                >
                  {groups.length <= 12 || index % Math.ceil(groups.length / 8) === 0 ? group.label : ''}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function UsageCompositionCard({
  totals,
  title,
  labels,
}: {
  totals: UsageTotals;
  title: string;
  labels: Record<string, string>;
}) {
  const segments = [
    { key: 'output', label: labels.output, value: totals.outputTokens, className: 'bg-usage-output' },
    { key: 'input', label: labels.input, value: totals.inputTokens, className: 'bg-usage-input' },
    { key: 'cacheWrite', label: labels.cacheWrite, value: totals.cacheWriteTokens, className: 'bg-indigo-500' },
    { key: 'cacheRead', label: labels.cacheRead, value: totals.cacheReadTokens, className: 'bg-usage-cache' },
  ];

  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/90 p-5 shadow-sm shadow-black/5 dark:shadow-black/20">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="mt-5 h-4 overflow-hidden rounded-full bg-surface-input/75">
        <div className="flex h-full">
          {segments.map((segment) => (
            segment.value > 0 ? (
              <div
                key={segment.key}
                className={segment.className}
                style={{ width: `${Math.max((segment.value / Math.max(totals.totalTokens, 1)) * 100, 2)}%` }}
              />
            ) : null
          ))}
        </div>
      </div>
      <div className="mt-5 space-y-3">
        {segments.map((segment) => (
          <div key={segment.key} className="flex items-center justify-between gap-3 text-meta">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className={cn('h-2.5 w-2.5 rounded-full', segment.className)} />
              {segment.label}
            </span>
            <span className="font-semibold text-foreground">{formatTokenCount(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageBreakdown({
  groups,
  title,
  totalLabel,
  costLabel,
  countLabel,
  inputLabel,
  outputLabel,
  cacheLabel,
  unknownLabel,
}: {
  groups: UsageGroup[];
  title: string;
  totalLabel: string;
  costLabel: string;
  countLabel: string;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
  unknownLabel: string;
}) {
  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);
  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/90 p-5 shadow-sm shadow-black/5 dark:shadow-black/20">
      <p className="mb-4 text-sm font-semibold text-foreground">{title}</p>
      <div className="space-y-4">
        {groups.map((group) => {
          const width = group.totalTokens > 0 ? Math.max((group.totalTokens / maxTokens) * 100, 4) : 0;
          return (
            <div key={group.label} className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium text-foreground">{group.label === 'Unknown' ? unknownLabel : group.label}</span>
                <span className="shrink-0 text-meta font-medium text-muted-foreground">
                  {totalLabel}: {formatCompactNumber(group.totalTokens)}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-surface-input/75">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,hsl(var(--usage-output)),hsl(var(--usage-input)),hsl(var(--usage-cache)))]"
                  style={{ width: `${width}%` }}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-tiny font-medium text-muted-foreground">
                <span>{countLabel}: {formatTokenCount(group.count)}</span>
                <span>{costLabel}: {formatUsd(group.costUsd)}</span>
                <span>{inputLabel}: {formatCompactNumber(group.inputTokens)}</span>
                <span>{outputLabel}: {formatCompactNumber(group.outputTokens)}</span>
                <span>{cacheLabel}: {formatCompactNumber(group.cacheTokens)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UsageEntryList({
  entries,
  page,
  totalPages,
  devModeUnlocked,
  onPrev,
  onNext,
  onSelect,
  labels,
}: {
  entries: UsageHistoryEntry[];
  page: number;
  totalPages: number;
  devModeUnlocked: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (entry: UsageHistoryEntry) => void;
  labels: Record<string, string>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{labels.title}</p>
        <p className="text-meta font-medium text-muted-foreground">{labels.page}</p>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div
            key={`${entry.sessionId}-${entry.timestamp}`}
            data-testid="token-usage-entry"
            className="rounded-lg border border-border/65 bg-surface-modal/90 p-4 shadow-sm shadow-black/5 transition-colors hover:border-border/85 hover:bg-surface-modal dark:shadow-black/20"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {entry.model || labels.unknown}
                </p>
                <p className="mt-0.5 truncate text-meta text-muted-foreground">
                  {[formatUsageSource(entry.provider), formatUsageSource(entry.agentId), entry.sessionId].filter(Boolean).join(' - ')}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={getUsageTotalClass(entry)}>{formatUsageTotal(entry)}</p>
                <p className="mt-0.5 text-tiny text-muted-foreground">{formatUsageTimestamp(entry.timestamp)}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta font-medium text-muted-foreground">
              {entry.usageStatus === 'available' || entry.usageStatus === undefined ? (
                <>
                  <span>{labels.input}: {formatTokenCount(entry.inputTokens)}</span>
                  <span>{labels.output}: {formatTokenCount(entry.outputTokens)}</span>
                  <span>{labels.cacheRead}: {formatTokenCount(entry.cacheReadTokens)}</span>
                  <span>{labels.cacheWrite}: {formatTokenCount(entry.cacheWriteTokens)}</span>
                </>
              ) : (
                <span>
                  {entry.usageStatus === 'missing' ? labels.noUsage : labels.usageParseError}
                </span>
              )}
              {typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && (
                <span className="rounded-md bg-surface-input/70 px-2 py-0.5 text-foreground/85">
                  {labels.cost}: {formatUsd(entry.costUsd)}
                </span>
              )}
              {devModeUnlocked && entry.content && (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 rounded-lg px-2.5 text-tiny"
                  onClick={() => onSelect(entry)}
                >
                  {labels.viewContent}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" className="h-8 rounded-lg" onClick={onPrev} disabled={page <= 1}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          {labels.prev}
        </Button>
        <Button variant="outline" size="sm" className="h-8 rounded-lg" onClick={onNext} disabled={page >= totalPages}>
          {labels.next}
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function UsageContentPopup({
  entry,
  onClose,
  title,
  closeLabel,
  unknownLabel,
}: {
  entry: UsageHistoryEntry;
  onClose: () => void;
  title: string;
  closeLabel: string;
  unknownLabel: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl rounded-lg border border-border/80 bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border/80 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {(entry.model || unknownLabel)} - {formatUsageTimestamp(entry.timestamp)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
            {entry.content}
          </pre>
        </div>
        <div className="flex justify-end border-t border-border/80 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default TokenUsageSettings;
