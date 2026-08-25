import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GatewayManager } from '../gateway/manager';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { AgentsSnapshot, AgentSummary } from '@shared/types/agent';
import type { CanonicalAgent } from '@shared/domains/agents';
import type { KernelId } from '@shared/kernels/contracts';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentModel,
  updateAgentName,
} from '../utils/agent-config';
import { deleteChannelAccountConfig } from '../utils/channel-config';
import { ensureClawXContext } from '../utils/openclaw-workspace';
import { isRecord } from './payload-utils';
import { syncAgentModelOverrideToRuntime, syncAllProviderAuthToRuntime } from './providers/provider-runtime-sync';
import type { RemoteDataServiceClient } from '../data/data-service-utility-host';
import { CanonicalAgentService, canonicalModelRef } from '../domains/agents/agent-service';
import type { AgentProjectionReconciler } from '../domains/agents/agent-projection-reconciler';

type AgentsApiContext = {
  gatewayManager: GatewayManager;
  dataClient?: RemoteDataServiceClient;
  agentService?: CanonicalAgentService;
  projectionReconciler?: AgentProjectionReconciler;
};

function requireString(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string' || !payload[key].trim()) {
    throw new Error(`${key} is required`);
  }
  return payload[key].trim();
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? payload[key].trim() : undefined;
}

function kernelIds(payload: Record<string, unknown>, fallback: KernelId[]): KernelId[] {
  if (!Array.isArray(payload.kernelIds)) return fallback;
  const values = [...new Set(payload.kernelIds.filter((value): value is string => (
    typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
  )))] as KernelId[];
  if (values.length === 0) throw new Error('At least one valid kernelId is required');
  return values;
}

function workspacePath(uri: string): string {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'file:' ? fileURLToPath(parsed) : uri;
  } catch {
    return uri;
  }
}

function toSummary(agent: CanonicalAgent): AgentSummary {
  const modelRef = canonicalModelRef(agent.model);
  return {
    id: agent.id,
    name: agent.displayName,
    modelDisplay: agent.model?.modelId ?? 'Default per kernel',
    modelRef,
    overrideModelRef: modelRef,
    inheritedModel: !agent.model,
    workspace: workspacePath(agent.workspaceUri),
    agentDir: '',
    mainSessionKey: `agent:${agent.id}:main`,
    channelTypes: [],
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.persona ? { persona: agent.persona } : {}),
    ...(agent.presetId ? { presetId: agent.presetId } : {}),
    supportedKernels: [...agent.supportedKernels],
    defaultForKernels: [...agent.defaultForKernels],
    projections: agent.projections.map(projection => ({
      kernelId: projection.kernelId,
      status: projection.state,
      desiredVersion: projection.desiredVersion,
      ...(projection.appliedVersion === undefined ? {} : { appliedVersion: projection.appliedVersion }),
      ...(projection.nativeId ? { nativeId: projection.nativeId } : {}),
      ...(projection.error ? { error: projection.error.message } : {}),
      updatedAt: projection.updatedAt,
    })),
    version: agent.version,
    ...(agent.deletedAt ? { deletedAt: agent.deletedAt } : {}),
  };
}

async function canonicalSnapshot(
  service: CanonicalAgentService,
  loadOpenClawSnapshot: () => Promise<Awaited<ReturnType<typeof listAgentsSnapshot>>> = listAgentsSnapshot,
): Promise<AgentsSnapshot> {
  const [agents, defaults] = await Promise.all([service.list(), service.defaults()]);
  const summaries = agents.map(toSummary);
  const snapshot: AgentsSnapshot = {
    agents: summaries,
    kernelDefaults: defaults.map(entry => ({ ...entry })),
    defaultModelRef: null,
    configuredChannelTypes: [],
    channelOwners: {},
    channelAccountOwners: {},
  };
  // Until Channels cut over to their canonical M12 tables, expose their
  // OpenClaw config projection through canonical Agent IDs. OpenClaw IDs are
  // never returned as authority: the kernel-scoped projection is the only
  // translation seam, and absence/failure leaves the canonical catalog usable.
  const nativeToCanonical = new Map<string, string>();
  for (const agent of agents) {
    const nativeId = agent.projections.find(projection => (
      projection.kernelId === 'openclaw' && projection.nativeId
    ))?.nativeId;
    if (nativeId) nativeToCanonical.set(nativeId.toLowerCase(), agent.id);
  }
  if (nativeToCanonical.size === 0) return snapshot;
  try {
    const projected = await loadOpenClawSnapshot();
    const projectedAgents = new Map(projected.agents.map(agent => [agent.id.toLowerCase(), agent]));
    for (const agent of agents) {
      const nativeId = agent.projections.find(value => value.kernelId === 'openclaw')?.nativeId;
      const legacy = nativeId ? projectedAgents.get(nativeId.toLowerCase()) : undefined;
      const summary = summaries.find(value => value.id === agent.id);
      if (legacy && summary) summary.channelTypes = [...legacy.channelTypes];
    }
    const canonicalOwner = (nativeId: string): string => (
      nativeToCanonical.get(nativeId.toLowerCase()) ?? nativeId
    );
    snapshot.defaultModelRef = projected.defaultModelRef;
    snapshot.configuredChannelTypes = [...projected.configuredChannelTypes];
    snapshot.channelOwners = Object.fromEntries(Object.entries(projected.channelOwners)
      .map(([channelType, nativeId]) => [channelType, canonicalOwner(nativeId)]));
    snapshot.channelAccountOwners = Object.fromEntries(Object.entries(projected.channelAccountOwners)
      .map(([account, nativeId]) => [account, canonicalOwner(nativeId)]));
  } catch {
    // A missing/stopped optional runtime must not make canonical Agents unreadable.
  }
  return snapshot;
}

