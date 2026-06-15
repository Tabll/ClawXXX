/**
 * Read/write OpenClaw memory embedding settings.
 *
 * OpenClaw stores embedding provider/model configuration under
 * agents.defaults.memorySearch. Keep this helper narrowly focused on fields
 * that select the embedding backend; leave ranking/indexing knobs untouched.
 */
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';

export type EmbeddingRemoteConfigSnapshot = {
  baseUrl: string;
  apiKeyConfigured: boolean;
};

export type EmbeddingLocalConfigSnapshot = {
  modelPath: string;
  modelCacheDir: string;
  contextSize: string;
};

export type EmbeddingSyncConfigSnapshot = {
  embeddingBatchTimeoutSeconds: number | null;
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

const EMBEDDING_CONFIG_KEYS = [
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
] as const;

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

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
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
  const remote = isRecord(memorySearch?.remote) ? memorySearch.remote : {};
  const local = isRecord(memorySearch?.local) ? memorySearch.local : {};
  const sync = isRecord(memorySearch?.sync) ? memorySearch.sync : {};

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
    },
    local: {
      modelPath: normalizeString(local.modelPath),
      modelCacheDir: normalizeString(local.modelCacheDir),
      contextSize: typeof local.contextSize === 'number'
        ? String(Math.floor(local.contextSize))
        : normalizeString(local.contextSize),
    },
    sync: {
      embeddingBatchTimeoutSeconds: normalizePositiveInteger(sync.embeddingBatchTimeoutSeconds),
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
  if (EMBEDDING_CONFIG_KEYS.some((key) => memorySearch[key] !== undefined)) {
    return true;
  }
  return isRecord(memorySearch.sync) && memorySearch.sync.embeddingBatchTimeoutSeconds !== undefined;
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

function assertValidSavePayload(payload: SaveEmbeddingSettingsPayload): void {
  const provider = normalizeString(payload.provider);
  if (!provider) {
    throw new Error('Embedding provider is required');
  }
  if (payload.outputDimensionality !== undefined && payload.outputDimensionality !== null) {
    if (!Number.isFinite(payload.outputDimensionality) || payload.outputDimensionality <= 0) {
      throw new Error('Embedding output dimensionality must be a positive number');
    }
  }
  if (payload.embeddingBatchTimeoutSeconds !== undefined && payload.embeddingBatchTimeoutSeconds !== null) {
    if (!Number.isFinite(payload.embeddingBatchTimeoutSeconds) || payload.embeddingBatchTimeoutSeconds <= 0) {
      throw new Error('Embedding batch timeout must be a positive number');
    }
  }
  const contextSize = normalizeString(payload.localContextSize);
  if (contextSize && contextSize !== 'auto') {
    const parsed = Number.parseInt(contextSize, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== contextSize) {
      throw new Error('Local embedding context size must be a positive integer or "auto"');
    }
  }
}

function setOptionalString(record: Record<string, unknown>, key: string, value: string | null | undefined): void {
  const normalized = normalizeString(value);
  if (normalized) {
    record[key] = normalized;
  } else {
    delete record[key];
  }
}

function setOptionalPositiveInteger(record: Record<string, unknown>, key: string, value: number | null | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    record[key] = Math.floor(value);
  } else {
    delete record[key];
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

  const remote = isRecord(memorySearch.remote) ? { ...memorySearch.remote } : {};
  setOptionalString(remote, 'baseUrl', payload.remoteBaseUrl);
  if (payload.clearRemoteApiKey) {
    delete remote.apiKey;
  } else if (typeof payload.remoteApiKey === 'string' && payload.remoteApiKey.trim()) {
    remote.apiKey = payload.remoteApiKey.trim();
  }
  if (Object.keys(remote).length > 0) {
    memorySearch.remote = remote;
  } else {
    delete memorySearch.remote;
  }

  const local = isRecord(memorySearch.local) ? { ...memorySearch.local } : {};
  setOptionalString(local, 'modelPath', payload.localModelPath);
  setOptionalString(local, 'modelCacheDir', payload.localModelCacheDir);
  const contextSize = normalizeString(payload.localContextSize);
  if (contextSize === 'auto') {
    local.contextSize = 'auto';
  } else if (contextSize) {
    local.contextSize = Number.parseInt(contextSize, 10);
  } else {
    delete local.contextSize;
  }
  if (Object.keys(local).length > 0) {
    memorySearch.local = local;
  } else {
    delete memorySearch.local;
  }

  const sync = isRecord(memorySearch.sync) ? { ...memorySearch.sync } : {};
  setOptionalPositiveInteger(sync, 'embeddingBatchTimeoutSeconds', payload.embeddingBatchTimeoutSeconds);
  if (Object.keys(sync).length > 0) {
    memorySearch.sync = sync;
  } else {
    delete memorySearch.sync;
  }
}

function deleteEmbeddingConfigFields(memorySearch: Record<string, unknown>): void {
  for (const key of EMBEDDING_CONFIG_KEYS) {
    delete memorySearch[key];
  }
  if (isRecord(memorySearch.sync)) {
    const sync = { ...memorySearch.sync };
    delete sync.embeddingBatchTimeoutSeconds;
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
    const memorySearch = isRecord(defaults.memorySearch) ? { ...defaults.memorySearch } : {};

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
