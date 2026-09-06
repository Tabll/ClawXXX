import { createHash } from 'node:crypto';
import type { AcpChatLoadPayload } from '@shared/acp-chat/types';
import type { KernelContextBlock } from '@shared/conversations/contracts';
import type { KernelRunIdentity, KernelRunRequest } from '@shared/kernels/contracts';

export function managedOpenClawSessionKey(input: KernelRunIdentity & { agentId?: string }): string {
  const agentId = input.agentId || 'main';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(agentId)) throw new Error('Invalid managed OpenClaw agent id');
  const identity = JSON.stringify([input.conversationId, input.runId, input.generation]);
  return `agent:${agentId}:dashboard:incognito-clawx-${createHash('sha256').update(identity).digest('hex')}`;
}

export function openClawPermissionMode(mode: KernelRunRequest['permissionMode']): 'read-only' | 'guarded' | 'workspace' {
  switch (mode) {
    case undefined:
    case 'default': return 'workspace';
    case 'ask': return 'guarded';
    case 'deny': return 'read-only';
    default: throw new Error('Unsupported managed OpenClaw permission mode');
  }
}

export function openClawModelRef(providerId?: string, modelId?: string): string | undefined {
  if (!modelId) {
    if (providerId) throw new Error('A model is required when selecting an OpenClaw provider');
    return undefined;
  }
  return providerId && !modelId.startsWith(`${providerId}/`) ? `${providerId}/${modelId}` : modelId;
}

export function compileManagedOpenClawSession(input: KernelRunRequest): {
  managedSession: NonNullable<AcpChatLoadPayload['managedSession']>;
  prompt: string;
} {
  const history: KernelContextBlock[] = [];
  const current: KernelContextBlock[] = [];
  for (const item of input.context) {
    const block = item as KernelContextBlock;
    if (!block.turnId || !['user', 'assistant', 'tool'].includes(block.role)
      || !Number.isInteger(block.position) || block.position < 0
      || block.revoked || ['private', 'secret'].includes(block.visibility)
      || (block.kernelId && block.kernelId !== 'openclaw' && block.visibility !== 'portable')) {
      throw new Error('OpenClaw requires role-preserving, admitted canonical context');
    }
    if (block.turnId === input.turnId) {
      if (block.role !== 'user') throw new Error('The current canonical turn must be a user turn');
      current.push(block);
    } else history.push(block);
  }
  if (!current.length) throw new Error('The current canonical turn is missing');
  // Metadata and blob references are transport bookkeeping, not user text.
  const prompt = current.sort((a, b) => a.position - b.position)
    .filter(block => block.type === 'text' || block.type === 'summary')
    .map(block => block.text ?? '').filter(Boolean).join('\n\n');
  return {
    managedSession: {
      protocol: 'clawx.openclaw-session/v1',
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
      generation: input.generation,
      agentId: input.agentId,
      history,
      model: openClawModelRef(input.providerId, input.modelId),
      permissionMode: openClawPermissionMode(input.permissionMode),
    },
    prompt,
  };
}
