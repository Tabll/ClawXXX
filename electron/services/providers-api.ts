import type { BrowserWindow } from 'electron';
import type {
  HostApiContract,
  ProviderKernelProjection,
  ProviderValidationResult,
} from '@shared/host-api/contract';
import type { KernelId } from '@shared/kernels/contracts';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { GatewayManager } from '../gateway/manager';
import type { ProviderConfig } from '../utils/secure-storage';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../utils/browser-oauth';
import { deviceOAuthManager, type OAuthProviderType } from '../utils/device-oauth';
import { getProviderConfig } from '../utils/provider-registry';
import { logger } from '../utils/logger';
import { getProviderService } from './providers/provider-service';
import {
  listProviderDefaults,
  providerAccountToConfig,
  setDefaultProviderAccount,
} from './providers/provider-store';
import {
  syncDefaultProviderToRuntime,
  syncDeletedProviderApiKeyToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
} from './providers/provider-runtime-sync';
import { validateApiKeyWithProvider } from './providers/provider-validation';
import {
  OLLAMA_PLACEHOLDER_API_KEY,
  type ProviderAccount,
} from '../shared/providers/types';
import { isRecord } from './payload-utils';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import type {
  ProviderProjectionReconciler,
  ProviderProjectionResult,
} from './providers/provider-projection-reconciler';
import type { CredentialStagingVault } from '../security/credential-staging-vault';
import { REDACTED_SECRET, redactSecrets } from '../security/secret-redaction';

type ProvidersApiContext = {
  gatewayManager: GatewayManager;
  mainWindow: BrowserWindow;
  dataClient?: RemoteDataServiceClient;
  projectionReconciler?: ProviderProjectionReconciler;
  credentialVault?: CredentialStagingVault;
};

type ProviderPayload<Action extends keyof HostApiContract['providers']> =
  Parameters<HostApiContract['providers'][Action]>[0];

type ValidationOptions = {
  baseUrl?: string;
  apiProtocol?: string;
  modelId?: string;
};

function payloadString(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireString(payload: unknown, key: string, action: string): string {
  const value = payloadString(payload, key);
  if (!value) throw new Error(`Invalid providers.${action} payload`);
  return value;
}

function getPayloadRecord(payload: unknown, action: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`Invalid providers.${action} payload`);
  return payload;
}

function getProviderId(payload: unknown, action: string): string {
  return requireString(payload, 'providerId', action);
}

function getAccountId(payload: unknown, action: string): string {
  return requireString(payload, 'accountId', action);
}

function safeError(error: unknown, credential?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (credential) message = message.split(credential).join(REDACTED_SECRET);
  return String(redactSecrets(message));
}

function getStagedCredential(
  ctx: ProvidersApiContext,
  handle: unknown,
  mode: 'read' | 'consume',
): string | undefined {
  if (handle === undefined) return undefined;
  if (typeof handle !== 'string' || !handle.startsWith('credential-stage://')) {
    throw new Error('Provider credential must be supplied as a secure staging handle');
  }
  if (!ctx.credentialVault) throw new Error('Secure credential staging is unavailable');
  const credential = mode === 'read'
    ? ctx.credentialVault.read(handle)
    : ctx.credentialVault.consume(handle);
  const normalized = credential.trim();
  if (!normalized) throw new Error('Provider credential is empty');
  return normalized;
}

function supportedKernelIds(account: ProviderAccount | null, providerType: string): KernelId[] {
  if (account?.supportedKernels?.length) return [...new Set(account.supportedKernels)] as KernelId[];
  return providerType === 'deepseek'
    ? ['openclaw', 'deepseek-harness']
    : ['openclaw'];
}

function selectReplacementAccount(
  accounts: ProviderAccount[],
  kernelId: KernelId,
): ProviderAccount | undefined {
  return accounts
    .filter(account => account.enabled && supportedKernelIds(account, account.vendorId).includes(kernelId))
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated !== 0 ? updated : left.id.localeCompare(right.id);
    })[0];
}

