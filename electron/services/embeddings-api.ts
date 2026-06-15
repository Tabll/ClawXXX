import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import {
  clearEmbeddingSettings,
  getEmbeddingSettingsSnapshot,
  saveEmbeddingSettings,
  type SaveEmbeddingSettingsPayload,
} from '../utils/openclaw-embeddings';
import { isRecord } from './payload-utils';

export function createEmbeddingsApi(): CompleteHostServiceRegistry['embeddings'] {
  return {
    settings: async () => ({
      success: true,
      ...(await getEmbeddingSettingsSnapshot()),
    }),
    saveSettings: async (payload) => ({
      success: true,
      ...(await saveEmbeddingSettings(isRecord(payload) ? payload as SaveEmbeddingSettingsPayload : {})),
    }),
    clearSettings: async () => ({
      success: true,
      ...(await clearEmbeddingSettings()),
    }),
  };
}
