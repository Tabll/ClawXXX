/**
 * Read/write OpenClaw memory embedding settings.
 *
 * OpenClaw stores embedding provider/model and memory-search tuning under
 * agents.defaults.memorySearch.
 */
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';

export type MemorySearchBooleanSetting = boolean | null;
export type MemorySearchSource = 'memory' | 'sessions';
export type MemorySearchModality = 'image' | 'audio' | 'all';

export type MemorySearchQmdCollection = {
  path: string;
  name?: string;
  pattern?: string;
};

export type EmbeddingRemoteConfigSnapshot = {
  baseUrl: string;
  apiKeyConfigured: boolean;
  headers: Record<string, string>;
  nonBatchConcurrency: number | null;
  batch: {
    enabled: MemorySearchBooleanSetting;
    wait: MemorySearchBooleanSetting;
    concurrency: number | null;
    pollIntervalMs: number | null;
    timeoutMinutes: number | null;
  };
};

export type EmbeddingLocalConfigSnapshot = {
  modelPath: string;
  modelCacheDir: string;
  contextSize: string;
};

export type EmbeddingSyncConfigSnapshot = {
  onSessionStart: MemorySearchBooleanSetting;
  onSearch: MemorySearchBooleanSetting;
  watch: MemorySearchBooleanSetting;
  watchDebounceMs: number | null;
  intervalMinutes: number | null;
  embeddingBatchTimeoutSeconds: number | null;
  sessions: {
    deltaBytes: number | null;
    deltaMessages: number | null;
    postCompactionForce: MemorySearchBooleanSetting;
  };
};

export type MemorySearchAdvancedConfigSnapshot = {
  sources: MemorySearchSource[];
  extraPaths: string[];
  qmd: {
    extraCollections: MemorySearchQmdCollection[];
  };
  multimodal: {
    enabled: MemorySearchBooleanSetting;
    modalities: MemorySearchModality[];
    maxFileBytes: number | null;
  };
  experimental: {
    sessionMemory: MemorySearchBooleanSetting;
  };
  store: {
    driver: string;
    path: string;
    ftsTokenizer: string;
    vector: {
      enabled: MemorySearchBooleanSetting;
      extensionPath: string;
    };
  };
  chunking: {
    tokens: number | null;
    overlap: number | null;
  };
  query: {
    maxResults: number | null;
    minScore: number | null;
    hybrid: {
      enabled: MemorySearchBooleanSetting;
      vectorWeight: number | null;
      textWeight: number | null;
      candidateMultiplier: number | null;
      mmr: {
        enabled: MemorySearchBooleanSetting;
        lambda: number | null;
      };
      temporalDecay: {
        enabled: MemorySearchBooleanSetting;
        halfLifeDays: number | null;
      };
    };
  };
  cache: {
    enabled: MemorySearchBooleanSetting;
    maxEntries: number | null;
  };
};

export type EmbeddingSettingsConfig = {
  enabled: boolean;
  provider: string;
  model: string;
  fallback: string;
  inputType: string;
  queryInputType: string;
  documentInputType: string;
  outputDimensionality: number | null;
  remote: EmbeddingRemoteConfigSnapshot;
  local: EmbeddingLocalConfigSnapshot;
  sync: EmbeddingSyncConfigSnapshot;
  advanced: MemorySearchAdvancedConfigSnapshot;
};

export type EmbeddingSettingsSnapshot = {
  source: 'agents.defaults.memorySearch';
  configured: boolean;
  config: EmbeddingSettingsConfig;
  knownProviders: string[];
};