function requestedKernelIds(body: Record<string, unknown>, supported: KernelId[]): KernelId[] {
  if (!Array.isArray(body.kernelIds)) return supported;
  const ids = body.kernelIds
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim() as KernelId);
  return [...new Set(ids)];
}

function toHostProjection(result: ProviderProjectionResult): ProviderKernelProjection {
  return {
    kernelId: result.kernelId,
    status: result.status,
    desiredVersion: 0,
    ...(result.status === 'ready' || result.status === 'partial' ? { appliedVersion: 0 } : {}),
    ...(result.nativeId ? { nativeId: result.nativeId } : {}),
    ...(result.error ? { error: result.error } : {}),
    updatedAt: new Date().toISOString(),
  };
}

async function reconcileAccount(
  ctx: ProvidersApiContext,
  accountId: string,
  kernelIds?: KernelId[],
): Promise<ProviderProjectionResult[]> {
  if (ctx.projectionReconciler) {
    return ctx.projectionReconciler.reconcileAccount(accountId, kernelIds);
  }

  // Production Main always supplies the reconciler. This fallback only keeps
  // isolated legacy/unit contexts operational.
  const account = await getProviderService().getAccount(accountId);
  if (!account) throw new Error(`Provider account not found: ${accountId}`);
  await syncSavedProviderToRuntime(providerAccountToConfig(account), undefined, ctx.gatewayManager);
  return [{ kernelId: 'openclaw', accountId, status: 'ready', nativeId: accountId }];
}

async function validateKey(
  ctx: ProvidersApiContext,
  payload: ProviderPayload<'validateKey'>,
): Promise<ProviderValidationResult> {
  let credential: string | undefined;
  try {
    const body = getPayloadRecord(payload, 'validateKey');
    credential = getStagedCredential(ctx, body.credentialHandle, 'read');
    if (!credential) return { valid: false, error: 'A secure credential handle is required' };

    const accountId = payloadString(body, 'accountId');
    const vendorId = payloadString(body, 'vendorId');
    const providerId = payloadString(body, 'providerId');
    const lookupId = accountId || providerId || vendorId || '';
    const providerService = getProviderService();
    const account = lookupId ? await providerService.getAccount(lookupId) : null;
    const legacyProvider = !account && providerId
      ? await providerService._getProviderInternal(providerId)
      : null;
    const providerType = account?.vendorId || legacyProvider?.type || vendorId || providerId;
    if (!providerType) return { valid: false, error: 'Provider identity is required' };

    const options = isRecord(body.options) ? body.options as ValidationOptions : undefined;
    const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
    const validation = await validateApiKeyWithProvider(providerType, credential, {
      baseUrl: options?.baseUrl || account?.baseUrl || legacyProvider?.baseUrl || registryBaseUrl,
      apiProtocol: options?.apiProtocol || account?.apiProtocol || legacyProvider?.apiProtocol,
      modelId: options?.modelId || account?.model || legacyProvider?.model,
    });

    const supported = supportedKernelIds(account, providerType);
    const requested = requestedKernelIds(body, supported);
    const kernels = requested.map(kernelId => {
      if (!supported.includes(kernelId)) {
        return { kernelId, valid: false, error: `Provider ${providerType} is unsupported by kernel ${kernelId}` };
      }
      return {
        kernelId,
        valid: validation.valid,
        ...(validation.error ? { error: safeError(validation.error, credential) } : {}),
      };
    });
    return {
      valid: kernels.length > 0 && kernels.every(result => result.valid),
      ...(!validation.valid && validation.error
        ? { error: safeError(validation.error, credential) }
        : {}),
      kernels,
    };
  } catch (error) {
    return { valid: false, error: safeError(error, credential) };
  }
}

