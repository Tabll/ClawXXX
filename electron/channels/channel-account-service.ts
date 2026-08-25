import type { KernelId } from '@shared/kernels/contracts';
import type {
  CanonicalChannelAccount,
  CanonicalChannelBinding,
  CanonicalChannelFormField,
} from '@shared/domains/channels';
import {
  canonicalChannelAccountKey,
  channelBindingKey,
  channelCredentialReference,
} from '@shared/domains/channels';
import { asAgentId } from '@shared/domains/identity';
import { CHANNEL_META, isSupportedChannelType } from '@shared/types/channel';
import type { ChannelSecretStore } from './channel-secret-store';

export type ChannelDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type ChannelAccountUpsertInput = {
  channelType: string;
  nativeAccountId: string;
  displayName?: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  isDefault?: boolean;
  status?: CanonicalChannelAccount['status'];
  statusDetail?: string;
  supportedKernels?: KernelId[];
};

function splitConfig(channelType: string, config: Record<string, unknown>): {
  publicConfig: Record<string, unknown>;
  secretConfig: Record<string, string>;
} {
  const secretKeys = new Set(
    isSupportedChannelType(channelType)
      ? CHANNEL_META[channelType].configFields.filter(field => field.type === 'password').map(field => field.key)
      : [],
  );
  const publicConfig: Record<string, unknown> = {};
  const secretConfig: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    const normalizedParts = key
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const looksSecret = normalizedParts.some(part => ['secret', 'password', 'authorization', 'cookie'].includes(part))
      || normalizedParts.at(-1) === 'token'
      || normalizedParts.some((part, index) => part === 'api' && normalizedParts[index + 1] === 'key')
      || normalizedParts.includes('credential')
      || normalizedParts.includes('auth');
    if (secretKeys.has(key) || looksSecret) {
      if (typeof value === 'string' && value.trim()) secretConfig[key] = value;
      continue;
    }
    if (value !== undefined) publicConfig[key] = value;
  }
  return { publicConfig, secretConfig };
}

function canonicalForm(channelType: string): CanonicalChannelFormField[] {
  if (!isSupportedChannelType(channelType)) return [];
  return CHANNEL_META[channelType].configFields.map(field => ({
    key: field.key,
    labelKey: field.label,
    type: field.type,
    required: field.required === true,
    secret: field.type === 'password',
    ...(field.options ? {
      options: field.options.map(option => ({ value: option.value, labelKey: option.label })),
    } : {}),
  }));
}

