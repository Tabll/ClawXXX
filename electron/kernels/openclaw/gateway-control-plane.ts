import type {
  CanonicalEntityController,
  KernelControlPlane,
} from '@shared/kernels/contracts';

export type OpenClawGatewayRpc = {
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

function entityController<T extends { id: string }>(
  gateway: OpenClawGatewayRpc,
  domain: string,
): CanonicalEntityController<T> {
  return {
    async list() {
      const result = await gateway.rpc<T[] | { items?: T[] }>(`clawx.${domain}.list`);
      return Array.isArray(result) ? result : result.items ?? [];
    },
    upsert(entity, operationId) {
      return gateway.rpc<T>(`clawx.${domain}.upsert`, { entity, operationId });
    },
    remove(id, operationId) {
      return gateway.rpc<void>(`clawx.${domain}.remove`, { id, operationId });
    },
  };
}

/**
 * Compatibility projection only. Canonical state remains in ClawX repositories;
 * this adapter must never invoke OpenClaw transcript/cron-history usage scans.
 */
export function createOpenClawGatewayControlPlane(gateway: OpenClawGatewayRpc): KernelControlPlane {
  const providers = entityController<import('@shared/domains/providers').CanonicalProviderAccount>(gateway, 'providers');
  const schedulerDisabled = (): never => {
    throw new Error('Cron is Main-owned; OpenClaw native scheduler projections are disabled');
  };
  return {
    agents: entityController(gateway, 'agents'),
    providers: {
      ...providers,
      setDefault: (input, operationId) => gateway.rpc<void>('clawx.providers.default.set', { ...input, operationId }),
    },
    skills: entityController(gateway, 'skills'),
    channels: {
      accounts: entityController(gateway, 'channel-accounts'),
      bindings: entityController(gateway, 'channel-bindings'),
    },
    cron: {
      list: async () => [],
      upsert: async () => schedulerDisabled(),
      remove: async () => schedulerDisabled(),
    },
    usage: {
      query: async () => {
        throw new Error('Usage is Main-owned and must be queried through the ClawX Usage repository');
      },
    },
    diagnostics: () => gateway.rpc<Record<string, unknown>>('clawx.diagnostics'),
  };
}
