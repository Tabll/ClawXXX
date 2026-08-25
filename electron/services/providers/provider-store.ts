import type { ProviderAccount, ProviderConfig, ProviderType } from '../../shared/providers/types';
import { getProviderDefinition } from '../../shared/providers/registry';
import { getClawXProviderStore } from './store-instance';
import type { KernelId } from '@shared/kernels/contracts';
import type {
  CanonicalProviderAccount,
  CanonicalProviderModel,
  KernelProviderDefault,
} from '@shared/domains/providers';
import { providerCredentialReference } from '@shared/domains/providers';
import { asProviderAccountId } from '@shared/domains/identity';

export type ProviderCanonicalDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

let canonicalDataClient: ProviderCanonicalDataClient | undefined;

export function configureCanonicalProviderStore(client: ProviderCanonicalDataClient | undefined): void {
  canonicalDataClient = client;
}

export function isCanonicalProviderStoreConfigured(): boolean {
  return canonicalDataClient !== undefined;
}

function supportedKernels(type: ProviderType): KernelId[] {
  return type === 'deepseek' ? ['openclaw', 'deepseek-harness'] : ['openclaw'];
}

function canonicalModels(account: ProviderAccount): CanonicalProviderModel[] {
  const ids = new Set<string>();
  if (account.model?.trim()) ids.add(account.model.trim());
  for (const model of account.metadata?.customModels ?? []) {
    if (model.trim()) ids.add(model.trim());
  }
  return [...ids].map(modelId => ({
    providerId: account.vendorId,
    modelId,
    displayName: modelId,
    modalities: account.modelCapabilities?.imageInput ? ['text', 'image'] : ['text'],
    ...(account.modelCapabilities?.reasoning ? { supportsTools: true } : {}),
    supportedKernels: supportedKernels(account.vendorId),
  }));
}

