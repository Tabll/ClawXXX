import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/clawx-openclaw-embeddings-${suffix}`,
    testUserData: `/tmp/clawx-openclaw-embeddings-user-data-${suffix}`,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

vi.mock('@electron/utils/paths', async () => {
  const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
  const resolvedDir = join(testHome, '.openclaw-test-openclaw');
  return {
    ...actual,
    getOpenClawResolvedDir: () => resolvedDir,
    getOpenClawDir: () => resolvedDir,
  };
});

async function writeOpenClawJson(config: unknown): Promise<void> {
  const openclawDir = join(testHome, '.openclaw');
  await mkdir(openclawDir, { recursive: true });
  await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function readOpenClawJson(): Promise<Record<string, unknown>> {
  const content = await readFile(join(testHome, '.openclaw', 'openclaw.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

describe('openclaw-embeddings helpers', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('reads OpenClaw defaults when memorySearch is not configured', async () => {
    await writeOpenClawJson({
      agents: {
        defaults: {},
      },
    });

    const { getEmbeddingSettingsSnapshot } = await import('@electron/utils/openclaw-embeddings');
    const snapshot = await getEmbeddingSettingsSnapshot();

    expect(snapshot.configured).toBe(false);
    expect(snapshot.config).toMatchObject({
      enabled: true,
      provider: 'openai',
      model: '',
      fallback: 'none',
    });
  });

  it('writes agents.defaults.memorySearch embedding and advanced memory-search fields', async () => {
    await writeOpenClawJson({
      models: {
        providers: {
          'embed-gpu': {
            api: 'openai-completions',
            baseUrl: 'http://gpu-box.local:8000/v1',
            models: [{ id: 'bge-m3' }],
          },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            query: {
              maxResults: 12,
              customRanking: 'keep-me',
            },
          },
        },
      },
    });

    const { saveEmbeddingSettings } = await import('@electron/utils/openclaw-embeddings');
    const snapshot = await saveEmbeddingSettings({
      enabled: true,
      provider: 'openai-compatible',
      model: 'bge-m3',
      fallback: 'none',
      remoteBaseUrl: 'https://embeddings.example/v1',
      remoteApiKey: 'sk-embed',
      inputType: 'passage',
      queryInputType: 'query',
      documentInputType: 'document',
      outputDimensionality: 1024,
      embeddingBatchTimeoutSeconds: 240,
      sources: ['memory', 'sessions'],
      extraPaths: ['~/notes', '../shared'],
      qmdExtraCollections: [{
        path: '~/qmd',
        name: 'QMD',
        pattern: '**/*.qmd',
      }],
      multimodalEnabled: true,
      multimodalModalities: ['image'],
      multimodalMaxFileBytes: 10485760,
      experimentalSessionMemory: true,
      remoteHeaders: {
        'X-Embedding': 'memory',
      },
      remoteNonBatchConcurrency: 4,
      remoteBatchEnabled: true,
      remoteBatchWait: false,
      remoteBatchConcurrency: 2,
      remoteBatchPollIntervalMs: 1000,
      remoteBatchTimeoutMinutes: 30,
      storeDriver: 'sqlite',
      storePath: '~/.openclaw/memory/search.sqlite',
      storeFtsTokenizer: 'trigram',
      storeVectorEnabled: true,
      storeVectorExtensionPath: '/tmp/sqlite-vec.dylib',
      chunkingTokens: 512,
      chunkingOverlap: 64,
      syncOnSessionStart: true,
      syncOnSearch: false,
      syncWatch: true,
      syncWatchDebounceMs: 500,
      syncIntervalMinutes: 15,
      syncSessionsDeltaBytes: 4096,
      syncSessionsDeltaMessages: 8,
      syncSessionsPostCompactionForce: true,
      queryMaxResults: 16,
      queryMinScore: 0.2,
      queryHybridEnabled: true,
      queryHybridVectorWeight: 0.7,
      queryHybridTextWeight: 0.3,
      queryHybridCandidateMultiplier: 4,
      queryHybridMmrEnabled: true,
      queryHybridMmrLambda: 0.5,
      queryHybridTemporalDecayEnabled: true,
      queryHybridTemporalDecayHalfLifeDays: 30,
      cacheEnabled: true,
      cacheMaxEntries: 512,
    });

    expect(snapshot.config.remote.apiKeyConfigured).toBe(true);
    expect(snapshot.config.advanced.query.maxResults).toBe(16);
    expect(snapshot.config.advanced.cache.enabled).toBe(true);
    expect(snapshot.knownProviders).toContain('embed-gpu');

    const saved = await readOpenClawJson();
    const defaults = (saved.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect(defaults.memorySearch).toEqual({
      query: {
        maxResults: 16,
        customRanking: 'keep-me',
        minScore: 0.2,
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          mmr: {
            enabled: true,
            lambda: 0.5,
          },
          temporalDecay: {
            enabled: true,
            halfLifeDays: 30,
          },
        },
      },
      enabled: true,
      provider: 'openai-compatible',
      model: 'bge-m3',
      fallback: 'none',
      inputType: 'passage',
      queryInputType: 'query',
      documentInputType: 'document',
      outputDimensionality: 1024,
      remote: {
        baseUrl: 'https://embeddings.example/v1',
        apiKey: 'sk-embed',
        headers: {
          'X-Embedding': 'memory',
        },
        nonBatchConcurrency: 4,
        batch: {
          enabled: true,
          wait: false,
          concurrency: 2,
          pollIntervalMs: 1000,
          timeoutMinutes: 30,
        },
      },
      sources: ['memory', 'sessions'],
      extraPaths: ['~/notes', '../shared'],
      qmd: {
        extraCollections: [{
          path: '~/qmd',
          name: 'QMD',
          pattern: '**/*.qmd',
        }],
      },
      multimodal: {
        enabled: true,
        modalities: ['image'],
        maxFileBytes: 10485760,
      },
      experimental: {
        sessionMemory: true,
      },
      store: {
        driver: 'sqlite',
        path: '~/.openclaw/memory/search.sqlite',
        fts: {
          tokenizer: 'trigram',
        },
        vector: {
          enabled: true,
          extensionPath: '/tmp/sqlite-vec.dylib',
        },
      },
      chunking: {
        tokens: 512,
        overlap: 64,
      },
      sync: {
        onSessionStart: true,
        onSearch: false,
        watch: true,
        watchDebounceMs: 500,
        intervalMinutes: 15,
        embeddingBatchTimeoutSeconds: 240,
        sessions: {
          deltaBytes: 4096,
          deltaMessages: 8,
          postCompactionForce: true,
        },
      },
      cache: {
        enabled: true,
        maxEntries: 512,
      },
    });
  });

  it('clears managed memorySearch fields while keeping unknown memorySearch settings', async () => {
    await writeOpenClawJson({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: 'openai-compatible',
            model: 'bge-m3',
            fallback: 'none',
            remote: {
              baseUrl: 'https://embeddings.example/v1',
              apiKey: 'sk-embed',
            },
            local: {
              modelPath: 'hf:model.gguf',
            },
            sync: {
              onSearch: true,
              embeddingBatchTimeoutSeconds: 240,
              customSync: 'keep-me',
            },
            query: {
              maxResults: 8,
            },
            customRuntimeFlag: true,
          },
        },
      },
    });

    const { clearEmbeddingSettings } = await import('@electron/utils/openclaw-embeddings');
    const snapshot = await clearEmbeddingSettings();

    expect(snapshot.configured).toBe(false);
    expect(snapshot.config.provider).toBe('openai');

    const saved = await readOpenClawJson();
    const defaults = (saved.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect(defaults.memorySearch).toEqual({
      sync: {
        customSync: 'keep-me',
      },
      customRuntimeFlag: true,
    });
  });
});
