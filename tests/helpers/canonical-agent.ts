import type { AgentRunSnapshot } from '@shared/domains/agents';
import { asAgentId } from '@shared/domains/identity';
import type { KernelId } from '@shared/kernels/contracts';

export function testAgentRouting(
  kernelId: KernelId,
  input: {
    agentId?: string;
    displayName?: string;
    workspaceUri?: string;
    providerId?: string;
    modelId?: string;
    canonicalVersion?: number;
  } = {},
): {
  agentId: string;
  workspaceUri: string;
  providerId?: string;
  modelId?: string;
  agentSnapshot: AgentRunSnapshot;
} {
  const agentId = input.agentId ?? 'main';
  const workspaceUri = input.workspaceUri ?? 'file:///tmp/clawx-test-workspace';
  const model = input.providerId && input.modelId
    ? {
        providerAccountId: input.providerId,
        providerId: input.providerId,
        modelId: input.modelId,
      }
    : undefined;
  return {
    agentId,
    workspaceUri,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    agentSnapshot: {
      agentId: asAgentId(agentId),
      displayName: input.displayName ?? 'Test Agent',
      kernelId,
      workspaceUri,
      ...(model ? { model } : {}),
      canonicalVersion: input.canonicalVersion ?? 1,
    },
  };
}