export function providerAccountToCanonical(
  account: ProviderAccount,
  existing?: CanonicalProviderAccount,
): CanonicalProviderAccount {
  return {
    id: asProviderAccountId(account.id),
    providerId: account.vendorId,
    displayName: account.label,
    authMode: account.authMode,
    ...(account.apiProtocol ? { protocol: account.apiProtocol } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(account.headers ? { headers: account.headers } : {}),
    credentialRef: existing?.credentialRef ?? providerCredentialReference(account.id),
    metadata: {
      ...(account.metadata?.region ? { region: account.metadata.region } : {}),
      ...(account.metadata?.email ? { email: account.metadata.email } : {}),
      ...(account.metadata?.resourceUrl ? { resourceUrl: account.metadata.resourceUrl } : {}),
      ...(account.metadata?.customModels ? { customModels: [...account.metadata.customModels] } : {}),
      ...(account.modelCapabilities?.reasoning !== undefined
        ? { reasoning: account.modelCapabilities.reasoning }
        : {}),
      ...(account.modelCapabilities?.imageInput !== undefined
        ? { imageInput: account.modelCapabilities.imageInput }
        : {}),
    },
    models: canonicalModels(account),
    ...(account.model ? { selectedModelId: account.model } : {}),
    ...(account.fallbackModels ? { fallbackModelIds: [...account.fallbackModels] } : {}),
    ...(account.fallbackAccountIds
      ? { fallbackAccountIds: account.fallbackAccountIds.map(asProviderAccountId) }
      : {}),
    enabled: account.enabled,
    projections: existing?.projections ?? [],
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function canonicalToProviderAccount(
  account: CanonicalProviderAccount,
  defaultAccountId?: string,
): ProviderAccount {
  return {
    id: account.id,
    vendorId: account.providerId as ProviderType,
    label: account.displayName,
    authMode: account.authMode ?? (account.providerId === 'ollama' ? 'local' : 'api_key'),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(account.protocol ? { apiProtocol: account.protocol as ProviderAccount['apiProtocol'] } : {}),
    ...(account.headers ? { headers: account.headers } : {}),
    ...(account.selectedModelId ? { model: account.selectedModelId } : {}),
    ...(account.metadata.reasoning !== undefined || account.metadata.imageInput !== undefined ? {
      modelCapabilities: {
        ...(account.metadata.reasoning !== undefined ? { reasoning: account.metadata.reasoning } : {}),
        ...(account.metadata.imageInput !== undefined ? { imageInput: account.metadata.imageInput } : {}),
      },
    } : {}),
    ...(account.fallbackModelIds ? { fallbackModels: [...account.fallbackModelIds] } : {}),
    ...(account.fallbackAccountIds ? { fallbackAccountIds: account.fallbackAccountIds.map(String) } : {}),
    enabled: account.enabled ?? true,
    isDefault: account.id === defaultAccountId,
    metadata: {
      ...(account.metadata.region ? { region: account.metadata.region } : {}),
      ...(account.metadata.email ? { email: account.metadata.email } : {}),
      ...(account.metadata.resourceUrl ? { resourceUrl: account.metadata.resourceUrl } : {}),
      ...(account.metadata.customModels ? { customModels: [...account.metadata.customModels] } : {}),
    },
    supportedKernels: Array.from(new Set([
      'openclaw',
      ...account.models.flatMap(model => model.supportedKernels.map(String)),
    ])),
    projections: account.projections.map(projection => ({
      kernelId: projection.kernelId,
      status: projection.state,
      desiredVersion: projection.desiredVersion,
      ...(projection.appliedVersion !== undefined ? { appliedVersion: projection.appliedVersion } : {}),
      ...(projection.nativeId ? { nativeId: projection.nativeId } : {}),
      ...(projection.error ? { error: projection.error.message } : {}),
      updatedAt: projection.updatedAt,
    })),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function inferAuthMode(type: ProviderType): ProviderAccount['authMode'] {
  if (type === 'ollama') {
    return 'local';
  }

  const definition = getProviderDefinition(type);
  if (definition?.defaultAuthMode) {
    return definition.defaultAuthMode;
  }

  return 'api_key';
}

export function providerConfigToAccount(
  config: ProviderConfig,
  options?: { isDefault?: boolean },
): ProviderAccount {
  return {
    id: config.id,
    vendorId: config.type,
    label: config.name,
    authMode: inferAuthMode(config.type),
    baseUrl: config.baseUrl,
    apiProtocol: config.apiProtocol || (config.type === 'custom' || config.type === 'ollama'
      ? 'openai-completions'
      : getProviderDefinition(config.type)?.providerConfig?.api),
    headers: config.headers,
    model: config.model,
    modelCapabilities: config.modelCapabilities,
    fallbackModels: config.fallbackModels,
    fallbackAccountIds: config.fallbackProviderIds,
    enabled: config.enabled,
    isDefault: options?.isDefault ?? false,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

export function providerAccountToConfig(account: ProviderAccount): ProviderConfig {
  return {
    id: account.id,
    name: account.label,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    headers: account.headers,
    model: account.model,
    modelCapabilities: account.modelCapabilities,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function listProviderAccounts(): Promise<ProviderAccount[]> {
  if (canonicalDataClient) {
    const [accounts, defaultEntry] = await Promise.all([
      canonicalDataClient.call<CanonicalProviderAccount[]>('listProviders'),
      canonicalDataClient.call<KernelProviderDefault | undefined>('getProviderDefault', 'openclaw'),
    ]);
    return accounts.map(account => canonicalToProviderAccount(account, defaultEntry?.accountId));
  }
  const store = await getClawXProviderStore();
  const accounts = store.get('providerAccounts') as Record<string, ProviderAccount> | undefined;
  return Object.values(accounts ?? {});
}

export async function getProviderAccount(accountId: string): Promise<ProviderAccount | null> {
  if (canonicalDataClient) {
    const [account, defaultEntry] = await Promise.all([
      canonicalDataClient.call<CanonicalProviderAccount | undefined>('getProvider', accountId),
      canonicalDataClient.call<KernelProviderDefault | undefined>('getProviderDefault', 'openclaw'),
    ]);
    return account ? canonicalToProviderAccount(account, defaultEntry?.accountId) : null;
  }
  const store = await getClawXProviderStore();
  const accounts = store.get('providerAccounts') as Record<string, ProviderAccount> | undefined;
  return accounts?.[accountId] ?? null;
}

export async function saveProviderAccount(account: ProviderAccount): Promise<void> {
  if (canonicalDataClient) {
    const existing = await canonicalDataClient.call<CanonicalProviderAccount | undefined>('getProvider', account.id);
    await canonicalDataClient.call('putProvider', providerAccountToCanonical(account, existing));
    if (account.isDefault) {
      await setDefaultProviderAccount(account.id, 'openclaw', account.model);
    }
    return;
  }
  const store = await getClawXProviderStore();
  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  accounts[account.id] = account;
  store.set('providerAccounts', accounts);
}

export async function deleteProviderAccount(accountId: string): Promise<void> {
  if (canonicalDataClient) {
    await canonicalDataClient.call('deleteProvider', accountId);
    return;
  }
  const store = await getClawXProviderStore();
  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  delete accounts[accountId];
  store.set('providerAccounts', accounts);

  if (store.get('defaultProviderAccountId') === accountId) {
    store.delete('defaultProviderAccountId');
  }
}

export async function setDefaultProviderAccount(
  accountId: string,
  kernelId: KernelId = 'openclaw',
  modelId?: string,
): Promise<void> {
  if (canonicalDataClient) {
    await canonicalDataClient.call('setProviderDefault', {
      kernelId,
      accountId: asProviderAccountId(accountId),
      ...(modelId ? { modelId } : {}),
      updatedAt: new Date().toISOString(),
    } satisfies KernelProviderDefault);
    return;
  }
  const store = await getClawXProviderStore();
  store.set('defaultProviderAccountId', accountId);

  const accounts = (store.get('providerAccounts') ?? {}) as Record<string, ProviderAccount>;
  for (const account of Object.values(accounts)) {
    account.isDefault = account.id === accountId;
  }
  store.set('providerAccounts', accounts);
}

export async function getDefaultProviderAccountId(kernelId: KernelId = 'openclaw'): Promise<string | undefined> {
  if (canonicalDataClient) {
    return (await canonicalDataClient.call<KernelProviderDefault | undefined>(
      'getProviderDefault',
      kernelId,
    ))?.accountId;
  }
  const store = await getClawXProviderStore();
  return store.get('defaultProviderAccountId') as string | undefined;
}

export async function listCanonicalProviderAccounts(): Promise<CanonicalProviderAccount[]> {
  if (!canonicalDataClient) return [];
  return canonicalDataClient.call('listProviders');
}

export async function getCanonicalProviderAccount(accountId: string): Promise<CanonicalProviderAccount | undefined> {
  if (!canonicalDataClient) return undefined;
  return canonicalDataClient.call('getProvider', accountId);
}

export async function listProviderDefaults(): Promise<KernelProviderDefault[]> {
  if (!canonicalDataClient) {
    const accountId = await getDefaultProviderAccountId();
    return accountId ? [{ kernelId: 'openclaw', accountId: asProviderAccountId(accountId), updatedAt: new Date(0).toISOString() }] : [];
  }
  return canonicalDataClient.call('listProviderDefaults');
}