async function createAccount(ctx: ProvidersApiContext, payload: ProviderPayload<'createAccount'>) {
  const body = getPayloadRecord(payload, 'createAccount');
  if (!isRecord(body.account)) throw new Error('Invalid providers.createAccount payload');
  const account = body.account as unknown as ProviderAccount;
  let credential: string | undefined;
  try {
    credential = getStagedCredential(ctx, body.credentialHandle, 'consume');
    if (!credential && account.vendorId === 'ollama') credential = OLLAMA_PLACEHOLDER_API_KEY;
    const saved = await getProviderService().createAccount(account, credential);
    const projections = await reconcileAccount(ctx, saved.id);
    return { success: true, account: saved, projections: projections.map(toHostProjection) };
  } catch (error) {
    return { success: false, error: safeError(error, credential) };
  }
}

async function updateAccount(ctx: ProvidersApiContext, payload: ProviderPayload<'updateAccount'>) {
  const body = getPayloadRecord(payload, 'updateAccount');
  const accountId = requireString(body, 'accountId', 'updateAccount');
  if (!isRecord(body.updates)) throw new Error('Invalid providers.updateAccount payload');
  let credential: string | undefined;
  try {
    credential = getStagedCredential(ctx, body.credentialHandle, 'consume');
    const existing = await getProviderService().getAccount(accountId);
    if (!existing) return { success: false, error: 'Provider account not found' };
    const updates = body.updates as Partial<ProviderAccount>;
    const noChange = credential === undefined
      && Object.keys(updates).every(key => (
        JSON.stringify(existing[key as keyof ProviderAccount])
        === JSON.stringify(updates[key as keyof ProviderAccount])
      ));
    if (noChange) return { success: true, noChange: true, account: existing };

    const saved = await getProviderService().updateAccount(accountId, updates, credential);
    const projections = await reconcileAccount(ctx, saved.id);
    return { success: true, account: saved, projections: projections.map(toHostProjection) };
  } catch (error) {
    return { success: false, error: safeError(error, credential) };
  }
}

async function deleteAccount(ctx: ProvidersApiContext, accountId: string, apiKeyOnly = false) {
  const providerService = getProviderService();
  try {
    const existing = await providerService.getAccount(accountId);
    if (!existing) return { success: true, noChange: true };
    if (apiKeyOnly) {
      await providerService._deleteProviderApiKeyInternal(accountId);
      await syncDeletedProviderApiKeyToRuntime(providerAccountToConfig(existing), accountId);
      return { success: true };
    }

    const defaults = await listProviderDefaults();
    const remaining = (await providerService.listAccounts()).filter(account => account.id !== accountId);
    const removals = ctx.projectionReconciler
      ? await ctx.projectionReconciler.removeAccount(accountId)
      : (await syncDeletedProviderToRuntime(
          providerAccountToConfig(existing), accountId, ctx.gatewayManager,
        ), []);
    await providerService.deleteAccount(accountId);

    for (const entry of defaults.filter(candidate => candidate.accountId === accountId)) {
      const replacement = selectReplacementAccount(remaining, entry.kernelId);
      if (!replacement) continue;
      await setDefaultProviderAccount(replacement.id, entry.kernelId, replacement.model);
      const nextDefault = (await listProviderDefaults()).find(item => item.kernelId === entry.kernelId);
      if (nextDefault && ctx.projectionReconciler) {
        await ctx.projectionReconciler.reconcileDefault(nextDefault);
      } else if (entry.kernelId === 'openclaw') {
        await syncDefaultProviderToRuntime(replacement.id, ctx.gatewayManager);
      }
    }
    return {
      success: true,
      ...(removals.length > 0 ? { projections: removals.map(toHostProjection) } : {}),
    };
  } catch (error) {
    return { success: false, error: safeError(error) };
  }
}

