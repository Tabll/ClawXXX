import { randomUUID } from 'node:crypto';
import type { CanonicalChannelAccount, CanonicalChannelBinding, ChannelOwnerLease } from '@shared/domains/channels';
import type { KernelId } from '@shared/kernels/contracts';
import type { CanonicalChannelAccountService, ChannelDataClient } from './channel-account-service';
import type { ChannelAdapterRegistry } from './channel-adapter-registry';
import type { ChannelInboundEnvelope, ChannelOutboundEnvelope } from './channel-runtime-contracts';

type ActiveOwner = {
  lease: ChannelOwnerLease;
  admitting: boolean;
  renewTimer?: ReturnType<typeof setInterval>;
};

export type ChannelInboundAdmission = (envelope: ChannelInboundEnvelope) => Promise<void>;

export class ChannelOwnerCoordinator {
  private readonly instanceId: string;
  private readonly active = new Map<CanonicalChannelAccount['id'], ActiveOwner>();
  private readonly generations = new Map<CanonicalChannelAccount['id'], number>();
  private stopped = false;

  constructor(
    private readonly data: ChannelDataClient,
    private readonly accounts: CanonicalChannelAccountService,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly inbound: ChannelInboundAdmission,
    private readonly options: {
      instanceId?: string;
      leaseDurationMs?: number;
      renewIntervalMs?: number;
      now?: () => Date;
    } = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
  }

  async activate(accountId: CanonicalChannelAccount['id'], kernelId: KernelId): Promise<ChannelOwnerLease> {
    if (this.stopped) throw new Error('Channel owner coordinator is stopped');
    const current = this.active.get(accountId);
    if (current?.admitting && current.lease.kernelId === kernelId) return current.lease;
    if (current) await this.deactivate(accountId);

    const account = await this.accounts.getById(accountId);
    if (!account || !account.enabled) throw new Error(`Enabled Channel account not found: ${accountId}`);
    const adapter = this.adapters.require(kernelId);
    if (!adapter.supportedChannels.includes(account.channelType)) {
      throw new Error(`${kernelId} does not support Channel ${account.channelType}`);
    }
    const now = this.now();
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    const lease: ChannelOwnerLease = {
      accountId,
      ownerId: `${adapter.ownerId}:${this.instanceId}`,
      kernelId,
      generation,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs()).toISOString(),
      updatedAt: now.toISOString(),
    };
    const result = await this.data.call<{ acquired: boolean; lease: ChannelOwnerLease }>(
      'acquireChannelOwnerLease',
      { ...lease, now: now.toISOString() },
    );
    if (!result.acquired) {
      throw new Error(`Channel account is already owned by ${result.lease.kernelId} (${result.lease.ownerId})`);
    }

