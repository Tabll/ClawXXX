// @vitest-environment node

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import {
  ProviderProjectionReconciler,
  type ProviderKernelProjectionAdapter,
} from '@electron/services/providers/provider-projection-reconciler';
import { asProviderAccountId } from '@shared/domains/identity';
import {
  providerCredentialReference,
  type CanonicalProviderAccount,
} from '@shared/domains/providers';

function account(overrides: Partial<CanonicalProviderAccount> = {}): CanonicalProviderAccount {
  return {
    id: asProviderAccountId('deepseek-primary'),
    providerId: 'deepseek',
    displayName: 'DeepSeek Primary',
    authMode: 'api_key',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    credentialRef: providerCredentialReference('deepseek-primary'),
    metadata: {},
    models: [{
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      modalities: ['text'],
      supportsTools: true,
      supportedKernels: ['openclaw', 'deepseek-harness'],
    }],
    selectedModelId: 'deepseek-chat',
    enabled: true,
    projections: [],
    version: 3,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function remote(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`Unknown method: ${method}`));
      return Reflect.apply(fn, client, args) as Promise<T>;
    },
  };
}

describe('canonical Provider projection contract', () => {
  it('projects one account to both kernels and preserves an independent partial failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-provider-projection-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    const main = service.connect({ role: 'main' });
    await main.putProvider(account());

    const openclawUpsert = vi.fn().mockResolvedValue({ nativeId: 'deepseek' });
    const dshUpsert = vi.fn().mockRejectedValue(new Error('DSH projection unavailable'));
    const adapters: ProviderKernelProjectionAdapter[] = [{
      kernelId: 'openclaw',
      available: () => true,
      upsert: openclawUpsert,
      remove: vi.fn(),
    }, {
      kernelId: 'deepseek-harness',
      available: () => true,
      upsert: dshUpsert,
      remove: vi.fn(),
    }];
    const reconciler = new ProviderProjectionReconciler(
      remote(main),
      adapters,
      () => new Date('2026-08-24T01:00:00.000Z'),
    );

    await expect(reconciler.reconcileAccount('deepseek-primary')).resolves.toEqual([
      expect.objectContaining({ kernelId: 'openclaw', status: 'ready', nativeId: 'deepseek' }),
      expect.objectContaining({
        kernelId: 'deepseek-harness',
        status: 'failed',
        error: 'DSH projection unavailable',
      }),
    ]);
    expect(openclawUpsert).toHaveBeenCalledTimes(1);
    expect(dshUpsert).toHaveBeenCalledTimes(1);

    const stored = await main.getProvider('deepseek-primary');
    expect(stored?.projections).toEqual([
      expect.objectContaining({ kernelId: 'deepseek-harness', state: 'failed', desiredVersion: 3 }),
      expect.objectContaining({
        kernelId: 'openclaw',
        state: 'ready',
        desiredVersion: 3,
        appliedVersion: 3,
      }),
    ]);
    await service.close();
  });

  it('stores kernel defaults independently and never serializes a credential value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-provider-storage-'));
    const databasePath = join(root, 'clawx.sqlite');
    const service = new ClawXDataService(databasePath);
    const main = service.connect({ role: 'main' });
    await main.putProvider(account());
    await main.setProviderDefault({
      kernelId: 'openclaw',
      accountId: asProviderAccountId('deepseek-primary'),
      modelId: 'deepseek-chat',
      updatedAt: '2026-08-24T01:00:00.000Z',
    });
    await main.setProviderDefault({
      kernelId: 'deepseek-harness',
      accountId: asProviderAccountId('deepseek-primary'),
      modelId: 'deepseek-chat',
      updatedAt: '2026-08-24T01:00:01.000Z',
    });
    expect(await main.listProviderDefaults()).toEqual([
      expect.objectContaining({ kernelId: 'deepseek-harness', accountId: 'deepseek-primary' }),
      expect.objectContaining({ kernelId: 'openclaw', accountId: 'deepseek-primary' }),
    ]);

    const forbiddenSecret = 'sk-forbidden-plaintext-provider-secret';
    await expect(main.putProvider(account({
      headers: { Authorization: `Bearer ${forbiddenSecret}` },
      version: 4,
    }))).rejects.toThrow(/secret|sensitive|Authorization/i);
    await service.close();

    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(forbiddenSecret))).toBe(false);
    }
  });
});