async function setKernelDefault(ctx: ProvidersApiContext, payload: ProviderPayload<'setKernelDefault'>) {
  const body = getPayloadRecord(payload, 'setKernelDefault');
  const kernelId = requireString(body, 'kernelId', 'setKernelDefault') as KernelId;
  const accountId = requireString(body, 'accountId', 'setKernelDefault');
  const modelId = payloadString(body, 'modelId');
  try {
    const account = await getProviderService().getAccount(accountId);
    if (!account) return { success: false, error: 'Provider account not found' };
    if (!supportedKernelIds(account, account.vendorId).includes(kernelId)) {
      return { success: false, error: `Provider ${account.vendorId} is unsupported by kernel ${kernelId}` };
    }
    await setDefaultProviderAccount(accountId, kernelId, modelId || account.model);
    const entry = (await listProviderDefaults()).find(item => item.kernelId === kernelId);
    const projection = entry ? await ctx.projectionReconciler?.reconcileDefault(entry) : undefined;
    if (!ctx.projectionReconciler && kernelId === 'openclaw') {
      await syncDefaultProviderToRuntime(accountId, ctx.gatewayManager);
    }
    return { success: true, ...(projection ? { projections: [toHostProjection(projection)] } : {}) };
  } catch (error) {
    return { success: false, error: safeError(error) };
  }
}

async function requestOAuth(payload: ProviderPayload<'requestOAuth'>) {
  const body = getPayloadRecord(payload, 'requestOAuth');
  const provider = payloadString(body, 'provider');
  if (!provider) return { success: false, error: 'Invalid providers.requestOAuth payload' };
  const region = body.region === 'global' || body.region === 'cn' ? body.region : undefined;
  const options = {
    accountId: payloadString(body, 'accountId'),
    label: payloadString(body, 'label'),
  };
  try {
    if (provider === 'openai') {
      await browserOAuthManager.startFlow(provider as BrowserOAuthProviderType, options);
    } else {
      await deviceOAuthManager.startFlow(provider as OAuthProviderType, region, options);
    }
    return { success: true };
  } catch (error) {
    logger.error('providers.requestOAuth failed', redactSecrets(error));
    return { success: false, error: safeError(error) };
  }
}

async function cancelOAuth() {
  try {
    await deviceOAuthManager.stopFlow();
    await browserOAuthManager.stopFlow();
    return { success: true };
  } catch (error) {
    logger.error('providers.cancelOAuth failed', redactSecrets(error));
    return { success: false, error: safeError(error) };
  }
}

async function submitOAuth(payload: ProviderPayload<'submitOAuth'>) {
  const body = getPayloadRecord(payload, 'submitOAuth');
  const code = typeof body.code === 'string' ? body.code : '';
  try {
    const accepted = browserOAuthManager.submitManualCode(code);
    return accepted
      ? { success: true }
      : { success: false, error: 'No active manual OAuth input pending' };
  } catch (error) {
    return { success: false, error: safeError(error, code) };
  }
}

