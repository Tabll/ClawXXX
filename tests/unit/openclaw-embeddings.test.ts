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

  it('writes agents.defaults.memorySearch embedding fields and preserves query tuning', async () => {
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
    });

    expect(snapshot.config.remote.apiKeyConfigured).toBe(true);
    expect(snapshot.knownProviders).toContain('embed-gpu');

    const saved = await readOpenClawJson();
    const defaults = (saved.agents as Record<string, unknown>).defaults as Record<string, unknown>;
    expect(defaults.memorySearch).toEqual({
      query: {
        maxResults: 12,
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
      },
      sync: {
        embeddingBatchTimeoutSeconds: 240,
      },
    });
  });

  it('clears embedding fields while keeping unrelated memorySearch settings', async () => {
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
            },
            query: {
              maxResults: 8,
            },
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
        onSearch: true,
      },
      query: {
        maxResults: 8,
      },
    });
  });
});
