import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchProviderSnapshot = vi.fn();
const mockValidateKey = vi.fn();

vi.mock('@/lib/provider-accounts', () => ({
  fetchProviderSnapshot: (...args: unknown[]) => mockFetchProviderSnapshot(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    providers: {
      validateKey: (...args: unknown[]) => mockValidateKey(...args),
    },
  },
}));

import { useProviderStore } from '@/stores/providers';

describe('useProviderStore - validateAccountApiKey()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards opaque credential handles without exposing or transforming secrets', async () => {
    mockValidateKey.mockResolvedValueOnce({ valid: true });
    const credentialHandle = 'credential-stage://opaque-validation-handle';

    const result = await useProviderStore.getState().validateAccountApiKey(
      'custom',
      credentialHandle,
      ['openclaw', 'deepseek-harness'],
      {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiProtocol: 'openai-completions',
        modelId: 'local-model',
      },
    );

    expect(result).toEqual({ valid: true });
    expect(mockValidateKey).toHaveBeenCalledWith({
      accountId: 'custom',
      vendorId: 'custom',
      providerId: 'custom',
      credentialHandle,
      kernelIds: ['openclaw', 'deepseek-harness'],
      options: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiProtocol: 'openai-completions',
        modelId: 'local-model',
      },
    });
    expect(mockValidateKey.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
  });

  it('returns validation failures without throwing', async () => {
    mockValidateKey.mockResolvedValueOnce({ valid: false, error: 'API key is rejected' });

    const result = await useProviderStore.getState().validateAccountApiKey(
      'custom',
      'credential-stage://rejected-handle',
    );

    expect(result).toEqual({ valid: false, error: 'API key is rejected' });
    expect(mockValidateKey).toHaveBeenCalledTimes(1);
  });

  it('normalizes invocation failures into validation failures', async () => {
    mockValidateKey.mockRejectedValueOnce(new Error('offline'));

    const result = await useProviderStore.getState().validateAccountApiKey(
      'custom',
      'credential-stage://offline-handle',
    );

    expect(result).toEqual({ valid: false, error: 'Error: offline' });
  });
});

describe('useProviderStore - credential boundary', () => {
  it('does not expose any Renderer API for reading raw provider credentials', () => {
    expect(useProviderStore.getState()).not.toHaveProperty('getAccountApiKey');
  });
});