/** Renderer-facing Provider API. Raw credential values never cross this contract. */
export function createProvidersApi(ctx: ProvidersApiContext): CompleteHostServiceRegistry['providers'] {
  const providerService = getProviderService();
  deviceOAuthManager.setWindow(ctx.mainWindow);
  browserOAuthManager.setWindow(ctx.mainWindow);

  return {
    list: () => providerService._listProvidersWithKeyInfoInternal(),
    get: payload => providerService._getProviderInternal(getProviderId(payload, 'get')),
    getDefault: () => providerService._getDefaultProviderInternal(),
    hasApiKey: payload => providerService._hasProviderApiKeyInternal(getProviderId(payload, 'hasApiKey')),
    validateKey: payload => validateKey(ctx, payload),
    save: async payload => {
      const body = getPayloadRecord(payload, 'save');
      if (!isRecord(body.config)) throw new Error('Invalid providers.save payload');
      const config = body.config as unknown as ProviderConfig;
      const existing = await providerService.getAccount(config.id);
      return existing
        ? updateAccount(ctx, {
            accountId: config.id,
            updates: {
              label: config.name,
              vendorId: config.type,
              baseUrl: config.baseUrl,
              apiProtocol: config.apiProtocol,
              headers: config.headers,
              model: config.model,
              modelCapabilities: config.modelCapabilities,
              fallbackModels: config.fallbackModels,
              fallbackAccountIds: config.fallbackProviderIds,
              enabled: config.enabled,
            },
            credentialHandle: body.credentialHandle,
          } as never)
        : createAccount(ctx, {
            account: {
              id: config.id,
              vendorId: config.type,
              label: config.name,
              authMode: config.type === 'ollama' ? 'local' : 'api_key',
              baseUrl: config.baseUrl,
              apiProtocol: config.apiProtocol,
              headers: config.headers,
              model: config.model,
              modelCapabilities: config.modelCapabilities,
              fallbackModels: config.fallbackModels,
              fallbackAccountIds: config.fallbackProviderIds,
              enabled: config.enabled,
              isDefault: false,
              createdAt: config.createdAt,
              updatedAt: config.updatedAt,
            },
            credentialHandle: body.credentialHandle,
          } as never);
    },
    delete: payload => deleteAccount(ctx, getProviderId(payload, 'delete')),
    setApiKey: payload => updateAccount(ctx, {
      accountId: getProviderId(payload, 'setApiKey'),
      updates: {},
      credentialHandle: getPayloadRecord(payload, 'setApiKey').credentialHandle,
    } as never),
    updateWithKey: payload => {
      const body = getPayloadRecord(payload, 'updateWithKey');
      return updateAccount(ctx, {
        accountId: requireString(body, 'providerId', 'updateWithKey'),
        updates: body.updates,
        credentialHandle: body.credentialHandle,
      } as never);
    },
    deleteApiKey: payload => deleteAccount(ctx, getProviderId(payload, 'deleteApiKey'), true),
    setDefault: payload => setKernelDefault(ctx, {
      kernelId: 'openclaw',
      accountId: getProviderId(payload, 'setDefault'),
    }),
    accounts: () => providerService.listAccounts(),
    vendors: () => providerService.listVendors(),
    accountKeyInfo: () => providerService.listAccountsKeyInfo(),
    getDefaultAccount: async () => ({ accountId: await providerService.getDefaultAccountId() ?? null }),
    getAccount: payload => providerService.getAccount(getAccountId(payload, 'getAccount')),
    hasAccountApiKey: payload => providerService.hasAccountApiKey(getAccountId(payload, 'hasAccountApiKey')),
    createAccount: payload => createAccount(ctx, payload),
    updateAccount: payload => updateAccount(ctx, payload),
    deleteAccount: payload => deleteAccount(ctx, getAccountId(payload, 'deleteAccount')),
    deleteAccountApiKey: payload => deleteAccount(ctx, getAccountId(payload, 'deleteAccountApiKey'), true),
    setDefaultAccount: payload => setKernelDefault(ctx, {
      kernelId: 'openclaw',
      accountId: getAccountId(payload, 'setDefaultAccount'),
    }),
    kernelDefaults: () => listProviderDefaults(),
    setKernelDefault: payload => setKernelDefault(ctx, payload),
    reconcileAccount: async payload => {
      const body = getPayloadRecord(payload, 'reconcileAccount');
      const accountId = requireString(body, 'accountId', 'reconcileAccount');
      const kernelIds = Array.isArray(body.kernelIds)
        ? body.kernelIds.filter((id): id is string => typeof id === 'string').map(id => id as KernelId)
        : undefined;
      try {
        const projections = await reconcileAccount(ctx, accountId, kernelIds);
        return { success: true, projections: projections.map(toHostProjection) };
      } catch (error) {
        return { success: false, error: safeError(error) };
      }
    },
    requestOAuth,
    cancelOAuth,
    submitOAuth,
  };
}