/** Main-owned canonical account service. Connector files are projections only. */
export class CanonicalChannelAccountService {
  constructor(
    private readonly data: ChannelDataClient,
    private readonly secrets: ChannelSecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(includeDeleted = false): Promise<CanonicalChannelAccount[]> {
    return this.data.call('listChannelAccounts', {
      includeDeleted,
      now: this.now().toISOString(),
    });
  }

  async get(channelType: string, nativeAccountId: string): Promise<CanonicalChannelAccount | undefined> {
    return this.getById(canonicalChannelAccountKey(channelType, nativeAccountId));
  }

  async getById(accountId: string, includeDeleted = false): Promise<CanonicalChannelAccount | undefined> {
    return this.data.call('getChannelAccount', accountId, {
      includeDeleted,
      now: this.now().toISOString(),
    });
  }

  async upsert(input: ChannelAccountUpsertInput): Promise<CanonicalChannelAccount> {
    if (!input.channelType.trim() || !input.nativeAccountId.trim()) {
      throw new Error('Channel type and native account id are required');
    }
    const accountId = canonicalChannelAccountKey(input.channelType, input.nativeAccountId);
    const existing = await this.data.call<CanonicalChannelAccount | undefined>(
      'getChannelAccount',
      accountId,
      { includeDeleted: true, now: this.now().toISOString() },
    );
    const { publicConfig, secretConfig } = splitConfig(input.channelType, input.config);
    if (Object.keys(secretConfig).length > 0) {
      const previous = await this.secrets.get(accountId);
      await this.secrets.set({
        accountId,
        values: { ...(previous?.values ?? {}), ...secretConfig },
        updatedAt: this.now().toISOString(),
      });
    }
    const timestamp = this.now().toISOString();
    // The two initial built-in adapters remain the compatibility baseline.
    // Runtime registration extends this set, so future kernels do not require
    // a schema or migration change.
    const supportedKernels = input.supportedKernels ?? existing?.supportedKernels ?? ['openclaw', 'deepseek-harness'];
    const account: CanonicalChannelAccount = {
      id: accountId,
      channelType: input.channelType,
      nativeAccountId: input.nativeAccountId,
      displayName: input.displayName?.trim() || existing?.displayName || input.nativeAccountId,
      ...((await this.secrets.has(accountId)) ? { credentialRef: channelCredentialReference(accountId) } : {}),
      status: input.status ?? existing?.status ?? 'disconnected',
      ...(input.statusDetail ? { statusDetail: input.statusDetail } : existing?.statusDetail ? { statusDetail: existing.statusDetail } : {}),
      config: { ...(existing?.config ?? {}), ...publicConfig },
      form: canonicalForm(input.channelType),
      targets: existing?.targets ?? [],
      enabled: input.enabled ?? existing?.enabled ?? true,
      isDefault: input.isDefault ?? existing?.isDefault ?? input.nativeAccountId === 'default',
      supportedKernels: [...new Set(supportedKernels)],
      projections: existing?.projections ?? [],
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.data.call('putChannelAccount', account);
    return (await this.data.call<CanonicalChannelAccount>('getChannelAccount', account.id, {
      now: timestamp,
    })) ?? account;
  }

  async setRuntimeState(input: {
    accountId: string;
    status: CanonicalChannelAccount['status'];
    statusDetail?: string;
    targets?: CanonicalChannelAccount['targets'];
  }): Promise<CanonicalChannelAccount> {
    const existing = await this.data.call<CanonicalChannelAccount | undefined>('getChannelAccount', input.accountId, {
      now: this.now().toISOString(),
    });
    if (!existing) throw new Error(`Channel account not found: ${input.accountId}`);
    const timestamp = this.now().toISOString();
    const next: CanonicalChannelAccount = {
      ...existing,
      connectionOwner: undefined,
      status: input.status,
      ...(input.statusDetail ? { statusDetail: input.statusDetail } : { statusDetail: undefined }),
      ...(input.targets ? { targets: input.targets } : {}),
      revision: existing.revision + 1,
      updatedAt: timestamp,
    };
    await this.data.call('putChannelAccount', next);
    return next;
  }

  async getProjectionConfig(account: CanonicalChannelAccount): Promise<Record<string, unknown>> {
    const credential = await this.secrets.get(account.id);
    return { ...account.config, ...(credential?.values ?? {}) };
  }

  /** Merge connector-refreshed credentials into the OS-protected secret store. */
  async updateSecrets(accountId: string, values: Record<string, string>): Promise<void> {
    const account = await this.getById(accountId);
    if (!account) throw new Error(`Channel account not found: ${accountId}`);
    if (Object.values(values).some(value => typeof value !== 'string')) {
      throw new Error('Channel secret values must be strings');
    }
    const previous = await this.secrets.get(accountId);
    await this.secrets.set({
      accountId,
      values: { ...(previous?.values ?? {}), ...values },
      updatedAt: this.now().toISOString(),
    });
  }

  async getPublicFormValues(account: CanonicalChannelAccount): Promise<{
    values: Record<string, string>;
    configuredSecretFields: string[];
  }> {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(account.config)) {
      if (typeof value === 'string') values[key] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') values[key] = String(value);
    }
    const credential = await this.secrets.get(account.id);
    return { values, configuredSecretFields: Object.keys(credential?.values ?? {}) };
  }

  async delete(channelType: string, nativeAccountId: string): Promise<boolean> {
    const id = canonicalChannelAccountKey(channelType, nativeAccountId);
    const deleted = await this.data.call<boolean>('deleteChannelAccount', id, this.now().toISOString());
    if (deleted) await this.secrets.delete(id);
    return deleted;
  }

  async setDefault(channelType: string, nativeAccountId: string): Promise<void> {
    const accounts = (await this.list()).filter(account => account.channelType === channelType);
    if (!accounts.some(account => account.nativeAccountId === nativeAccountId)) {
      throw new Error(`Channel account not found: ${channelType}/${nativeAccountId}`);
    }
    const timestamp = this.now().toISOString();
    for (const account of accounts) {
      const isDefault = account.nativeAccountId === nativeAccountId;
      if (account.isDefault === isDefault) continue;
      await this.data.call('putChannelAccount', {
        ...account,
        connectionOwner: undefined,
        projections: [],
        isDefault,
        revision: account.revision + 1,
        updatedAt: timestamp,
      } satisfies CanonicalChannelAccount);
    }
  }

  async setEnabled(channelType: string, enabled: boolean, nativeAccountId?: string): Promise<CanonicalChannelAccount[]> {
    const matches = (await this.list()).filter(account => (
      account.channelType === channelType
      && (nativeAccountId === undefined || account.nativeAccountId === nativeAccountId)
    ));
    if (matches.length === 0) throw new Error(`Channel account not found: ${channelType}/${nativeAccountId ?? '*'}`);
    const timestamp = this.now().toISOString();
    const results: CanonicalChannelAccount[] = [];
    for (const account of matches) {
      if (account.enabled === enabled) {
        results.push(account);
        continue;
      }
      const next: CanonicalChannelAccount = {
        ...account,
        connectionOwner: undefined,
        projections: [],
        enabled,
        status: enabled ? 'disconnected' : 'disconnected',
        revision: account.revision + 1,
        updatedAt: timestamp,
      };
      await this.data.call('putChannelAccount', next);
      results.push(next);
    }
    return results;
  }

  async importLegacy(input: ChannelAccountUpsertInput & { agentId?: string }): Promise<CanonicalChannelAccount> {
    const account = await this.upsert(input);
    if (input.agentId) {
      const existing = await this.data.call<CanonicalChannelBinding | undefined>('getChannelBinding', account.id, '*');
      const timestamp = this.now().toISOString();
      await this.data.call('putChannelBinding', {
        id: channelBindingKey(account.id),
        accountId: account.id,
        targetId: '*',
        kernelId: 'openclaw',
        agentId: asAgentId(input.agentId),
        conversationPolicy: 'per-thread',
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies CanonicalChannelBinding);
    }
    return account;
  }

  /**
   * Extend persisted compatibility from the adapters discovered by Main.
   *
   * Compatibility is monotonic here: uninstalling or temporarily failing to
   * load an adapter must not invalidate an existing binding. Admission still
   * requires a currently registered adapter, while a future kernel adapter can
   * make itself available to all compatible accounts without a schema change.
   */
  async extendSupportedKernels(
    resolveKernels: (account: CanonicalChannelAccount) => readonly KernelId[],
  ): Promise<number> {
    const timestamp = this.now().toISOString();
    let changed = 0;
    for (const account of await this.list()) {
      const supportedKernels = [...new Set([
        ...account.supportedKernels,
        ...resolveKernels(account).filter(kernelId => kernelId.trim().length > 0),
      ])];
      if (supportedKernels.length === account.supportedKernels.length
        && supportedKernels.every((kernelId, index) => kernelId === account.supportedKernels[index])) {
        continue;
      }
      await this.data.call('putChannelAccount', {
        ...account,
        supportedKernels,
        revision: account.revision + 1,
        updatedAt: timestamp,
      } satisfies CanonicalChannelAccount);
      changed += 1;
    }
    return changed;
  }
}

export async function ensureCanonicalChannelCatalog(input: {
  service: CanonicalChannelAccountService;
  scanLegacy(): Promise<Array<ChannelAccountUpsertInput & { agentId?: string }>>;
}): Promise<number> {
  if ((await input.service.list()).length > 0) return 0;
  const legacy = await input.scanLegacy();
  for (const account of legacy) await input.service.importLegacy(account);
  return legacy.length;
}
