/**
 * Provider State Store
 * Manages AI provider configurations
 */
import { create } from 'zustand';
import type {
  ProviderAccount,
  ProviderConfig,
  ProviderKernelDefault,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';
import { hostApi } from '@/lib/host-api';
import { fetchProviderSnapshot } from '@/lib/provider-accounts';

// Re-export types for consumers that imported from here
export type {
  ProviderAccount,
  ProviderConfig,
  ProviderKernelDefault,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';
export type { ProviderSnapshot } from '@/lib/provider-accounts';

interface ProviderState {
  statuses: ProviderWithKeyInfo[];
  accounts: ProviderAccount[];
  vendors: ProviderVendorInfo[];
  defaultAccountId: string | null;
  kernelDefaults: ProviderKernelDefault[];
  loading: boolean;
  error: string | null;

  // Actions
  init: () => Promise<void>;
  refreshProviderSnapshot: () => Promise<void>;
  createAccount: (account: ProviderAccount, credentialHandle?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  validateAccountApiKey: (
    accountId: string,
    credentialHandle: string,
    kernelIds?: string[],
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol']; modelId?: string }
  ) => Promise<{ valid: boolean; error?: string }>;

  // Legacy compatibility aliases
  fetchProviders: () => Promise<void>;
  addProvider: (config: Omit<ProviderConfig, 'createdAt' | 'updatedAt'>, credentialHandle?: string) => Promise<void>;
  addAccount: (account: ProviderAccount, credentialHandle?: string) => Promise<void>;
  updateProvider: (providerId: string, updates: Partial<ProviderConfig>, credentialHandle?: string) => Promise<void>;
  updateAccount: (accountId: string, updates: Partial<ProviderAccount>, credentialHandle?: string) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  deleteAccount: (accountId: string) => Promise<void>;
  setApiKey: (providerId: string, credentialHandle: string) => Promise<void>;
  updateProviderWithKey: (
    providerId: string,
    updates: Partial<ProviderConfig>,
    credentialHandle?: string
  ) => Promise<void>;
  deleteApiKey: (providerId: string) => Promise<void>;
  setDefaultProvider: (providerId: string) => Promise<void>;
  setDefaultAccount: (accountId: string) => Promise<void>;
  setKernelDefault: (kernelId: string, accountId: string, modelId?: string) => Promise<void>;
  reconcileAccount: (accountId: string, kernelIds?: string[]) => Promise<void>;
  validateApiKey: (
    providerId: string,
    credentialHandle: string,
    kernelIds?: string[],
    options?: { baseUrl?: string; apiProtocol?: ProviderAccount['apiProtocol'] }
  ) => Promise<{ valid: boolean; error?: string }>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  statuses: [],
  accounts: [],
  vendors: [],
  defaultAccountId: null,
  kernelDefaults: [],
  loading: false,
  error: null,

  init: async () => {
    await get().refreshProviderSnapshot();
  },

  refreshProviderSnapshot: async () => {
    set({ loading: true, error: null });
    
    try {
      const snapshot = await fetchProviderSnapshot();
      
      set({ 
        statuses: snapshot.statuses ?? [],
        accounts: snapshot.accounts ?? [],
        vendors: snapshot.vendors ?? [],
        defaultAccountId: snapshot.defaultAccountId ?? null,
        kernelDefaults: snapshot.kernelDefaults ?? [],
        loading: false 
      });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  fetchProviders: async () => get().refreshProviderSnapshot(),

  // Legacy ProviderConfig-shaped alias kept for backward compatibility
  // with any stale caller. Internally projects the legacy config payload
  // onto the ProviderAccount surface and delegates to createAccount.
  addProvider: async (config, credentialHandle) => {
    try {
      const now = new Date().toISOString();
      const account: ProviderAccount = {
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
        createdAt: now,
        updatedAt: now,
      };
      await get().createAccount(account, credentialHandle);
    } catch (error) {
      console.error('Failed to add provider', error);
      throw error;
    }
  },

  createAccount: async (account, credentialHandle) => {
    try {
      const result = await hostApi.providers.createAccount({ account, credentialHandle });

      if (!result.success) {
        throw new Error(result.error || 'Failed to create provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to add account:', error);
      throw error;
    }
  },

  addAccount: async (account, credentialHandle) => get().createAccount(account, credentialHandle),

  // Legacy ProviderConfig-shaped alias. Translates the partial ProviderConfig
  // patch into a ProviderAccount patch and routes through updateAccount.
  updateProvider: async (providerId, updates, credentialHandle) => {
    try {
      const accountUpdates: Partial<ProviderAccount> = {};
      if (updates.name !== undefined) accountUpdates.label = updates.name;
      if (updates.type !== undefined) accountUpdates.vendorId = updates.type;
      if (updates.baseUrl !== undefined) accountUpdates.baseUrl = updates.baseUrl;
      if (updates.apiProtocol !== undefined) accountUpdates.apiProtocol = updates.apiProtocol;
      if (updates.headers !== undefined) accountUpdates.headers = updates.headers;
      if (updates.model !== undefined) accountUpdates.model = updates.model;
      if (updates.modelCapabilities !== undefined) accountUpdates.modelCapabilities = updates.modelCapabilities;
      if (updates.fallbackModels !== undefined) accountUpdates.fallbackModels = updates.fallbackModels;
      if (updates.fallbackProviderIds !== undefined) accountUpdates.fallbackAccountIds = updates.fallbackProviderIds;
      if (updates.enabled !== undefined) accountUpdates.enabled = updates.enabled;
      await get().updateAccount(providerId, accountUpdates, credentialHandle);
    } catch (error) {
      console.error('Failed to update provider', error);
      throw error;
    }
  },

  updateAccount: async (accountId, updates, credentialHandle) => {
    try {
      const result = await hostApi.providers.updateAccount(
        accountId,
        updates,
        credentialHandle,
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to update provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to update account:', error);
      throw error;
    }
  },

  deleteProvider: async (providerId) => get().removeAccount(providerId),

  removeAccount: async (accountId) => {
    try {
      const result = await hostApi.providers.deleteAccount(accountId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to delete provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to delete account:', error);
      throw error;
    }
  },

  deleteAccount: async (accountId) => get().removeAccount(accountId),

  // Legacy alias kept for in-flight callers; routes the call through
  // updateAccount, which is semantically equivalent to "set API key without
  // other changes".
  setApiKey: async (providerId, credentialHandle) => get().updateAccount(providerId, {}, credentialHandle),

  updateProviderWithKey: async (providerId, updates, credentialHandle) => {
    try {
      const accountUpdates: Partial<ProviderAccount> = {};
      if (updates.name !== undefined) accountUpdates.label = updates.name;
      if (updates.type !== undefined) accountUpdates.vendorId = updates.type;
      if (updates.baseUrl !== undefined) accountUpdates.baseUrl = updates.baseUrl;
      if (updates.apiProtocol !== undefined) accountUpdates.apiProtocol = updates.apiProtocol;
      if (updates.headers !== undefined) accountUpdates.headers = updates.headers;
      if (updates.model !== undefined) accountUpdates.model = updates.model;
      if (updates.modelCapabilities !== undefined) accountUpdates.modelCapabilities = updates.modelCapabilities;
      if (updates.fallbackModels !== undefined) accountUpdates.fallbackModels = updates.fallbackModels;
      if (updates.fallbackProviderIds !== undefined) accountUpdates.fallbackAccountIds = updates.fallbackProviderIds;
      if (updates.enabled !== undefined) accountUpdates.enabled = updates.enabled;
      await get().updateAccount(providerId, accountUpdates, credentialHandle);
    } catch (error) {
      console.error('Failed to update provider with key:', error);
      throw error;
    }
  },

  // Legacy alias that clears only the stored key for an account.
  deleteApiKey: async (providerId) => {
    try {
      const result = await hostApi.providers.deleteAccountApiKey(providerId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to delete API key');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to delete API key:', error);
      throw error;
    }
  },

  setDefaultProvider: async (providerId) => get().setDefaultAccount(providerId),

  setDefaultAccount: async (accountId) => {
    try {
      const result = await hostApi.providers.setDefaultAccount(accountId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to set default provider account');
      }

      set({ defaultAccountId: accountId });
    } catch (error) {
      console.error('Failed to set default account:', error);
      throw error;
    }
  },

  setKernelDefault: async (kernelId, accountId, modelId) => {
    const result = await hostApi.providers.setKernelDefault({ kernelId, accountId, modelId });
    if (!result.success) throw new Error(result.error || 'Failed to set kernel Provider default');
    await get().refreshProviderSnapshot();
  },

  reconcileAccount: async (accountId, kernelIds) => {
    const result = await hostApi.providers.reconcileAccount({ accountId, kernelIds });
    if (!result.success) throw new Error(result.error || 'Failed to reconcile Provider account');
    await get().refreshProviderSnapshot();
  },
  
  validateAccountApiKey: async (providerId, credentialHandle, kernelIds, options) => {
    try {
      const result = await hostApi.providers.validateKey({
          accountId: providerId,
          vendorId: providerId,
          providerId,
          credentialHandle,
          kernelIds,
          options,
      });
      return result?.valid === true
        ? { valid: true }
        : { valid: false, error: result?.error };
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  },

  validateApiKey: async (providerId, credentialHandle, kernelIds, options) => (
    get().validateAccountApiKey(providerId, credentialHandle, kernelIds, options)
  ),
}));
