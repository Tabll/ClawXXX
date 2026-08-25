import { randomUUID } from 'node:crypto';
import type { CanonicalAgent, KernelAgentDefault } from '@shared/domains/agents';
import type { KernelId } from '@shared/kernels/contracts';
import type { KernelSupervisorRegistry } from '../../kernels/supervisor-registry';

export type AgentProjectionDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type AgentProjectionPayload = Omit<CanonicalAgent, 'projections' | 'defaultForKernels' | 'deletedAt'>;

export interface AgentKernelProjectionAdapter {
  readonly kernelId: KernelId;
  available(): boolean | Promise<boolean>;
  upsert(agent: AgentProjectionPayload, operationId: string): Promise<{ nativeId?: string; partial?: boolean }>;
  remove(nativeId: string, operationId: string): Promise<void>;
  setDefault?(nativeId: string, operationId: string): Promise<void>;
}

export type AgentProjectionResult = {
  kernelId: KernelId;
  agentId: string;
  status: 'ready' | 'partial' | 'pending' | 'failed' | 'unsupported';
  nativeId?: string;
  error?: string;
};

function payloadOf(agent: CanonicalAgent): AgentProjectionPayload {
  const {
    projections: _projections,
    defaultForKernels: _defaultForKernels,
    deletedAt: _deletedAt,
    ...payload
  } = agent;
  return structuredClone(payload);
}

export class AgentProjectionReconciler {
  private readonly adapters = new Map<KernelId, AgentKernelProjectionAdapter>();

