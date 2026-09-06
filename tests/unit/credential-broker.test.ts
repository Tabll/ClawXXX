// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { CredentialBroker, type CredentialBrokerAuditEvent } from '@electron/security/credential-broker';
import { asProviderAccountId } from '@shared/domains/identity';
import { providerCredentialReference, type CanonicalProviderAccount } from '@shared/domains/providers';

const identity = {
  kernelId: 'deepseek-harness' as const,
  generation: 7,
  pid: 4321,
  artifactVersion: '0.1.2-alpha.2+clawx.10',
};

function account(overrides: Partial<CanonicalProviderAccount> = {}): CanonicalProviderAccount {
  return {
    id: asProviderAccountId('deepseek-primary'),
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    authMode: 'api_key',
    credentialRef: providerCredentialReference('deepseek-primary'),
    metadata: {},
    models: [{
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      modalities: ['text'],
      supportedKernels: ['openclaw', 'deepseek-harness'],
    }],
    selectedModelId: 'deepseek-chat',
    enabled: true,
    projections: [{
      kernelId: 'deepseek-harness',
      nativeId: 'deepseek-primary',
      state: 'ready',
      desiredVersion: 1,
      appliedVersion: 1,
      updatedAt: '2026-08-24T00:00:00.000Z',
    }],
    version: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('CredentialBroker', () => {
  it('authorizes an exact registered process/account/projection/purpose without auditing the value', async () => {
    const events: CredentialBrokerAuditEvent[] = [];
    const broker = new CredentialBroker({
      getAccount: vi.fn().mockResolvedValue(account()),
      getSecret: vi.fn().mockResolvedValue({
        type: 'api_key',
        accountId: 'deepseek-primary',
        apiKey: 'sk-live-never-audit-this-value',
      }),
      audit: event => events.push(event),
      now: () => new Date('2026-08-24T01:00:00.000Z'),
    });
    broker.registerProcess(identity);

    await expect(broker.resolve({
      ...identity,
      accountId: 'deepseek-primary',
      purpose: 'model-request',
    })).resolves.toBe('sk-live-never-audit-this-value');

    expect(events).toEqual([expect.objectContaining({
      outcome: 'allowed',
      kernelId: 'deepseek-harness',
      generation: 7,
      pid: 4321,
      accountId: 'deepseek-primary',
      purpose: 'model-request',
    })]);
    expect(JSON.stringify(events)).not.toContain('sk-live-never-audit-this-value');
  });

  it.each([
    ['PID', { pid: 4322 }, 'not registered'],
    ['generation', { generation: 8 }, 'not registered'],
    ['artifact', { artifactVersion: 'tampered' }, 'not registered'],
  ])('fails closed for a mismatched %s identity', async (_label, mismatch, message) => {
    const broker = new CredentialBroker({
      getAccount: vi.fn().mockResolvedValue(account()),
      getSecret: vi.fn().mockResolvedValue({ type: 'api_key', accountId: 'deepseek-primary', apiKey: 'secret' }),
    });
    broker.registerProcess(identity);
    await expect(broker.resolve({
      ...identity,
      ...mismatch,
      accountId: 'deepseek-primary',
      purpose: 'model-request',
    })).rejects.toThrow(message);
  });

  it('rejects unauthorized purpose, disabled accounts, invalid refs and non-ready projections', async () => {
    let current = account();
    const broker = new CredentialBroker({
      getAccount: vi.fn().mockImplementation(async () => current),
      getSecret: vi.fn().mockResolvedValue({ type: 'api_key', accountId: 'deepseek-primary', apiKey: 'secret' }),
    });
    broker.registerProcess(identity);

    await expect(broker.resolve({
      ...identity,
      accountId: 'deepseek-primary',
      purpose: 'channel-connect',
    })).rejects.toThrow('purpose is not authorized');

    current = account({ enabled: false });
    await expect(broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' }))
      .rejects.toThrow('account is unavailable');

    current = account({ credentialRef: providerCredentialReference('another-account') });
    await expect(broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' }))
      .rejects.toThrow('reference is invalid');

    current = account({
      projections: [{
        kernelId: 'deepseek-harness',
        state: 'failed',
        desiredVersion: 1,
        error: { code: 'FAILED', message: 'projection failed', retryable: true },
        updatedAt: '2026-08-24T00:00:00.000Z',
      }],
    });
    await expect(broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' }))
      .rejects.toThrow('not projected');
  });

  it('revokes on disconnect and enforces a bounded per-process request budget', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const broker = new CredentialBroker({
      getAccount: vi.fn().mockImplementation(async () => {
        await blocked;
        return account();
      }),
      getSecret: vi.fn().mockResolvedValue({ type: 'api_key', accountId: 'deepseek-primary', apiKey: 'secret' }),
      maxConcurrentRequestsPerProcess: 1,
    });
    const revoke = broker.registerProcess(identity);
    const first = broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' });
    await Promise.resolve();
    await expect(broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' }))
      .rejects.toThrow('budget is exhausted');
    release();
    await expect(first).resolves.toBe('secret');

    revoke();
    expect(broker.isRegistered(identity)).toBe(false);
    await expect(broker.resolve({ ...identity, accountId: 'deepseek-primary', purpose: 'model-request' }))
      .rejects.toThrow('not registered');
  });
});
