import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Coins,
  Cpu,
  Database,
  Download,
  FileText,
  Info,
  Layers3,
  MessageSquare,
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
import { hostApi } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import {
  aggregateUsageSessions,
  filterUsageHistoryByWindow,
  groupUsageHistory,
  matchesUsageSession,
  resolveStableUsageHistory,
  resolveVisibleUsageHistory,
  type UsageGroup,
  type UsageGroupBy,
  type UsageContextWeightEntry,
  type UsageHistoryEntry,
  type UsageSessionBreakdownItem,
  type UsageSessionSummary,
  type UsageWindow,
} from '@/lib/usage-history';
import { cn } from '@/lib/utils';
import { kernelDisplayName, useKernelStore } from '@/stores/kernels';

const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;
const USAGE_FETCH_RETRY_DELAY_MS = 1500;
const USAGE_AUTO_REFRESH_INTERVAL_MS = 15_000;
const USAGE_PAGE_SIZE = 8;
const HIDDEN_USAGE_MARKERS = ['gateway-injected', 'delivery-mirror'];
const CONTEXT_TOKEN_CHAR_RATIO = 4;
const MONOTONE_USAGE_BAR_BACKGROUND = 'linear-gradient(90deg, hsl(var(--usage-input) / 0.58), hsl(var(--usage-input)))';

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
  knownTokenEntries: number;
  unknownTokenEntries: number;
  knownCostEntries: number;
  unknownCostEntries: number;
};

type UsageKernelFilter = 'all' | string;

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

function formatKnownNumber(value: number | undefined, unknown: string, formatter = formatTokenCount): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatter(value) : unknown;
}

function knownTokenSubtotal(entry: UsageHistoryEntry): number {
  return (entry.inputTokens ?? 0)
    + (entry.outputTokens ?? 0)
    + (entry.cacheReadTokens ?? 0)
    + (entry.cacheWriteTokens ?? 0);
}

function formatEntryCost(entry: UsageHistoryEntry, unknown: string): string {
  if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost)) return unknown;
  if (!entry.currency || entry.currency === 'USD') return formatUsd(entry.cost);
  return `${Intl.NumberFormat().format(entry.cost)} ${entry.currency}`;
}

function formatSessionTokenField(
  session: UsageSessionSummary,
  key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'totalTokens',
  unknown: string,
): string {
  const hasKnownValue = session.entries.some(entry => (
    typeof entry[key] === 'number' && Number.isFinite(entry[key])
  ));
  return hasKnownValue ? formatTokenCount(session[key]) : unknown;
}

function formatSessionUsdCost(session: UsageSessionSummary, unknown: string): string {
  const hasKnownUsdCost = session.entries.some(entry => (
    typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)
  ));
  return hasKnownUsdCost ? formatUsd(session.costUsd) : unknown;
}

function estimateContextTokens(chars: number): number {
  return Math.round(Math.max(0, chars) / CONTEXT_TOKEN_CHAR_RATIO);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
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

function formatUsageTimestampMs(timestamp: number | undefined, fallback: string): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return fallback;
  return formatUsageTimestamp(new Date(timestamp).toISOString());
}

function formatDurationMs(durationMs: number | undefined, fallback: string): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return fallback;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
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
    knownTokenEntries: 0,
    unknownTokenEntries: 0,
    knownCostEntries: 0,
    unknownCostEntries: 0,
  };

  for (const entry of entries) {
    totals.totalTokens += entry.totalTokens ?? knownTokenSubtotal(entry);
    totals.inputTokens += entry.inputTokens ?? 0;
    totals.outputTokens += entry.outputTokens ?? 0;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
    totals.costUsd += typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
    if (entry.totalTokens === undefined) totals.unknownTokenEntries += 1;
    else totals.knownTokenEntries += 1;
    if (entry.costUsd === undefined) totals.unknownCostEntries += 1;
    else totals.knownCostEntries += 1;
    if (entry.usageStatus === 'missing') totals.missingEntries += 1;
    if (entry.usageStatus === 'error') totals.errorEntries += 1;
    if (entry.sessionId) sessionIds.add(`${entry.agentId || 'Unknown'}::${entry.sessionId}`);
    if (entry.model && !isHiddenUsageSource(entry.model)) models.add(entry.model);
    if (entry.provider && !isHiddenUsageSource(entry.provider)) providers.add(entry.provider);
  }

  totals.cacheTokens = totals.cacheReadTokens + totals.cacheWriteTokens;
  totals.sessions = sessionIds.size;
  totals.models = models.size;
  totals.providers = providers.size;
  return totals;
}

function exportUsageJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function TokenUsageSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const usageFetchMaxAttempts = window.electron.platform === 'win32'
    ? WINDOWS_USAGE_FETCH_MAX_ATTEMPTS
    : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;

  const [usageWindow, setUsageWindow] = useState<UsageWindow>('7d');
  const [kernelFilter, setKernelFilter] = useState<UsageKernelFilter>('all');
  const kernelCatalog = useKernelStore((state) => state.catalog);
  const [usageGroupBy, setUsageGroupBy] = useState<UsageGroupBy>('model');
  const [query, setQuery] = useState('');
  const [usagePage, setUsagePage] = useState(1);
  const [selectedUsageSession, setSelectedUsageSession] = useState<UsageSessionSummary | null>(null);
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
    const restartMarker = `canonical-sqlite:${generation}`;
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
    const matchesKernel = (entry: UsageHistoryEntry) => kernelFilter === 'all' || entry.kernelId === kernelFilter;
    const usageHistory = fetchState.data.filter((entry) => !shouldHideUsageEntry(entry) && matchesKernel(entry));
    const stableUsageHistory = fetchState.stableData.filter((entry) => !shouldHideUsageEntry(entry) && matchesKernel(entry));
    return resolveVisibleUsageHistory(usageHistory, stableUsageHistory, {
      preferStableOnEmpty: fetchState.status === 'loading',
    });
  }, [fetchState.data, fetchState.stableData, fetchState.status, kernelFilter]);
  const usageKernelIds = useMemo(() => {
    const ids = new Set(kernelCatalog?.entries.map(entry => entry.kernelId) ?? []);
    fetchState.data.forEach(entry => { if (entry.kernelId) ids.add(entry.kernelId); });
    fetchState.stableData.forEach(entry => { if (entry.kernelId) ids.add(entry.kernelId); });
    return [...ids];
  }, [fetchState.data, fetchState.stableData, kernelCatalog]);

  const windowedUsageHistory = useMemo(
    () => filterUsageHistoryByWindow(visibleUsageHistory, usageWindow),
    [usageWindow, visibleUsageHistory],
  );
  const windowedUsageSessions = useMemo(
    () => aggregateUsageSessions(windowedUsageHistory),
    [windowedUsageHistory],
  );
  const filteredUsageSessions = useMemo(
    () => windowedUsageSessions.filter((session) => matchesUsageSession(session, query)),
    [query, windowedUsageSessions],
  );
  const filteredUsageHistory = useMemo(
    () => filteredUsageSessions.flatMap((session) => session.entries),
    [filteredUsageSessions],
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
  const usageTotalPages = Math.max(1, Math.ceil(filteredUsageSessions.length / USAGE_PAGE_SIZE));
  const safeUsagePage = Math.min(usagePage, usageTotalPages);
  const pagedUsageSessions = filteredUsageSessions.slice(
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
            onClick={() => exportUsageJson({
              generatedAt: new Date().toISOString(),
              window: usageWindow,
              query,
              totals,
              sessions: filteredUsageSessions,
            }, 'clawx-token-usage.json')}
            disabled={filteredUsageSessions.length === 0}
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
            <span className="mx-1 h-8 w-px bg-border/65" aria-hidden="true" />
            {(['all', ...usageKernelIds] as UsageKernelFilter[]).map((kernelId) => (
              <Button
                key={kernelId}
                variant={kernelFilter === kernelId ? 'secondary' : 'outline'}
                size="sm"
                className={cn(
                  'h-8 rounded-lg text-meta',
                  kernelFilter === kernelId
                    ? 'border-primary/45 bg-primary/10 text-primary shadow-none'
                    : 'bg-surface-modal/70 text-muted-foreground hover:border-ring/35 hover:bg-surface-modal',
                )}
                onClick={() => {
                  setKernelFilter(kernelId);
                  setUsagePage(1);
                }}
                data-testid={`token-usage-kernel-${kernelId}`}
              >
                {kernelId === 'all' ? t('tokenUsage.kernels.all') : kernelDisplayName(kernelId)}
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
            : t('tokenUsage.showingSessions', { shown: filteredUsageSessions.length, total: windowedUsageSessions.length })}
        </p>
        <p className="text-tiny text-muted-foreground" data-testid="token-usage-cost-semantics">
          {t('tokenUsage.costSemantics')}
        </p>
      </div>

      {usageLoading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/55 bg-surface-input/70 py-12 text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          {t('tokenUsage.loading')}
        </div>
      ) : visibleUsageHistory.length === 0 ? (
        <EmptyUsageState title={t('tokenUsage.emptyTitle')} description={t('tokenUsage.emptyDescription')} />
      ) : filteredUsageSessions.length === 0 ? (
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
            unknown: t('tokenUsage.unknown'),
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
              labels={{
                total: t('tokenUsage.metrics.totalTokens'),
                input: t('tokenUsage.metrics.input'),
                output: t('tokenUsage.metrics.output'),
                cache: t('tokenUsage.breakdown.cacheShort'),
                cost: t('tokenUsage.metrics.cost'),
                unknown: t('tokenUsage.unknown'),
              }}
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

          <UsageSessionList
            sessions={pagedUsageSessions}
            page={safeUsagePage}
            totalPages={usageTotalPages}
            onPrev={() => setUsagePage((page) => Math.max(1, page - 1))}
            onNext={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
            onSelect={setSelectedUsageSession}
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
              viewDetails: t('tokenUsage.entries.viewDetails'),
              noUsage: t('tokenUsage.entries.noUsage'),
              usageParseError: t('tokenUsage.entries.usageParseError'),
              unknown: t('tokenUsage.unknown'),
              calls: t('tokenUsage.entries.calls'),
              updated: t('tokenUsage.entries.updated'),
              mixedModels: t('tokenUsage.entries.mixedModels'),
            }}
          />
        </>
      )}

      {selectedUsageSession && (
        <UsageSessionDetailDialog
          session={selectedUsageSession}
          onClose={() => setSelectedUsageSession(null)}
          title={t('tokenUsage.contentDialog.title')}
          closeLabel={t('common:actions.close')}
          labels={{
            unknown: t('tokenUsage.unknown'),
            totalTokens: t('tokenUsage.metrics.totalTokens'),
            cost: t('tokenUsage.metrics.cost'),
            calls: t('tokenUsage.contentDialog.calls'),
            dateRange: t('tokenUsage.contentDialog.dateRange'),
            tokenComposition: t('tokenUsage.contentDialog.tokenComposition'),
            modelBreakdown: t('tokenUsage.contentDialog.modelBreakdown'),
            providerBreakdown: t('tokenUsage.contentDialog.providerBreakdown'),
            callTimeline: t('tokenUsage.contentDialog.callTimeline'),
            contentExcerpts: t('tokenUsage.contentDialog.contentExcerpts'),
            noContent: t('tokenUsage.contentDialog.noContent'),
            assistant: t('tokenUsage.contentDialog.assistant'),
            toolResult: t('tokenUsage.contentDialog.toolResult'),
            input: t('tokenUsage.metrics.input'),
            output: t('tokenUsage.metrics.output'),
            cacheRead: t('tokenUsage.metrics.cacheRead'),
            cacheWrite: t('tokenUsage.metrics.cacheWrite'),
            statusAvailable: t('tokenUsage.contentDialog.statusAvailable'),
            statusMissing: t('tokenUsage.contentDialog.statusMissing'),
            statusError: t('tokenUsage.contentDialog.statusError'),
            sessionMeta: t('tokenUsage.contentDialog.sessionMeta'),
            entries: t('tokenUsage.metrics.entries'),
            systemPromptBreakdown: t('tokenUsage.contentDialog.systemPromptBreakdown'),
            systemPromptShare: t('tokenUsage.contentDialog.systemPromptShare'),
            estimatedContext: t('tokenUsage.contentDialog.estimatedContext'),
            estimatedTokens: t('tokenUsage.contentDialog.estimatedTokens'),
            noContextData: t('tokenUsage.contentDialog.noContextData'),
            system: t('tokenUsage.contentDialog.system'),
            systemShort: t('tokenUsage.contentDialog.systemShort'),
            skills: t('tokenUsage.contentDialog.skills'),
            tools: t('tokenUsage.contentDialog.tools'),
            files: t('tokenUsage.contentDialog.files'),
            ofInput: t('tokenUsage.contentDialog.ofInput'),
            baseContextPerMessage: t('tokenUsage.contentDialog.baseContextPerMessage'),
            sessionOverview: t('tokenUsage.contentDialog.sessionOverview'),
            messages: t('tokenUsage.contentDialog.messages'),
            userMessages: t('tokenUsage.contentDialog.userMessages'),
            assistantMessages: t('tokenUsage.contentDialog.assistantMessages'),
            toolCalls: t('tokenUsage.contentDialog.toolCalls'),
            toolResults: t('tokenUsage.contentDialog.toolResults'),
            errors: t('tokenUsage.contentDialog.errors'),
            duration: t('tokenUsage.contentDialog.duration'),
            cacheHitRate: t('tokenUsage.contentDialog.cacheHitRate'),
            sessionLabel: t('tokenUsage.contentDialog.sessionLabel'),
            sessionKey: t('tokenUsage.contentDialog.sessionKey'),
            channel: t('tokenUsage.contentDialog.channel'),
            chatType: t('tokenUsage.contentDialog.chatType'),
            status: t('tokenUsage.contentDialog.status'),
            started: t('tokenUsage.contentDialog.started'),
            updated: t('tokenUsage.contentDialog.updated'),
            ended: t('tokenUsage.contentDialog.ended'),
            runtime: t('tokenUsage.contentDialog.runtime'),
            familySessions: t('tokenUsage.contentDialog.familySessions'),
            modelOverride: t('tokenUsage.contentDialog.modelOverride'),
            providerOverride: t('tokenUsage.contentDialog.providerOverride'),
            costBreakdown: t('tokenUsage.contentDialog.costBreakdown'),
            inputCost: t('tokenUsage.contentDialog.inputCost'),
            outputCost: t('tokenUsage.contentDialog.outputCost'),
            cacheReadCost: t('tokenUsage.contentDialog.cacheReadCost'),
            cacheWriteCost: t('tokenUsage.contentDialog.cacheWriteCost'),
            averageTokens: t('tokenUsage.contentDialog.averageTokens'),
            averageCost: t('tokenUsage.contentDialog.averageCost'),
            topTools: t('tokenUsage.contentDialog.topTools'),
            noToolCalls: t('tokenUsage.contentDialog.noToolCalls'),
            content: t('tokenUsage.contentDialog.content'),
            noCallContent: t('tokenUsage.contentDialog.noCallContent'),
            missingValue: t('tokenUsage.contentDialog.missingValue'),
          }}
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
      value: totals.knownTokenEntries > 0 ? formatCompactNumber(totals.totalTokens) : labels.unknown,
      detail: totals.knownTokenEntries > 0 ? labels.rawTokensDetail : labels.unknown,
      icon: Sigma,
      className: 'from-cyan-500/18 via-blue-500/10 to-transparent',
    },
    {
      key: 'cost',
      label: labels.cost,
      value: totals.knownCostEntries > 0 ? formatUsd(totals.costUsd) : labels.unknown,
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
  labels,
}: {
  groups: UsageGroup[];
  title: string;
  subtitle: string;
  emptyLabel: string;
  labels: Record<string, string>;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 720;
  const height = 260;
  const padding = { top: 22, right: 26, bottom: 38, left: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);
  const yBase = padding.top + chartHeight;
  const points = groups.map((group, index) => {
    const x = groups.length === 1
      ? padding.left + chartWidth / 2
      : padding.left + (index / Math.max(groups.length - 1, 1)) * chartWidth;
    const y = padding.top + chartHeight - (group.totalTokens / maxTokens) * chartHeight;
    return { x, y, group };
  });
  const linePath = points.length === 0
    ? ''
    : points.length === 1
      ? `M ${points[0].x} ${points[0].y}`
      : points.reduce((path, point, index) => {
        if (index === 0) return `M ${point.x} ${point.y}`;
        const previous = points[index - 1];
        const controlX = (previous.x + point.x) / 2;
        return `${path} C ${controlX} ${previous.y}, ${controlX} ${point.y}, ${point.x} ${point.y}`;
      }, '');
  const areaPath = points.length === 0
    ? ''
    : points.length === 1
      ? `M ${points[0].x} ${points[0].y} L ${points[0].x} ${yBase} Z`
      : `${linePath} L ${points[points.length - 1].x} ${yBase} L ${points[0].x} ${yBase} Z`;
  const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex];
  const tooltipAlignClass = hoveredIndex === 0
    ? 'translate-x-0'
    : hoveredIndex === points.length - 1
      ? '-translate-x-full'
      : '-translate-x-1/2';
  const tooltipVerticalClass = hoveredPoint && hoveredPoint.y < 92
    ? 'translate-y-3'
    : '-translate-y-[calc(100%+10px)]';

  return (
    <div
      className="rounded-lg border border-border/65 bg-surface-modal/90 p-5 shadow-sm shadow-black/5 dark:shadow-black/20"
      data-testid="token-usage-trend-chart"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-meta text-muted-foreground">{subtitle}</p>
        </div>
        <TrendingUp className="h-5 w-5 text-muted-foreground" />
      </div>
      {groups.length === 0 ? (
        <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border/60 text-meta text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="relative" onMouseLeave={() => setHoveredIndex(null)}>
          <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full overflow-visible" role="img" aria-label={title}>
            <defs>
              <linearGradient id="usageTrendAreaGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--usage-input))" stopOpacity="0.22" />
                <stop offset="58%" stopColor="hsl(var(--usage-input))" stopOpacity="0.08" />
                <stop offset="100%" stopColor="hsl(var(--usage-input))" stopOpacity="0.01" />
              </linearGradient>
              <linearGradient id="usageTrendLineGradient" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="hsl(var(--usage-input))" stopOpacity="0.74" />
                <stop offset="48%" stopColor="hsl(var(--usage-input))" stopOpacity="0.96" />
                <stop offset="100%" stopColor="hsl(var(--usage-input))" stopOpacity="0.78" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
              const y = padding.top + chartHeight - chartHeight * tick;
              const tickValue = Math.round(maxTokens * tick);
              return (
                <g key={tick}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                    stroke="hsl(var(--border))"
                    strokeOpacity="0.36"
                  />
                  {(tick === 0 || tick === 1) && (
                    <text
                      x={padding.left}
                      y={y - 6}
                      fill="hsl(var(--muted-foreground))"
                      fontSize="10"
                    >
                      {formatCompactNumber(tickValue)}
                    </text>
                  )}
                </g>
              );
            })}
            <path d={areaPath} fill="url(#usageTrendAreaGradient)" />
            <path
              d={linePath}
              fill="none"
              stroke="url(#usageTrendLineGradient)"
              strokeWidth="2.75"
              strokeLinecap="round"
            />
            {hoveredPoint && (
              <g>
                <line
                  x1={hoveredPoint.x}
                  x2={hoveredPoint.x}
                  y1={padding.top}
                  y2={yBase}
                  stroke="hsl(var(--usage-input))"
                  strokeDasharray="4 5"
                  strokeOpacity="0.48"
                />
                <circle
                  cx={hoveredPoint.x}
                  cy={hoveredPoint.y}
                  r="7"
                  fill="hsl(var(--background))"
                  stroke="hsl(var(--usage-input))"
                  strokeWidth="3"
                />
                <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="3.5" fill="hsl(var(--usage-input))" />
              </g>
            )}
            {points.map((point, index) => {
              const hotspotWidth = groups.length === 1 ? chartWidth : chartWidth / Math.max(groups.length - 1, 1);
              const hotspotX = groups.length === 1
                ? padding.left
                : Math.max(padding.left, point.x - hotspotWidth / 2);
              const boundedWidth = groups.length === 1
                ? chartWidth
                : Math.min(hotspotWidth, width - padding.right - hotspotX);
              return (
                <g key={`${point.group.label}-${index}`}>
                  <rect
                    x={hotspotX}
                    y={padding.top}
                    width={boundedWidth}
                    height={chartHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoveredIndex(index)}
                    onFocus={() => setHoveredIndex(index)}
                    tabIndex={0}
                    data-testid="token-usage-trend-hotspot"
                    data-day={point.group.label}
                  />
                  <text
                    x={point.x}
                    y={height - 14}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize="11"
                  >
                    {groups.length <= 12 || index % Math.ceil(groups.length / 8) === 0 ? point.group.label : ''}
                  </text>
                </g>
              );
            })}
          </svg>
          {hoveredPoint && (
            <div
              data-testid="token-usage-trend-tooltip"
              className={cn(
                'pointer-events-none absolute z-10 w-56 rounded-lg border border-border/70 bg-background/95 p-3 shadow-xl shadow-black/10 backdrop-blur dark:shadow-black/35',
                tooltipAlignClass,
                tooltipVerticalClass,
              )}
              style={{
                left: `${(hoveredPoint.x / width) * 100}%`,
                top: `${(hoveredPoint.y / height) * 100}%`,
              }}
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-foreground">{hoveredPoint.group.label}</p>
                <p className="text-meta font-semibold text-usage-input">
                  {hoveredPoint.group.count > hoveredPoint.group.unknownTokenEntries
                    ? formatCompactNumber(hoveredPoint.group.totalTokens)
                    : labels.unknown}
                </p>
              </div>
              <div className="space-y-1.5 text-tiny font-medium text-muted-foreground">
                <div className="flex justify-between gap-3">
                  <span>{labels.total}</span>
                  <span className="text-foreground">
                    {hoveredPoint.group.count > hoveredPoint.group.unknownTokenEntries
                      ? formatTokenCount(hoveredPoint.group.totalTokens)
                      : labels.unknown}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>{labels.input}</span>
                  <span className="text-foreground">{formatTokenCount(hoveredPoint.group.inputTokens)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>{labels.output}</span>
                  <span className="text-foreground">{formatTokenCount(hoveredPoint.group.outputTokens)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>{labels.cache}</span>
                  <span className="text-foreground">{formatTokenCount(hoveredPoint.group.cacheTokens)}</span>
                </div>
                <div className="flex justify-between gap-3 border-t border-border/55 pt-1.5">
                  <span>{labels.cost}</span>
                  <span className="text-foreground">
                    {hoveredPoint.group.count > hoveredPoint.group.unknownCostEntries
                      ? formatUsd(hoveredPoint.group.costUsd)
                      : labels.unknown}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
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
                  {totalLabel}: {group.count > group.unknownTokenEntries ? formatCompactNumber(group.totalTokens) : unknownLabel}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-surface-input/75">
                <div
                  data-testid="token-usage-group-bar"
                  className="h-full rounded-full"
                  style={{
                    width: `${width}%`,
                    backgroundImage: MONOTONE_USAGE_BAR_BACKGROUND,
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-tiny font-medium text-muted-foreground">
                <span>{countLabel}: {formatTokenCount(group.count)}</span>
                <span>{costLabel}: {group.count > group.unknownCostEntries ? formatUsd(group.costUsd) : unknownLabel}</span>
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

function UsageSessionList({
  sessions,
  page,
  totalPages,
  onPrev,
  onNext,
  onSelect,
  labels,
}: {
  sessions: UsageSessionSummary[];
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (session: UsageSessionSummary) => void;
  labels: Record<string, string>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{labels.title}</p>
        <p className="text-meta font-medium text-muted-foreground">{labels.page}</p>
      </div>
      <div className="space-y-2.5">
        {sessions.map((session) => {
          const modelLabel = session.models.length > 1
            ? `${session.model || labels.unknown} +${session.models.length - 1}`
            : session.model || labels.unknown;
          const sourceLine = [
            formatUsageSource(session.provider),
            formatUsageSource(session.agentId),
            session.sessionId,
          ].filter(Boolean).join(' - ');
          const hasIssue = session.missingEntries > 0 || session.errorEntries > 0;

          return (
            <div
              key={session.id}
              data-testid="token-usage-entry"
              className="rounded-lg border border-border/65 bg-surface-modal/90 p-4 shadow-sm shadow-black/5 transition-colors hover:border-ring/45 hover:bg-surface-modal dark:shadow-black/20"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-semibold text-foreground">{modelLabel}</p>
                    {session.models.length > 1 && (
                      <span className="rounded-md bg-black/5 px-2 py-0.5 text-tiny font-medium text-muted-foreground dark:bg-white/10">
                        {labels.mixedModels}
                      </span>
                    )}
                    {hasIssue && (
                      <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-tiny font-medium text-amber-700 dark:text-amber-400">
                        {session.errorEntries > 0 ? labels.usageParseError : labels.noUsage}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-meta text-muted-foreground">{sourceLine}</p>
                  <SessionTokenBar session={session} className="mt-3" />
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-meta font-medium text-muted-foreground">
                    <span>{labels.input}: {formatSessionTokenField(session, 'inputTokens', labels.unknown)}</span>
                    <span>{labels.output}: {formatSessionTokenField(session, 'outputTokens', labels.unknown)}</span>
                    <span>{labels.cacheRead}: {formatSessionTokenField(session, 'cacheReadTokens', labels.unknown)}</span>
                    <span>{labels.cacheWrite}: {formatSessionTokenField(session, 'cacheWriteTokens', labels.unknown)}</span>
                    <span>{labels.calls}: {formatTokenCount(session.entries.length)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-end justify-between gap-4 lg:flex-col lg:items-end">
                  <div className="text-left lg:text-right">
                    <p className="text-base font-semibold text-foreground" data-testid="token-usage-session-total">
                      {formatSessionTokenField(session, 'totalTokens', labels.unknown)}
                    </p>
                    <p className="mt-0.5 text-tiny text-muted-foreground">
                      {labels.updated}: {formatUsageTimestamp(session.lastTimestamp)}
                    </p>
                    <p className="mt-1 text-tiny font-medium text-muted-foreground" data-testid="token-usage-session-cost">
                      {labels.cost}: {formatSessionUsdCost(session, labels.unknown)}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg px-3 text-meta"
                    onClick={() => onSelect(session)}
                    data-testid="token-usage-session-details"
                  >
                    <Info className="mr-1.5 h-3.5 w-3.5" />
                    {labels.viewDetails}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
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

function SessionTokenBar({ session, className }: { session: UsageSessionSummary; className?: string }) {
  const total = Math.max(session.totalTokens, 1);
  const segments = [
    { key: 'output', value: session.outputTokens, className: 'bg-usage-output' },
    { key: 'input', value: session.inputTokens, className: 'bg-usage-input' },
    { key: 'cacheWrite', value: session.cacheWriteTokens, className: 'bg-indigo-500' },
    { key: 'cacheRead', value: session.cacheReadTokens, className: 'bg-usage-cache' },
  ];

  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-surface-input/75', className)}>
      <div className="flex h-full">
        {segments.map((segment) => (
          segment.value > 0 ? (
            <div
              key={segment.key}
              className={segment.className}
              style={{ width: `${Math.max((segment.value / total) * 100, 2)}%` }}
            />
          ) : null
        ))}
      </div>
    </div>
  );
}

function UsageSessionDetailDialog({
  session,
  onClose,
  title,
  closeLabel,
  labels,
}: {
  session: UsageSessionSummary;
  onClose: () => void;
  title: string;
  closeLabel: string;
  labels: Record<string, string>;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const dateRange = session.firstTimestamp === session.lastTimestamp
    ? formatUsageTimestamp(session.lastTimestamp)
    : `${formatUsageTimestamp(session.firstTimestamp)} - ${formatUsageTimestamp(session.lastTimestamp)}`;
  const messageCount = session.messageCounts?.total ?? session.entries.length;
  const toolCalls = session.toolUsage?.totalCalls ?? 0;
  const averageTokens = session.entries.length > 0 ? session.totalTokens / session.entries.length : 0;
  const averageCost = session.entries.length > 0 ? session.costUsd / session.entries.length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-usage-session-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-testid="token-usage-session-dialog"
        className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-border/80 bg-background shadow-2xl shadow-black/20"
      >
        <div className="border-b border-border/70 bg-surface-modal/80 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id="token-usage-session-dialog-title" className="text-base font-semibold text-foreground">{title}</p>
              <p className="mt-1 truncate text-meta text-muted-foreground">
                {[
                  session.sessionMeta?.label,
                  session.model || labels.unknown,
                  session.provider || labels.unknown,
                  session.agentId,
                ].filter(Boolean).join(' - ')}
              </p>
              <p className="mt-0.5 truncate text-tiny text-muted-foreground">{session.sessionId}</p>
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
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DetailMetricCard
              icon={Sigma}
              label={labels.totalTokens}
              value={formatSessionTokenField(session, 'totalTokens', labels.unknown)}
              detail={`${labels.averageTokens}: ${session.unknownTokenEntries < session.entries.length ? formatTokenCount(averageTokens) : labels.unknown}`}
              className="from-cyan-500/18 via-blue-500/10 to-transparent"
            />
            <DetailMetricCard
              icon={Coins}
              label={labels.cost}
              value={formatSessionUsdCost(session, labels.unknown)}
              detail={`${labels.averageCost}: ${session.unknownCostEntries < session.entries.length ? formatUsd(averageCost) : labels.unknown}`}
              className="from-emerald-500/18 via-teal-500/10 to-transparent"
            />
            <DetailMetricCard
              icon={MessageSquare}
              label={labels.messages}
              value={formatTokenCount(messageCount)}
              detail={`${labels.calls}: ${formatTokenCount(session.availableEntries)}`}
              className="from-violet-500/16 via-fuchsia-500/10 to-transparent"
            />
            <DetailMetricCard
              icon={Cpu}
              label={labels.toolCalls}
              value={formatTokenCount(toolCalls)}
              detail={session.toolUsage?.tools.slice(0, 2).map((tool) => tool.name).join(' - ') || labels.noToolCalls}
              className="from-amber-500/18 via-orange-500/10 to-transparent"
            />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="min-w-0 space-y-4">
              <TokenCompositionDetail session={session} title={labels.tokenComposition} labels={labels} />
              <UsageCallTimeline session={session} labels={labels} />
            </div>
            <div className="min-w-0 space-y-4">
              <SessionOverviewPanel session={session} labels={labels} dateRange={dateRange} />
              <ContextWeightDetail session={session} labels={labels} />
              <CostBreakdownPanel session={session} labels={labels} />
              <UsageBreakdownPanel title={labels.modelBreakdown} items={session.models} />
              <UsageBreakdownPanel title={labels.providerBreakdown} items={session.providers} />
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-border/70 bg-surface-modal/75 px-5 py-3">
          <Button variant="outline" className="h-9 rounded-lg" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailMetricCard({
  icon: Icon,
  label,
  value,
  detail,
  className,
}: {
  icon: typeof Sigma;
  label: string;
  value: string;
  detail: string;
  className: string;
}) {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-surface-modal/90 bg-gradient-to-br p-4 shadow-sm shadow-black/5', className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="truncate text-meta font-medium text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="truncate text-xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 truncate text-tiny font-medium text-muted-foreground">{detail}</p>
    </div>
  );
}

function getSessionDurationMs(session: UsageSessionSummary): number | undefined {
  if (session.sessionMeta?.runtimeMs !== undefined) return session.sessionMeta.runtimeMs;
  const start = Date.parse(session.firstTimestamp);
  const end = Date.parse(session.lastTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function SessionOverviewPanel({
  session,
  labels,
  dateRange,
}: {
  session: UsageSessionSummary;
  labels: Record<string, string>;
  dateRange: string;
}) {
  const meta = session.sessionMeta;
  const messageCounts = session.messageCounts;
  const toolUsage = session.toolUsage;
  const durationMs = getSessionDurationMs(session);
  const inputBasis = session.inputTokens + session.cacheReadTokens + session.cacheWriteTokens;
  const cacheHitRate = inputBasis > 0 ? (session.cacheReadTokens / inputBasis) * 100 : undefined;
  const fields = [
    { label: labels.sessionLabel, value: meta?.label },
    { label: labels.sessionKey, value: meta?.key },
    { label: labels.channel, value: meta?.channel },
    { label: labels.chatType, value: meta?.chatType },
    { label: labels.status, value: meta?.status },
    { label: labels.modelOverride, value: meta?.modelOverride ?? meta?.modelProvider },
    { label: labels.providerOverride, value: meta?.providerOverride ?? meta?.originProvider },
    { label: labels.familySessions, value: meta?.includedSessionIds?.length ? formatTokenCount(meta.includedSessionIds.length) : undefined },
  ].filter((field) => field.value);
  const timeFields = [
    { label: labels.dateRange, value: dateRange },
    { label: labels.started, value: formatUsageTimestampMs(meta?.startedAt, labels.missingValue) },
    { label: labels.updated, value: formatUsageTimestampMs(meta?.updatedAt, labels.missingValue) },
    { label: labels.ended, value: formatUsageTimestampMs(meta?.endedAt, labels.missingValue) },
  ];

  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/80 p-4">
      <div className="mb-4 flex items-center gap-2">
        <Info className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{labels.sessionOverview}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label={labels.messages} value={formatTokenCount(messageCounts?.total ?? session.entries.length)} detail={`${formatTokenCount(messageCounts?.user ?? 0)} ${labels.userMessages}`} />
        <MiniStat label={labels.toolCalls} value={formatTokenCount(toolUsage?.totalCalls ?? 0)} detail={`${formatTokenCount(toolUsage?.uniqueTools ?? 0)} ${labels.tools}`} />
        <MiniStat label={labels.errors} value={formatTokenCount(messageCounts?.errors ?? 0)} detail={`${formatTokenCount(messageCounts?.toolResults ?? 0)} ${labels.toolResults}`} />
        <MiniStat label={labels.cacheHitRate} value={cacheHitRate === undefined ? labels.missingValue : formatPercent(cacheHitRate)} detail={formatDurationMs(durationMs, labels.missingValue)} />
      </div>

      {fields.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {fields.map((field) => (
            <span key={field.label} className="max-w-full rounded-md border border-border/50 bg-background/55 px-2.5 py-1 text-tiny font-medium text-muted-foreground">
              <span className="text-foreground">{field.label}</span>: {field.value}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
        {timeFields.map((field) => (
          <div key={field.label} className="flex items-center justify-between gap-3 text-tiny">
            <span className="text-muted-foreground">{field.label}</span>
            <span className="min-w-0 truncate text-right font-medium text-foreground">{field.value}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-tiny font-semibold uppercase text-muted-foreground">{labels.topTools}</p>
          <p className="text-tiny text-muted-foreground">{formatTokenCount(toolUsage?.totalCalls ?? 0)}</p>
        </div>
        {toolUsage && toolUsage.tools.length > 0 ? (
          <div className="space-y-2">
            {toolUsage.tools.slice(0, 5).map((tool) => (
              <div key={tool.name} className="flex items-center justify-between gap-3 text-tiny">
                <span className="min-w-0 truncate font-mono text-muted-foreground" title={tool.name}>{tool.name}</span>
                <span className="shrink-0 font-semibold text-foreground">{formatTokenCount(tool.count)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-meta text-muted-foreground">{labels.noToolCalls}</p>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
      <p className="text-tiny font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 truncate text-tiny text-muted-foreground">{detail}</p>
    </div>
  );
}

function TokenCompositionDetail({
  session,
  title,
  labels,
}: {
  session: UsageSessionSummary;
  title: string;
  labels: Record<string, string>;
}) {
  const rows = [
    { key: 'output', label: labels.output, value: session.outputTokens, className: 'bg-usage-output' },
    { key: 'input', label: labels.input, value: session.inputTokens, className: 'bg-usage-input' },
    { key: 'cacheWrite', label: labels.cacheWrite, value: session.cacheWriteTokens, className: 'bg-indigo-500' },
    { key: 'cacheRead', label: labels.cacheRead, value: session.cacheReadTokens, className: 'bg-usage-cache' },
  ];

  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/80 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-meta font-semibold text-muted-foreground">{formatTokenCount(session.totalTokens)}</p>
      </div>
      <SessionTokenBar session={session} className="h-3" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="rounded-lg border border-border/50 bg-background/50 p-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-meta">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className={cn('h-2.5 w-2.5 rounded-full', row.className)} />
                {row.label}
              </span>
              <span className="font-semibold text-foreground">{formatTokenCount(row.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-input/70">
              <div
                className={cn('h-full rounded-full', row.className)}
                style={{ width: `${row.value > 0 ? Math.max((row.value / Math.max(session.totalTokens, 1)) * 100, 2) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageBreakdownPanel({ title, items }: { title: string; items: UsageSessionBreakdownItem[] }) {
  const maxTokens = Math.max(...items.map((item) => item.totalTokens), 1);
  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/80 p-4">
      <p className="mb-3 text-sm font-semibold text-foreground">{title}</p>
      <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
        {items.map((item) => (
          <div key={item.label} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-meta">
              <span className="truncate font-medium text-foreground">{item.label}</span>
              <span className="shrink-0 font-semibold text-muted-foreground">{formatCompactNumber(item.totalTokens)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-input/70">
              <div
                data-testid="token-usage-breakdown-bar"
                className="h-full rounded-full"
                style={{
                  width: `${item.totalTokens > 0 ? Math.max((item.totalTokens / maxTokens) * 100, 4) : 0}%`,
                  backgroundImage: MONOTONE_USAGE_BAR_BACKGROUND,
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-tiny font-medium text-muted-foreground">
              <span>{formatTokenCount(item.count)}</span>
              <span>{formatUsd(item.costUsd)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CostBreakdownPanel({
  session,
  labels,
}: {
  session: UsageSessionSummary;
  labels: Record<string, string>;
}) {
  const rows = [
    { key: 'output', label: labels.outputCost, value: session.outputCostUsd, className: 'bg-usage-output' },
    { key: 'input', label: labels.inputCost, value: session.inputCostUsd, className: 'bg-usage-input' },
    { key: 'cacheWrite', label: labels.cacheWriteCost, value: session.cacheWriteCostUsd, className: 'bg-indigo-500' },
    { key: 'cacheRead', label: labels.cacheReadCost, value: session.cacheReadCostUsd, className: 'bg-usage-cache' },
  ];
  const hasCostParts = rows.some((row) => row.value > 0);
  if (!hasCostParts && session.costUsd <= 0) return null;

  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/80 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{labels.costBreakdown}</p>
        <p className="text-meta font-semibold text-muted-foreground">{formatUsd(session.costUsd)}</p>
      </div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-tiny">
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', row.className)} />
                <span className="truncate">{row.label}</span>
              </span>
              <span className="shrink-0 font-semibold text-foreground">{formatUsd(row.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-input/70">
              <div
                className={cn('h-full rounded-full', row.className)}
                style={{ width: `${row.value > 0 ? Math.max((row.value / Math.max(session.costUsd, 0.000001)) * 100, 2) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildConicGradient(segments: Array<{ value: number; color: string }>): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return 'hsl(var(--muted) / 0.35) 0 100%';
  let cursor = 0;
  return segments.map((segment) => {
    const start = cursor;
    cursor += (segment.value / total) * 100;
    return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  }).join(', ');
}

function ContextWeightDetail({
  session,
  labels,
}: {
  session: UsageSessionSummary;
  labels: Record<string, string>;
}) {
  const contextWeight = session.contextWeight;
  if (!contextWeight) {
    return (
      <div
        data-testid="token-usage-context-breakdown"
        className="rounded-lg border border-border/65 bg-surface-modal/80 p-4"
      >
        <div className="mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold text-foreground">{labels.systemPromptBreakdown}</p>
        </div>
        <div className="rounded-lg border border-dashed border-border/60 bg-surface-input/55 px-4 py-8 text-center text-meta text-muted-foreground">
          {labels.noContextData}
        </div>
      </div>
    );
  }

  const systemChars = contextWeight.systemPrompt.chars;
  const skillsChars = contextWeight.skills.promptChars;
  const toolsChars = contextWeight.tools.listChars + contextWeight.tools.schemaChars;
  const filesChars = contextWeight.injectedWorkspaceFiles.reduce((sum, entry) => sum + (entry.injectedChars ?? 0), 0);
  const systemTokens = estimateContextTokens(systemChars);
  const skillsTokens = estimateContextTokens(skillsChars);
  const toolsTokens = estimateContextTokens(toolsChars);
  const filesTokens = estimateContextTokens(filesChars);
  const totalContextTokens = Math.max(systemTokens + skillsTokens + toolsTokens + filesTokens, 0);
  const inputBasis = session.inputTokens + session.cacheReadTokens;
  const inputShare = inputBasis > 0 ? Math.min((totalContextTokens / inputBasis) * 100, 100) : undefined;
  const systemShare = totalContextTokens > 0 ? (systemTokens / totalContextTokens) * 100 : 0;
  const segments = [
    { key: 'system', label: labels.systemShort, value: systemTokens, color: 'hsl(var(--usage-input))', className: 'bg-usage-input' },
    { key: 'skills', label: labels.skills, value: skillsTokens, color: 'hsl(var(--usage-output))', className: 'bg-usage-output' },
    { key: 'tools', label: labels.tools, value: toolsTokens, color: 'rgb(99 102 241)', className: 'bg-indigo-500' },
    { key: 'files', label: labels.files, value: filesTokens, color: 'hsl(var(--usage-cache))', className: 'bg-usage-cache' },
  ];
  const contextShareText = inputShare !== undefined
    ? `~${formatPercent(inputShare)} ${labels.ofInput}`
    : labels.baseContextPerMessage;

  return (
    <div
      data-testid="token-usage-context-breakdown"
      className="rounded-lg border border-border/65 bg-surface-modal/80 p-4"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">{labels.systemPromptBreakdown}</p>
          </div>
          <p className="mt-1 text-meta text-muted-foreground">{contextShareText}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold text-foreground">~{formatTokenCount(totalContextTokens)}</p>
          <p className="text-tiny text-muted-foreground">{labels.estimatedTokens}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[132px_minmax(0,1fr)]">
        <div className="relative mx-auto h-32 w-32 rounded-full border border-border/60 p-2">
          <div
            data-testid="token-usage-context-pie"
            className="h-full w-full rounded-full"
            style={{ background: `conic-gradient(${buildConicGradient(segments)})` }}
            role="img"
            aria-label={`${labels.systemPromptShare}: ${formatPercent(systemShare)}`}
          />
          <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full border border-border/55 bg-background text-center">
            <span className="text-lg font-semibold text-foreground">{formatPercent(systemShare)}</span>
            <span className="mt-0.5 text-[10px] font-medium text-muted-foreground">{labels.systemShort}</span>
          </div>
        </div>
        <div className="grid content-center gap-2">
          {segments.map((segment) => (
            <div key={segment.key} className="rounded-lg border border-border/50 bg-background/50 p-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2 text-meta font-medium text-muted-foreground">
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', segment.className)} />
                  <span className="truncate">{segment.label}</span>
                </span>
                <span className="shrink-0 text-meta font-semibold text-foreground">
                  {formatPercent(totalContextTokens > 0 ? (segment.value / totalContextTokens) * 100 : 0)}
                </span>
              </div>
              <p className="mt-1 text-tiny font-medium text-muted-foreground">~{formatTokenCount(segment.value)}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <ContextEntryList
          title={`${labels.skills} (${contextWeight.skills.entries.length})`}
          entries={contextWeight.skills.entries}
          getChars={(entry) => entry.blockChars ?? 0}
        />
        <ContextEntryList
          title={`${labels.tools} (${contextWeight.tools.entries.length})`}
          entries={contextWeight.tools.entries}
          getChars={(entry) => (entry.summaryChars ?? 0) + (entry.schemaChars ?? 0)}
        />
        <ContextEntryList
          title={`${labels.files} (${contextWeight.injectedWorkspaceFiles.length})`}
          entries={contextWeight.injectedWorkspaceFiles}
          getChars={(entry) => entry.injectedChars ?? 0}
        />
      </div>
    </div>
  );
}

function ContextEntryList({
  title,
  entries,
  getChars,
}: {
  title: string;
  entries: UsageContextWeightEntry[];
  getChars: (entry: UsageContextWeightEntry) => number;
}) {
  const sortedEntries = [...entries]
    .sort((a, b) => getChars(b) - getChars(a))
    .slice(0, 4);

  if (sortedEntries.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
      <p className="mb-2 text-meta font-semibold text-foreground">{title}</p>
      <div className="space-y-2">
        {sortedEntries.map((entry) => (
          <div key={entry.name} className="flex items-center justify-between gap-3 text-tiny">
            <span className="min-w-0 truncate font-mono text-muted-foreground" title={entry.name}>
              {entry.name}
            </span>
            <span className="shrink-0 font-semibold text-foreground">
              ~{formatTokenCount(estimateContextTokens(getChars(entry)))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageCallTimeline({
  session,
  labels,
}: {
  session: UsageSessionSummary;
  labels: Record<string, string>;
}) {
  return (
    <div className="rounded-lg border border-border/65 bg-surface-modal/80 p-4">
      <div className="mb-3 flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-semibold text-foreground">{labels.callTimeline}</p>
      </div>
      <div className="space-y-3">
        {session.entries.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${index}`}
            data-testid="token-usage-call-row"
            className="rounded-lg border border-border/55 bg-background/55 p-3"
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="rounded-md bg-black/5 px-2 py-0.5 text-tiny font-medium text-foreground dark:bg-white/10">
                    {getUsageRecordKindLabel(entry, labels)}
                  </span>
                  <span className={cn('rounded-md px-2 py-0.5 text-tiny font-medium', getUsageStatusClass(entry.usageStatus))}>
                    {getUsageStatusLabel(entry, labels)}
                  </span>
                  <span className="text-tiny text-muted-foreground">{formatUsageTimestamp(entry.timestamp)}</span>
                </div>
                <p className="mt-2 truncate text-sm font-semibold text-foreground">{entry.model || labels.unknown}</p>
                <p className="mt-0.5 truncate text-meta text-muted-foreground">{entry.provider || labels.unknown}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-right text-tiny font-medium text-muted-foreground sm:grid-cols-3 xl:min-w-[430px]">
                <span>{labels.totalTokens}: <b className="font-semibold text-foreground">{formatKnownNumber(entry.totalTokens, labels.unknown)}</b></span>
                <span>{labels.cost}: <b className="font-semibold text-foreground">{formatEntryCost(entry, labels.unknown)}</b></span>
                <span>{labels.input}: <b className="font-semibold text-foreground">{formatKnownNumber(entry.inputTokens, labels.unknown)}</b></span>
                <span>{labels.output}: <b className="font-semibold text-foreground">{formatKnownNumber(entry.outputTokens, labels.unknown)}</b></span>
                <span>{labels.cacheRead}: <b className="font-semibold text-foreground">{formatKnownNumber(entry.cacheReadTokens, labels.unknown)}</b></span>
                <span>{labels.cacheWrite}: <b className="font-semibold text-foreground">{formatKnownNumber(entry.cacheWriteTokens, labels.unknown)}</b></span>
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-border/45 bg-surface-input/45 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-tiny font-semibold uppercase text-muted-foreground">{labels.content}</span>
                <span className="text-tiny text-muted-foreground">{formatUsageTimestamp(entry.timestamp)}</span>
              </div>
              {entry.content ? (
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-foreground">
                  {entry.content}
                </pre>
              ) : (
                <p className="text-meta text-muted-foreground">{labels.noCallContent}</p>
              )}
            </div>
            {(entry.inputCostUsd || entry.outputCostUsd || entry.cacheReadCostUsd || entry.cacheWriteCostUsd) && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-tiny text-muted-foreground sm:grid-cols-4">
                <span>{labels.inputCost}: <b className="font-semibold text-foreground">{formatUsd(entry.inputCostUsd ?? 0)}</b></span>
                <span>{labels.outputCost}: <b className="font-semibold text-foreground">{formatUsd(entry.outputCostUsd ?? 0)}</b></span>
                <span>{labels.cacheReadCost}: <b className="font-semibold text-foreground">{formatUsd(entry.cacheReadCostUsd ?? 0)}</b></span>
                <span>{labels.cacheWriteCost}: <b className="font-semibold text-foreground">{formatUsd(entry.cacheWriteCostUsd ?? 0)}</b></span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function getUsageRecordKindLabel(entry: UsageHistoryEntry, labels: Record<string, string>): string {
  return entry.recordKind === 'toolResult' ? labels.toolResult : labels.assistant;
}

function getUsageStatusLabel(entry: UsageHistoryEntry, labels: Record<string, string>): string {
  if (entry.usageStatus === 'missing') return labels.statusMissing;
  if (entry.usageStatus === 'error') return labels.statusError;
  return labels.statusAvailable;
}

function getUsageStatusClass(status: UsageHistoryEntry['usageStatus']): string {
  if (status === 'missing') return 'bg-amber-500/10 text-amber-700 dark:text-amber-400';
  if (status === 'error') return 'bg-red-500/10 text-red-700 dark:text-red-400';
  return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
}

export default TokenUsageSettings;
