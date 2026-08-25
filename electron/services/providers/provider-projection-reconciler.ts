import { randomUUID } from 'node:crypto';
import type { CanonicalProviderAccount, KernelProviderDefault } from '@shared/domains/providers';
import type { KernelId } from '@shared/kernels/contracts';
import type { KernelSupervisorRegistry } from '../../kernels/supervisor-registry';
import { canonicalToProviderAccount, providerAccountToConfig } from './provider-store';
import {
  syncDefaultProviderToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
} from './provider-runtime-sync';
import { getProvider } from '../../utils/secure-storage';

export type ProviderProjectionDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type ProviderProjectionPayload = Omit<CanonicalProviderAccount, 'credentialRef' | 'projections'>;

export type ProviderProjectionApplyResult = {
  nativeId?: string;
  partial?: boolean;
};

export interface ProviderKernelProjectionAdapter {
  readonly kernelId: KernelId;
  available(): boolean | Promise<boolean>;
  upsert(account: ProviderProjectionPayload, operationId: string): Promise<ProviderProjectionApplyResult>;
  remove(accountId: string, operationId: string): Promise<void>;
  setDefault?(input: { accountId: string; modelId?: string }, operationId: string): Promise<void>;
}

export type ProviderProjectionResult = {
  kernelId: KernelId;
  accountId: string;
  status: 'ready' | 'partial' | 'pending' | 'failed' | 'unsupported';
  nativeId?: string;
  error?: string;
};

function payloadOf(account: CanonicalProviderAccount): ProviderProjectionPayload {
  const { credentialRef: _credentialRef, projections: _projections, ...payload } = account;
  return structuredClone(payload);
}

function supportsKernel(account: CanonicalProviderAccount, kernelId: KernelId): boolean {
  if (kernelId === 'openclaw') return true;
  return account.models.some(model => model.supportedKernels.includes(kernelId));
}

/** Reconciles each kernel independently; no cross-kernel transaction exists. */
export class ProviderProjectionReconciler {
  private readonly adapters = new Map<KernelId, ProviderKernelProjectionAdapter>();

