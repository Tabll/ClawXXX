import type {
  AgentRunSnapshot,
  CanonicalAgent,
  CanonicalModelSelection,
  KernelAgentDefault,
} from '@shared/domains/agents';
import { asAgentId } from '@shared/domains/identity';
import type { KernelId } from '@shared/kernels/contracts';

export type AgentDataClient = {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
};

export type CreateCanonicalAgentInput = {
  displayName: string;
  description?: string;
  persona?: string;
  presetId?: string;
  workspaceUri?: string;
  modelRef?: string | null;
  supportedKernels: KernelId[];
};

export type UpdateCanonicalAgentInput = Partial<Omit<CreateCanonicalAgentInput, 'supportedKernels'>> & {
  supportedKernels?: KernelId[];
};

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized && !/^\d+$/.test(normalized) ? normalized : 'agent';
}

export function canonicalModelFromRef(modelRef: string | null | undefined): CanonicalModelSelection | undefined {
  const normalized = normalizedText(modelRef ?? undefined);
  if (!normalized) return undefined;
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error('modelRef must be in provider/model format');
  }
  const providerId = normalized.slice(0, separator);
  return {
    providerAccountId: providerId,
    providerId,
    modelId: normalized.slice(separator + 1),
  };
}

export function canonicalModelRef(model: CanonicalModelSelection | undefined): string | null {
  return model ? `${model.providerAccountId ?? model.providerId}/${model.modelId}` : null;
}

function uniqueKernelIds(kernelIds: KernelId[]): KernelId[] {
  const result = [...new Set(kernelIds.map(value => value.trim()).filter(Boolean))] as KernelId[];
  if (result.length === 0) throw new Error('At least one target kernel is required');
  return result;
}

