import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { CanonicalAgent, KernelAgentDefault } from '@shared/domains/agents';
import { asAgentId } from '@shared/domains/identity';
import type { KernelId } from '@shared/kernels/contracts';
import { canonicalModelFromRef, type AgentDataClient } from './agent-service';

export type LegacyAgentSnapshot = {
  agents: Array<{
    id: string;
    name: string;
    workspace: string;
    modelRef?: string | null;
  }>;
  defaultAgentId: string;
};

function workspaceUri(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return pathToFileURL(resolve(value)).href;
  }
}

/**
 * One-time metadata cutover. Conversation/Cron history is deliberately not
 * inspected; only current OpenClaw Agent configuration may seed the canonical
 * catalog. If OpenClaw is absent, a kernel-neutral Main Agent is created.
 */
export async function ensureCanonicalAgentCatalog(input: {
  data: AgentDataClient;
  defaultWorkspaceUri: string;
  openClawAvailable: boolean;
  loadOpenClawSnapshot?: () => Promise<LegacyAgentSnapshot>;
  now?: () => Date;
}): Promise<void> {
  const existing = await input.data.call<CanonicalAgent[]>('listAgents', true);
  if (existing.length > 0) return;
  const now = (input.now ?? (() => new Date()))().toISOString();
  let imported: LegacyAgentSnapshot | undefined;
  if (input.openClawAvailable && input.loadOpenClawSnapshot) {
    imported = await input.loadOpenClawSnapshot();
  }
  const source = imported?.agents.length
    ? imported.agents
    : [{ id: 'main', name: 'Main Agent', workspace: input.defaultWorkspaceUri, modelRef: null }];
  for (const entry of source) {
    const model = canonicalModelFromRef(entry.modelRef);
    const agent: CanonicalAgent = {
      id: asAgentId(entry.id.trim()),
      displayName: entry.name.trim() || entry.id,
      workspaceUri: workspaceUri(entry.workspace || input.defaultWorkspaceUri),
      ...(model ? { model } : {}),
      enabled: true,
      supportedKernels: ['openclaw', 'deepseek-harness'],
      defaultForKernels: [],
      projections: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await input.data.call('putAgent', agent);
  }
  const ids = new Set(source.map(entry => entry.id));
  const defaultId = imported && ids.has(imported.defaultAgentId)
    ? imported.defaultAgentId
    : source[0]!.id;
  const defaults: KernelId[] = ['openclaw', 'deepseek-harness'];
  for (const kernelId of defaults) {
    const value: KernelAgentDefault = {
      kernelId,
      agentId: asAgentId(defaultId),
      updatedAt: now,
    };
    await input.data.call('setAgentDefault', value);
  }
}
