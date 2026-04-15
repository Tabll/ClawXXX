/**
 * Dream (梦境) Page
 * Displays dreaming status, scene animation, diary, and advanced memory view.
 * Adapted from OpenClaw control-ui dreaming tab.
 */
import { useEffect, useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import {
  RefreshCw,
  Loader2,
  BookOpenCheck,
  AlertCircle,
  Eraser,
  RotateCcw,
  Wrench,
  Power,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useGatewayStore } from '@/stores/gateway';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface PhaseInfo {
  enabled: boolean;
  intervalMs?: number;
  lastRanAt?: string;
  lookbackDays?: number;
  limit?: number;
}

interface DreamingStatus {
  enabled: boolean;
  timezone?: string;
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath?: string;
  storeError?: string;
  shortTermEntries?: MemoryEntry[];
  signalEntries?: MemoryEntry[];
  promotedEntries?: MemoryEntry[];
  phases?: {
    light: PhaseInfo;
    deep: PhaseInfo;
    rem: PhaseInfo;
  };
}

interface MemoryEntry {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
}

/* ------------------------------------------------------------------ */
/*  Phrases (rotating text for idle animation)                         */
/* ------------------------------------------------------------------ */
const DREAM_PHRASES = [
  'phrases.consolidatingMemories',
  'phrases.tidyingKnowledgeGraph',
  'phrases.replayingConversations',
  'phrases.weavingShortTerm',
  'phrases.defragmentingMindPalace',
  'phrases.filingLooseThoughts',
  'phrases.connectingDots',
  'phrases.compostingContext',
  'phrases.promotingHunches',
  'phrases.forgettingNoise',
  'phrases.reorganizingAttic',
  'phrases.indexingDay',
  'phrases.nurturingInsights',
  'phrases.simmeringIdeas',
];

const STARS = [
  { top: 8, left: 15, size: 3, delay: 0 },
  { top: 12, left: 72, size: 2, delay: 1.4 },
  { top: 22, left: 35, size: 3, delay: 0.6 },
  { top: 18, left: 88, size: 2, delay: 2.1 },
  { top: 35, left: 8, size: 2, delay: 0.9 },
  { top: 45, left: 92, size: 2, delay: 1.7 },
  { top: 55, left: 25, size: 3, delay: 2.5 },
  { top: 65, left: 78, size: 2, delay: 0.3 },
  { top: 75, left: 45, size: 2, delay: 1.1 },
  { top: 82, left: 60, size: 3, delay: 1.8 },
  { top: 30, left: 55, size: 2, delay: 0.4 },
  { top: 88, left: 18, size: 2, delay: 2.3 },
];

type DreamTab = 'scene' | 'diary' | 'advanced';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Dream() {
  const { t } = useTranslation('dream');
  const rpc = useGatewayStore((s) => s.rpc);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isReady = gatewayStatus.state === 'running' && gatewayStatus.gatewayReady !== false;

  const [tab, setTab] = useState<DreamTab>('scene');
  const [status, setStatus] = useState<DreamingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diaryContent, setDiaryContent] = useState<string | null>(null);
  const [diaryLoading, setDiaryLoading] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * DREAM_PHRASES.length));
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const phraseTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  // Rotate dreaming phrases
  useEffect(() => {
    phraseTimer.current = setInterval(() => {
      setPhraseIndex((i) => (i + 1) % DREAM_PHRASES.length);
    }, 6000);
    return () => clearInterval(phraseTimer.current);
  }, []);

  const fetchStatus = useCallback(async () => {
    if (!isReady) return;
    setLoading(true);
    setError(null);
    try {
      const res = await rpc<{ dreaming?: DreamingStatus }>('doctor.memory.status', {});
      setStatus(res?.dreaming ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [isReady, rpc]);

  const fetchDiary = useCallback(async () => {
    if (!isReady) return;
    setDiaryLoading(true);
    try {
      const res = await rpc<{ found?: boolean; content?: string }>('doctor.memory.dreamDiary', {});
      setDiaryContent(res?.found ? (res.content ?? '') : null);
    } catch {
      setDiaryContent(null);
    } finally {
      setDiaryLoading(false);
    }
  }, [isReady, rpc]);

  useEffect(() => {
    fetchStatus();
    fetchDiary();
  }, [fetchStatus, fetchDiary]);

  const handleRefresh = useCallback(() => {
    fetchStatus();
    if (tab === 'diary') fetchDiary();
  }, [fetchStatus, fetchDiary, tab]);

  const runAction = useCallback(async (method: string) => {
    if (!isReady || actionLoading) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      await rpc(method, {});
      await fetchStatus();
      await fetchDiary();
      setActionMessage({ kind: 'success', text: t('scene.actionSuccess') });
    } catch (e) {
      setActionMessage({ kind: 'error', text: String(e) });
    } finally {
      setActionLoading(false);
    }
  }, [isReady, actionLoading, rpc, fetchStatus, fetchDiary, t]);

  const toggleDreaming = useCallback(async (enabled: boolean) => {
    if (!isReady || toggleLoading) return;
    setToggleLoading(true);
    try {
      // Fetch current config hash first
      const configRes = await rpc<{ hash?: string; config?: Record<string, unknown> }>('config.get', {});
      if (!configRes?.hash) return;
      // Patch dreaming enabled state
      const patchPayload = JSON.stringify({
        plugins: { entries: { 'memory-core': { config: { dreaming: { enabled } } } } },
      });
      await rpc('config.patch', {
        baseHash: configRes.hash,
        raw: patchPayload,
        sessionKey: 'dreaming-toggle',
        note: 'Dreaming settings updated from the Dreaming tab.',
      });
      await fetchStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setToggleLoading(false);
    }
  }, [isReady, toggleLoading, rpc, fetchStatus]);

  const isActive = status?.enabled === true;
  const isIdle = !isActive;
  const phrase = t(DREAM_PHRASES[phraseIndex]);

  const phases = useMemo(() => {
    if (!status?.phases) return [];
    return (['light', 'deep', 'rem'] as const).map((key) => ({
      key,
      label: t(`phase.${key}`),
      on: status.phases![key].enabled,
      lastRan: status.phases![key].lastRanAt,
    }));
  }, [status, t]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-0">
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={
            <div className="flex items-center gap-2.5">
              <div className="flex items-center gap-2 rounded-full border border-black/10 dark:border-white/10 px-3 py-1.5">
                <Power className={cn(
                  'h-3.5 w-3.5 transition-colors',
                  isActive ? 'text-emerald-500' : 'text-muted-foreground'
                )} />
                <span className="text-[13px] font-medium text-foreground/80">
                  {isActive ? t('header.on') : t('header.off')}
                </span>
                <Switch
                  checked={isActive}
                  onCheckedChange={toggleDreaming}
                  disabled={toggleLoading || !isReady}
                />
              </div>
              <Button
                variant="outline"
                onClick={handleRefresh}
                disabled={loading}
                className="h-9 text-[13px] font-medium rounded-full px-4 border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-none text-foreground/80 hover:text-foreground transition-colors"
              >
                {loading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                {loading ? t('header.refreshing') : t('header.refresh')}
              </Button>
            </div>
          }
        />
      </div>

      {/* Tabs */}
      <div className="shrink-0 px-6 pb-4">
        <DreamTabs tab={tab} onTabChange={(key) => { setTab(key); if (key === 'diary') fetchDiary(); }} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="shrink-0 mx-6 mb-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Content area */}
      <div className={cn('flex-1 min-h-0', tab === 'scene' ? 'overflow-hidden' : 'overflow-auto')}>
        {tab === 'scene' && (
          <SceneTab
            status={status}
            isActive={isActive}
            isIdle={isIdle}
            phrase={phrase}
            phases={phases}
          />
        )}
        {tab === 'diary' && (
          <DiaryTab
            diaryContent={diaryContent}
            loading={diaryLoading}
          />
        )}
        {tab === 'advanced' && (
          <AdvancedTab
            status={status}
            actionLoading={actionLoading}
            actionMessage={actionMessage}
            onAction={runAction}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function formatRelativeTime(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface DiaryDateGroup {
  date: string;
  body: string;
}

const RE_DIARY_START = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const RE_DIARY_END = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

/** Parse diary exactly like OpenClaw: extract between markers, split by ---, *date* header */
function parseDiary(raw: string): DiaryDateGroup[] {
  if (!raw) return [];
  let content = raw;
  const startMatch = RE_DIARY_START.exec(raw);
  const endMatch = RE_DIARY_END.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  const sections = content.split(/\n---\n/).filter((s) => s.trim().length > 0);
  const groups: DiaryDateGroup[] = [];

  for (const section of sections) {
    const lines = section.trim().split('\n');
    let date = '';
    const bodyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // First *italic* line is the date label
      if (!date && trimmed.startsWith('*') && trimmed.endsWith('*') && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      // Skip headings and HTML comments
      if (trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue;
      if (trimmed.length > 0) bodyLines.push(trimmed);
    }
    if (bodyLines.length > 0) {
      groups.push({ date, body: cleanDiaryBody(bodyLines.join('\n')) });
    }
  }
  return groups;
}

/** Clean diary body lines like OpenClaw _E: strip bullets, section headers, memory paths */
function cleanDiaryBody(text: string): string {
  const SKIP_HEADERS = ['What Happened', 'Reflections', 'Candidates', 'Possible Lasting Updates'];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !SKIP_HEADERS.includes(l))
    .map((l) => l.replace(/\s*\[memory\/[^\]]+\]/g, ''))
    .map((l) =>
      l
        .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, '')
        .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, '')
        .trim()
    )
    .filter((l) => l.length > 0)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/*  Tab Switcher with sliding indicator                                */
/* ------------------------------------------------------------------ */
const TAB_KEYS: DreamTab[] = ['scene', 'diary', 'advanced'];

function DreamTabs({ tab, onTabChange }: { tab: DreamTab; onTabChange: (t: DreamTab) => void }) {
  const { t } = useTranslation('dream');
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const idx = TAB_KEYS.indexOf(tab);
    const btn = container.children[idx + 1] as HTMLElement | undefined; // +1 for the indicator div
    if (btn) {
      setIndicator({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
  }, [tab]);

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center rounded-lg border border-border/50 bg-muted/30 p-0.5"
    >
      {/* Sliding indicator */}
      <div
        className="absolute top-0.5 bottom-0.5 rounded-md bg-background shadow-sm transition-all duration-300 ease-out"
        style={{ left: indicator.left, width: indicator.width }}
      />
      {TAB_KEYS.map((key) => (
        <button
          key={key}
          onClick={() => onTabChange(key)}
          className={cn(
            'relative z-[1] rounded-md px-4 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors',
            tab === key
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground/70'
          )}
        >
          {t(`tabs.${key}`)}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Lobster SVG Mascot (from OpenClaw)                                 */
/* ------------------------------------------------------------------ */
function LobsterSvg() {
  return (
    <svg viewBox="0 0 120 120" fill="none" className="w-40 h-40">
      <defs>
        <linearGradient id="dream-lob-g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="100%" stopColor="#991b1b" />
        </linearGradient>
      </defs>
      {/* Body */}
      <path
        d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
        fill="url(#dream-lob-g)"
      />
      {/* Left claw */}
      <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#dream-lob-g)" />
      {/* Right claw */}
      <path
        d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
        fill="url(#dream-lob-g)"
      />
      {/* Left antenna */}
      <path d="M45 15Q38 8 35 14" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      {/* Right antenna */}
      <path d="M75 15Q82 8 85 14" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      {/* Left eye (brow) */}
      <path
        d="M39 36Q45 32 51 36"
        stroke="#050810"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
      {/* Right eye (brow) */}
      <path
        d="M69 36Q75 32 81 36"
        stroke="#050810"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Scene Tab                                                          */
/* ------------------------------------------------------------------ */
interface SceneProps {
  status: DreamingStatus | null;
  isActive: boolean;
  isIdle: boolean;
  phrase: string;
  phases: { key: string; label: string; on: boolean; lastRan?: string }[];
}

function SceneTab({ status, isActive, isIdle, phrase, phases }: SceneProps) {
  const { t } = useTranslation('dream');

  return (
    <section className={cn(
      'relative flex flex-col items-center justify-center select-none',
      'h-full',
      isIdle && 'dreams--idle'
    )}>
      {/* Stars */}
      {STARS.map((star, i) => (
        <div
          key={i}
          className="absolute rounded-full animate-dream-twinkle"
          style={{
            top: `${star.top}%`,
            left: `${star.left}%`,
            width: star.size,
            height: star.size,
            background: i % 4 === 0 ? 'hsl(var(--primary) / 0.5)' : 'hsl(var(--foreground))',
            animationDelay: `${star.delay}s`,
          }}
        />
      ))}

      {/* Moon (top right decorative) */}
      <div
        className="absolute top-10 right-20 w-16 h-16 rounded-full animate-dream-moon-glow opacity-70"
        style={{
          background: 'radial-gradient(circle at 35% 35%, #fef3c7, #fbbf24)',
          boxShadow: '0 0 40px rgba(251,191,36,0.2), 0 0 80px rgba(251,191,36,0.08)',
        }}
      />

      {/* Thought bubble (only when active) — positioned relative to lobster */}
      {isActive && (
        <>
          <div
            className="absolute animate-dream-bubble-float rounded-2xl backdrop-blur-md px-5 py-3"
            style={{
              bottom: 'calc(50% + 150px)',
              right: 'calc(50% + 30px)',
              background: 'linear-gradient(135deg, hsl(var(--primary) / 0.08), hsl(var(--primary) / 0.03))',
              border: '1px solid hsl(var(--primary) / 0.1)',
              boxShadow: '0 8px 32px hsl(var(--primary) / 0.06), inset 0 1px 0 hsl(var(--primary) / 0.08)',
            }}
          >
            <span className="text-[13px] italic text-primary/70 text-center block min-w-[140px] max-w-[200px] leading-relaxed">{phrase}</span>
          </div>
          {/* Bubble dots connecting to character */}
          <div
            className="absolute rounded-full animate-dream-bubble-float backdrop-blur-sm"
            style={{
              bottom: 'calc(50% + 126px)',
              right: 'calc(50% + 14px)',
              width: 10,
              height: 10,
              background: 'hsl(var(--primary) / 0.06)',
              border: '1px solid hsl(var(--primary) / 0.08)',
              animationDelay: '0.2s',
            }}
          />
          <div
            className="absolute rounded-full animate-dream-bubble-float backdrop-blur-sm"
            style={{
              bottom: 'calc(50% + 108px)',
              right: 'calc(50% + 2px)',
              width: 7,
              height: 7,
              background: 'hsl(var(--primary) / 0.05)',
              border: '1px solid hsl(var(--primary) / 0.06)',
              animationDelay: '0.4s',
            }}
          />
        </>
      )}

      {/* Glow under the lobster */}
      <div
        className="absolute pointer-events-none w-60 h-24 rounded-full animate-dream-glow-pulse"
        style={{
          top: 'calc(50% + 60px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'radial-gradient(rgba(255,77,77,0.08) 0%, transparent 70%)',
        }}
      />

      {/* Lobster mascot (central) */}
      <div className={cn(
        'animate-dream-breathe transition-[filter] duration-700',
        isActive
          ? 'drop-shadow-[0_0_40px_rgba(255,77,77,0.25)]'
          : 'drop-shadow-[0_0_20px_rgba(255,77,77,0.1)]'
      )}>
        <LobsterSvg />
      </div>

      {/* Floating Z's */}
      <span
        className="absolute font-mono font-bold text-primary text-sm animate-dream-float-z"
        style={{ top: 'calc(50% - 90px)', left: 'calc(50% + 70px)' }}
      >z</span>
      <span
        className="absolute font-mono font-bold text-primary text-xl animate-dream-float-z"
        style={{ top: 'calc(50% - 130px)', left: 'calc(50% + 100px)', animationDelay: '1.2s' }}
      >z</span>
      <span
        className="absolute font-mono font-bold text-primary text-2xl animate-dream-float-z"
        style={{ top: 'calc(50% - 175px)', left: 'calc(50% + 130px)', animationDelay: '2.4s' }}
      >Z</span>

      {/* Status label */}
      <div className="mt-8 flex flex-col items-center gap-2.5 z-[1]">
        <span className="text-[13px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {isActive ? t('status.active') : t('status.idle')}
        </span>
        {status && (
          <div className="flex items-center gap-2 text-xs">
            <span className={cn(
              'h-1.5 w-1.5 rounded-full',
              isActive
                ? 'bg-emerald-500 animate-dream-dot-pulse shadow-[0_0_6px_rgba(34,197,94,0.4)]'
                : 'bg-muted-foreground/40'
            )} />
            <span className={cn(
              isActive ? 'text-emerald-600 dark:text-emerald-400/70' : 'text-muted-foreground'
            )}>
              {status.promotedTotal} {t('stats.promoted')}
              {status.totalSignalCount > 0 && <> · {status.totalSignalCount} {t('stats.signals')}</>}
            </span>
          </div>
        )}
      </div>

      {/* Phase indicators */}
      {phases.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 z-[1]">
          {phases.map((p) => (
            <div
              key={p.key}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-4 py-2',
                'border-border/40 bg-card/50 backdrop-blur-sm',
                !p.on && 'opacity-40'
              )}
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                p.on ? 'bg-emerald-500 shadow-[0_0_6px_rgba(34,197,94,0.3)]' : 'bg-muted-foreground/40'
              )} />
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground">{p.label}</span>
              {p.lastRan && (
                <span className="text-[10px] text-muted-foreground/60 tabular-nums">
                  {formatRelativeTime(p.lastRan)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Diary Tab                                                          */
/* ------------------------------------------------------------------ */
interface DiaryProps {
  diaryContent: string | null;
  loading: boolean;
}

function DiaryTab({ diaryContent, loading }: DiaryProps) {
  const { t } = useTranslation('dream');
  const [collapsedDates, setCollapsedDates] = useState<Set<number>>(new Set());

  const groups = useMemo(() => parseDiary(diaryContent ?? ''), [diaryContent]);
  // Reverse so newest is first
  const reversed = useMemo(() => [...groups].reverse(), [groups]);

  const toggleGroup = (idx: number) => {
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!diaryContent || reversed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <BookOpenCheck className="h-10 w-10 text-muted-foreground/30" />
        <p className="text-sm italic text-muted-foreground/60">{t('diary.noDreamsYet')}</p>
        <p className="text-xs text-muted-foreground/40">{t('diary.noDreamsHint')}</p>
      </div>
    );
  }

  return (
    <div className="px-6 pb-10 max-w-[920px] mx-auto">
      <div className="space-y-3">
        {reversed.map((group, gi) => {
          const isCollapsed = collapsedDates.has(gi);
          const paragraphs = group.body
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          return (
            <div
              key={gi}
              className="rounded-xl border border-border/40 bg-card/50 overflow-hidden"
            >
              {/* Date header */}
              <button
                onClick={() => toggleGroup(gi)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <svg
                  className={cn(
                    'h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform duration-200',
                    !isCollapsed && 'rotate-90'
                  )}
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M6 3l5 5-5 5V3z" />
                </svg>
                <span className="text-[13px] font-semibold text-foreground tracking-tight">
                  {group.date || t('diary.undated')}
                </span>
                <span className="text-[11px] text-muted-foreground/50 tabular-nums ml-auto">
                  {paragraphs.length}
                </span>
              </button>

              {/* Entries */}
              {!isCollapsed && paragraphs.length > 0 && (
                <div className="border-t border-border/30 px-4 py-3">
                  <div className="space-y-2.5">
                    {paragraphs.map((para, pi) => (
                      <div
                        key={pi}
                        className="relative pl-4 animate-dream-diary-entry"
                        style={{ animationDelay: `${pi * 0.08}s` }}
                      >
                        <div className="absolute left-0 top-[6px] w-1 h-1 rounded-full bg-primary/30" />
                        <p className="text-[13px] leading-[1.7] text-foreground/90 break-words">{para}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Advanced Tab                                                       */
/* ------------------------------------------------------------------ */
interface AdvancedProps {
  status: DreamingStatus | null;
  actionLoading: boolean;
  actionMessage: { kind: 'success' | 'error'; text: string } | null;
  onAction: (method: string) => void;
}

function AdvancedTab({ status, actionLoading, actionMessage, onAction }: AdvancedProps) {
  const { t } = useTranslation('dream');
  const [sortBy, setSortBy] = useState<'recent' | 'signals'>('recent');

  if (!status) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
        {t('advanced.noData')}
      </div>
    );
  }

  const shortTermEntries = [...(status.shortTermEntries ?? [])].sort((a, b) =>
    sortBy === 'signals'
      ? b.totalSignalCount - a.totalSignalCount
      : (b.lastRecalledAt ?? '').localeCompare(a.lastRecalledAt ?? '')
  );

  const promotedEntries = status.promotedEntries ?? [];

  return (
    <div className="px-6 pb-10 max-w-[920px] mx-auto">
      {/* Summary bar */}
      <div className="mb-6">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h2 className="text-lg font-semibold text-foreground">{t('advanced.title')}</h2>
          <div className="flex items-center gap-4 text-xs text-muted-foreground tabular-nums">
            <span>{status.shortTermEntries?.length ?? 0} {t('advanced.summaryFromDailyLog')}</span>
            <span className="text-border">|</span>
            <span>{status.shortTermCount} {t('advanced.summaryWaiting')}</span>
            <span className="text-border">|</span>
            <span>{status.promotedToday} {t('advanced.summaryPromotedToday')}</span>
          </div>
        </div>
        <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed max-w-[60ch]">
          {t('advanced.description')}
        </p>
      </div>

      {/* Actions card */}
      <div className="mb-6 rounded-xl border border-border/40 bg-card/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{t('advanced.actionsTitle')}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={actionLoading}
            onClick={() => onAction('doctor.memory.backfillDreamDiary')}
            className="rounded-full text-xs h-8 px-3.5 border-black/10 dark:border-white/10"
          >
            {actionLoading ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <BookOpenCheck className="mr-1.5 h-3 w-3" />}
            {t('scene.backfill')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={actionLoading}
            onClick={() => onAction('doctor.memory.dedupeDreamDiary')}
            className="rounded-full text-xs h-8 px-3.5 border-black/10 dark:border-white/10"
          >
            <Eraser className="mr-1.5 h-3 w-3" />
            {t('scene.dedupeDiary')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={actionLoading}
            onClick={() => onAction('doctor.memory.resetGroundedShortTerm')}
            className="rounded-full text-xs h-8 px-3.5 border-black/10 dark:border-white/10"
          >
            <RotateCcw className="mr-1.5 h-3 w-3" />
            {t('scene.clearGrounded')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={actionLoading}
            onClick={() => onAction('doctor.memory.repairDreamingArtifacts')}
            className="rounded-full text-xs h-8 px-3.5 border-black/10 dark:border-white/10"
          >
            <Wrench className="mr-1.5 h-3 w-3" />
            {t('scene.repairCache')}
          </Button>
        </div>
        {actionMessage && (
          <div className={cn(
            'mt-3 text-xs px-3 py-2 rounded-lg',
            actionMessage.kind === 'success' ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10' : 'text-destructive bg-destructive/10'
          )}>
            {actionMessage.text}
          </div>
        )}
      </div>

      {/* Memory sections */}
      <div className="space-y-4">
        {/* Short Term */}
        <AdvancedSection
          title={t('advanced.shortTermTitle')}
          description={t('advanced.shortTermDescription')}
          count={shortTermEntries.length}
          emptyText={t('advanced.emptyShortTerm')}
          entries={shortTermEntries}
          toolbar={
            <div className="inline-flex items-center gap-0.5 rounded-full border border-border/50 bg-card/80 p-0.5">
              <button
                onClick={() => setSortBy('recent')}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                  sortBy === 'recent' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('advanced.sortRecent')}
              </button>
              <button
                onClick={() => setSortBy('signals')}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                  sortBy === 'signals' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('advanced.sortSignals')}
              </button>
            </div>
          }
        />

        {/* Promoted */}
        <AdvancedSection
          title={t('advanced.promotedTitle')}
          description={t('advanced.promotedDescription')}
          count={promotedEntries.length}
          emptyText={t('advanced.emptyPromoted')}
          entries={promotedEntries}
        />
      </div>

      {/* Store info */}
      {status.storePath && (
        <div className="mt-6 rounded-xl border border-border/30 bg-card/30 px-4 py-3">
          <span className="text-[11px] text-muted-foreground/60 font-mono break-all">{status.storePath}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared Advanced Section                                            */
/* ------------------------------------------------------------------ */

interface AdvancedSectionProps {
  title: string;
  description: string;
  count: number;
  emptyText: string;
  entries: MemoryEntry[];
  toolbar?: React.ReactNode;
}

function AdvancedSection({ title, description, count, emptyText, entries, toolbar }: AdvancedSectionProps) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card/70 overflow-hidden">
      {/* Section header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/40 px-4 py-3.5">
        <div className="min-w-0 max-w-[56ch]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{title}</div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{description}</p>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center min-w-[26px] h-[26px] px-2 rounded-full bg-primary/10 text-xs font-bold tabular-nums text-primary">
            {count}
          </span>
          {toolbar}
        </div>
      </div>
      {/* Entries */}
      {entries.length === 0 ? (
        <div className="px-4 py-4 text-xs text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="divide-y divide-border/30">
          {entries.map((entry) => (
            <div key={entry.key} className="px-4 py-3.5">
              <div className="text-[13px] text-foreground leading-[1.45]">{entry.snippet}</div>
              <div className="mt-2 font-mono text-[11px] text-muted-foreground">{entry.path}:{entry.startLine}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {[
                  entry.totalSignalCount > 0 ? `${entry.totalSignalCount} signals` : '',
                  entry.groundedCount > 0 ? `${entry.groundedCount} grounded` : '',
                  entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hits` : '',
                  entry.promotedAt ? `promoted ${new Date(entry.promotedAt).toLocaleDateString()}` : '',
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