    const owner: ActiveOwner = { lease, admitting: false };
    this.active.set(accountId, owner);
    try {
      const connectionConfig = await this.accounts.getProjectionConfig(account);
      await adapter.activate({
        account,
        connectionConfig,
        onInbound: async envelope => {
          const active = this.active.get(accountId);
          if (!active?.admitting || active.lease !== owner.lease) return;
          if (envelope.accountId !== accountId || envelope.channelType !== account.channelType) {
            throw new Error('Connector inbound identity does not match its owner lease');
          }
          const liveLease = await this.data.call<ChannelOwnerLease | undefined>(
            'getChannelOwnerLease',
            accountId,
            this.now().toISOString(),
          );
          if (!liveLease || liveLease.ownerId !== owner.lease.ownerId
            || liveLease.kernelId !== owner.lease.kernelId
            || liveLease.generation !== owner.lease.generation) return;
          await this.inbound(envelope);
        },
        onStatus: status => this.accounts.setRuntimeState({
          accountId,
          status: status.state,
          ...(status.detail ? { statusDetail: status.detail } : {}),
        }).then(() => undefined),
      });
      owner.admitting = true;
      owner.renewTimer = setInterval(() => void this.renew(accountId, owner), this.renewIntervalMs());
      owner.renewTimer.unref?.();
      return lease;
    } catch (error) {
      this.active.delete(accountId);
      await adapter.deactivate(accountId).catch(() => undefined);
      await this.data.call('releaseChannelOwnerLease', {
        accountId,
        ownerId: lease.ownerId,
        kernelId,
        generation,
      }).catch(() => undefined);
      await this.accounts.setRuntimeState({
        accountId,
        status: 'error',
        statusDetail: safeError(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  async deactivate(accountId: CanonicalChannelAccount['id']): Promise<void> {
    const owner = this.active.get(accountId);
    if (!owner) return;
    owner.admitting = false;
    this.active.delete(accountId);
    if (owner.renewTimer) clearInterval(owner.renewTimer);
    const adapter = this.adapters.get(owner.lease.kernelId);
    await adapter?.deactivate(accountId).catch(() => undefined);
    await this.data.call('releaseChannelOwnerLease', {
      accountId,
      ownerId: owner.lease.ownerId,
      kernelId: owner.lease.kernelId,
      generation: owner.lease.generation,
    }).catch(() => undefined);
    await this.accounts.setRuntimeState({ accountId, status: 'disconnected' }).catch(() => undefined);
  }

  async reconcile(): Promise<Array<{ accountId: string; kernelId: KernelId; ok: boolean; error?: string }>> {
    const accounts = await this.accounts.list();
    const bindings = await this.data.call<CanonicalChannelBinding[]>('listChannelBindings');
    const bindingByAccount = new Map<string, CanonicalChannelBinding>();
    for (const binding of bindings) if (!bindingByAccount.has(binding.accountId)) bindingByAccount.set(binding.accountId, binding);
    const results: Array<{ accountId: string; kernelId: KernelId; ok: boolean; error?: string }> = [];
    for (const account of accounts) {
      const binding = bindingByAccount.get(account.id);
      if (!account.enabled || !binding) continue;
      try {
        await this.activate(account.id, binding.kernelId);
        results.push({ accountId: account.id, kernelId: binding.kernelId, ok: true });
      } catch (error) {
        results.push({ accountId: account.id, kernelId: binding.kernelId, ok: false, error: safeError(error) });
      }
    }
    return results;
  }

  async send(kernelId: KernelId, message: ChannelOutboundEnvelope): Promise<void> {
    const owner = this.active.get(message.accountId);
    if (!owner?.admitting || owner.lease.kernelId !== kernelId) {
      throw new Error(`Channel account has no active ${kernelId} owner: ${message.accountId}`);
    }
    await this.adapters.require(kernelId).send(message);
  }

  async targets(accountId: CanonicalChannelAccount['id'], kernelId: KernelId, query?: string) {
    return this.adapters.require(kernelId).targets(accountId, query);
  }

  activeLease(accountId: CanonicalChannelAccount['id']): ChannelOwnerLease | undefined {
    return this.active.get(accountId)?.lease;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled([...this.active.keys()].map(accountId => this.deactivate(accountId)));
  }

  private async renew(accountId: CanonicalChannelAccount['id'], owner: ActiveOwner): Promise<void> {
    if (this.active.get(accountId) !== owner || !owner.admitting) return;
    const now = this.now();
    const next: ChannelOwnerLease = {
      ...owner.lease,
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs()).toISOString(),
      updatedAt: now.toISOString(),
    };
    const renewed = await this.data.call<boolean>('renewChannelOwnerLease', {
      ...next,
      now: now.toISOString(),
    }).catch(() => false);
    if (renewed) {
      owner.lease = next;
      return;
    }
    owner.admitting = false;
    if (owner.renewTimer) clearInterval(owner.renewTimer);
    this.active.delete(accountId);
    await this.adapters.get(owner.lease.kernelId)?.deactivate(accountId).catch(() => undefined);
    await this.accounts.setRuntimeState({
      accountId,
      status: 'error',
      statusDetail: 'Channel owner lease was lost',
    }).catch(() => undefined);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private leaseDurationMs(): number {
    return Math.max(this.options.leaseDurationMs ?? 30_000, 3_000);
  }

  private renewIntervalMs(): number {
    return Math.min(
      Math.max(this.options.renewIntervalMs ?? 10_000, 1_000),
      Math.floor(this.leaseDurationMs() / 2),
    );
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/((?:token|secret|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}
