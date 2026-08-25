/**
 * Global memory embedding settings (agents.defaults.memorySearch).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrainCircuit, Eye, EyeOff, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  clearEmbeddingSettings,
  fetchEmbeddingSettings,
  saveEmbeddingSettings,
  type EmbeddingSettingsConfig,
  type EmbeddingSettingsSnapshot,
  type MemorySearchModality,
  type MemorySearchQmdCollection,
  type MemorySearchSource,
} from '@/lib/embeddings';
import { cn } from '@/lib/utils';

type BooleanDraft = 'default' | 'true' | 'false';

type AdvancedFieldProps = {
  id: string;
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
};

type AdvancedGroupProps = {
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
};

type ComparableEmbeddingDraft = {
  enabled: boolean;
  provider: string;
  model: string;
  fallback: string;
  remoteBaseUrl: string;
  inputType: string;
  queryInputType: string;
  documentInputType: string;
  outputDimensionality: string;
  localModelPath: string;
  localModelCacheDir: string;
  localContextSize: string;
  embeddingBatchTimeoutSeconds: string;
  sourcesText: string;
  extraPathsText: string;
  qmdExtraCollectionsJson: string;
  multimodalEnabled: BooleanDraft;
  multimodalModalitiesText: string;
  multimodalMaxFileBytes: string;
  experimentalSessionMemory: BooleanDraft;
  remoteHeadersJson: string;
  remoteNonBatchConcurrency: string;
  remoteBatchEnabled: BooleanDraft;
  remoteBatchWait: BooleanDraft;
  remoteBatchConcurrency: string;
  remoteBatchPollIntervalMs: string;
  remoteBatchTimeoutMinutes: string;
  storeDriver: string;
  storePath: string;
  storeFtsTokenizer: string;
  storeVectorEnabled: BooleanDraft;
  storeVectorExtensionPath: string;
  chunkingTokens: string;
  chunkingOverlap: string;
  syncOnSessionStart: BooleanDraft;
  syncOnSearch: BooleanDraft;
  syncWatch: BooleanDraft;
  syncWatchDebounceMs: string;
  syncIntervalMinutes: string;
  syncSessionsDeltaBytes: string;
  syncSessionsDeltaMessages: string;
  syncSessionsPostCompactionForce: BooleanDraft;
  queryMaxResults: string;
  queryMinScore: string;
  queryHybridEnabled: BooleanDraft;
  queryHybridVectorWeight: string;
  queryHybridTextWeight: string;
  queryHybridCandidateMultiplier: string;
  queryHybridMmrEnabled: BooleanDraft;
  queryHybridMmrLambda: string;
  queryHybridTemporalDecayEnabled: BooleanDraft;
  queryHybridTemporalDecayHalfLifeDays: string;
  cacheEnabled: BooleanDraft;
  cacheMaxEntries: string;
};

const inputClasses =
  'h-9 rounded-lg font-mono text-meta bg-surface-modal/70 border-border/75 hover:border-ring/35 focus-visible:border-ring/60 focus-visible:ring-0 shadow-sm transition-[background-color,border-color,color] text-foreground placeholder:text-muted-foreground/65';
const textareaClasses =
  'min-h-[92px] rounded-lg font-mono text-meta bg-surface-modal/70 border-border/75 hover:border-ring/35 focus-visible:border-ring/60 focus-visible:ring-0 shadow-sm transition-[background-color,border-color,color] text-foreground placeholder:text-muted-foreground/65';
const labelClasses = 'clawx-form-label';

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
  'openai-compatible': 'text-embedding-3-small',
  gemini: 'gemini-embedding-001',
  mistral: 'mistral-embed',
  voyage: 'voyage-4-large',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
};

const DEFAULT_LOCAL_MODEL_PATH =
  'hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf';

const BUILTIN_PROVIDER_IDS = [
  'openai',
  'openai-compatible',
  'gemini',
  'voyage',
  'mistral',
  'bedrock',
  'deepinfra',
  'github-copilot',
  'lmstudio',
  'ollama',
  'local',
  'none',
];

const MEMORY_SEARCH_SOURCES: MemorySearchSource[] = ['memory', 'sessions'];
const MEMORY_SEARCH_MODALITIES: MemorySearchModality[] = ['image', 'audio', 'all'];

function getDefaultModel(provider: string): string {
  return DEFAULT_PROVIDER_MODELS[provider.trim().toLowerCase()] ?? '';
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized || 'openai';
}

function normalizeText(value: string): string {
  return value.trim();
}

function formatNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function formatLines(values: string[]): string {
  return values.join('\n');
}

function parseLines(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatJson(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) return '';
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0
  ) {
    return '';
  }
  return JSON.stringify(value, null, 2);
}

function parseJsonDraft<T>(value: string, emptyValue: T): T {
  const trimmed = value.trim();
  if (!trimmed) return emptyValue;
  return JSON.parse(trimmed) as T;
}

function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new Error('invalid-positive-integer');
  }
  return parsed;
}

function parseNonNegativeIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== trimmed) {
    throw new Error('invalid-non-negative-integer');
  }
  return parsed;
}

function parseRatioDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1 || Number(trimmed) !== parsed) {
    throw new Error('invalid-ratio');
  }
  return parsed;
}

function parseBooleanDraft(value: BooleanDraft): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function formatBooleanDraft(value: boolean | null): BooleanDraft {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'default';
}

function parseSourceDraft(value: string): MemorySearchSource[] {
  const sources = parseLines(value);
  const invalid = sources.find((source) => !MEMORY_SEARCH_SOURCES.includes(source as MemorySearchSource));
  if (invalid) throw new Error('invalid-source');
  return sources as MemorySearchSource[];
}

function parseModalityDraft(value: string): MemorySearchModality[] {
  const modalities = parseLines(value);
  const invalid = modalities.find((modality) => !MEMORY_SEARCH_MODALITIES.includes(modality as MemorySearchModality));
  if (invalid) throw new Error('invalid-modality');
  return modalities as MemorySearchModality[];
}

function createComparableFromConfig(config: EmbeddingSettingsConfig): ComparableEmbeddingDraft {
  return {
    enabled: config.enabled,
    provider: normalizeProvider(config.provider),
    model: config.model || getDefaultModel(config.provider),
    fallback: (config.fallback || 'none').trim().toLowerCase(),
    remoteBaseUrl: config.remote.baseUrl || '',
    inputType: config.inputType || '',
    queryInputType: config.queryInputType || '',
    documentInputType: config.documentInputType || '',
    outputDimensionality: formatNumber(config.outputDimensionality),
    localModelPath: config.local.modelPath || '',
    localModelCacheDir: config.local.modelCacheDir || '',
    localContextSize: config.local.contextSize || '',
    embeddingBatchTimeoutSeconds: formatNumber(config.sync.embeddingBatchTimeoutSeconds),
    sourcesText: formatLines(config.advanced.sources),
    extraPathsText: formatLines(config.advanced.extraPaths),
    qmdExtraCollectionsJson: formatJson(config.advanced.qmd.extraCollections),
    multimodalEnabled: formatBooleanDraft(config.advanced.multimodal.enabled),
    multimodalModalitiesText: formatLines(config.advanced.multimodal.modalities),
    multimodalMaxFileBytes: formatNumber(config.advanced.multimodal.maxFileBytes),
    experimentalSessionMemory: formatBooleanDraft(config.advanced.experimental.sessionMemory),
    remoteHeadersJson: formatJson(config.remote.headers),
    remoteNonBatchConcurrency: formatNumber(config.remote.nonBatchConcurrency),
    remoteBatchEnabled: formatBooleanDraft(config.remote.batch.enabled),
    remoteBatchWait: formatBooleanDraft(config.remote.batch.wait),
    remoteBatchConcurrency: formatNumber(config.remote.batch.concurrency),
    remoteBatchPollIntervalMs: formatNumber(config.remote.batch.pollIntervalMs),
    remoteBatchTimeoutMinutes: formatNumber(config.remote.batch.timeoutMinutes),
    storeDriver: config.advanced.store.driver || '',
    storePath: config.advanced.store.path || '',
    storeFtsTokenizer: config.advanced.store.ftsTokenizer || '',
    storeVectorEnabled: formatBooleanDraft(config.advanced.store.vector.enabled),
    storeVectorExtensionPath: config.advanced.store.vector.extensionPath || '',
    chunkingTokens: formatNumber(config.advanced.chunking.tokens),
    chunkingOverlap: formatNumber(config.advanced.chunking.overlap),
    syncOnSessionStart: formatBooleanDraft(config.sync.onSessionStart),
    syncOnSearch: formatBooleanDraft(config.sync.onSearch),
    syncWatch: formatBooleanDraft(config.sync.watch),
    syncWatchDebounceMs: formatNumber(config.sync.watchDebounceMs),
    syncIntervalMinutes: formatNumber(config.sync.intervalMinutes),
    syncSessionsDeltaBytes: formatNumber(config.sync.sessions.deltaBytes),
    syncSessionsDeltaMessages: formatNumber(config.sync.sessions.deltaMessages),
    syncSessionsPostCompactionForce: formatBooleanDraft(config.sync.sessions.postCompactionForce),
    queryMaxResults: formatNumber(config.advanced.query.maxResults),
    queryMinScore: formatNumber(config.advanced.query.minScore),
    queryHybridEnabled: formatBooleanDraft(config.advanced.query.hybrid.enabled),
    queryHybridVectorWeight: formatNumber(config.advanced.query.hybrid.vectorWeight),
    queryHybridTextWeight: formatNumber(config.advanced.query.hybrid.textWeight),
    queryHybridCandidateMultiplier: formatNumber(config.advanced.query.hybrid.candidateMultiplier),
    queryHybridMmrEnabled: formatBooleanDraft(config.advanced.query.hybrid.mmr.enabled),
    queryHybridMmrLambda: formatNumber(config.advanced.query.hybrid.mmr.lambda),
    queryHybridTemporalDecayEnabled: formatBooleanDraft(config.advanced.query.hybrid.temporalDecay.enabled),
    queryHybridTemporalDecayHalfLifeDays: formatNumber(config.advanced.query.hybrid.temporalDecay.halfLifeDays),
    cacheEnabled: formatBooleanDraft(config.advanced.cache.enabled),
    cacheMaxEntries: formatNumber(config.advanced.cache.maxEntries),
  };
}

function AdvancedField({ id, label, hint, children, className }: AdvancedFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={id} className={labelClasses}>
        {label}
      </Label>
      {children}
      {hint ? (
        <p className="text-tiny leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function AdvancedGroup({ title, description, children, testId }: AdvancedGroupProps) {
  return (
    <div
      className="space-y-4 rounded-lg border border-border/60 bg-surface-input/45 p-4"
      data-testid={testId}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="text-meta leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function BooleanSelect({
  id,
  value,
  onChange,
  labels,
  testId,
}: {
  id: string;
  value: BooleanDraft;
  onChange: (value: BooleanDraft) => void;
  labels: { default: string; enabled: string; disabled: string };
  testId?: string;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as BooleanDraft)}
      className={inputClasses}
      data-testid={testId}
    >
      <option value="default">{labels.default}</option>
      <option value="true">{labels.enabled}</option>
      <option value="false">{labels.disabled}</option>
    </Select>
  );
}

function ProviderSuggestionInput({
  id,
  value,
  onChange,
  options,
  className,
  placeholder,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  className?: string;
  placeholder?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedValue = value.trim().toLowerCase();
  const listboxId = `${id}-suggestions`;
  const suggestions = useMemo(() => {
    const uniqueOptions = Array.from(new Set(options.map(normalizeProvider).filter(Boolean)));
    const filtered = normalizedValue
      ? uniqueOptions.filter((option) => option.includes(normalizedValue))
      : uniqueOptions;

    return filtered.length > 0 ? filtered : uniqueOptions;
  }, [normalizedValue, options]);
  const safeActiveIndex = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

  const selectSuggestion = useCallback((nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  }, [onChange]);

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && suggestions[safeActiveIndex] ? `${listboxId}-${suggestions[safeActiveIndex]}` : undefined}
        value={value}
        onFocus={() => {
          setActiveIndex(0);
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.min(current + 1, suggestions.length - 1));
            return;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => Math.max(current - 1, 0));
            return;
          }

          if (event.key === 'Enter' && open && suggestions[safeActiveIndex]) {
            event.preventDefault();
            selectSuggestion(suggestions[safeActiveIndex]);
            return;
          }

          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        className={className}
        placeholder={placeholder}
        data-testid={testId}
      />
      {open && suggestions.length > 0 && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-auto rounded-lg border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl shadow-black/10 backdrop-blur-xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 dark:shadow-black/35"
        >
          {suggestions.map((option, index) => (
            <button
              key={option}
              id={`${listboxId}-${option}`}
              type="button"
              role="option"
              aria-selected={option === normalizeProvider(value)}
              className={cn(
                'flex min-h-8 w-full items-center rounded-md px-2.5 py-1.5 text-left font-mono text-meta outline-none transition-[background-color,color] duration-150',
                index === activeIndex
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-surface-input',
                option === normalizeProvider(value) && 'text-primary',
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                selectSuggestion(option);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmbeddingSettings() {
  const { t } = useTranslation(['dashboard', 'settings', 'common']);
  const booleanLabels = useMemo(() => ({
    default: t('embeddings.advanced.booleanDefault'),
    enabled: t('embeddings.advanced.booleanEnabled'),
    disabled: t('embeddings.advanced.booleanDisabled'),
  }), [t]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [snapshot, setSnapshot] = useState<EmbeddingSettingsSnapshot | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState(DEFAULT_PROVIDER_MODELS.openai);
  const [fallback, setFallback] = useState('none');
  const [remoteBaseUrl, setRemoteBaseUrl] = useState('');
  const [remoteApiKey, setRemoteApiKey] = useState('');
  const [showRemoteApiKey, setShowRemoteApiKey] = useState(false);
  const [clearRemoteApiKey, setClearRemoteApiKey] = useState(false);
  const [inputType, setInputType] = useState('');
  const [queryInputType, setQueryInputType] = useState('');
  const [documentInputType, setDocumentInputType] = useState('');
  const [outputDimensionality, setOutputDimensionality] = useState('');
  const [localModelPath, setLocalModelPath] = useState('');
  const [localModelCacheDir, setLocalModelCacheDir] = useState('');
  const [localContextSize, setLocalContextSize] = useState('');
  const [embeddingBatchTimeoutSeconds, setEmbeddingBatchTimeoutSeconds] = useState('');

  const [sourcesText, setSourcesText] = useState('');
  const [extraPathsText, setExtraPathsText] = useState('');
  const [qmdExtraCollectionsJson, setQmdExtraCollectionsJson] = useState('');
  const [multimodalEnabled, setMultimodalEnabled] = useState<BooleanDraft>('default');
  const [multimodalModalitiesText, setMultimodalModalitiesText] = useState('');
  const [multimodalMaxFileBytes, setMultimodalMaxFileBytes] = useState('');
  const [experimentalSessionMemory, setExperimentalSessionMemory] = useState<BooleanDraft>('default');
  const [remoteHeadersJson, setRemoteHeadersJson] = useState('');
  const [remoteNonBatchConcurrency, setRemoteNonBatchConcurrency] = useState('');
  const [remoteBatchEnabled, setRemoteBatchEnabled] = useState<BooleanDraft>('default');
  const [remoteBatchWait, setRemoteBatchWait] = useState<BooleanDraft>('default');
  const [remoteBatchConcurrency, setRemoteBatchConcurrency] = useState('');
  const [remoteBatchPollIntervalMs, setRemoteBatchPollIntervalMs] = useState('');
  const [remoteBatchTimeoutMinutes, setRemoteBatchTimeoutMinutes] = useState('');
  const [storeDriver, setStoreDriver] = useState('');
  const [storePath, setStorePath] = useState('');
  const [storeFtsTokenizer, setStoreFtsTokenizer] = useState('');
  const [storeVectorEnabled, setStoreVectorEnabled] = useState<BooleanDraft>('default');
  const [storeVectorExtensionPath, setStoreVectorExtensionPath] = useState('');
  const [chunkingTokens, setChunkingTokens] = useState('');
  const [chunkingOverlap, setChunkingOverlap] = useState('');
  const [syncOnSessionStart, setSyncOnSessionStart] = useState<BooleanDraft>('default');
  const [syncOnSearch, setSyncOnSearch] = useState<BooleanDraft>('default');
  const [syncWatch, setSyncWatch] = useState<BooleanDraft>('default');
  const [syncWatchDebounceMs, setSyncWatchDebounceMs] = useState('');
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState('');
  const [syncSessionsDeltaBytes, setSyncSessionsDeltaBytes] = useState('');
  const [syncSessionsDeltaMessages, setSyncSessionsDeltaMessages] = useState('');
  const [syncSessionsPostCompactionForce, setSyncSessionsPostCompactionForce] = useState<BooleanDraft>('default');
  const [queryMaxResults, setQueryMaxResults] = useState('');
  const [queryMinScore, setQueryMinScore] = useState('');
  const [queryHybridEnabled, setQueryHybridEnabled] = useState<BooleanDraft>('default');
  const [queryHybridVectorWeight, setQueryHybridVectorWeight] = useState('');
  const [queryHybridTextWeight, setQueryHybridTextWeight] = useState('');
  const [queryHybridCandidateMultiplier, setQueryHybridCandidateMultiplier] = useState('');
  const [queryHybridMmrEnabled, setQueryHybridMmrEnabled] = useState<BooleanDraft>('default');
  const [queryHybridMmrLambda, setQueryHybridMmrLambda] = useState('');
  const [queryHybridTemporalDecayEnabled, setQueryHybridTemporalDecayEnabled] = useState<BooleanDraft>('default');
  const [queryHybridTemporalDecayHalfLifeDays, setQueryHybridTemporalDecayHalfLifeDays] = useState('');
  const [cacheEnabled, setCacheEnabled] = useState<BooleanDraft>('default');
  const [cacheMaxEntries, setCacheMaxEntries] = useState('');

  const applySnapshot = useCallback((settings: EmbeddingSettingsSnapshot) => {
    const config = settings.config;
    const comparable = createComparableFromConfig(config);
    setSnapshot(settings);
    setEnabled(comparable.enabled);
    setProvider(comparable.provider || 'openai');
    setModel(comparable.model || getDefaultModel(config.provider));
    setFallback(comparable.fallback || 'none');
    setRemoteBaseUrl(comparable.remoteBaseUrl);
    setRemoteApiKey('');
    setShowRemoteApiKey(false);
    setClearRemoteApiKey(false);
    setInputType(comparable.inputType);
    setQueryInputType(comparable.queryInputType);
    setDocumentInputType(comparable.documentInputType);
    setOutputDimensionality(comparable.outputDimensionality);
    setLocalModelPath(comparable.localModelPath);
    setLocalModelCacheDir(comparable.localModelCacheDir);
    setLocalContextSize(comparable.localContextSize);
    setEmbeddingBatchTimeoutSeconds(comparable.embeddingBatchTimeoutSeconds);
    setSourcesText(comparable.sourcesText);
    setExtraPathsText(comparable.extraPathsText);
    setQmdExtraCollectionsJson(comparable.qmdExtraCollectionsJson);
    setMultimodalEnabled(comparable.multimodalEnabled);
    setMultimodalModalitiesText(comparable.multimodalModalitiesText);
    setMultimodalMaxFileBytes(comparable.multimodalMaxFileBytes);
    setExperimentalSessionMemory(comparable.experimentalSessionMemory);
    setRemoteHeadersJson(comparable.remoteHeadersJson);
    setRemoteNonBatchConcurrency(comparable.remoteNonBatchConcurrency);
    setRemoteBatchEnabled(comparable.remoteBatchEnabled);
    setRemoteBatchWait(comparable.remoteBatchWait);
    setRemoteBatchConcurrency(comparable.remoteBatchConcurrency);
    setRemoteBatchPollIntervalMs(comparable.remoteBatchPollIntervalMs);
    setRemoteBatchTimeoutMinutes(comparable.remoteBatchTimeoutMinutes);
    setStoreDriver(comparable.storeDriver);
    setStorePath(comparable.storePath);
    setStoreFtsTokenizer(comparable.storeFtsTokenizer);
    setStoreVectorEnabled(comparable.storeVectorEnabled);
    setStoreVectorExtensionPath(comparable.storeVectorExtensionPath);
    setChunkingTokens(comparable.chunkingTokens);
    setChunkingOverlap(comparable.chunkingOverlap);
    setSyncOnSessionStart(comparable.syncOnSessionStart);
    setSyncOnSearch(comparable.syncOnSearch);
    setSyncWatch(comparable.syncWatch);
    setSyncWatchDebounceMs(comparable.syncWatchDebounceMs);
    setSyncIntervalMinutes(comparable.syncIntervalMinutes);
    setSyncSessionsDeltaBytes(comparable.syncSessionsDeltaBytes);
    setSyncSessionsDeltaMessages(comparable.syncSessionsDeltaMessages);
    setSyncSessionsPostCompactionForce(comparable.syncSessionsPostCompactionForce);
    setQueryMaxResults(comparable.queryMaxResults);
    setQueryMinScore(comparable.queryMinScore);
    setQueryHybridEnabled(comparable.queryHybridEnabled);
    setQueryHybridVectorWeight(comparable.queryHybridVectorWeight);
    setQueryHybridTextWeight(comparable.queryHybridTextWeight);
    setQueryHybridCandidateMultiplier(comparable.queryHybridCandidateMultiplier);
    setQueryHybridMmrEnabled(comparable.queryHybridMmrEnabled);
    setQueryHybridMmrLambda(comparable.queryHybridMmrLambda);
    setQueryHybridTemporalDecayEnabled(comparable.queryHybridTemporalDecayEnabled);
    setQueryHybridTemporalDecayHalfLifeDays(comparable.queryHybridTemporalDecayHalfLifeDays);
    setCacheEnabled(comparable.cacheEnabled);
    setCacheMaxEntries(comparable.cacheMaxEntries);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      applySnapshot(await fetchEmbeddingSettings());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    void load();
  }, [load]);

  const knownProviders = useMemo(() => {
    return Array.from(new Set([
      ...BUILTIN_PROVIDER_IDS,
      ...(snapshot?.knownProviders ?? []),
      normalizeProvider(provider),
    ])).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [provider, snapshot]);
  const fallbackProviderOptions = useMemo(() => {
    return Array.from(new Set(['none', ...knownProviders])).sort((a, b) => a.localeCompare(b));
  }, [knownProviders]);

  const currentProvider = normalizeProvider(provider);
  const showRemoteFields = currentProvider === 'openai-compatible'
    || Boolean(remoteBaseUrl.trim())
    || Boolean(snapshot?.config.remote.apiKeyConfigured)
    || Boolean(remoteHeadersJson.trim())
    || Boolean(remoteNonBatchConcurrency.trim());
  const showLocalFields = currentProvider === 'local'
    || Boolean(localModelPath.trim())
    || Boolean(localModelCacheDir.trim())
    || Boolean(localContextSize.trim());

  const currentComparable: ComparableEmbeddingDraft = {
    enabled,
    provider: normalizeProvider(provider),
    model: model.trim() || getDefaultModel(provider),
    fallback: (fallback.trim() || 'none').toLowerCase(),
    remoteBaseUrl: normalizeText(remoteBaseUrl),
    inputType: normalizeText(inputType),
    queryInputType: normalizeText(queryInputType),
    documentInputType: normalizeText(documentInputType),
    outputDimensionality: normalizeText(outputDimensionality),
    localModelPath: normalizeText(localModelPath),
    localModelCacheDir: normalizeText(localModelCacheDir),
    localContextSize: normalizeText(localContextSize),
    embeddingBatchTimeoutSeconds: normalizeText(embeddingBatchTimeoutSeconds),
    sourcesText: formatLines(parseLines(sourcesText)),
    extraPathsText: formatLines(parseLines(extraPathsText)),
    qmdExtraCollectionsJson: normalizeText(qmdExtraCollectionsJson),
    multimodalEnabled,
    multimodalModalitiesText: formatLines(parseLines(multimodalModalitiesText)),
    multimodalMaxFileBytes: normalizeText(multimodalMaxFileBytes),
    experimentalSessionMemory,
    remoteHeadersJson: normalizeText(remoteHeadersJson),
    remoteNonBatchConcurrency: normalizeText(remoteNonBatchConcurrency),
    remoteBatchEnabled,
    remoteBatchWait,
    remoteBatchConcurrency: normalizeText(remoteBatchConcurrency),
    remoteBatchPollIntervalMs: normalizeText(remoteBatchPollIntervalMs),
    remoteBatchTimeoutMinutes: normalizeText(remoteBatchTimeoutMinutes),
    storeDriver: normalizeText(storeDriver),
    storePath: normalizeText(storePath),
    storeFtsTokenizer: normalizeText(storeFtsTokenizer),
    storeVectorEnabled,
    storeVectorExtensionPath: normalizeText(storeVectorExtensionPath),
    chunkingTokens: normalizeText(chunkingTokens),
    chunkingOverlap: normalizeText(chunkingOverlap),
    syncOnSessionStart,
    syncOnSearch,
    syncWatch,
    syncWatchDebounceMs: normalizeText(syncWatchDebounceMs),
    syncIntervalMinutes: normalizeText(syncIntervalMinutes),
    syncSessionsDeltaBytes: normalizeText(syncSessionsDeltaBytes),
    syncSessionsDeltaMessages: normalizeText(syncSessionsDeltaMessages),
    syncSessionsPostCompactionForce,
    queryMaxResults: normalizeText(queryMaxResults),
    queryMinScore: normalizeText(queryMinScore),
    queryHybridEnabled,
    queryHybridVectorWeight: normalizeText(queryHybridVectorWeight),
    queryHybridTextWeight: normalizeText(queryHybridTextWeight),
    queryHybridCandidateMultiplier: normalizeText(queryHybridCandidateMultiplier),
    queryHybridMmrEnabled,
    queryHybridMmrLambda: normalizeText(queryHybridMmrLambda),
    queryHybridTemporalDecayEnabled,
    queryHybridTemporalDecayHalfLifeDays: normalizeText(queryHybridTemporalDecayHalfLifeDays),
    cacheEnabled,
    cacheMaxEntries: normalizeText(cacheMaxEntries),
  };

  const dirty = snapshot
    ? JSON.stringify(currentComparable) !== JSON.stringify(createComparableFromConfig(snapshot.config))
      || remoteApiKey.trim().length > 0
      || clearRemoteApiKey
    : false;

  const handleProviderChange = (nextProvider: string) => {
    const previousDefault = getDefaultModel(provider);
    const nextDefault = getDefaultModel(nextProvider);
    setProvider(nextProvider);
    if (!model.trim() || (previousDefault && model.trim() === previousDefault)) {
      setModel(nextDefault);
    }
    if (nextProvider.trim().toLowerCase() === 'local' && !localModelPath.trim()) {
      setLocalModelPath(DEFAULT_LOCAL_MODEL_PATH);
      if (!localContextSize.trim()) {
        setLocalContextSize('4096');
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const normalizedProvider = normalizeProvider(provider);
      if (!normalizedProvider) {
        throw new Error(t('embeddings.errors.providerRequired'));
      }
      if (normalizedProvider === 'openai-compatible' && !remoteBaseUrl.trim()) {
        throw new Error(t('embeddings.errors.remoteBaseUrlRequired'));
      }
      if (localContextSize.trim() && localContextSize.trim() !== 'auto') {
        parsePositiveIntegerDraft(localContextSize);
      }

      const remoteHeaders = parseJsonDraft<Record<string, string>>(remoteHeadersJson, {});
      const qmdExtraCollections = parseJsonDraft<MemorySearchQmdCollection[]>(qmdExtraCollectionsJson, []);

      const next = await saveEmbeddingSettings({
        enabled,
        provider: normalizedProvider,
        model: model.trim() || null,
        fallback: fallback.trim() || 'none',
        remoteBaseUrl: remoteBaseUrl.trim() || null,
        remoteApiKey: remoteApiKey.trim() || undefined,
        clearRemoteApiKey,
        inputType: inputType.trim() || null,
        queryInputType: queryInputType.trim() || null,
        documentInputType: documentInputType.trim() || null,
        outputDimensionality: parsePositiveIntegerDraft(outputDimensionality),
        localModelPath: localModelPath.trim() || null,
        localModelCacheDir: localModelCacheDir.trim() || null,
        localContextSize: localContextSize.trim() || null,
        embeddingBatchTimeoutSeconds: parsePositiveIntegerDraft(embeddingBatchTimeoutSeconds),
        sources: parseSourceDraft(sourcesText),
        extraPaths: parseLines(extraPathsText),
        qmdExtraCollections,
        multimodalEnabled: parseBooleanDraft(multimodalEnabled),
        multimodalModalities: parseModalityDraft(multimodalModalitiesText),
        multimodalMaxFileBytes: parsePositiveIntegerDraft(multimodalMaxFileBytes),
        experimentalSessionMemory: parseBooleanDraft(experimentalSessionMemory),
        remoteHeaders,
        remoteNonBatchConcurrency: parsePositiveIntegerDraft(remoteNonBatchConcurrency),
        remoteBatchEnabled: parseBooleanDraft(remoteBatchEnabled),
        remoteBatchWait: parseBooleanDraft(remoteBatchWait),
        remoteBatchConcurrency: parsePositiveIntegerDraft(remoteBatchConcurrency),
        remoteBatchPollIntervalMs: parseNonNegativeIntegerDraft(remoteBatchPollIntervalMs),
        remoteBatchTimeoutMinutes: parsePositiveIntegerDraft(remoteBatchTimeoutMinutes),
        storeDriver: storeDriver.trim() || null,
        storePath: storePath.trim() || null,
        storeFtsTokenizer: storeFtsTokenizer.trim() || null,
        storeVectorEnabled: parseBooleanDraft(storeVectorEnabled),
        storeVectorExtensionPath: storeVectorExtensionPath.trim() || null,
        chunkingTokens: parsePositiveIntegerDraft(chunkingTokens),
        chunkingOverlap: parseNonNegativeIntegerDraft(chunkingOverlap),
        syncOnSessionStart: parseBooleanDraft(syncOnSessionStart),
        syncOnSearch: parseBooleanDraft(syncOnSearch),
        syncWatch: parseBooleanDraft(syncWatch),
        syncWatchDebounceMs: parseNonNegativeIntegerDraft(syncWatchDebounceMs),
        syncIntervalMinutes: parseNonNegativeIntegerDraft(syncIntervalMinutes),
        syncSessionsDeltaBytes: parseNonNegativeIntegerDraft(syncSessionsDeltaBytes),
        syncSessionsDeltaMessages: parseNonNegativeIntegerDraft(syncSessionsDeltaMessages),
        syncSessionsPostCompactionForce: parseBooleanDraft(syncSessionsPostCompactionForce),
        queryMaxResults: parsePositiveIntegerDraft(queryMaxResults),
        queryMinScore: parseRatioDraft(queryMinScore),
        queryHybridEnabled: parseBooleanDraft(queryHybridEnabled),
        queryHybridVectorWeight: parseRatioDraft(queryHybridVectorWeight),
        queryHybridTextWeight: parseRatioDraft(queryHybridTextWeight),
        queryHybridCandidateMultiplier: parsePositiveIntegerDraft(queryHybridCandidateMultiplier),
        queryHybridMmrEnabled: parseBooleanDraft(queryHybridMmrEnabled),
        queryHybridMmrLambda: parseRatioDraft(queryHybridMmrLambda),
        queryHybridTemporalDecayEnabled: parseBooleanDraft(queryHybridTemporalDecayEnabled),
        queryHybridTemporalDecayHalfLifeDays: parsePositiveIntegerDraft(queryHybridTemporalDecayHalfLifeDays),
        cacheEnabled: parseBooleanDraft(cacheEnabled),
        cacheMaxEntries: parsePositiveIntegerDraft(cacheMaxEntries),
      });
      applySnapshot(next);
      toast.success(t('embeddings.toast.saved'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'invalid-positive-integer') {
        toast.error(t('embeddings.errors.positiveInteger'));
      } else if (message === 'invalid-non-negative-integer') {
        toast.error(t('embeddings.errors.nonNegativeInteger'));
      } else if (message === 'invalid-ratio') {
        toast.error(t('embeddings.errors.ratio'));
      } else if (message === 'invalid-source') {
        toast.error(t('embeddings.errors.source'));
      } else if (message === 'invalid-modality') {
        toast.error(t('embeddings.errors.modality'));
      } else if (error instanceof SyntaxError) {
        toast.error(t('embeddings.errors.json'));
      } else {
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      applySnapshot(await clearEmbeddingSettings());
      setClearConfirmOpen(false);
      toast.success(t('embeddings.toast.cleared'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div data-testid="embedding-settings" className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            data-testid="embedding-settings-title"
            className="clawx-section-title flex items-center gap-2"
          >
            <BrainCircuit className="h-5 w-5 text-muted-foreground" />
            {t('embeddings.title')}
          </h2>
          <p className="text-meta text-muted-foreground mt-2 max-w-2xl">
            {t('embeddings.description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 rounded-lg"
          onClick={() => void load()}
          disabled={loading}
          data-testid="embedding-refresh"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border/55 bg-surface-input/70 py-10 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="space-y-6 rounded-lg border border-border/65 bg-surface-modal/90 p-5 shadow-sm shadow-black/5 dark:shadow-black/20">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border/65 bg-surface-input/45 p-4">
            <div>
              <Label htmlFor="embedding-enabled" className={labelClasses}>
                {t('embeddings.enabled')}
              </Label>
              <p className="text-meta text-muted-foreground mt-1">
                {t('embeddings.enabledDesc')}
              </p>
            </div>
            <Switch
              id="embedding-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="embedding-enabled"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <AdvancedField
              id="embedding-provider"
              label={t('embeddings.provider')}
              hint={t('embeddings.providerHint')}
            >
              <ProviderSuggestionInput
                id="embedding-provider"
                value={provider}
                onChange={handleProviderChange}
                options={knownProviders}
                className={inputClasses}
                placeholder="openai"
                testId="embedding-provider"
              />
            </AdvancedField>

            <AdvancedField
              id="embedding-model"
              label={t('embeddings.model')}
              hint={t('embeddings.modelHint')}
            >
              <Input
                id="embedding-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className={inputClasses}
                placeholder={getDefaultModel(currentProvider) || 'text-embedding-3-small'}
                data-testid="embedding-model"
              />
            </AdvancedField>

            <AdvancedField id="embedding-fallback" label={t('embeddings.fallback')}>
              <ProviderSuggestionInput
                id="embedding-fallback"
                value={fallback}
                onChange={setFallback}
                options={fallbackProviderOptions}
                className={inputClasses}
                placeholder="none"
                testId="embedding-fallback"
              />
            </AdvancedField>

            <AdvancedField id="embedding-output-dimensionality" label={t('embeddings.outputDimensionality')}>
              <Input
                id="embedding-output-dimensionality"
                type="number"
                min={1}
                step={1}
                value={outputDimensionality}
                onChange={(event) => setOutputDimensionality(event.target.value)}
                className={inputClasses}
                placeholder="1536"
                data-testid="embedding-output-dimensionality"
              />
            </AdvancedField>
          </div>

          {showRemoteFields ? (
            <AdvancedGroup
              title={t('embeddings.remote.title')}
              description={t('embeddings.remote.description')}
              testId="embedding-remote-section"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <AdvancedField id="embedding-remote-base-url" label={t('embeddings.remote.baseUrl')}>
                  <Input
                    id="embedding-remote-base-url"
                    value={remoteBaseUrl}
                    onChange={(event) => setRemoteBaseUrl(event.target.value)}
                    className={inputClasses}
                    placeholder="https://api.example.com/v1"
                    data-testid="embedding-remote-base-url"
                  />
                </AdvancedField>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label htmlFor="embedding-remote-api-key" className={labelClasses}>
                        {snapshot?.config.remote.apiKeyConfigured
                          ? t('settings:aiProviders.dialog.replaceApiKey')
                          : t('embeddings.remote.apiKey')}
                      </Label>
                      <p className="text-xs text-muted-foreground" data-testid="embedding-api-key-status">
                        {snapshot?.config.remote.apiKeyConfigured
                          ? t('settings:aiProviders.dialog.apiKeyConfigured')
                          : t('settings:aiProviders.dialog.apiKeyMissing')}
                      </p>
                    </div>
                    {snapshot?.config.remote.apiKeyConfigured ? (
                      <Button
                        type="button"
                        variant={clearRemoteApiKey ? 'secondary' : 'outline'}
                        size="sm"
                        className="rounded-lg"
                        onClick={() => setClearRemoteApiKey((value) => !value)}
                        data-testid="embedding-clear-api-key"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                        {clearRemoteApiKey
                          ? t('embeddings.remote.keepKey')
                          : t('embeddings.remote.clearKey')}
                      </Button>
                    ) : null}
                  </div>
                  <div className="relative">
                    <Input
                      id="embedding-remote-api-key"
                      type={showRemoteApiKey ? 'text' : 'password'}
                      value={remoteApiKey}
                      onChange={(event) => setRemoteApiKey(event.target.value)}
                      disabled={clearRemoteApiKey}
                      className={cn(inputClasses, 'pr-10')}
                      placeholder={
                        snapshot?.config.remote.apiKeyConfigured
                          ? t('settings:aiProviders.dialog.replaceApiKeyHelp')
                          : 'sk-...'
                      }
                      autoComplete="off"
                      data-testid="embedding-remote-api-key"
                    />
                    <button
                      type="button"
                      onClick={() => setShowRemoteApiKey((value) => !value)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                      disabled={clearRemoteApiKey}
                    >
                      {showRemoteApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <AdvancedField id="embedding-input-type" label={t('embeddings.inputType')}>
                  <Input
                    id="embedding-input-type"
                    value={inputType}
                    onChange={(event) => setInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="passage"
                    data-testid="embedding-input-type"
                  />
                </AdvancedField>
                <AdvancedField id="embedding-query-input-type" label={t('embeddings.queryInputType')}>
                  <Input
                    id="embedding-query-input-type"
                    value={queryInputType}
                    onChange={(event) => setQueryInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="query"
                    data-testid="embedding-query-input-type"
                  />
                </AdvancedField>
                <AdvancedField id="embedding-document-input-type" label={t('embeddings.documentInputType')}>
                  <Input
                    id="embedding-document-input-type"
                    value={documentInputType}
                    onChange={(event) => setDocumentInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="passage"
                    data-testid="embedding-document-input-type"
                  />
                </AdvancedField>
              </div>
            </AdvancedGroup>
          ) : null}

          {showLocalFields ? (
            <AdvancedGroup
              title={t('embeddings.local.title')}
              description={t('embeddings.local.description')}
              testId="embedding-local-section"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <AdvancedField
                  id="embedding-local-model-path"
                  label={t('embeddings.local.modelPath')}
                  className="md:col-span-2"
                >
                  <Input
                    id="embedding-local-model-path"
                    value={localModelPath}
                    onChange={(event) => setLocalModelPath(event.target.value)}
                    className={inputClasses}
                    placeholder={DEFAULT_LOCAL_MODEL_PATH}
                    data-testid="embedding-local-model-path"
                  />
                </AdvancedField>
                <AdvancedField id="embedding-local-cache-dir" label={t('embeddings.local.modelCacheDir')}>
                  <Input
                    id="embedding-local-cache-dir"
                    value={localModelCacheDir}
                    onChange={(event) => setLocalModelCacheDir(event.target.value)}
                    className={inputClasses}
                    placeholder="~/.cache/openclaw/embeddings"
                    data-testid="embedding-local-cache-dir"
                  />
                </AdvancedField>
                <AdvancedField id="embedding-local-context-size" label={t('embeddings.local.contextSize')}>
                  <Input
                    id="embedding-local-context-size"
                    value={localContextSize}
                    onChange={(event) => setLocalContextSize(event.target.value)}
                    className={inputClasses}
                    placeholder="4096"
                    data-testid="embedding-local-context-size"
                  />
                </AdvancedField>
              </div>
            </AdvancedGroup>
          ) : null}

          <AdvancedGroup
            title={t('embeddings.advanced.sourcesTitle')}
            description={t('embeddings.advanced.sourcesDescription')}
            testId="embedding-advanced-section"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <AdvancedField
                id="embedding-sources"
                label={t('embeddings.advanced.sources')}
                hint={t('embeddings.advanced.sourcesHint')}
              >
                <Textarea
                  id="embedding-sources"
                  value={sourcesText}
                  onChange={(event) => setSourcesText(event.target.value)}
                  className={textareaClasses}
                  placeholder={'memory\nsessions'}
                  data-testid="embedding-sources"
                />
              </AdvancedField>
              <AdvancedField
                id="embedding-extra-paths"
                label={t('embeddings.advanced.extraPaths')}
                hint={t('embeddings.advanced.extraPathsHint')}
              >
                <Textarea
                  id="embedding-extra-paths"
                  value={extraPathsText}
                  onChange={(event) => setExtraPathsText(event.target.value)}
                  className={textareaClasses}
                  placeholder={'~/knowledge\n../shared-notes'}
                  data-testid="embedding-extra-paths"
                />
              </AdvancedField>
              <AdvancedField
                id="embedding-qmd-collections"
                label={t('embeddings.advanced.qmdCollections')}
                hint={t('embeddings.advanced.qmdCollectionsHint')}
                className="md:col-span-2"
              >
                <Textarea
                  id="embedding-qmd-collections"
                  value={qmdExtraCollectionsJson}
                  onChange={(event) => setQmdExtraCollectionsJson(event.target.value)}
                  className={cn(textareaClasses, 'min-h-[118px]')}
                  placeholder={'[\n  {"path":"~/notes","name":"Notes","pattern":"**/*.qmd"}\n]'}
                  data-testid="embedding-qmd-collections"
                />
              </AdvancedField>
            </div>
          </AdvancedGroup>

          <AdvancedGroup
            title={t('embeddings.advanced.remoteTitle')}
            description={t('embeddings.advanced.remoteDescription')}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <AdvancedField
                id="embedding-remote-headers"
                label={t('embeddings.advanced.remoteHeaders')}
                hint={t('embeddings.advanced.remoteHeadersHint')}
                className="md:col-span-2"
              >
                <Textarea
                  id="embedding-remote-headers"
                  value={remoteHeadersJson}
                  onChange={(event) => setRemoteHeadersJson(event.target.value)}
                  className={textareaClasses}
                  placeholder={'{\n  "X-Provider": "memory"\n}'}
                  data-testid="embedding-remote-headers"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-non-batch-concurrency" label={t('embeddings.advanced.nonBatchConcurrency')}>
                <Input
                  id="embedding-remote-non-batch-concurrency"
                  type="number"
                  min={1}
                  step={1}
                  value={remoteNonBatchConcurrency}
                  onChange={(event) => setRemoteNonBatchConcurrency(event.target.value)}
                  className={inputClasses}
                  placeholder="4"
                  data-testid="embedding-remote-non-batch-concurrency"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-batch-enabled" label={t('embeddings.advanced.batchEnabled')}>
                <BooleanSelect
                  id="embedding-remote-batch-enabled"
                  value={remoteBatchEnabled}
                  onChange={setRemoteBatchEnabled}
                  labels={booleanLabels}
                  testId="embedding-remote-batch-enabled"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-batch-wait" label={t('embeddings.advanced.batchWait')}>
                <BooleanSelect
                  id="embedding-remote-batch-wait"
                  value={remoteBatchWait}
                  onChange={setRemoteBatchWait}
                  labels={booleanLabels}
                  testId="embedding-remote-batch-wait"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-batch-concurrency" label={t('embeddings.advanced.batchConcurrency')}>
                <Input
                  id="embedding-remote-batch-concurrency"
                  type="number"
                  min={1}
                  step={1}
                  value={remoteBatchConcurrency}
                  onChange={(event) => setRemoteBatchConcurrency(event.target.value)}
                  className={inputClasses}
                  placeholder="2"
                  data-testid="embedding-remote-batch-concurrency"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-batch-poll" label={t('embeddings.advanced.batchPollInterval')}>
                <Input
                  id="embedding-remote-batch-poll"
                  type="number"
                  min={0}
                  step={1}
                  value={remoteBatchPollIntervalMs}
                  onChange={(event) => setRemoteBatchPollIntervalMs(event.target.value)}
                  className={inputClasses}
                  placeholder="1000"
                  data-testid="embedding-remote-batch-poll"
                />
              </AdvancedField>
              <AdvancedField id="embedding-remote-batch-timeout-minutes" label={t('embeddings.advanced.batchTimeoutMinutes')}>
                <Input
                  id="embedding-remote-batch-timeout-minutes"
                  type="number"
                  min={1}
                  step={1}
                  value={remoteBatchTimeoutMinutes}
                  onChange={(event) => setRemoteBatchTimeoutMinutes(event.target.value)}
                  className={inputClasses}
                  placeholder="30"
                  data-testid="embedding-remote-batch-timeout-minutes"
                />
              </AdvancedField>
            </div>
          </AdvancedGroup>

          <AdvancedGroup
            title={t('embeddings.advanced.multimodalTitle')}
            description={t('embeddings.advanced.multimodalDescription')}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <AdvancedField id="embedding-multimodal-enabled" label={t('embeddings.advanced.multimodalEnabled')}>
                <BooleanSelect
                  id="embedding-multimodal-enabled"
                  value={multimodalEnabled}
                  onChange={setMultimodalEnabled}
                  labels={booleanLabels}
                  testId="embedding-multimodal-enabled"
                />
              </AdvancedField>
              <AdvancedField
                id="embedding-multimodal-modalities"
                label={t('embeddings.advanced.multimodalModalities')}
                hint={t('embeddings.advanced.multimodalModalitiesHint')}
              >
                <Input
                  id="embedding-multimodal-modalities"
                  value={multimodalModalitiesText}
                  onChange={(event) => setMultimodalModalitiesText(event.target.value)}
                  className={inputClasses}
                  placeholder="image, audio, all"
                  data-testid="embedding-multimodal-modalities"
                />
              </AdvancedField>
              <AdvancedField id="embedding-multimodal-max-file-bytes" label={t('embeddings.advanced.multimodalMaxFileBytes')}>
                <Input
                  id="embedding-multimodal-max-file-bytes"
                  type="number"
                  min={1}
                  step={1}
                  value={multimodalMaxFileBytes}
                  onChange={(event) => setMultimodalMaxFileBytes(event.target.value)}
                  className={inputClasses}
                  placeholder="10485760"
                  data-testid="embedding-multimodal-max-file-bytes"
                />
              </AdvancedField>
              <AdvancedField id="embedding-session-memory" label={t('embeddings.advanced.sessionMemory')}>
                <BooleanSelect
                  id="embedding-session-memory"
                  value={experimentalSessionMemory}
                  onChange={setExperimentalSessionMemory}
                  labels={booleanLabels}
                  testId="embedding-session-memory"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-on-session-start" label={t('embeddings.advanced.syncOnSessionStart')}>
                <BooleanSelect
                  id="embedding-sync-on-session-start"
                  value={syncOnSessionStart}
                  onChange={setSyncOnSessionStart}
                  labels={booleanLabels}
                  testId="embedding-sync-on-session-start"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-on-search" label={t('embeddings.advanced.syncOnSearch')}>
                <BooleanSelect
                  id="embedding-sync-on-search"
                  value={syncOnSearch}
                  onChange={setSyncOnSearch}
                  labels={booleanLabels}
                  testId="embedding-sync-on-search"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-watch" label={t('embeddings.advanced.syncWatch')}>
                <BooleanSelect
                  id="embedding-sync-watch"
                  value={syncWatch}
                  onChange={setSyncWatch}
                  labels={booleanLabels}
                  testId="embedding-sync-watch"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-watch-debounce" label={t('embeddings.advanced.watchDebounceMs')}>
                <Input
                  id="embedding-sync-watch-debounce"
                  type="number"
                  min={0}
                  step={1}
                  value={syncWatchDebounceMs}
                  onChange={(event) => setSyncWatchDebounceMs(event.target.value)}
                  className={inputClasses}
                  placeholder="500"
                  data-testid="embedding-sync-watch-debounce"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-interval" label={t('embeddings.advanced.syncIntervalMinutes')}>
                <Input
                  id="embedding-sync-interval"
                  type="number"
                  min={0}
                  step={1}
                  value={syncIntervalMinutes}
                  onChange={(event) => setSyncIntervalMinutes(event.target.value)}
                  className={inputClasses}
                  placeholder="15"
                  data-testid="embedding-sync-interval"
                />
              </AdvancedField>
              <AdvancedField id="embedding-batch-timeout" label={t('embeddings.batchTimeout')}>
                <Input
                  id="embedding-batch-timeout"
                  type="number"
                  min={1}
                  step={1}
                  value={embeddingBatchTimeoutSeconds}
                  onChange={(event) => setEmbeddingBatchTimeoutSeconds(event.target.value)}
                  className={inputClasses}
                  placeholder="120"
                  data-testid="embedding-batch-timeout"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-delta-bytes" label={t('embeddings.advanced.sessionDeltaBytes')}>
                <Input
                  id="embedding-sync-delta-bytes"
                  type="number"
                  min={0}
                  step={1}
                  value={syncSessionsDeltaBytes}
                  onChange={(event) => setSyncSessionsDeltaBytes(event.target.value)}
                  className={inputClasses}
                  placeholder="4096"
                  data-testid="embedding-sync-delta-bytes"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-delta-messages" label={t('embeddings.advanced.sessionDeltaMessages')}>
                <Input
                  id="embedding-sync-delta-messages"
                  type="number"
                  min={0}
                  step={1}
                  value={syncSessionsDeltaMessages}
                  onChange={(event) => setSyncSessionsDeltaMessages(event.target.value)}
                  className={inputClasses}
                  placeholder="8"
                  data-testid="embedding-sync-delta-messages"
                />
              </AdvancedField>
              <AdvancedField id="embedding-sync-post-compaction" label={t('embeddings.advanced.postCompactionForce')}>
                <BooleanSelect
                  id="embedding-sync-post-compaction"
                  value={syncSessionsPostCompactionForce}
                  onChange={setSyncSessionsPostCompactionForce}
                  labels={booleanLabels}
                  testId="embedding-sync-post-compaction"
                />
              </AdvancedField>
            </div>
          </AdvancedGroup>

          <AdvancedGroup
            title={t('embeddings.advanced.storageTitle')}
            description={t('embeddings.advanced.storageDescription')}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <AdvancedField id="embedding-store-driver" label={t('embeddings.advanced.storeDriver')}>
                <Select
                  id="embedding-store-driver"
                  value={storeDriver}
                  onChange={(event) => setStoreDriver(event.target.value)}
                  className={inputClasses}
                  data-testid="embedding-store-driver"
                >
                  <option value="">{t('embeddings.advanced.defaultValue')}</option>
                  <option value="sqlite">sqlite</option>
                </Select>
              </AdvancedField>
              <AdvancedField id="embedding-store-path" label={t('embeddings.advanced.storePath')}>
                <Input
                  id="embedding-store-path"
                  value={storePath}
                  onChange={(event) => setStorePath(event.target.value)}
                  className={inputClasses}
                  placeholder="~/.clawx/kernel-cache/openclaw/memory/search.sqlite"
                  data-testid="embedding-store-path"
                />
              </AdvancedField>
              <AdvancedField id="embedding-fts-tokenizer" label={t('embeddings.advanced.ftsTokenizer')}>
                <Select
                  id="embedding-fts-tokenizer"
                  value={storeFtsTokenizer}
                  onChange={(event) => setStoreFtsTokenizer(event.target.value)}
                  className={inputClasses}
                  data-testid="embedding-fts-tokenizer"
                >
                  <option value="">{t('embeddings.advanced.defaultValue')}</option>
                  <option value="unicode61">unicode61</option>
                  <option value="trigram">trigram</option>
                </Select>
              </AdvancedField>
              <AdvancedField id="embedding-store-vector-enabled" label={t('embeddings.advanced.vectorEnabled')}>
                <BooleanSelect
                  id="embedding-store-vector-enabled"
                  value={storeVectorEnabled}
                  onChange={setStoreVectorEnabled}
                  labels={booleanLabels}
                  testId="embedding-store-vector-enabled"
                />
              </AdvancedField>
              <AdvancedField id="embedding-store-vector-extension" label={t('embeddings.advanced.vectorExtensionPath')}>
                <Input
                  id="embedding-store-vector-extension"
                  value={storeVectorExtensionPath}
                  onChange={(event) => setStoreVectorExtensionPath(event.target.value)}
                  className={inputClasses}
                  placeholder="/usr/local/lib/sqlite-vec.dylib"
                  data-testid="embedding-store-vector-extension"
                />
              </AdvancedField>
              <AdvancedField id="embedding-chunking-tokens" label={t('embeddings.advanced.chunkingTokens')}>
                <Input
                  id="embedding-chunking-tokens"
                  type="number"
                  min={1}
                  step={1}
                  value={chunkingTokens}
                  onChange={(event) => setChunkingTokens(event.target.value)}
                  className={inputClasses}
                  placeholder="512"
                  data-testid="embedding-chunking-tokens"
                />
              </AdvancedField>
              <AdvancedField id="embedding-chunking-overlap" label={t('embeddings.advanced.chunkingOverlap')}>
                <Input
                  id="embedding-chunking-overlap"
                  type="number"
                  min={0}
                  step={1}
                  value={chunkingOverlap}
                  onChange={(event) => setChunkingOverlap(event.target.value)}
                  className={inputClasses}
                  placeholder="64"
                  data-testid="embedding-chunking-overlap"
                />
              </AdvancedField>
            </div>
          </AdvancedGroup>

          <AdvancedGroup
            title={t('embeddings.advanced.queryTitle')}
            description={t('embeddings.advanced.queryDescription')}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <AdvancedField id="embedding-query-max-results" label={t('embeddings.advanced.queryMaxResults')}>
                <Input
                  id="embedding-query-max-results"
                  type="number"
                  min={1}
                  step={1}
                  value={queryMaxResults}
                  onChange={(event) => setQueryMaxResults(event.target.value)}
                  className={inputClasses}
                  placeholder="8"
                  data-testid="embedding-query-max-results"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-min-score" label={t('embeddings.advanced.queryMinScore')}>
                <Input
                  id="embedding-query-min-score"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={queryMinScore}
                  onChange={(event) => setQueryMinScore(event.target.value)}
                  className={inputClasses}
                  placeholder="0.2"
                  data-testid="embedding-query-min-score"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-hybrid-enabled" label={t('embeddings.advanced.hybridEnabled')}>
                <BooleanSelect
                  id="embedding-query-hybrid-enabled"
                  value={queryHybridEnabled}
                  onChange={setQueryHybridEnabled}
                  labels={booleanLabels}
                  testId="embedding-query-hybrid-enabled"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-vector-weight" label={t('embeddings.advanced.vectorWeight')}>
                <Input
                  id="embedding-query-vector-weight"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={queryHybridVectorWeight}
                  onChange={(event) => setQueryHybridVectorWeight(event.target.value)}
                  className={inputClasses}
                  placeholder="0.7"
                  data-testid="embedding-query-vector-weight"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-text-weight" label={t('embeddings.advanced.textWeight')}>
                <Input
                  id="embedding-query-text-weight"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={queryHybridTextWeight}
                  onChange={(event) => setQueryHybridTextWeight(event.target.value)}
                  className={inputClasses}
                  placeholder="0.3"
                  data-testid="embedding-query-text-weight"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-candidate-multiplier" label={t('embeddings.advanced.candidateMultiplier')}>
                <Input
                  id="embedding-query-candidate-multiplier"
                  type="number"
                  min={1}
                  step={1}
                  value={queryHybridCandidateMultiplier}
                  onChange={(event) => setQueryHybridCandidateMultiplier(event.target.value)}
                  className={inputClasses}
                  placeholder="4"
                  data-testid="embedding-query-candidate-multiplier"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-mmr-enabled" label={t('embeddings.advanced.mmrEnabled')}>
                <BooleanSelect
                  id="embedding-query-mmr-enabled"
                  value={queryHybridMmrEnabled}
                  onChange={setQueryHybridMmrEnabled}
                  labels={booleanLabels}
                  testId="embedding-query-mmr-enabled"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-mmr-lambda" label={t('embeddings.advanced.mmrLambda')}>
                <Input
                  id="embedding-query-mmr-lambda"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={queryHybridMmrLambda}
                  onChange={(event) => setQueryHybridMmrLambda(event.target.value)}
                  className={inputClasses}
                  placeholder="0.5"
                  data-testid="embedding-query-mmr-lambda"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-temporal-decay" label={t('embeddings.advanced.temporalDecayEnabled')}>
                <BooleanSelect
                  id="embedding-query-temporal-decay"
                  value={queryHybridTemporalDecayEnabled}
                  onChange={setQueryHybridTemporalDecayEnabled}
                  labels={booleanLabels}
                  testId="embedding-query-temporal-decay"
                />
              </AdvancedField>
              <AdvancedField id="embedding-query-temporal-half-life" label={t('embeddings.advanced.temporalHalfLifeDays')}>
                <Input
                  id="embedding-query-temporal-half-life"
                  type="number"
                  min={1}
                  step={1}
                  value={queryHybridTemporalDecayHalfLifeDays}
                  onChange={(event) => setQueryHybridTemporalDecayHalfLifeDays(event.target.value)}
                  className={inputClasses}
                  placeholder="30"
                  data-testid="embedding-query-temporal-half-life"
                />
              </AdvancedField>
              <AdvancedField id="embedding-cache-enabled" label={t('embeddings.advanced.cacheEnabled')}>
                <BooleanSelect
                  id="embedding-cache-enabled"
                  value={cacheEnabled}
                  onChange={setCacheEnabled}
                  labels={booleanLabels}
                  testId="embedding-cache-enabled"
                />
              </AdvancedField>
              <AdvancedField id="embedding-cache-max-entries" label={t('embeddings.advanced.cacheMaxEntries')}>
                <Input
                  id="embedding-cache-max-entries"
                  type="number"
                  min={1}
                  step={1}
                  value={cacheMaxEntries}
                  onChange={(event) => setCacheMaxEntries(event.target.value)}
                  className={inputClasses}
                  placeholder="512"
                  data-testid="embedding-cache-max-entries"
                />
              </AdvancedField>
            </div>
          </AdvancedGroup>

          <div className="flex flex-wrap items-center gap-3 border-t border-border/65 pt-4">
            <Button
              className="h-9 rounded-lg"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              data-testid="embedding-save"
            >
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {saving ? t('embeddings.saving') : t('embeddings.save')}
            </Button>
            <Button
              variant="outline"
              className="h-9 rounded-lg text-destructive hover:text-destructive"
              onClick={() => setClearConfirmOpen(true)}
              disabled={clearing || !snapshot?.configured}
              data-testid="embedding-clear"
            >
              {clearing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              {clearing ? t('embeddings.clearing') : t('embeddings.clear')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={clearConfirmOpen}
        title={t('embeddings.clearConfirmTitle')}
        message={t('embeddings.clearConfirmMessage')}
        confirmLabel={t('embeddings.clearConfirmAction')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={handleClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}