export type SaveEmbeddingSettingsPayload = {
  enabled?: boolean;
  provider?: string | null;
  model?: string | null;
  fallback?: string | null;
  inputType?: string | null;
  queryInputType?: string | null;
  documentInputType?: string | null;
  outputDimensionality?: number | null;
  remoteBaseUrl?: string | null;
  remoteApiKey?: string;
  clearRemoteApiKey?: boolean;
  localModelPath?: string | null;
  localModelCacheDir?: string | null;
  localContextSize?: string | null;
  embeddingBatchTimeoutSeconds?: number | null;
  sources?: MemorySearchSource[] | null;
  extraPaths?: string[] | null;
  qmdExtraCollections?: MemorySearchQmdCollection[] | null;
  multimodalEnabled?: MemorySearchBooleanSetting;
  multimodalModalities?: MemorySearchModality[] | null;
  multimodalMaxFileBytes?: number | null;
  experimentalSessionMemory?: MemorySearchBooleanSetting;
  remoteHeaders?: Record<string, string> | null;
  remoteNonBatchConcurrency?: number | null;
  remoteBatchEnabled?: MemorySearchBooleanSetting;
  remoteBatchWait?: MemorySearchBooleanSetting;
  remoteBatchConcurrency?: number | null;
  remoteBatchPollIntervalMs?: number | null;
  remoteBatchTimeoutMinutes?: number | null;
  storeDriver?: string | null;
  storePath?: string | null;
  storeFtsTokenizer?: string | null;
  storeVectorEnabled?: MemorySearchBooleanSetting;
  storeVectorExtensionPath?: string | null;
  chunkingTokens?: number | null;
  chunkingOverlap?: number | null;
  syncOnSessionStart?: MemorySearchBooleanSetting;
  syncOnSearch?: MemorySearchBooleanSetting;
  syncWatch?: MemorySearchBooleanSetting;
  syncWatchDebounceMs?: number | null;
  syncIntervalMinutes?: number | null;
  syncSessionsDeltaBytes?: number | null;
  syncSessionsDeltaMessages?: number | null;
  syncSessionsPostCompactionForce?: MemorySearchBooleanSetting;
  queryMaxResults?: number | null;
  queryMinScore?: number | null;
  queryHybridEnabled?: MemorySearchBooleanSetting;
  queryHybridVectorWeight?: number | null;
  queryHybridTextWeight?: number | null;
  queryHybridCandidateMultiplier?: number | null;
  queryHybridMmrEnabled?: MemorySearchBooleanSetting;
  queryHybridMmrLambda?: number | null;
  queryHybridTemporalDecayEnabled?: MemorySearchBooleanSetting;
  queryHybridTemporalDecayHalfLifeDays?: number | null;
  cacheEnabled?: MemorySearchBooleanSetting;
  cacheMaxEntries?: number | null;
};

export const KNOWN_EMBEDDING_PROVIDERS = [
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
] as const;

const MEMORY_SEARCH_TOP_LEVEL_CONFIG_KEYS = [
  'enabled',
  'provider',
  'model',
  'fallback',
  'inputType',
  'queryInputType',
  'documentInputType',
  'outputDimensionality',
  'remote',
  'local',
  'sources',
  'extraPaths',
  'qmd',
  'multimodal',
  'experimental',
  'store',
  'chunking',
  'query',
  'cache',
] as const;

const MEMORY_SEARCH_SYNC_CONFIG_KEYS = [
  'onSessionStart',
  'onSearch',
  'watch',
  'watchDebounceMs',
  'intervalMinutes',
  'embeddingBatchTimeoutSeconds',
  'sessions',
] as const;

const SOURCE_VALUES: MemorySearchSource[] = ['memory', 'sessions'];
const MODALITY_VALUES: MemorySearchModality[] = ['image', 'audio', 'all'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value: unknown): string {
  const provider = normalizeString(value).toLowerCase();
  if (!provider || provider === 'auto') return 'openai';
  return provider;
}

function normalizeFallback(value: unknown): string {
  const fallback = normalizeString(value).toLowerCase();
  return fallback || 'none';
}

function normalizeBoolean(value: unknown): MemorySearchBooleanSetting {
  return typeof value === 'boolean' ? value : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function normalizeSourceArray(value: unknown): MemorySearchSource[] {
  return normalizeStringArray(value).filter((item): item is MemorySearchSource => {
    return SOURCE_VALUES.includes(item as MemorySearchSource);
  });
}

function normalizeModalityArray(value: unknown): MemorySearchModality[] {
  return normalizeStringArray(value).filter((item): item is MemorySearchModality => {
    return MODALITY_VALUES.includes(item as MemorySearchModality);
  });
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key.trim(), normalizeString(entry)] as const)
      .filter(([key, entry]) => key && entry),
  );
}