  constructor(
    private readonly data: ProviderProjectionDataClient,
    adapters: ProviderKernelProjectionAdapter[],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kernelId)) throw new Error(`Duplicate Provider projection adapter: ${adapter.kernelId}`);
      this.adapters.set(adapter.kernelId, adapter);
    }
  }

  kernelIds(): KernelId[] {
    return [...this.adapters.keys()];
  }

  async reconcileAccount(accountId: string, kernelIds = this.kernelIds()): Promise<ProviderProjectionResult[]> {
    const account = await this.data.call<CanonicalProviderAccount | undefined>('getProvider', accountId);
    if (!account) throw new Error(`Provider account not found: ${accountId}`);
    return Promise.all(kernelIds.map(kernelId => this.reconcileOne(account, kernelId)));
  }

  async reconcileAll(kernelId?: KernelId): Promise<ProviderProjectionResult[]> {
    const accounts = await this.data.call<CanonicalProviderAccount[]>('listProviders');
    const kernelIds = kernelId ? [kernelId] : this.kernelIds();
    const settled = await Promise.all(accounts.flatMap(account => (
      kernelIds.map(candidate => this.reconcileOne(account, candidate))
    )));
    return settled;
  }

  async removeAccount(accountId: string): Promise<ProviderProjectionResult[]> {
    return Promise.all(this.kernelIds().map(async kernelId => {
      const adapter = this.adapters.get(kernelId)!;
      if (!await adapter.available()) return { kernelId, accountId, status: 'pending' as const };
      try {
        await adapter.remove(accountId, randomUUID());
        return { kernelId, accountId, status: 'ready' as const };
      } catch (error) {
        return {
          kernelId,
          accountId,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
  }

  async reconcileDefault(defaultEntry: KernelProviderDefault): Promise<ProviderProjectionResult> {
    const adapter = this.adapters.get(defaultEntry.kernelId);
    if (!adapter?.setDefault) {
      return { kernelId: defaultEntry.kernelId, accountId: defaultEntry.accountId, status: 'unsupported' };
    }
    if (!await adapter.available()) {
      return { kernelId: defaultEntry.kernelId, accountId: defaultEntry.accountId, status: 'pending' };
    }
    try {
      await adapter.setDefault({
        accountId: defaultEntry.accountId,
        ...(defaultEntry.modelId ? { modelId: defaultEntry.modelId } : {}),
      }, randomUUID());
      return { kernelId: defaultEntry.kernelId, accountId: defaultEntry.accountId, status: 'ready' };
    } catch (error) {
      return {
        kernelId: defaultEntry.kernelId,
        accountId: defaultEntry.accountId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async reconcileOne(
    account: CanonicalProviderAccount,
    kernelId: KernelId,
  ): Promise<ProviderProjectionResult> {
    const adapter = this.adapters.get(kernelId);
    if (!adapter || !supportsKernel(account, kernelId)) {
      await this.writeProjection(account, kernelId, 'unsupported');
      return { kernelId, accountId: account.id, status: 'unsupported' };
    }
    if (!await adapter.available()) {
      await this.writeProjection(account, kernelId, 'pending');
      return { kernelId, accountId: account.id, status: 'pending' };
    }
    await this.writeProjection(account, kernelId, 'applying');
    try {
      const applied = await adapter.upsert(payloadOf(account), randomUUID());
      const status = applied.partial ? 'partial' : 'ready';
      await this.writeProjection(account, kernelId, status, applied.nativeId ?? account.id);
      return {
        kernelId,
        accountId: account.id,
        status,
        nativeId: applied.nativeId ?? account.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeProjection(account, kernelId, 'failed', undefined, message);
      return { kernelId, accountId: account.id, status: 'failed', error: message };
    }
  }

  private async writeProjection(
    account: CanonicalProviderAccount,
    kernelId: KernelId,
    status: string,
    nativeId?: string,
    error?: string,
  ): Promise<void> {
    await this.data.call('upsertProjection', {
      entityType: 'provider',
      entityId: account.id,
      kernelId,
      desiredVersion: account.version,
      ...(status === 'ready' || status === 'partial' ? { appliedVersion: account.version } : {}),
      status,
      ...(nativeId ? { nativeId } : {}),
      ...(error ? { error } : {}),
      updatedAt: this.now().toISOString(),
    });
  }
}

export function createSupervisorProviderAdapter(
  supervisors: KernelSupervisorRegistry,
  kernelId: KernelId,
): ProviderKernelProjectionAdapter {
  return {
    kernelId,
    available: () => supervisors.status(kernelId).state === 'ready',
    async upsert(account, operationId) {
      const result = await supervisors.request<CanonicalProviderAccount>(
        kernelId,
        'control.providers.upsert',
        { entity: account, operationId },
      );
      return { nativeId: result?.id ?? account.id };
    },
    remove: (accountId, operationId) => supervisors.request(
      kernelId,
      'control.providers.remove',
      { id: accountId, operationId },
    ),
    setDefault: (input, operationId) => supervisors.request(
      kernelId,
      'control.providers.default.set',
      { ...input, operationId },
    ),
  };
}

/** Existing OpenClaw auth SQLite/config/secrets.reload projection contract. */
export function createOpenClawProviderProjectionAdapter(
  supervisors: KernelSupervisorRegistry,
): ProviderKernelProjectionAdapter {
  return {
    kernelId: 'openclaw',
    available: () => supervisors.isLaunchAvailable('openclaw'),
    async upsert(account) {
      const canonical = { ...account, projections: [] } as CanonicalProviderAccount;
      await syncSavedProviderToRuntime(
        providerAccountToConfig(canonicalToProviderAccount(canonical)),
        undefined,
      );
      return { nativeId: account.providerId };
    },
    async remove(accountId) {
      const existing = await getProvider(accountId);
      await syncDeletedProviderToRuntime(existing, accountId);
    },
    async setDefault(input) {
      await syncDefaultProviderToRuntime(input.accountId);
    },
  };
}