  constructor(
    private readonly data: AgentProjectionDataClient,
    adapters: AgentKernelProjectionAdapter[],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kernelId)) throw new Error(`Duplicate Agent projection adapter: ${adapter.kernelId}`);
      this.adapters.set(adapter.kernelId, adapter);
    }
  }

  kernelIds(): KernelId[] {
    return [...this.adapters.keys()];
  }

  async reconcileAgent(agentId: string, kernelIds = this.kernelIds()): Promise<AgentProjectionResult[]> {
    const agent = await this.data.call<CanonicalAgent | undefined>('getAgent', agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return Promise.all(kernelIds.map(kernelId => this.reconcileOne(agent, kernelId)));
  }

  async reconcileAll(kernelId?: KernelId): Promise<AgentProjectionResult[]> {
    const agents = await this.data.call<CanonicalAgent[]>('listAgents');
    const kernels = kernelId ? [kernelId] : this.kernelIds();
    return Promise.all(agents.flatMap(agent => kernels.map(candidate => this.reconcileOne(agent, candidate))));
  }

  /**
   * Replays native removals retained on soft-deleted canonical Agents. A
   * projection row is the durable deletion tombstone until its kernel confirms
   * removal, so an offline kernel cannot leave an unowned native Agent behind.
   */
  async reconcileDeleted(kernelId?: KernelId): Promise<AgentProjectionResult[]> {
    const agents = await this.data.call<CanonicalAgent[]>('listAgents', true);
    const deleted = agents.filter(agent => agent.deletedAt);
    return Promise.all(deleted.flatMap(agent => {
      const projections = kernelId
        ? agent.projections.filter(projection => projection.kernelId === kernelId)
        : agent.projections;
      return projections.map(projection => this.removeOne(agent, projection.kernelId));
    }));
  }

  async removeAgent(agent: CanonicalAgent): Promise<AgentProjectionResult[]> {
    return Promise.all(agent.projections.map(projection => this.removeOne(agent, projection.kernelId)));
  }

  async reconcileDefault(entry: KernelAgentDefault): Promise<AgentProjectionResult> {
    const agent = await this.data.call<CanonicalAgent | undefined>('getAgent', entry.agentId);
    if (!agent) throw new Error(`Agent not found: ${entry.agentId}`);
    const projection = agent.projections.find(candidate => candidate.kernelId === entry.kernelId);
    const adapter = this.adapters.get(entry.kernelId);
    if (!adapter?.setDefault) {
      return { kernelId: entry.kernelId, agentId: entry.agentId, status: 'unsupported' };
    }
    if (!projection || (projection.state !== 'ready' && projection.state !== 'partial')) {
      return { kernelId: entry.kernelId, agentId: entry.agentId, status: 'pending' };
    }
    if (!await adapter.available()) {
      return { kernelId: entry.kernelId, agentId: entry.agentId, status: 'pending' };
    }
    try {
      await adapter.setDefault(projection.nativeId ?? agent.id, randomUUID());
      return {
        kernelId: entry.kernelId,
        agentId: entry.agentId,
        status: 'ready',
        nativeId: projection.nativeId ?? agent.id,
      };
    } catch (error) {
      return {
        kernelId: entry.kernelId,
        agentId: entry.agentId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async reconcileOne(agent: CanonicalAgent, kernelId: KernelId): Promise<AgentProjectionResult> {
    const adapter = this.adapters.get(kernelId);
    const existing = agent.projections.find(candidate => candidate.kernelId === kernelId);
    if (!agent.supportedKernels.includes(kernelId)) {
      if (existing && adapter) return this.removeOne(agent, kernelId);
      if (existing) await this.writeProjection(agent, kernelId, 'unsupported', existing.nativeId);
      return { kernelId, agentId: agent.id, status: 'unsupported' };
    }
    if (!adapter) {
      await this.writeProjection(agent, kernelId, 'unsupported', existing?.nativeId);
      return { kernelId, agentId: agent.id, status: 'unsupported' };
    }
    if (!await adapter.available()) {
      await this.writeProjection(agent, kernelId, 'pending', existing?.nativeId);
      return { kernelId, agentId: agent.id, status: 'pending' };
    }
    await this.writeProjection(agent, kernelId, 'applying', existing?.nativeId);
    try {
      const applied = await adapter.upsert(payloadOf(agent), randomUUID());
      const status = applied.partial ? 'partial' : 'ready';
      const nativeId = applied.nativeId ?? agent.id;
      await this.writeProjection(agent, kernelId, status, nativeId);
      return { kernelId, agentId: agent.id, status, nativeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeProjection(agent, kernelId, 'failed', existing?.nativeId, message);
      return { kernelId, agentId: agent.id, status: 'failed', error: message };
    }
  }

  private async removeOne(agent: CanonicalAgent, kernelId: KernelId): Promise<AgentProjectionResult> {
    const projection = agent.projections.find(candidate => candidate.kernelId === kernelId);
    if (!projection) return { kernelId, agentId: agent.id, status: 'ready' };
    const adapter = this.adapters.get(kernelId);
    if (!adapter) {
      await this.writeProjection(agent, kernelId, 'unsupported', projection.nativeId);
      return { kernelId, agentId: agent.id, status: 'unsupported' };
    }
    if (!await adapter.available()) {
      await this.writeProjection(agent, kernelId, 'pending', projection.nativeId);
      return { kernelId, agentId: agent.id, status: 'pending' };
    }
    const nativeId = projection.nativeId ?? agent.id;
    try {
      await adapter.remove(nativeId, randomUUID());
      await this.data.call('deleteProjection', 'agent', agent.id, kernelId);
      return { kernelId, agentId: agent.id, status: 'ready', nativeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeProjection(agent, kernelId, 'failed', projection.nativeId, message);
      return { kernelId, agentId: agent.id, status: 'failed', error: message };
    }
  }

  private async writeProjection(
    agent: CanonicalAgent,
    kernelId: KernelId,
    status: string,
    nativeId?: string,
    error?: string,
  ): Promise<void> {
    await this.data.call('upsertProjection', {
      entityType: 'agent',
      entityId: agent.id,
      kernelId,
      desiredVersion: agent.version,
      ...(status === 'ready' || status === 'partial' ? { appliedVersion: agent.version } : {}),
      status,
      ...(nativeId ? { nativeId } : {}),
      ...(error ? { error } : {}),
      updatedAt: this.now().toISOString(),
    });
  }
}

export function createSupervisorAgentProjectionAdapter(
  supervisors: KernelSupervisorRegistry,
  kernelId: KernelId,
): AgentKernelProjectionAdapter {
  return {
    kernelId,
    available: () => supervisors.status(kernelId).state === 'ready',
    async upsert(agent, operationId) {
      const result = await supervisors.request<{ id?: string }>(
        kernelId,
        'control.agents.upsert',
        { entity: agent, operationId },
      );
      return { nativeId: result?.id ?? agent.id };
    },
    remove: (nativeId, operationId) => supervisors.request(
      kernelId,
      'control.agents.remove',
      { id: nativeId, operationId },
    ),
    setDefault: (nativeId, operationId) => supervisors.request(
      kernelId,
      'control.agents.default.set',
      { agentId: nativeId, operationId },
    ),
  };
}
