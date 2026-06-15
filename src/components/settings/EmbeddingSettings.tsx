/**
 * Global memory embedding settings (agents.defaults.memorySearch).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrainCircuit, Eye, EyeOff, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  clearEmbeddingSettings,
  fetchEmbeddingSettings,
  saveEmbeddingSettings,
  type EmbeddingSettingsSnapshot,
} from '@/lib/embeddings';
import { cn } from '@/lib/utils';

const inputClasses =
  'h-9 rounded-lg font-mono text-meta bg-surface-modal/70 border-border/75 hover:border-ring/35 focus-visible:border-ring/60 focus-visible:ring-0 shadow-sm transition-[background-color,border-color,color] text-foreground placeholder:text-muted-foreground/65';
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

function getDefaultModel(provider: string): string {
  return DEFAULT_PROVIDER_MODELS[provider.trim().toLowerCase()] ?? '';
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized || 'openai';
}

function parsePositiveIntegerDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    throw new Error('invalid');
  }
  return parsed;
}

export function EmbeddingSettings() {
  const { t } = useTranslation(['dashboard', 'settings', 'common']);
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

  const applySnapshot = useCallback((settings: EmbeddingSettingsSnapshot) => {
    const config = settings.config;
    setSnapshot(settings);
    setEnabled(config.enabled);
    setProvider(config.provider || 'openai');
    setModel(config.model || getDefaultModel(config.provider));
    setFallback(config.fallback || 'none');
    setRemoteBaseUrl(config.remote.baseUrl || '');
    setRemoteApiKey('');
    setShowRemoteApiKey(false);
    setClearRemoteApiKey(false);
    setInputType(config.inputType || '');
    setQueryInputType(config.queryInputType || '');
    setDocumentInputType(config.documentInputType || '');
    setOutputDimensionality(config.outputDimensionality ? String(config.outputDimensionality) : '');
    setLocalModelPath(config.local.modelPath || '');
    setLocalModelCacheDir(config.local.modelCacheDir || '');
    setLocalContextSize(config.local.contextSize || '');
    setEmbeddingBatchTimeoutSeconds(config.sync.embeddingBatchTimeoutSeconds
      ? String(config.sync.embeddingBatchTimeoutSeconds)
      : '');
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

  const currentProvider = normalizeProvider(provider);
  const showRemoteFields = currentProvider === 'openai-compatible'
    || Boolean(remoteBaseUrl.trim())
    || Boolean(snapshot?.config.remote.apiKeyConfigured);
  const showLocalFields = currentProvider === 'local'
    || Boolean(localModelPath.trim())
    || Boolean(localModelCacheDir.trim())
    || Boolean(localContextSize.trim());

  const dirty = useMemo(() => {
    if (!snapshot) return false;
    const config = snapshot.config;
    const outputDimensionalityParsed = outputDimensionality.trim()
      ? Number.parseInt(outputDimensionality.trim(), 10)
      : null;
    const timeoutParsed = embeddingBatchTimeoutSeconds.trim()
      ? Number.parseInt(embeddingBatchTimeoutSeconds.trim(), 10)
      : null;

    return (
      enabled !== config.enabled
      || normalizeProvider(provider) !== normalizeProvider(config.provider)
      || model.trim() !== (config.model || getDefaultModel(config.provider)).trim()
      || fallback.trim().toLowerCase() !== (config.fallback || 'none').trim().toLowerCase()
      || remoteBaseUrl.trim() !== (config.remote.baseUrl || '').trim()
      || remoteApiKey.trim().length > 0
      || clearRemoteApiKey
      || inputType.trim() !== (config.inputType || '').trim()
      || queryInputType.trim() !== (config.queryInputType || '').trim()
      || documentInputType.trim() !== (config.documentInputType || '').trim()
      || outputDimensionalityParsed !== config.outputDimensionality
      || localModelPath.trim() !== (config.local.modelPath || '').trim()
      || localModelCacheDir.trim() !== (config.local.modelCacheDir || '').trim()
      || localContextSize.trim() !== (config.local.contextSize || '').trim()
      || timeoutParsed !== config.sync.embeddingBatchTimeoutSeconds
    );
  }, [
    clearRemoteApiKey,
    documentInputType,
    embeddingBatchTimeoutSeconds,
    enabled,
    fallback,
    inputType,
    localContextSize,
    localModelCacheDir,
    localModelPath,
    model,
    outputDimensionality,
    provider,
    queryInputType,
    remoteApiKey,
    remoteBaseUrl,
    snapshot,
  ]);

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
      const outputDimensionalityParsed = parsePositiveIntegerDraft(outputDimensionality);
      const timeoutParsed = parsePositiveIntegerDraft(embeddingBatchTimeoutSeconds);
      if (localContextSize.trim() && localContextSize.trim() !== 'auto') {
        parsePositiveIntegerDraft(localContextSize);
      }
      if (normalizedProvider === 'openai-compatible' && !remoteBaseUrl.trim()) {
        throw new Error(t('embeddings.errors.remoteBaseUrlRequired'));
      }

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
        outputDimensionality: outputDimensionalityParsed,
        localModelPath: localModelPath.trim() || null,
        localModelCacheDir: localModelCacheDir.trim() || null,
        localContextSize: localContextSize.trim() || null,
        embeddingBatchTimeoutSeconds: timeoutParsed,
      });
      applySnapshot(next);
      toast.success(t('embeddings.toast.saved'));
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid') {
        toast.error(t('embeddings.errors.positiveInteger'));
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
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
            <div className="space-y-2">
              <Label htmlFor="embedding-provider" className={labelClasses}>
                {t('embeddings.provider')}
              </Label>
              <Input
                id="embedding-provider"
                list="embedding-provider-options"
                value={provider}
                onChange={(event) => handleProviderChange(event.target.value)}
                className={inputClasses}
                placeholder="openai"
                data-testid="embedding-provider"
              />
              <datalist id="embedding-provider-options">
                {knownProviders.map((providerId) => (
                  <option key={providerId} value={providerId} />
                ))}
              </datalist>
              <p className="text-tiny text-muted-foreground">
                {t('embeddings.providerHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-model" className={labelClasses}>
                {t('embeddings.model')}
              </Label>
              <Input
                id="embedding-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className={inputClasses}
                placeholder={getDefaultModel(currentProvider) || 'text-embedding-3-small'}
                data-testid="embedding-model"
              />
              <p className="text-tiny text-muted-foreground">
                {t('embeddings.modelHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-fallback" className={labelClasses}>
                {t('embeddings.fallback')}
              </Label>
              <Input
                id="embedding-fallback"
                list="embedding-provider-options"
                value={fallback}
                onChange={(event) => setFallback(event.target.value)}
                className={inputClasses}
                placeholder="none"
                data-testid="embedding-fallback"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-output-dimensionality" className={labelClasses}>
                {t('embeddings.outputDimensionality')}
              </Label>
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
            </div>
          </div>

          {showRemoteFields ? (
            <div className="space-y-4 rounded-lg border border-border/65 bg-surface-input/45 p-4" data-testid="embedding-remote-section">
              <div>
                <Label className={labelClasses}>{t('embeddings.remote.title')}</Label>
                <p className="text-meta text-muted-foreground mt-1">
                  {t('embeddings.remote.description')}
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="embedding-remote-base-url" className={labelClasses}>
                    {t('embeddings.remote.baseUrl')}
                  </Label>
                  <Input
                    id="embedding-remote-base-url"
                    value={remoteBaseUrl}
                    onChange={(event) => setRemoteBaseUrl(event.target.value)}
                    className={inputClasses}
                    placeholder="https://api.example.com/v1"
                    data-testid="embedding-remote-base-url"
                  />
                </div>
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
                <div className="space-y-2">
                  <Label htmlFor="embedding-input-type" className={labelClasses}>
                    {t('embeddings.inputType')}
                  </Label>
                  <Input
                    id="embedding-input-type"
                    value={inputType}
                    onChange={(event) => setInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="passage"
                    data-testid="embedding-input-type"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding-query-input-type" className={labelClasses}>
                    {t('embeddings.queryInputType')}
                  </Label>
                  <Input
                    id="embedding-query-input-type"
                    value={queryInputType}
                    onChange={(event) => setQueryInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="query"
                    data-testid="embedding-query-input-type"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding-document-input-type" className={labelClasses}>
                    {t('embeddings.documentInputType')}
                  </Label>
                  <Input
                    id="embedding-document-input-type"
                    value={documentInputType}
                    onChange={(event) => setDocumentInputType(event.target.value)}
                    className={inputClasses}
                    placeholder="passage"
                    data-testid="embedding-document-input-type"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {showLocalFields ? (
            <div className="space-y-4 rounded-lg border border-border/65 bg-surface-input/45 p-4" data-testid="embedding-local-section">
              <div>
                <Label className={labelClasses}>{t('embeddings.local.title')}</Label>
                <p className="text-meta text-muted-foreground mt-1">
                  {t('embeddings.local.description')}
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="embedding-local-model-path" className={labelClasses}>
                    {t('embeddings.local.modelPath')}
                  </Label>
                  <Input
                    id="embedding-local-model-path"
                    value={localModelPath}
                    onChange={(event) => setLocalModelPath(event.target.value)}
                    className={inputClasses}
                    placeholder={DEFAULT_LOCAL_MODEL_PATH}
                    data-testid="embedding-local-model-path"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding-local-cache-dir" className={labelClasses}>
                    {t('embeddings.local.modelCacheDir')}
                  </Label>
                  <Input
                    id="embedding-local-cache-dir"
                    value={localModelCacheDir}
                    onChange={(event) => setLocalModelCacheDir(event.target.value)}
                    className={inputClasses}
                    placeholder="~/.cache/openclaw/embeddings"
                    data-testid="embedding-local-cache-dir"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="embedding-local-context-size" className={labelClasses}>
                    {t('embeddings.local.contextSize')}
                  </Label>
                  <Input
                    id="embedding-local-context-size"
                    value={localContextSize}
                    onChange={(event) => setLocalContextSize(event.target.value)}
                    className={inputClasses}
                    placeholder="4096"
                    data-testid="embedding-local-context-size"
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2 max-w-sm">
            <Label htmlFor="embedding-batch-timeout" className={labelClasses}>
              {t('embeddings.batchTimeout')}
            </Label>
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
          </div>

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