function legacySnapshot(snapshot: Awaited<ReturnType<typeof listAgentsSnapshot>>): AgentsSnapshot {
  return {
    agents: snapshot.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      modelDisplay: agent.modelDisplay,
      modelRef: agent.modelRef,
      overrideModelRef: agent.overrideModelRef,
      inheritedModel: agent.inheritedModel,
      workspace: agent.workspace,
      agentDir: agent.agentDir,
      mainSessionKey: agent.mainSessionKey,
      channelTypes: agent.channelTypes,
      supportedKernels: ['openclaw'],
      defaultForKernels: agent.isDefault ? ['openclaw'] : [],
      projections: [],
      version: 1,
    })),
    kernelDefaults: [{
      kernelId: 'openclaw',
      agentId: snapshot.defaultAgentId,
      updatedAt: new Date(0).toISOString(),
    }],
    defaultModelRef: snapshot.defaultModelRef,
    configuredChannelTypes: snapshot.configuredChannelTypes,
    channelOwners: snapshot.channelOwners,
    channelAccountOwners: snapshot.channelAccountOwners,
  };
}

function createLegacyAgentsApi(): CompleteHostServiceRegistry['agents'] {
  const snapshot = async () => legacySnapshot(await listAgentsSnapshot());
  return {
    list: async () => ({ success: true, ...await snapshot() }),
    create: async payload => {
      const result = legacySnapshot(await createAgent(requireString(payload, 'name'), {
        inheritWorkspace: isRecord(payload) ? payload.inheritWorkspace === true : undefined,
      }));
      syncAllProviderAuthToRuntime().catch(() => undefined);
      void ensureClawXContext({ waitForAllConfiguredWorkspaces: true }).catch(() => undefined);
      return { success: true, ...result };
    },
    update: async payload => ({
      success: true,
      ...legacySnapshot(await updateAgentName(requireString(payload, 'id'), requireString(payload, 'name'))),
    }),
    updateModel: async payload => {
      const id = requireString(payload, 'id');
      const modelRef = isRecord(payload) && typeof payload.modelRef === 'string' ? payload.modelRef : null;
      const result = legacySnapshot(await updateAgentModel(id, modelRef));
      await syncAllProviderAuthToRuntime();
      await syncAgentModelOverrideToRuntime(id);
      return { success: true, ...result };
    },
    delete: async payload => {
      if (!isRecord(payload) || payload.preserveHistory !== true) {
        throw new Error('Agent deletion must explicitly preserve history');
      }
      const { snapshot: next, removedEntry } = await deleteAgentConfig(requireString(payload, 'id'));
      await removeAgentWorkspaceDirectory(removedEntry).catch(() => undefined);
      return { success: true, ...legacySnapshot(next) };
    },
    setDefault: async () => { throw new Error('Kernel-scoped Agent defaults require canonical DataService'); },
    reconcile: async () => { throw new Error('Agent reconciliation requires canonical DataService'); },
    assignChannel: async payload => ({
      success: true,
      ...legacySnapshot(await assignChannelToAgent(requireString(payload, 'id'), requireString(payload, 'channelType'))),
    }),
    removeChannel: async payload => {
      const id = requireString(payload, 'id');
      const channelType = requireString(payload, 'channelType');
      const before = await listAgentsSnapshot();
      const ownerId = id.toLowerCase();
      const accounts = Object.entries(before.channelAccountOwners)
        .filter(([key, owner]) => owner === ownerId && key.startsWith(`${channelType}:`))
        .map(([key]) => key.slice(key.indexOf(':') + 1));
      if (accounts.length === 0) accounts.push(resolveAccountIdForAgent(id));
      for (const accountId of accounts) {
        await deleteChannelAccountConfig(channelType, accountId);
        await clearChannelBinding(channelType, accountId);
      }
      return { success: true, ...await snapshot() };
    },
  };
}

