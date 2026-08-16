import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Clock,
  Eraser,
  ExternalLink,
  Loader2,
  Moon,
  Power,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApi } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';

type DreamPhaseName = 'light' | 'rem' | 'deep';
type DreamTabKey = 'scene' | 'diary' | 'advanced';

interface DreamPhase {
  enabled?: boolean;
  cron?: string;
  managedCronPresent?: boolean;
  nextRunAtMs?: number;
}

interface DreamMemoryEntry {
  key?: string;
  path?: string;
  snippet?: string;
  startLine?: number;
  endLine?: number;
  recallCount?: number;
  dailyCount?: number;
  groundedCount?: number;
  totalSignalCount?: number;
  phaseHitCount?: number;
  promotedAt?: string;
  lastRecalledAt?: string;
}

interface DreamingStatus {
  enabled?: boolean;
  timezone?: string;
  verboseLogging?: boolean;
  storageMode?: string;
  separateReports?: boolean;
  shortTermCount?: number;
  recallSignalCount?: number;
  dailySignalCount?: number;
  groundedSignalCount?: number;
  totalSignalCount?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  promotedTotal?: number;
  promotedToday?: number;
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
  phaseSignalError?: string;
  shortTermEntries?: DreamMemoryEntry[];
  promotedEntries?: DreamMemoryEntry[];
  phases?: Partial<Record<DreamPhaseName, DreamPhase>>;
}

interface DreamDiaryResponse {
  path?: string;
  found?: boolean;
  content?: string;
}

interface DreamDiaryEntry {
  id: string;
  date: string;
  summary: string;
  lines: string[];
}

interface ConfigSnapshot {
  hash?: string;
}

type DreamActionKey = 'backfill' | 'dedupe' | 'repair' | 'resetDiary' | 'resetGrounded';
type DreamToggleKey = 'enable' | 'disable';

interface RefreshOptions {
  force?: boolean;
}

interface PendingConfirmation {
  action: DreamActionKey;
  title: string;
  message: string;
  destructive?: boolean;
}

const DREAM_ACTION_METHODS: Record<DreamActionKey, string> = {
  backfill: 'doctor.memory.backfillDreamDiary',
  dedupe: 'doctor.memory.dedupeDreamDiary',
  repair: 'doctor.memory.repairDreamingArtifacts',
  resetDiary: 'doctor.memory.resetDreamDiary',
  resetGrounded: 'doctor.memory.resetGroundedShortTerm',
};

const DIARY_START_MARKER = '<!-- openclaw:dreaming:diary:start -->';
const DIARY_END_MARKER = '<!-- openclaw:dreaming:diary:end -->';

const DREAM_PHRASE_KEYS = [
  'phrases.consolidatingMemories',
  'phrases.tidyingKnowledgeGraph',
  'phrases.replayingConversations',
  'phrases.weavingShortTerm',
  'phrases.defragmentingMindPalace',
  'phrases.filingLooseThoughts',
  'phrases.connectingDots',
  'phrases.promotingHunches',
  'phrases.forgettingNoise',
  'phrases.dreamingEmbeddings',
  'phrases.indexingDay',
  'phrases.nurturingInsights',
] as const;