function normalizeQmdCollections(value: unknown): MemorySearchQmdCollection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const path = normalizeString(entry.path);
    if (!path) return [];
    const collection: MemorySearchQmdCollection = { path };
    const name = normalizeString(entry.name);
    const pattern = normalizeString(entry.pattern);
    if (name) collection.name = name;
    if (pattern) collection.pattern = pattern;
    return [collection];
  });
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function pruneEmptyObjects(record: Record<string, unknown>, key: string): void {
  const child = record[key];
  if (isRecord(child) && Object.keys(child).length === 0) {
    delete record[key];
  }
}

function getAgentsDefaults(config: OpenClawConfig): Record<string, unknown> | undefined {
  if (!isRecord(config.agents)) return undefined;
  if (!isRecord(config.agents.defaults)) return undefined;
  return config.agents.defaults;
}

function getMemorySearch(config: OpenClawConfig): Record<string, unknown> | undefined {
  const defaults = getAgentsDefaults(config);
  if (!defaults || !isRecord(defaults.memorySearch)) return undefined;
  return defaults.memorySearch;
}

function ensureAgentsDefaults(config: OpenClawConfig): Record<string, unknown> {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  agents.defaults = defaults;
  config.agents = agents;
  return defaults;
}

function parseEmbeddingSettingsConfig(memorySearch?: Record<string, unknown>): EmbeddingSettingsConfig {
  const remote = cloneRecord(memorySearch?.remote);
  const remoteBatch = cloneRecord(remote.batch);
  const local = cloneRecord(memorySearch?.local);
  const sync = cloneRecord(memorySearch?.sync);
  const syncSessions = cloneRecord(sync.sessions);
  const qmd = cloneRecord(memorySearch?.qmd);
  const multimodal = cloneRecord(memorySearch?.multimodal);
  const experimental = cloneRecord(memorySearch?.experimental);
  const store = cloneRecord(memorySearch?.store);
  const storeFts = cloneRecord(store.fts);
  const storeVector = cloneRecord(store.vector);
  const chunking = cloneRecord(memorySearch?.chunking);
  const query = cloneRecord(memorySearch?.query);
  const queryHybrid = cloneRecord(query.hybrid);
  const queryHybridMmr = cloneRecord(queryHybrid.mmr);
  const queryHybridTemporalDecay = cloneRecord(queryHybrid.temporalDecay);
  const cache = cloneRecord(memorySearch?.cache);

  return {
    enabled: memorySearch?.enabled !== false,
    provider: normalizeProvider(memorySearch?.provider),
    model: normalizeString(memorySearch?.model),
    fallback: normalizeFallback(memorySearch?.fallback),
    inputType: normalizeString(memorySearch?.inputType),
    queryInputType: normalizeString(memorySearch?.queryInputType),
    documentInputType: normalizeString(memorySearch?.documentInputType),
    outputDimensionality: normalizePositiveInteger(memorySearch?.outputDimensionality),
    remote: {
      baseUrl: normalizeString(remote.baseUrl),
      apiKeyConfigured: Boolean(remote.apiKey),
      headers: normalizeStringRecord(remote.headers),
      nonBatchConcurrency: normalizePositiveInteger(remote.nonBatchConcurrency),
      batch: {
        enabled: normalizeBoolean(remoteBatch.enabled),
        wait: normalizeBoolean(remoteBatch.wait),
        concurrency: normalizePositiveInteger(remoteBatch.concurrency),
        pollIntervalMs: normalizeNonNegativeInteger(remoteBatch.pollIntervalMs),
        timeoutMinutes: normalizePositiveInteger(remoteBatch.timeoutMinutes),
      },
    },
    local: {
      modelPath: normalizeString(local.modelPath),
      modelCacheDir: normalizeString(local.modelCacheDir),
      contextSize: typeof local.contextSize === 'number'
        ? String(Math.floor(local.contextSize))
        : normalizeString(local.contextSize),
    },
    sync: {
      onSessionStart: normalizeBoolean(sync.onSessionStart),
      onSearch: normalizeBoolean(sync.onSearch),
      watch: normalizeBoolean(sync.watch),
      watchDebounceMs: normalizeNonNegativeInteger(sync.watchDebounceMs),
      intervalMinutes: normalizeNonNegativeInteger(sync.intervalMinutes),
      embeddingBatchTimeoutSeconds: normalizePositiveInteger(sync.embeddingBatchTimeoutSeconds),
      sessions: {
        deltaBytes: normalizeNonNegativeInteger(syncSessions.deltaBytes),
        deltaMessages: normalizeNonNegativeInteger(syncSessions.deltaMessages),
        postCompactionForce: normalizeBoolean(syncSessions.postCompactionForce),
      },
    },
    advanced: {
      sources: normalizeSourceArray(memorySearch?.sources),
      extraPaths: normalizeStringArray(memorySearch?.extraPaths),
      qmd: {
        extraCollections: normalizeQmdCollections(qmd.extraCollections),
      },
      multimodal: {
        enabled: normalizeBoolean(multimodal.enabled),
        modalities: normalizeModalityArray(multimodal.modalities),
        maxFileBytes: normalizePositiveInteger(multimodal.maxFileBytes),
      },
      experimental: {
        sessionMemory: normalizeBoolean(experimental.sessionMemory),
      },
      store: {
        driver: normalizeString(store.driver),
        path: normalizeString(store.path),
        ftsTokenizer: normalizeString(storeFts.tokenizer),
        vector: {
          enabled: normalizeBoolean(storeVector.enabled),
          extensionPath: normalizeString(storeVector.extensionPath),
        },
      },
      chunking: {
        tokens: normalizePositiveInteger(chunking.tokens),
        overlap: normalizeNonNegativeInteger(chunking.overlap),
      },
      query: {
        maxResults: normalizePositiveInteger(query.maxResults),
        minScore: normalizeRatio(query.minScore),
        hybrid: {
          enabled: normalizeBoolean(queryHybrid.enabled),
          vectorWeight: normalizeRatio(queryHybrid.vectorWeight),
          textWeight: normalizeRatio(queryHybrid.textWeight),
          candidateMultiplier: normalizePositiveInteger(queryHybrid.candidateMultiplier),
          mmr: {
            enabled: normalizeBoolean(queryHybridMmr.enabled),
            lambda: normalizeRatio(queryHybridMmr.lambda),
          },
          temporalDecay: {
            enabled: normalizeBoolean(queryHybridTemporalDecay.enabled),
            halfLifeDays: normalizePositiveInteger(queryHybridTemporalDecay.halfLifeDays),
          },
        },
      },
      cache: {
        enabled: normalizeBoolean(cache.enabled),
        maxEntries: normalizePositiveInteger(cache.maxEntries),
      },
    },
  };
}