export function createAgentsApi(ctx: AgentsApiContext): CompleteHostServiceRegistry['agents'] {
  const service = ctx.agentService ?? (ctx.dataClient
    ? new CanonicalAgentService(ctx.dataClient, id => pathToFileURL(id).href)
    : undefined);
  if (!service) return createLegacyAgentsApi();
  const snapshot = () => canonicalSnapshot(service);
  const reconcile = async (id: string, kernels?: KernelId[]) => {
    await ctx.projectionReconciler?.reconcileAgent(id, kernels);
  };
  return {
    list: async () => ({ success: true, ...await snapshot() }),
    create: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      const created = await service.create({
        displayName: requireString(body, 'name'),
        supportedKernels: kernelIds(body, ['openclaw', 'deepseek-harness']),
        ...(optionalString(body, 'workspaceUri') ? { workspaceUri: optionalString(body, 'workspaceUri') } : {}),
        ...(optionalString(body, 'description') ? { description: optionalString(body, 'description') } : {}),
        ...(optionalString(body, 'persona') ? { persona: optionalString(body, 'persona') } : {}),
        ...(optionalString(body, 'presetId') ? { presetId: optionalString(body, 'presetId') } : {}),
        ...(typeof body.modelRef === 'string' || body.modelRef === null
          ? { modelRef: body.modelRef as string | null }
          : {}),
      });
      await reconcile(created.id);
      return { success: true, ...await snapshot() };
    },
    update: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      const id = requireString(body, 'id');
      const updated = await service.update(id, {
        ...(optionalString(body, 'name') !== undefined ? { displayName: optionalString(body, 'name') } : {}),
        ...(body.workspaceUri !== undefined ? { workspaceUri: optionalString(body, 'workspaceUri') } : {}),
        ...(body.description !== undefined ? { description: optionalString(body, 'description') } : {}),
        ...(body.persona !== undefined ? { persona: optionalString(body, 'persona') } : {}),
        ...(body.presetId !== undefined ? { presetId: optionalString(body, 'presetId') } : {}),
        ...(Array.isArray(body.kernelIds) ? { supportedKernels: kernelIds(body, []) } : {}),
      });
      await reconcile(updated.id);
      return { success: true, ...await snapshot() };
    },
    updateModel: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      const id = requireString(body, 'id');
      const updated = await service.update(id, {
        modelRef: typeof body.modelRef === 'string' ? body.modelRef : null,
      });
      await reconcile(updated.id);
      return { success: true, ...await snapshot() };
    },
    delete: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      if (body.preserveHistory !== true) throw new Error('Agent deletion must explicitly preserve history');
      const id = requireString(body, 'id');
      const agent = await service.get(id);
      if (!agent) throw new Error(`Agent not found: ${id}`);
      await ctx.projectionReconciler?.removeAgent(agent);
      await service.delete(id);
      return { success: true, ...await snapshot() };
    },
    setDefault: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      const entry = await service.setDefault(
        requireString(body, 'kernelId') as KernelId,
        requireString(body, 'id'),
      );
      await ctx.projectionReconciler?.reconcileDefault(entry);
      return { success: true, ...await snapshot() };
    },
    reconcile: async payload => {
      const body: Record<string, unknown> = isRecord(payload) ? payload : {};
      const id = requireString(body, 'id');
      await reconcile(id, Array.isArray(body.kernelIds) ? kernelIds(body, []) : undefined);
      return { success: true, ...await snapshot() };
    },
    assignChannel: async payload => {
      const agent = await service.get(requireString(payload, 'id'));
      const nativeId = agent?.projections.find(value => value.kernelId === 'openclaw')?.nativeId;
      if (!nativeId) throw new Error('Agent has no OpenClaw projection for this Channel operation');
      await assignChannelToAgent(nativeId, requireString(payload, 'channelType'));
      return { success: true, ...await snapshot() };
    },
    removeChannel: async payload => {
      const agent = await service.get(requireString(payload, 'id'));
      const nativeId = agent?.projections.find(value => value.kernelId === 'openclaw')?.nativeId;
      if (!nativeId) throw new Error('Agent has no OpenClaw projection for this Channel operation');
      const channelType = requireString(payload, 'channelType');
      const accountId = resolveAccountIdForAgent(nativeId);
      await deleteChannelAccountConfig(channelType, accountId);
      await clearChannelBinding(channelType, accountId);
      return { success: true, ...await snapshot() };
    },
  };
}