export class CanonicalAgentService {
  constructor(
    private readonly data: AgentDataClient,
    private readonly defaultWorkspaceUri: (agentId: string) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(includeDeleted = false): Promise<CanonicalAgent[]> {
    return this.data.call('listAgents', includeDeleted);
  }

  get(id: string, includeDeleted = false): Promise<CanonicalAgent | undefined> {
    return this.data.call('getAgent', id, includeDeleted);
  }

  defaults(): Promise<KernelAgentDefault[]> {
    return this.data.call('listAgentDefaults');
  }

  async create(input: CreateCanonicalAgentInput): Promise<CanonicalAgent> {
    const displayName = normalizedText(input.displayName);
    if (!displayName) throw new Error('Agent display name is required');
    const existing = await this.list(true);
    const ids = new Set<string>(existing.map(agent => agent.id));
    const base = slug(displayName);
    let id = base;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
    const timestamp = this.now().toISOString();
    const agent: CanonicalAgent = {
      id: asAgentId(id),
      displayName,
      ...(normalizedText(input.description) ? { description: normalizedText(input.description) } : {}),
      ...(normalizedText(input.persona) ? { persona: normalizedText(input.persona) } : {}),
      ...(normalizedText(input.presetId) ? { presetId: normalizedText(input.presetId) } : {}),
      workspaceUri: normalizedText(input.workspaceUri) ?? this.defaultWorkspaceUri(id),
      ...(canonicalModelFromRef(input.modelRef) ? { model: canonicalModelFromRef(input.modelRef) } : {}),
      enabled: true,
      supportedKernels: uniqueKernelIds(input.supportedKernels),
      defaultForKernels: [],
      projections: [],
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.data.call('putAgent', agent);
    return agent;
  }

  async update(id: string, updates: UpdateCanonicalAgentInput): Promise<CanonicalAgent> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    const model = updates.modelRef === undefined
      ? existing.model
      : canonicalModelFromRef(updates.modelRef);
    const next: CanonicalAgent = {
      ...existing,
      ...(updates.displayName === undefined
        ? {}
        : { displayName: normalizedText(updates.displayName) ?? existing.displayName }),
      ...(updates.description === undefined
        ? {}
        : { description: normalizedText(updates.description) }),
      ...(updates.persona === undefined ? {} : { persona: normalizedText(updates.persona) }),
      ...(updates.presetId === undefined ? {} : { presetId: normalizedText(updates.presetId) }),
      ...(updates.workspaceUri === undefined
        ? {}
        : { workspaceUri: normalizedText(updates.workspaceUri) ?? existing.workspaceUri }),
      ...(updates.supportedKernels === undefined
        ? {}
        : { supportedKernels: uniqueKernelIds(updates.supportedKernels) }),
      ...(model ? { model } : {}),
      version: existing.version + 1,
      updatedAt: this.now().toISOString(),
      projections: existing.projections,
    };
    if (!model) delete next.model;
    if (!next.description) delete next.description;
    if (!next.persona) delete next.persona;
    if (!next.presetId) delete next.presetId;
    next.defaultForKernels = existing.defaultForKernels.filter(kernelId => next.supportedKernels.includes(kernelId));
    await this.data.call('putAgent', next);
    for (const entry of existing.defaultForKernels) {
      if (!next.supportedKernels.includes(entry)) await this.data.call('clearAgentDefault', entry);
    }
    return next;
  }

  async delete(id: string): Promise<CanonicalAgent> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);
    if (existing.defaultForKernels.length > 0) {
      throw new Error(`Agent is still the default for: ${existing.defaultForKernels.join(', ')}`);
    }
    const deletedAt = this.now().toISOString();
    if (!await this.data.call<boolean>('deleteAgent', id, deletedAt)) {
      throw new Error(`Agent not found: ${id}`);
    }
    return {
      ...existing,
      enabled: false,
      defaultForKernels: [],
      version: existing.version + 1,
      updatedAt: deletedAt,
      deletedAt,
    };
  }

  async setDefault(kernelId: KernelId, id: string): Promise<KernelAgentDefault> {
    const agent = await this.get(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    if (!agent.supportedKernels.includes(kernelId)) throw new Error(`Agent does not support kernel ${kernelId}`);
    const entry: KernelAgentDefault = {
      kernelId,
      agentId: agent.id,
      updatedAt: this.now().toISOString(),
    };
    await this.data.call('setAgentDefault', entry);
    return entry;
  }

  async resolveRunSnapshot(input: {
    agentId?: string;
    kernelId: KernelId;
    providerId?: string;
    modelId?: string;
  }): Promise<AgentRunSnapshot> {
    const defaultEntry = input.agentId ? undefined : await this.data.call<KernelAgentDefault | undefined>(
      'getAgentDefault',
      input.kernelId,
    );
    const id = input.agentId ?? defaultEntry?.agentId;
    if (!id) throw new Error(`No default Agent is configured for kernel ${input.kernelId}`);
    const agent = await this.get(id);
    if (!agent || !agent.enabled) throw new Error(`Agent is unavailable: ${id}`);
    if (!agent.supportedKernels.includes(input.kernelId)) {
      throw new Error(`Agent ${id} does not support kernel ${input.kernelId}`);
    }
    const projection = agent.projections.find(candidate => candidate.kernelId === input.kernelId);
    if (!projection || (projection.state !== 'ready' && projection.state !== 'partial')) {
      throw new Error(`Agent ${id} is not projected to kernel ${input.kernelId}`);
    }
    const model = input.providerId && input.modelId
      ? {
          providerAccountId: input.providerId,
          providerId: input.providerId,
          modelId: input.modelId,
        }
      : agent.model;
    return {
      agentId: agent.id,
      displayName: agent.displayName,
      kernelId: input.kernelId,
      workspaceUri: agent.workspaceUri,
      ...(agent.persona ? { persona: agent.persona } : {}),
      ...(agent.presetId ? { presetId: agent.presetId } : {}),
      ...(model ? { model } : {}),
      canonicalVersion: agent.version,
    };
  }
}
