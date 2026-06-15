import { hostApi } from '@/lib/host-api';

export interface EmbeddingRemoteConfigSnapshot {
  baseUrl: string;
  apiKeyConfigured: boolean;
}

export interface EmbeddingLocalConfigSnapshot {
  modelPath: string;
  modelCacheDir: string;
  contextSize: string;
}

export interface EmbeddingSyncConfigSnapshot {
  embeddingBatchTimeoutSeconds: number | null;
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