function buildDreamingEnabledPatchRaw(enabled: boolean): string {
  return JSON.stringify({
    plugins: {
      entries: {
        'memory-core': {
          config: {
            dreaming: {
              enabled,
            },
          },
        },
      },
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeDreamingStatus(response: unknown): DreamingStatus | null {
  if (!isRecord(response)) return null;
  const dreaming = response.dreaming;
  if (isRecord(dreaming)) return dreaming as DreamingStatus;
  return response as DreamingStatus;
}

function getDiaryBody(content: string): string {
  const start = content.indexOf(DIARY_START_MARKER);
  const end = content.indexOf(DIARY_END_MARKER);
  if (start >= 0 && end > start) {
    return content.slice(start + DIARY_START_MARKER.length, end);
  }
  return content;
}

function parseDreamDiary(content?: string): DreamDiaryEntry[] {
  if (!content?.trim()) return [];

  return getDiaryBody(content)
    .split(/\n\s*---+\s*\n/g)
    .map((block, index) => {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith('#') && !line.startsWith('<!--'));

      const dateLine = lines.find((line) => /^\*[^*]+\*$/.test(line));
      const date = dateLine?.replace(/^\*/, '').replace(/\*$/, '') || '';
      const cleanLines = lines
        .filter((line) => line !== dateLine)
        .filter((line) => !/^(What Happened|Reflections|Candidates|Possible Lasting Updates)$/i.test(line))
        .map((line) => line.replace(/\[[^\]]+\]/g, '').replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);

      return {
        id: `${date || 'entry'}-${index}`,
        date,
        lines: cleanLines,
        summary: cleanLines.slice(0, 3).join(' '),
      };
    })
    .filter((entry) => entry.summary || entry.lines.length > 0);
}

function formatDateTime(value?: number | string): string {
  if (value == null || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString();
}

function formatPhaseTime(value?: number | string): string {
  if (value == null || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDiaryChip(value: string, fallback: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value || fallback;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function firstNumber(result: unknown, keys: string[]): number | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of keys) {
    const value = asNumber(result[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isMemoryDoctorStartupError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('rpc timeout: doctor.memory.')
    || lower.includes('service not initialized')
    || lower.includes('not yet ready')
    || lower.includes('unavailable during gateway startup');
}

function getNextPhaseRun(dreaming: DreamingStatus | null): number | undefined {
  const candidates = Object.values(dreaming?.phases ?? {})
    .map((phase) => phase?.nextRunAtMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

function getSignalCount(entry: DreamMemoryEntry): number {
  return entry.totalSignalCount ?? entry.phaseHitCount ?? entry.groundedCount ?? entry.recallCount ?? entry.dailyCount ?? 0;
}

function buildSignalSource(entry: DreamMemoryEntry, unknownSource: string): string {
  const base = entry.path || entry.key || unknownSource;
  if (!entry.startLine) return base;
  if (!entry.endLine || entry.endLine === entry.startLine) return `${base}:${entry.startLine}`;
  return `${base}:${entry.startLine}-${entry.endLine}`;
}

export function Dreams() {
  const { t } = useTranslation(['dreams', 'common']);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const rpc = useGatewayStore((state) => state.rpc);

  const [dreaming, setDreaming] = useState<DreamingStatus | null>(null);
  const [diary, setDiary] = useState<DreamDiaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<DreamActionKey | null>(null);
  const [runningToggle, setRunningToggle] = useState<DreamToggleKey | null>(null);
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [openingFullUi, setOpeningFullUi] = useState(false);
  const [activeTab, setActiveTab] = useState<DreamTabKey>('scene');
  const [activeDiaryIndex, setActiveDiaryIndex] = useState(0);
  const [dreamPhraseIndex, setDreamPhraseIndex] = useState(() => Math.floor(Math.random() * DREAM_PHRASE_KEYS.length));
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const gatewayRunning = gatewayStatus.state === 'running';
  const gatewayReady = gatewayStatus.gatewayReady !== false;
  const dreamsReady = gatewayRunning && gatewayReady;
  const busy = runningAction != null || runningToggle != null;
  const actionsDisabled = !dreamsReady || busy;
  const dreamsActive = dreamsReady && dreaming?.enabled === true;

  const diaryEntries = useMemo(() => parseDreamDiary(diary?.content), [diary?.content]);
  const shortTermEntries = useMemo(() => dreaming?.shortTermEntries ?? [], [dreaming?.shortTermEntries]);
  const promotedEntries = useMemo(() => dreaming?.promotedEntries ?? [], [dreaming?.promotedEntries]);
  const groundedEntries = useMemo(
    () => shortTermEntries.filter((entry) => (entry.groundedCount ?? 0) > 0).slice(0, 6),
    [shortTermEntries],
  );
  const recentSignals = useMemo(
    () => [...shortTermEntries, ...promotedEntries].slice(0, 6),
    [promotedEntries, shortTermEntries],
  );
  const nextCycle = useMemo(() => getNextPhaseRun(dreaming), [dreaming]);
  const currentDreamPhrase = t(DREAM_PHRASE_KEYS[dreamPhraseIndex] ?? DREAM_PHRASE_KEYS[0]);

  useEffect(() => {
    if (diaryEntries.length === 0) {
      setActiveDiaryIndex(0);
      return;
    }
    setActiveDiaryIndex((index) => Math.min(index, diaryEntries.length - 1));
  }, [diaryEntries.length]);

  useEffect(() => {
    if (!dreamsActive) return undefined;
    const interval = window.setInterval(() => {
      setDreamPhraseIndex((index) => (index + 1) % DREAM_PHRASE_KEYS.length);
    }, 6000);
    return () => window.clearInterval(interval);
  }, [dreamsActive]);

  const refreshAll = useCallback(async (options?: RefreshOptions) => {
    if (refreshInFlightRef.current && !options?.force) {
      return refreshInFlightRef.current;
    }

    if (!dreamsReady) {
      setLoading(false);
      setError(null);
      return;
    }

    let refreshPromise!: Promise<void>;
    refreshPromise = (async () => {
      setLoading(true);
      setError(null);
      try {
        const [statusResponse, diaryResponse] = await Promise.all([
          rpc<unknown>('doctor.memory.status', {}, 12_000),
          rpc<DreamDiaryResponse>('doctor.memory.dreamDiary', {}, 12_000),
        ]);
        setDreaming(normalizeDreamingStatus(statusResponse));
        setDiary(diaryResponse);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(isMemoryDoctorStartupError(message) ? t('errors.memoryInitializing') : message);
      } finally {
        setLoading(false);
        if (refreshInFlightRef.current === refreshPromise) {
          refreshInFlightRef.current = null;
        }
      }
    })();

    refreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }, [dreamsReady, rpc, t]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const buildActionMessage = useCallback((action: DreamActionKey, result: unknown): string => {
    if (action === 'backfill') {
      const count = firstNumber(result, ['written', 'created', 'count']);
      return t('actions.backfillSuccess', { count: count ?? 0 });
    }
    if (action === 'dedupe') {
      const removed = firstNumber(result, ['removedEntries', 'removed', 'removedCount', 'duplicatesRemoved']);
      const kept = firstNumber(result, ['keptEntries', 'kept', 'keptCount']);
      return t('actions.dedupeSuccess', { removed: removed ?? 0, kept: kept ?? 0 });
    }
    if (action === 'repair') {
      return t('actions.repairSuccess');
    }
    if (action === 'resetDiary') {
      const count = firstNumber(result, ['removedEntries', 'removed', 'removedCount', 'count']);
      return t('actions.resetDiarySuccess', { count: count ?? 0 });
    }
    const count = firstNumber(result, ['removedShortTermEntries', 'cleared', 'removed', 'count']);
    return t('actions.resetGroundedSuccess', { count: count ?? 0 });
  }, [t]);

  const runAction = useCallback(async (action: DreamActionKey) => {
    setRunningAction(action);
    setError(null);
    setLastActionMessage(null);
    try {
      const result = await rpc<unknown>(DREAM_ACTION_METHODS[action], {}, 120_000);
      const message = buildActionMessage(action, result);
      setLastActionMessage(message);
      toast.success(message);
      await refreshAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setRunningAction(null);
      setPendingConfirmation(null);
    }
  }, [buildActionMessage, refreshAll, rpc]);

  const setDreamingEnabled = useCallback(async (enabled: boolean) => {
    const toggleKey: DreamToggleKey = enabled ? 'enable' : 'disable';
    setRunningToggle(toggleKey);
    setError(null);
    setLastActionMessage(null);
    try {
      const snapshot = await rpc<ConfigSnapshot>('config.get', {}, 12_000);
      if (!snapshot.hash) {
        throw new Error(t('errors.configHashMissing'));
      }
      await rpc<unknown>('config.patch', {
        raw: buildDreamingEnabledPatchRaw(enabled),
        baseHash: snapshot.hash,
        note: enabled ? 'Enable memory dreaming from ClawX Dreams.' : 'Disable memory dreaming from ClawX Dreams.',
      }, 30_000);
      const message = enabled ? t('actions.enableSuccess') : t('actions.disableSuccess');
      setDreaming((current) => ({ ...(current ?? {}), enabled }));
      setLastActionMessage(message);
      toast.success(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setRunningToggle(null);
    }
  }, [rpc, t]);

  const requestConfirmation = useCallback((action: DreamActionKey) => {
    setPendingConfirmation({
      action,
      title: t(`confirmations.${action}.title`),
      message: t(`confirmations.${action}.message`),
      destructive: action === 'resetDiary' || action === 'resetGrounded',
    });
  }, [t]);

  const openFullDreams = useCallback(async () => {
    setOpeningFullUi(true);
    setError(null);
    try {
      const result = await hostApi.gateway.controlUi('dreams');
      if (result.success && result.url) {
        await hostApi.shell.openExternal(result.url);
      } else {
        throw new Error(result.error || t('errors.openFullUi'));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(message);
    } finally {
      setOpeningFullUi(false);
    }
  }, [t]);

  const metrics = [
    { label: t('metrics.shortTerm'), value: dreaming?.shortTermCount ?? 0, icon: Archive },
    { label: t('metrics.grounded'), value: dreaming?.groundedSignalCount ?? 0, icon: Sparkles },
    { label: t('metrics.signals'), value: dreaming?.totalSignalCount ?? 0, icon: Moon },
    { label: t('metrics.promotedToday'), value: dreaming?.promotedToday ?? 0, icon: BookOpen },
  ];

  const tabs = [
    { key: 'scene' as const, label: t('tabs.scene'), icon: Moon, badge: dreamsActive ? t('scene.statusActive') : t('scene.statusIdle') },
    { key: 'diary' as const, label: t('tabs.diary'), icon: BookOpen, badge: String(diaryEntries.length) },
    { key: 'advanced' as const, label: t('tabs.advanced'), icon: Sparkles, badge: String(recentSignals.length) },
  ];

  const phases: Array<{ key: DreamPhaseName; label: string }> = [
    { key: 'light', label: t('phases.light') },
    { key: 'rem', label: t('phases.rem') },
    { key: 'deep', label: t('phases.deep') },
  ];

  const activeDiaryEntry = diaryEntries[activeDiaryIndex];

  const renderMascotWidget = () => (
    <div className={cn('clawx-dreams-mascot-widget', !dreamsActive && 'clawx-dreams-mascot-widget-idle')}>
      <div aria-hidden="true" className="clawx-dreams-pulse-ring" />
      <div data-testid="dreams-mascot" role="img" aria-label={t('accessibility.mascot')} className="clawx-dreams-character">
        <svg viewBox="0 0 120 120" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="clawx-dream-character-g" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="hsl(var(--foreground) / 0.9)" />
              <stop offset="100%" stopColor="hsl(var(--muted-foreground) / 0.74)" />
            </linearGradient>
          </defs>
          <path
            d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
            fill="url(#clawx-dream-character-g)"
          />
          <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#clawx-dream-character-g)" />
          <path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#clawx-dream-character-g)" />
          <path d="M45 15Q38 8 35 14" stroke="hsl(var(--foreground) / 0.58)" strokeWidth="3" strokeLinecap="round" />
          <path d="M75 15Q82 8 85 14" stroke="hsl(var(--foreground) / 0.58)" strokeWidth="3" strokeLinecap="round" />
          <g className="clawx-dreams-character-eyes">
            <path d="M39 36Q45 32 51 36" stroke="hsl(var(--background))" strokeWidth="2.5" strokeLinecap="round" fill="none" />
            <path d="M69 36Q75 32 81 36" stroke="hsl(var(--background))" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          </g>
        </svg>
      </div>
      <span aria-hidden="true" className="clawx-dreams-z clawx-dreams-z-sm">z</span>
      <span aria-hidden="true" className="clawx-dreams-z clawx-dreams-z-md">z</span>
      <span aria-hidden="true" className="clawx-dreams-z clawx-dreams-z-lg">Z</span>
    </div>
  );

  const renderSignalCard = (entry: DreamMemoryEntry, index: number) => (
    <article
      key={`${entry.key || entry.path || 'signal'}-${index}`}
      className="clawx-dreams-signal-row"
    >
      <div className="min-w-0">
        <div className="truncate font-mono text-tiny text-muted-foreground">
          {buildSignalSource(entry, t('signals.unknownSource'))}
        </div>
        <p className={cn('mt-1 line-clamp-2 text-meta leading-5', !entry.snippet && 'text-muted-foreground')}>
          {entry.snippet || t('signals.noSnippet')}
        </p>
      </div>
      <Badge variant="outline" className="h-6 shrink-0 rounded-md border-border/60 bg-surface-modal/70 px-2 text-tiny tabular-nums">
        {getSignalCount(entry)}
      </Badge>
    </article>
  );

  const renderDiaryPanel = () => (
    <section className="clawx-dreams-diary-workbench">
      <div className="clawx-dreams-panel-header">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('diary.title')}</h2>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {diary?.found ? (diary.path || 'DREAMS.md') : t('diary.notFound')}
          </div>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {diaryEntries.length === 0 ? (
        <div data-testid="dreams-empty-diary" className="grid min-h-[460px] place-items-center border border-dashed border-border/70 bg-surface-input/35 p-8 text-center">
          <div>
            <Moon className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <div className="mt-3 text-sm font-medium text-muted-foreground">
              {diary?.found ? t('diary.empty') : t('diary.notFound')}
            </div>
            <div className="mt-1 text-xs text-muted-foreground/70">{t('diary.waitingHint')}</div>
          </div>
        </div>
      ) : (
        <div className="clawx-dreams-diary-shell">
          <div className="clawx-dreams-daychips">
            {diaryEntries.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                data-testid={`dreams-diary-entry-${index}`}
                className={cn(
                  'clawx-dreams-daychip',
                  activeDiaryIndex === index
                    ? 'clawx-dreams-daychip-active'
                    : 'border-border/60 bg-surface-input/45 text-muted-foreground hover:border-border/80 hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
                )}
                onClick={() => setActiveDiaryIndex(index)}
              >
                {formatDiaryChip(entry.date, t('diary.undated'))}
              </button>
            ))}
          </div>
          <article className="clawx-dreams-diary-entry">
            <div className="clawx-dreams-diary-accent" aria-hidden="true" />
            {activeDiaryEntry?.date && (
              <time className="mb-5 block font-mono text-xs text-muted-foreground">{activeDiaryEntry.date}</time>
            )}
            <div className="max-w-3xl space-y-4">
              {(activeDiaryEntry?.lines ?? []).map((line, index) => (
                <p
                  key={`${activeDiaryEntry?.id}-${index}`}
                  className="clawx-dreams-diary-line text-sm leading-7 text-foreground/90"
                  style={{ animationDelay: `${index * 120}ms` }}
                >
                  {line}
                </p>
              ))}
            </div>
          </article>
        </div>
      )}
    </section>
  );

  const renderMaintenancePanel = () => (
    <section className="clawx-dreams-command-panel">
      <div className="clawx-dreams-panel-header">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('actions.title')}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('actions.description')}</p>
        </div>
        {runningAction && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>
      <div className="clawx-dreams-command-grid">
        <Button
          data-testid="dreams-action-backfill"
          variant="outline"
          className="clawx-action-surface h-10 justify-start"
          onClick={() => void runAction('backfill')}
          disabled={actionsDisabled}
        >
          {runningAction === 'backfill' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BookOpen className="mr-2 h-4 w-4" />}
          {t('actions.backfill')}
        </Button>
        <Button
          data-testid="dreams-action-dedupe"
          variant="outline"
          className="clawx-action-surface h-10 justify-start"
          onClick={() => requestConfirmation('dedupe')}
          disabled={actionsDisabled}
        >
          <Eraser className="mr-2 h-4 w-4" />
          {t('actions.dedupe')}
        </Button>
        <Button
          data-testid="dreams-action-repair"
          variant="outline"
          className="clawx-action-surface h-10 justify-start"
          onClick={() => requestConfirmation('repair')}
          disabled={actionsDisabled}
        >
          <Wrench className="mr-2 h-4 w-4" />
          {t('actions.repair')}
        </Button>
        <Button
          data-testid="dreams-action-reset-grounded"
          variant="outline"
          className="clawx-action-surface h-10 justify-start"
          onClick={() => requestConfirmation('resetGrounded')}
          disabled={actionsDisabled}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('actions.resetGrounded')}
        </Button>
        <Button
          data-testid="dreams-action-reset-diary"
          variant="outline"
          className="h-10 justify-start rounded-lg border border-destructive/30 bg-destructive/5 px-3 text-meta text-destructive shadow-none hover:bg-destructive/10 hover:text-destructive dark:border-destructive/40 sm:col-span-2"
          onClick={() => requestConfirmation('resetDiary')}
          disabled={actionsDisabled}
        >
          <Archive className="mr-2 h-4 w-4" />
          {t('actions.resetDiary')}
        </Button>
      </div>
    </section>
  );

  const renderPhasesPanel = () => (
    <div className="clawx-dreams-phases-strip">
      <div className="clawx-dreams-phase-summary">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span>{t('scene.nextSweep', { time: nextCycle ? formatDateTime(nextCycle) : '—' })}</span>
      </div>
      <div className="clawx-dreams-phase-items">
        {phases.map((phase) => {
          const value = dreaming?.phases?.[phase.key];
          const enabled = value?.enabled === true;
          return (
            <div key={phase.key} className={cn('clawx-dreams-phase-chip', value && !enabled && 'opacity-50')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', enabled ? 'bg-green-500 shadow-[0_0_10px_rgb(34_197_94_/_0.45)]' : 'bg-muted-foreground/30')} />
              <span className="text-xs font-semibold text-foreground/85">{phase.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {value ? (enabled ? formatPhaseTime(value.nextRunAtMs) : t('phases.off')) : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderRecentSignalsPanel = () => (
    <section className="clawx-dreams-data-panel">
      <div className="clawx-dreams-panel-header">
        <h2 className="text-sm font-semibold text-foreground">{t('signals.title')}</h2>
        <Badge variant="outline" className="rounded-md border-border/60 bg-surface-input/70 text-tiny tabular-nums">
          {recentSignals.length}
        </Badge>
      </div>
      {(dreaming?.storeError || dreaming?.phaseSignalError) && (
        <div className="mx-4 mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {dreaming.storeError || dreaming.phaseSignalError}
        </div>
      )}
      {recentSignals.length === 0 ? (
        <div className="m-4 rounded-lg border border-dashed border-border/70 bg-surface-input/50 p-4 text-sm text-muted-foreground">
          {t('signals.empty')}
        </div>
      ) : (
        <div className="divide-y divide-border/45">{recentSignals.map(renderSignalCard)}</div>
      )}
    </section>
  );

  const renderScenePage = () => (
    <div className="space-y-4">
      <section className="clawx-dreams-overview-panel">
        <div className="clawx-dreams-scene-grid">
          <div className="clawx-dreams-hero-visual">
            {renderMascotWidget()}
          </div>
          <div className="clawx-dreams-hero-copy">
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                data-testid="dreams-enabled-badge"
                variant="outline"
                className="rounded-md border-border/70 bg-surface-input/80 text-xs text-foreground/85"
              >
                {dreaming?.enabled ? t('common:status.enabled') : t('common:status.disabled')}
              </Badge>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 rounded-full', dreamsActive ? 'bg-green-500' : 'bg-muted-foreground/30')} />
                <span>
                  {dreamsActive ? t('scene.statusActive') : t('scene.statusIdle')}
                  {dreaming?.timezone ? ` · ${dreaming.timezone}` : ''}
                </span>
              </div>
            </div>

            <div data-testid="dreams-phrase" className="clawx-dreams-hero-title">
              {dreamsActive ? currentDreamPhrase : t('scene.noNextCycle')}
            </div>

            <div className="clawx-dreams-hero-meta">
              {dreaming?.storageMode ? t('signals.storageMode', { mode: dreaming.storageMode }) : t('signals.noStorageMode')}
            </div>
          </div>
        </div>
        <div className="clawx-dreams-metric-stack">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="clawx-dreams-metric-item">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="truncate text-tiny font-semibold uppercase tracking-[0.12em]">{metric.label}</span>
                </div>
                <span className="text-xl font-semibold tabular-nums text-foreground">{metric.value}</span>
              </div>
            );
          })}
        </div>
        {renderPhasesPanel()}
      </section>
    </div>
  );

  const renderDiaryPage = () => (
    <div className="clawx-dreams-diary-page">
      {renderDiaryPanel()}
    </div>
  );

  const renderAdvancedPage = () => (
    <section className="clawx-dreams-advanced-page">
      <div className="clawx-dreams-section-heading">
        <div className="min-w-0">
          <div className="text-tiny font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('advanced.eyebrow')}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-foreground">{t('advanced.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('advanced.description')}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-surface-input/60 px-4 py-3 text-xs text-muted-foreground">
          {t('advanced.summary', {
            grounded: groundedEntries.length,
            shortTerm: dreaming?.shortTermCount ?? 0,
            promoted: dreaming?.promotedToday ?? 0,
          })}
        </div>
      </div>
      <div className="clawx-dreams-advanced-grid">
        {renderMaintenancePanel()}
        {renderRecentSignalsPanel()}
      </div>
    </section>
  );

  return (
    <div data-testid="dreams-page" className="clawx-page-root clawx-dreams-root">
      <div className="clawx-page-container clawx-dreams-container">
        <header className="clawx-page-header clawx-dreams-page-header">
          <div className="min-w-0">
            <h1 className="clawx-page-title">{t('title')}</h1>
            <p className="clawx-page-subtitle">{t('subtitle')}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              data-testid={dreaming?.enabled ? 'dreams-disable' : 'dreams-enable'}
              variant={dreaming?.enabled ? 'outline' : 'default'}
              onClick={() => void setDreamingEnabled(!dreaming?.enabled)}
              disabled={!dreamsReady || busy || loading}
              className={dreaming?.enabled ? 'clawx-toolbar-button h-9' : 'h-9 rounded-lg px-4 text-meta font-medium shadow-sm'}
            >
              {runningToggle ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Power className="mr-2 h-3.5 w-3.5" />}
              {dreaming?.enabled ? t('actions.disable') : t('actions.enable')}
            </Button>
            <Button
              data-testid="dreams-refresh"
              variant="outline"
              onClick={() => void refreshAll({ force: true })}
              disabled={!dreamsReady}
              className="clawx-toolbar-button h-9"
            >
              {loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              {t('common:actions.refresh')}
            </Button>
            <Button
              data-testid="dreams-open-full-ui"
              variant="outline"
              onClick={() => void openFullDreams()}
              disabled={openingFullUi || !gatewayRunning}
              className="clawx-toolbar-button h-9"
            >
              {openingFullUi ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="mr-2 h-3.5 w-3.5" />}
              {t('openFullUi')}
            </Button>
          </div>
        </header>

        <main className="clawx-page-content clawx-dreams-workspace">
          {!dreamsReady && (
            <div className="rounded-lg border border-border/70 bg-surface-input/70 px-4 py-3 text-sm text-muted-foreground">
              {t('gatewayNotReady')}
            </div>
          )}

          {error && (
            <div data-testid="dreams-error" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {lastActionMessage && (
            <div data-testid="dreams-action-message" className="rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
              {lastActionMessage}
            </div>
          )}

          <section className="clawx-dreams-suite">
            <div className="clawx-dreams-rail">
              <nav aria-label={t('tabs.label')} role="tablist" className="clawx-dreams-tab-grid">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      data-testid={`dreams-tab-${tab.key}`}
                      aria-selected={activeTab === tab.key}
                      className={cn(
                        'clawx-dreams-tab',
                        activeTab === tab.key && 'clawx-dreams-tab-active',
                      )}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="clawx-dreams-tab-icon">
                          <Icon className="h-4 w-4 shrink-0" />
                        </span>
                        <span className="truncate text-sm font-semibold">{tab.label}</span>
                      </span>
                      <span className="clawx-dreams-tab-badge">
                        {tab.badge}
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="clawx-dreams-view">
              {activeTab === 'scene' ? renderScenePage() : activeTab === 'diary' ? renderDiaryPage() : renderAdvancedPage()}
            </div>
          </section>
        </main>
      </div>

      <ConfirmDialog
        open={pendingConfirmation != null}
        title={pendingConfirmation?.title || ''}
        message={pendingConfirmation?.message || ''}
        confirmLabel={t('common:actions.confirm')}
        cancelLabel={t('common:actions.cancel')}
        variant={pendingConfirmation?.destructive ? 'destructive' : 'default'}
        onConfirm={() => {
          if (pendingConfirmation) void runAction(pendingConfirmation.action);
        }}
        onCancel={() => setPendingConfirmation(null)}
      />
    </div>
  );
}
