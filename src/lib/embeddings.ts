import { hostApi } from '@/lib/host-api';

export type MemorySearchBooleanSetting = boolean | null;
export type MemorySearchSource = 'memory' | 'sessions';
export type MemorySearchModality = 'image' | 'audio' | 'all';

export interface MemorySearchQmdCollection {
  path: string;
  name?: string;
  pattern?: string;
}

export interface EmbeddingRemoteConfigSnapshot {
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
}

export interface EmbeddingLocalConfigSnapshot {
  modelPath: string;
  modelCacheDir: string;
  contextSize: string;
}

export interface EmbeddingSyncConfigSnapshot {
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
}

export interface MemorySearchAdvancedConfigSnapshot {
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
}

export interface EmbeddingSettingsConfig {
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
}

export interface EmbeddingSettingsSnapshot {
  source: 'agents.defaults.memorySearch';
  configured: boolean;
  config: EmbeddingSettingsConfig;
  knownProviders: string[];
}

export type SaveEmbeddingSettingsInput = {
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

export async function fetchEmbeddingSettings(): Promise<EmbeddingSettingsSnapshot> {
  const response = await hostApi.embeddings.settings();
  if (response.success === false) {
    throw new Error('Failed to load embedding settings');
  }
  return response;
}

export async function saveEmbeddingSettings(
  payload: SaveEmbeddingSettingsInput,
): Promise<EmbeddingSettingsSnapshot> {
  const response = await hostApi.embeddings.saveSettings(payload);
  if (response.success === false) {
    throw new Error('Failed to save embedding settings');
  }
  return response;
}

export async function clearEmbeddingSettings(): Promise<EmbeddingSettingsSnapshot> {
  const response = await hostApi.embeddings.clearSettings();
  if (response.success === false) {
    throw new Error('Failed to clear embedding settings');
  }
  return response;
}
