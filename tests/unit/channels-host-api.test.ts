// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelAdapterRegistry } from '@electron/channels/channel-adapter-registry';
import { CanonicalChannelAccountService } from '@electron/channels/channel-account-service';
import { MemoryChannelSecretStore } from '@electron/channels/channel-secret-store';
import type { ChannelKernelAdapter } from '@electron/channels/channel-runtime-contracts';
import { ClawXDataService, type ClawXDataClient } from '@electron/data/clawx-data-service';
import { createChannelsApi } from '@electron/services/channels-api';
import { CredentialStagingVault } from '@electron/security/credential-staging-vault';
import type { KernelId } from '@shared/kernels/contracts';
import { SUPPORTED_CHANNEL_TYPES } from '@shared/types/channel';
import { validateFeishuCredentials } from '@electron/channels/feishu-credentials';
import { proxyAwareFetch } from '@electron/utils/proxy-fetch';
vi.mock('@electron/utils/proxy-fetch', () => ({ proxyAwareFetch: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

function remote(client: ClawXDataClient) {
  return {
    call<T>(method: string, ...args: unknown[]): Promise<T> {
      const operation = (client as unknown as Record<string, unknown>)[method];
      if (typeof operation !== 'function') return Promise.reject(new Error(`Unknown DataService method: ${method}`));
      return Reflect.apply(operation, client, args) as Promise<T>;
    },
  };
}

describe('canonical Channels Host API', () => {
  it.each(['openclaw', 'deepseek-harness'] as const)('validates Feishu before persisting or consuming credentials for %s', async kernelId => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-feishu-api-'));
    const service = new ClawXDataService(join(root, 'clawx.sqlite'));
    cleanups.push(() => service.close());
    const data = remote(service.connect({ role: 'main' }));
    const secrets = new MemoryChannelSecretStore();
    const accounts = new CanonicalChannelAccountService(data, secrets);
    const vault = new CredentialStagingVault();
    const adapters = new ChannelAdapterRegistry();
    adapters.register({ kernelId, ownerId: 'test-owner', supportedChannels: ['feishu'], validate: (_type, config) => validateFeishuCredentials(config), activate: vi.fn(), deactivate: vi.fn(), send: vi.fn(), targets: async () => [], status: async () => ({ state: 'disconnected', changedAt: new Date().toISOString() }) });
    const owner = { activate: vi.fn(), deactivate: vi.fn(), targets: vi.fn() };
    const api = createChannelsApi({ gatewayManager: {} as never, dataClient: data, accountService: accounts, credentialVault: vault, adapterRegistry: adapters, ownerCoordinator: owner as never, bindingService: {} as never });
    const handle = vault.stage('secret');
    const payload = { channelType: 'feishu', accountId: 'team', kernelId, config: { appId: 'cli', appSecret: handle } };
    vi.mocked(proxyAwareFetch).mockResolvedValue(Response.json({ code: 1, msg: 'private response' }));
    expect(await api.saveConfig(payload)).toEqual({ success: false, errorCode: 'feishuRejected' });
    expect(await accounts.list()).toEqual([]);
    expect(vault.size).toBe(1);
    expect(owner.activate).not.toHaveBeenCalled();
    vi.mocked(proxyAwareFetch).mockReset().mockResolvedValueOnce(Response.json({ code: 1 })).mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: 'private token' }));
    expect(await api.saveConfig(payload)).toEqual({ success: true });
    expect(vault.size).toBe(0);
    const saved = (await accounts.get('feishu', 'team'))!;
    expect(saved.config).toEqual({ appId: 'cli', domain: 'lark' });
    expect((await secrets.get(saved.id))?.values).toEqual({ appSecret: 'secret' });
    vi.mocked(proxyAwareFetch).mockClear();
    const changed = { ...payload, config: { appId: 'another-app' } };
    expect(await api.validateCredentials(changed)).toMatchObject({ valid: false, errorCode: 'feishuAppSecretReenter' });
    expect(await api.saveConfig(changed)).toEqual({ success: false, errorCode: 'feishuAppSecretReenter' });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect((await accounts.get('feishu', 'team'))?.config).toEqual(saved.config);
  });

  it('routes secure CRUD and QR login through the explicitly selected kernel adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-channels-api-'));
    const dataService = new ClawXDataService(join(root, 'clawx.sqlite'));
    const client = dataService.connect({ role: 'main' });
    cleanups.push(() => dataService.close());
    const data = remote(client);
    const secrets = new MemoryChannelSecretStore();
    const accounts = new CanonicalChannelAccountService(data, secrets);
    const vault = new CredentialStagingVault();
    const validationCalls: Array<{ kernelId: KernelId; token?: unknown }> = [];
    const adapters = new ChannelAdapterRegistry();
    const makeAdapter = (kernelId: KernelId): ChannelKernelAdapter => ({
      kernelId,
      ownerId: `${kernelId}-channels`,
      supportedChannels: SUPPORTED_CHANNEL_TYPES,
      validate: async (_channelType, config) => {
        validationCalls.push({ kernelId, token: config.botToken });
        return { valid: config.botToken === 'relay-secret' };
      },
      activate: async () => undefined,
      deactivate: async () => undefined,
      send: async () => undefined,
      targets: async () => [],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
      startLogin: async (_channelType, nativeAccountId, emit) => {
        emit({
          type: 'success',
          nativeAccountId: nativeAccountId || 'qr-account',
          credential: { botToken: 'qr-secret' },
        });
      },
      cancelLogin: async () => undefined,
    });
    adapters.register(makeAdapter('openclaw'));
    adapters.register(makeAdapter('deepseek-harness'));
    const owner = {
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined),
      targets: vi.fn(async () => []),
    };
    const binding = {
      rebind: vi.fn(async () => ({ ok: true, rolledBack: false })),
      remove: vi.fn(async () => true),
    };
    const events: Array<{ name: string; payload: unknown }> = [];
    const api = createChannelsApi({
      gatewayManager: { getStatus: () => ({ state: 'stopped' }) } as never,
      mainWindow: {
        isDestroyed: () => false,
        webContents: { send: (name: string, payload: unknown) => events.push({ name, payload }) },
      } as never,
      dataClient: data,
      accountService: accounts,
      bindingService: binding as never,
      ownerCoordinator: owner as never,
      adapterRegistry: adapters,
      credentialVault: vault,
    });

    const stagedForValidation = vault.stage('relay-secret');
    expect(await api.validateCredentials({
      channelType: 'telegram',
      accountId: 'relay-account',
      kernelId: 'deepseek-harness',
      config: { botToken: stagedForValidation },
    })).toEqual(expect.objectContaining({ success: true, valid: true }));
    expect(validationCalls).toEqual([{ kernelId: 'deepseek-harness', token: 'relay-secret' }]);
    expect(vault.size).toBe(1);

    const stagedForSave = vault.stage('relay-secret');
    await api.saveConfig({
      channelType: 'telegram',
      accountId: 'relay-account',
      kernelId: 'deepseek-harness',
      config: { botToken: stagedForSave, allowedUsers: 'alice' },
    });
    expect(vault.size).toBe(1);
    expect(await api.formValues({ channelType: 'telegram', accountId: 'relay-account' })).toEqual({
      success: true,
      values: { allowedUsers: 'alice' },
      configuredSecretFields: ['botToken'],
    });
    const stored = await accounts.get('telegram', 'relay-account');
    expect(stored?.config).toEqual({ allowedUsers: 'alice' });
    expect(JSON.stringify(await client.getChannelAccount(stored!.id))).not.toContain('relay-secret');
    expect((await secrets.get(stored!.id))?.values).toEqual({ botToken: 'relay-secret' });

    const list = await api.accounts({ mode: 'config' });
    expect(list.adapters).toEqual([
      expect.objectContaining({ kernelId: 'deepseek-harness' }),
      expect.objectContaining({ kernelId: 'openclaw' }),
    ]);

    await api.startLogin({ channelType: 'wechat', accountId: 'qr-account', kernelId: 'deepseek-harness' });
    await vi.waitFor(async () => {
      expect((await accounts.get('wechat', 'qr-account'))?.credentialRef).toBeTruthy();
    });
    expect((await secrets.get((await accounts.get('wechat', 'qr-account'))!.id))?.values).toEqual({ botToken: 'qr-secret' });
    expect(events).toContainEqual(expect.objectContaining({ name: expect.stringContaining('wechat-success') }));
  });

  it('enables or disables only the requested account when accountId is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-channels-enabled-'));
    const dataService = new ClawXDataService(join(root, 'clawx.sqlite'));
    const client = dataService.connect({ role: 'main' });
    cleanups.push(() => dataService.close());
    const data = remote(client);
    const accounts = new CanonicalChannelAccountService(data, new MemoryChannelSecretStore());
    await accounts.upsert({ channelType: 'telegram', nativeAccountId: 'one', config: { botToken: 'one' } });
    await accounts.upsert({ channelType: 'telegram', nativeAccountId: 'two', config: { botToken: 'two' } });
    const adapters = new ChannelAdapterRegistry();
    adapters.register({
      kernelId: 'deepseek-harness',
      ownerId: 'relay',
      supportedChannels: SUPPORTED_CHANNEL_TYPES,
      validate: async () => ({ valid: true }),
      activate: async () => undefined,
      deactivate: async () => undefined,
      send: async () => undefined,
      targets: async () => [],
      status: async () => ({ state: 'connected', changedAt: new Date().toISOString() }),
    });
    const owner = { activate: vi.fn(), deactivate: vi.fn(async () => undefined), targets: vi.fn() };
    const api = createChannelsApi({
      gatewayManager: {} as never,
      dataClient: data,
      accountService: accounts,
      bindingService: { rebind: vi.fn(), remove: vi.fn() } as never,
      ownerCoordinator: owner as never,
      adapterRegistry: adapters,
    });
    await api.setEnabled({ channelType: 'telegram', accountId: 'one', enabled: false });
    expect((await accounts.get('telegram', 'one'))?.enabled).toBe(false);
    expect((await accounts.get('telegram', 'two'))?.enabled).toBe(true);
    expect(owner.deactivate).toHaveBeenCalledTimes(1);
  });
});