function collectConfiguredProviderIds(config: OpenClawConfig): string[] {
  const providers = isRecord(config.models)
    && isRecord(config.models.providers)
    ? Object.keys(config.models.providers)
    : [];
  return Array.from(new Set([
    ...KNOWN_EMBEDDING_PROVIDERS,
    ...providers,
  ])).sort((a, b) => a.localeCompare(b));
}

function hasEmbeddingConfig(memorySearch?: Record<string, unknown>): boolean {
  if (!memorySearch) return false;
  if (MEMORY_SEARCH_TOP_LEVEL_CONFIG_KEYS.some((key) => memorySearch[key] !== undefined)) {
    return true;
  }
  const sync = memorySearch.sync;
  return isRecord(sync)
    && MEMORY_SEARCH_SYNC_CONFIG_KEYS.some((key) => sync[key] !== undefined);
}

export async function getEmbeddingSettingsSnapshot(): Promise<EmbeddingSettingsSnapshot> {
  const config = await readOpenClawConfig();
  const memorySearch = getMemorySearch(config);
  return {
    source: 'agents.defaults.memorySearch',
    configured: hasEmbeddingConfig(memorySearch),
    config: parseEmbeddingSettingsConfig(memorySearch),
    knownProviders: collectConfiguredProviderIds(config),
  };
}

function assertPositiveInteger(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value <= 0 || Math.floor(value) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertRatio(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
}

function assertValidBooleanSetting(value: MemorySearchBooleanSetting | undefined, label: string): void {
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw new Error(`${label} must be true, false, or default`);
  }
}

function assertValidStringRecord(value: Record<string, string> | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim() || typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label} must contain non-empty string keys and values`);
    }
  }
}

function assertValidQmdCollections(value: MemorySearchQmdCollection[] | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error('QMD collections must be an array');
  }
  for (const collection of value) {
    if (!collection.path?.trim()) {
      throw new Error('QMD collections require a path');
    }
  }
}

function assertValidSavePayload(payload: SaveEmbeddingSettingsPayload): void {
  const provider = normalizeString(payload.provider);
  if (!provider) {
    throw new Error('Embedding provider is required');
  }

  assertPositiveInteger(payload.outputDimensionality, 'Embedding output dimensionality');
  assertPositiveInteger(payload.embeddingBatchTimeoutSeconds, 'Embedding batch timeout');
  assertPositiveInteger(payload.remoteNonBatchConcurrency, 'Remote non-batch concurrency');
  assertPositiveInteger(payload.remoteBatchConcurrency, 'Remote batch concurrency');
  assertNonNegativeInteger(payload.remoteBatchPollIntervalMs, 'Remote batch poll interval');
  assertPositiveInteger(payload.remoteBatchTimeoutMinutes, 'Remote batch timeout');
  assertPositiveInteger(payload.multimodalMaxFileBytes, 'Multimodal max file bytes');
  assertPositiveInteger(payload.chunkingTokens, 'Chunking tokens');
  assertNonNegativeInteger(payload.chunkingOverlap, 'Chunking overlap');
  assertNonNegativeInteger(payload.syncWatchDebounceMs, 'Sync watch debounce');
  assertNonNegativeInteger(payload.syncIntervalMinutes, 'Sync interval');
  assertNonNegativeInteger(payload.syncSessionsDeltaBytes, 'Session delta bytes');
  assertNonNegativeInteger(payload.syncSessionsDeltaMessages, 'Session delta messages');
  assertPositiveInteger(payload.queryMaxResults, 'Query max results');
  assertRatio(payload.queryMinScore, 'Query min score');
  assertRatio(payload.queryHybridVectorWeight, 'Hybrid vector weight');
  assertRatio(payload.queryHybridTextWeight, 'Hybrid text weight');
  assertPositiveInteger(payload.queryHybridCandidateMultiplier, 'Hybrid candidate multiplier');
  assertRatio(payload.queryHybridMmrLambda, 'MMR lambda');
  assertPositiveInteger(payload.queryHybridTemporalDecayHalfLifeDays, 'Temporal decay half-life');
  assertPositiveInteger(payload.cacheMaxEntries, 'Cache max entries');

  for (const [value, label] of [
    [payload.multimodalEnabled, 'Multimodal enabled'],
    [payload.experimentalSessionMemory, 'Experimental session memory'],
    [payload.remoteBatchEnabled, 'Remote batch enabled'],
    [payload.remoteBatchWait, 'Remote batch wait'],
    [payload.storeVectorEnabled, 'Store vector enabled'],
    [payload.syncOnSessionStart, 'Sync on session start'],
    [payload.syncOnSearch, 'Sync on search'],
    [payload.syncWatch, 'Sync watch'],
    [payload.syncSessionsPostCompactionForce, 'Post-compaction sync'],
    [payload.queryHybridEnabled, 'Hybrid query enabled'],
    [payload.queryHybridMmrEnabled, 'MMR enabled'],
    [payload.queryHybridTemporalDecayEnabled, 'Temporal decay enabled'],
    [payload.cacheEnabled, 'Cache enabled'],
  ] as const) {
    assertValidBooleanSetting(value, label);
  }

  if (payload.sources) {
    for (const source of payload.sources) {
      if (!SOURCE_VALUES.includes(source)) {
        throw new Error('Memory search sources must be memory or sessions');
      }
    }
  }
  if (payload.multimodalModalities) {
    for (const modality of payload.multimodalModalities) {
      if (!MODALITY_VALUES.includes(modality)) {
        throw new Error('Multimodal modalities must be image, audio, or all');
      }
    }
  }
  if (payload.storeDriver && normalizeString(payload.storeDriver) !== 'sqlite') {
    throw new Error('Store driver must be sqlite');
  }
  if (payload.storeFtsTokenizer) {
    const tokenizer = normalizeString(payload.storeFtsTokenizer);
    if (tokenizer !== 'unicode61' && tokenizer !== 'trigram') {
      throw new Error('Store FTS tokenizer must be unicode61 or trigram');
    }
  }
  assertValidStringRecord(payload.remoteHeaders, 'Remote headers');
  assertValidQmdCollections(payload.qmdExtraCollections);

  const contextSize = normalizeString(payload.localContextSize);
  if (contextSize && contextSize !== 'auto') {
    const parsed = Number.parseInt(contextSize, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== contextSize) {
      throw new Error('Local embedding context size must be a positive integer or "auto"');
    }
  }
}

function setOptionalString(record: Record<string, unknown>, key: string, value: string | null | undefined): void {
  if (value === undefined) return;
  const normalized = normalizeString(value);
  if (normalized) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalStringArray(record: Record<string, unknown>, key: string, value: string[] | null | undefined): void {
  if (value === undefined) return;
  const normalized = normalizeStringArray(value);
  if (normalized.length > 0) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalSourceArray(
  record: Record<string, unknown>,
  key: string,
  value: MemorySearchSource[] | null | undefined,
): void {
  if (value === undefined) return;
  const normalized = normalizeSourceArray(value);
  if (normalized.length > 0) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalModalityArray(
  record: Record<string, unknown>,
  key: string,
  value: MemorySearchModality[] | null | undefined,
): void {
  if (value === undefined) return;
  const normalized = normalizeModalityArray(value);
  if (normalized.length > 0) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalStringRecord(
  record: Record<string, unknown>,
  key: string,
  value: Record<string, string> | null | undefined,
): void {
  if (value === undefined) return;
  const normalized = normalizeStringRecord(value);
  if (Object.keys(normalized).length > 0) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    record[key] = Math.floor(value);
  } else {
    delete record[key];
  }
}

function setOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  value: number | null | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    record[key] = Math.floor(value);
  } else {
    delete record[key];
  }
}

function setOptionalRatio(record: Record<string, unknown>, key: string, value: number | null | undefined): void {
  if (value === undefined) return;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    record[key] = value;
  } else {
    delete record[key];
  }
}

function setOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  value: MemorySearchBooleanSetting | undefined,
): void {
  if (value === undefined) return;
  if (typeof value === 'boolean') {
    record[key] = value;
  } else {
    delete record[key];
  }
}

function setOptionalQmdCollections(
  record: Record<string, unknown>,
  key: string,
  value: MemorySearchQmdCollection[] | null | undefined,
): void {
  if (value === undefined) return;
  const normalized = normalizeQmdCollections(value);
  if (normalized.length > 0) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function assignChildIfNotEmpty(parent: Record<string, unknown>, key: string, child: Record<string, unknown>): void {
  if (Object.keys(child).length > 0) {
    parent[key] = child;
  } else {
    delete parent[key];
  }
}

function applyEmbeddingSettingsToMemorySearch(
  memorySearch: Record<string, unknown>,
  payload: SaveEmbeddingSettingsPayload,
): void {
  memorySearch.enabled = payload.enabled !== false;
  memorySearch.provider = normalizeProvider(payload.provider);
  setOptionalString(memorySearch, 'model', payload.model);
  memorySearch.fallback = normalizeFallback(payload.fallback);
  setOptionalString(memorySearch, 'inputType', payload.inputType);
  setOptionalString(memorySearch, 'queryInputType', payload.queryInputType);
  setOptionalString(memorySearch, 'documentInputType', payload.documentInputType);
  setOptionalPositiveInteger(memorySearch, 'outputDimensionality', payload.outputDimensionality);
  setOptionalSourceArray(memorySearch, 'sources', payload.sources);
  setOptionalStringArray(memorySearch, 'extraPaths', payload.extraPaths);

  const remote = cloneRecord(memorySearch.remote);
  setOptionalString(remote, 'baseUrl', payload.remoteBaseUrl);
  if (payload.clearRemoteApiKey) {
    delete remote.apiKey;
  } else if (typeof payload.remoteApiKey === 'string' && payload.remoteApiKey.trim()) {
    remote.apiKey = payload.remoteApiKey.trim();
  }
  setOptionalStringRecord(remote, 'headers', payload.remoteHeaders);
  setOptionalPositiveInteger(remote, 'nonBatchConcurrency', payload.remoteNonBatchConcurrency);
  const remoteBatch = cloneRecord(remote.batch);
  setOptionalBoolean(remoteBatch, 'enabled', payload.remoteBatchEnabled);
  setOptionalBoolean(remoteBatch, 'wait', payload.remoteBatchWait);
  setOptionalPositiveInteger(remoteBatch, 'concurrency', payload.remoteBatchConcurrency);
  setOptionalNonNegativeInteger(remoteBatch, 'pollIntervalMs', payload.remoteBatchPollIntervalMs);
  setOptionalPositiveInteger(remoteBatch, 'timeoutMinutes', payload.remoteBatchTimeoutMinutes);
  assignChildIfNotEmpty(remote, 'batch', remoteBatch);
  assignChildIfNotEmpty(memorySearch, 'remote', remote);

  const local = cloneRecord(memorySearch.local);
  setOptionalString(local, 'modelPath', payload.localModelPath);
  setOptionalString(local, 'modelCacheDir', payload.localModelCacheDir);
  if (payload.localContextSize !== undefined) {
    const contextSize = normalizeString(payload.localContextSize);
    if (contextSize === 'auto') {
      local.contextSize = 'auto';
    } else if (contextSize) {
      local.contextSize = Number.parseInt(contextSize, 10);
    } else {
      delete local.contextSize;
    }
  }
  assignChildIfNotEmpty(memorySearch, 'local', local);

  const qmd = cloneRecord(memorySearch.qmd);
  setOptionalQmdCollections(qmd, 'extraCollections', payload.qmdExtraCollections);
  assignChildIfNotEmpty(memorySearch, 'qmd', qmd);

  const multimodal = cloneRecord(memorySearch.multimodal);
  setOptionalBoolean(multimodal, 'enabled', payload.multimodalEnabled);
  setOptionalModalityArray(multimodal, 'modalities', payload.multimodalModalities);
  setOptionalPositiveInteger(multimodal, 'maxFileBytes', payload.multimodalMaxFileBytes);
  assignChildIfNotEmpty(memorySearch, 'multimodal', multimodal);

  const experimental = cloneRecord(memorySearch.experimental);
  setOptionalBoolean(experimental, 'sessionMemory', payload.experimentalSessionMemory);
  assignChildIfNotEmpty(memorySearch, 'experimental', experimental);

  const store = cloneRecord(memorySearch.store);
  setOptionalString(store, 'driver', payload.storeDriver);
  setOptionalString(store, 'path', payload.storePath);
  const storeFts = cloneRecord(store.fts);
  setOptionalString(storeFts, 'tokenizer', payload.storeFtsTokenizer);
  assignChildIfNotEmpty(store, 'fts', storeFts);
  const storeVector = cloneRecord(store.vector);
  setOptionalBoolean(storeVector, 'enabled', payload.storeVectorEnabled);
  setOptionalString(storeVector, 'extensionPath', payload.storeVectorExtensionPath);
  assignChildIfNotEmpty(store, 'vector', storeVector);
  assignChildIfNotEmpty(memorySearch, 'store', store);

  const chunking = cloneRecord(memorySearch.chunking);
  setOptionalPositiveInteger(chunking, 'tokens', payload.chunkingTokens);
  setOptionalNonNegativeInteger(chunking, 'overlap', payload.chunkingOverlap);
  assignChildIfNotEmpty(memorySearch, 'chunking', chunking);

  const sync = cloneRecord(memorySearch.sync);
  setOptionalBoolean(sync, 'onSessionStart', payload.syncOnSessionStart);
  setOptionalBoolean(sync, 'onSearch', payload.syncOnSearch);
  setOptionalBoolean(sync, 'watch', payload.syncWatch);
  setOptionalNonNegativeInteger(sync, 'watchDebounceMs', payload.syncWatchDebounceMs);
  setOptionalNonNegativeInteger(sync, 'intervalMinutes', payload.syncIntervalMinutes);
  setOptionalPositiveInteger(sync, 'embeddingBatchTimeoutSeconds', payload.embeddingBatchTimeoutSeconds);
  const syncSessions = cloneRecord(sync.sessions);
  setOptionalNonNegativeInteger(syncSessions, 'deltaBytes', payload.syncSessionsDeltaBytes);
  setOptionalNonNegativeInteger(syncSessions, 'deltaMessages', payload.syncSessionsDeltaMessages);
  setOptionalBoolean(syncSessions, 'postCompactionForce', payload.syncSessionsPostCompactionForce);
  assignChildIfNotEmpty(sync, 'sessions', syncSessions);
  assignChildIfNotEmpty(memorySearch, 'sync', sync);

  const query = cloneRecord(memorySearch.query);
  setOptionalPositiveInteger(query, 'maxResults', payload.queryMaxResults);
  setOptionalRatio(query, 'minScore', payload.queryMinScore);
  const hybrid = cloneRecord(query.hybrid);
  setOptionalBoolean(hybrid, 'enabled', payload.queryHybridEnabled);
  setOptionalRatio(hybrid, 'vectorWeight', payload.queryHybridVectorWeight);
  setOptionalRatio(hybrid, 'textWeight', payload.queryHybridTextWeight);
  setOptionalPositiveInteger(hybrid, 'candidateMultiplier', payload.queryHybridCandidateMultiplier);
  const mmr = cloneRecord(hybrid.mmr);
  setOptionalBoolean(mmr, 'enabled', payload.queryHybridMmrEnabled);
  setOptionalRatio(mmr, 'lambda', payload.queryHybridMmrLambda);
  assignChildIfNotEmpty(hybrid, 'mmr', mmr);
  const temporalDecay = cloneRecord(hybrid.temporalDecay);
  setOptionalBoolean(temporalDecay, 'enabled', payload.queryHybridTemporalDecayEnabled);
  setOptionalPositiveInteger(temporalDecay, 'halfLifeDays', payload.queryHybridTemporalDecayHalfLifeDays);
  assignChildIfNotEmpty(hybrid, 'temporalDecay', temporalDecay);
  assignChildIfNotEmpty(query, 'hybrid', hybrid);
  assignChildIfNotEmpty(memorySearch, 'query', query);

  const cache = cloneRecord(memorySearch.cache);
  setOptionalBoolean(cache, 'enabled', payload.cacheEnabled);
  setOptionalPositiveInteger(cache, 'maxEntries', payload.cacheMaxEntries);
  assignChildIfNotEmpty(memorySearch, 'cache', cache);
}

function deleteEmbeddingConfigFields(memorySearch: Record<string, unknown>): void {
  for (const key of MEMORY_SEARCH_TOP_LEVEL_CONFIG_KEYS) {
    delete memorySearch[key];
  }
  if (isRecord(memorySearch.sync)) {
    const sync = { ...memorySearch.sync };
    for (const key of MEMORY_SEARCH_SYNC_CONFIG_KEYS) {
      delete sync[key];
    }
    if (Object.keys(sync).length > 0) {
      memorySearch.sync = sync;
    } else {
      delete memorySearch.sync;
    }
  }
}

export async function saveEmbeddingSettings(
  payload: SaveEmbeddingSettingsPayload,
): Promise<EmbeddingSettingsSnapshot> {
  assertValidSavePayload(payload);

  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const defaults = ensureAgentsDefaults(config);
    const memorySearch = cloneRecord(defaults.memorySearch);

    applyEmbeddingSettingsToMemorySearch(memorySearch, payload);
    defaults.memorySearch = memorySearch;
    await writeOpenClawConfig(config);

    return {
      source: 'agents.defaults.memorySearch',
      configured: true,
      config: parseEmbeddingSettingsConfig(memorySearch),
      knownProviders: collectConfiguredProviderIds(config),
    };
  });
}

export async function clearEmbeddingSettings(): Promise<EmbeddingSettingsSnapshot> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const defaults = getAgentsDefaults(config);
    if (defaults && isRecord(defaults.memorySearch)) {
      const memorySearch = { ...defaults.memorySearch };
      deleteEmbeddingConfigFields(memorySearch);
      pruneEmptyObjects(memorySearch, 'remote');
      pruneEmptyObjects(memorySearch, 'local');
      pruneEmptyObjects(memorySearch, 'sync');
      pruneEmptyObjects(memorySearch, 'qmd');
      pruneEmptyObjects(memorySearch, 'multimodal');
      pruneEmptyObjects(memorySearch, 'experimental');
      pruneEmptyObjects(memorySearch, 'store');
      pruneEmptyObjects(memorySearch, 'chunking');
      pruneEmptyObjects(memorySearch, 'query');
      pruneEmptyObjects(memorySearch, 'cache');
      if (Object.keys(memorySearch).length > 0) {
        defaults.memorySearch = memorySearch;
      } else {
        delete defaults.memorySearch;
      }
    }
    await writeOpenClawConfig(config);

    return {
      source: 'agents.defaults.memorySearch',
      configured: hasEmbeddingConfig(getMemorySearch(config)),
      config: parseEmbeddingSettingsConfig(getMemorySearch(config)),
      knownProviders: collectConfiguredProviderIds(config),
    };
  });
}
