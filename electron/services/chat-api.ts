import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import type { GatewayManager } from '../gateway/manager';
import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import { createAcpChatService, type AcpChatService } from './acp-chat-service';
import type { AcpSessionAccessRegistry } from './acp-session-access-registry';
import type { ConversationRouter } from '../conversations/conversation-router';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { KernelId } from '@shared/kernels/contracts';
import type { StagedAttachmentRegistry } from './attachment-access';

type PendingConfiguration = {
  providerId?: string;
  modelId?: string;
  permissionMode?: 'default' | 'ask' | 'deny';
};

function conversationId(payload: { sessionKey: string; conversationId?: string }) {
  return asConversationId(payload.conversationId?.trim() || payload.sessionKey.trim());
}

function agentId(payload: { sessionKey: string; agentId?: string }): string {
  if (payload.agentId?.trim()) return payload.agentId.trim();
  const match = payload.sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] || 'main';
}

function assertActiveIdentity(
  payload: {
    turnId?: string;
    runId?: string;
    kernelId?: KernelId;
    generation?: number;
  },
  active: {
    turnId: string;
    runId: string;
    kernelId: KernelId;
    generation: number;
  },
): void {
  if (
    (payload.turnId !== undefined && payload.turnId !== active.turnId)
    || (payload.runId !== undefined && payload.runId !== active.runId)
    || (payload.kernelId !== undefined && payload.kernelId !== active.kernelId)
    || (payload.generation !== undefined && payload.generation !== active.generation)
  ) {
    throw new Error('Conversation run identity is stale');
  }
}

/**
 * Chat compatibility facade. With a ConversationRouter installed, ACP is an
 * internal driver transport and no renderer action loads runtime history.
 */
export function createChatApi({
  gatewayManager,
  mainWindow,
  acpSessionAccessRegistry,
  acpChatService,
  conversationRouter,
  stagedAttachments,
}: {
  gatewayManager: GatewayManager;
  mainWindow: BrowserWindow;
  acpSessionAccessRegistry: AcpSessionAccessRegistry;
  acpChatService?: AcpChatService;
  conversationRouter?: ConversationRouter;
  stagedAttachments?: StagedAttachmentRegistry;
}): CompleteHostServiceRegistry['chat'] {
  if (!conversationRouter) {
    const acpChat = acpChatService
      ?? createAcpChatService(mainWindow, acpSessionAccessRegistry, gatewayManager);
    return {
      selectConversationKernel: payload => acpChat.loadSession(payload),
      loadAcpSession: payload => acpChat.loadSession(payload),
      sendAcpPrompt: payload => acpChat.sendPrompt(payload),
      cancelAcpSession: payload => acpChat.cancelSession(payload),
      setAcpSessionConfigOption: payload => acpChat.setSessionConfigOption(payload),
      respondAcpPermission: payload => acpChat.respondPermission(payload),
    };
  }

  const selectedKernels = new Map<string, KernelId>();
  const pendingConfigurations = new Map<string, PendingConfiguration>();

  const selectConversationKernel = async (payload: Parameters<CompleteHostServiceRegistry['chat']['selectConversationKernel']>[0]) => {
      if (!payload.sessionKey.trim() || !payload.cwd || !payload.workspaceRoot) {
        return { success: false, error: 'Invalid Conversation load payload' };
      }
      const id = conversationId(payload);
      const kernelId = payload.kernelId ?? selectedKernels.get(id) ?? 'openclaw';
      const snapshot = conversationRouter.runtimeSnapshot(kernelId);
      const preparedAccessGrant = await acpSessionAccessRegistry.prepareGrant({
        sessionKey: id,
        generation: snapshot.generation,
        workspaceRoot: payload.workspaceRoot,
        executionCwd: payload.cwd,
      });
      acpSessionAccessRegistry.commitGrant(preparedAccessGrant);
      selectedKernels.set(id, kernelId);
      const active = conversationRouter.activeRun(id);
      return {
        success: true,
        generation: snapshot.generation,
        conversationId: id,
        kernelId,
        ...(active ? { ...active, resumedActivePrompt: true } : {}),
      };
  };

  return {
    selectConversationKernel,
    loadAcpSession: selectConversationKernel,
    sendAcpPrompt: async payload => {
      try {
        const id = conversationId(payload);
        const kernelId = payload.kernelId ?? selectedKernels.get(id) ?? 'openclaw';
        selectedKernels.set(id, kernelId);
        const pending = pendingConfigurations.get(id);
        const attachmentInputs = await Promise.all((payload.media ?? []).map(async (media) => {
          const canonicalPath = stagedAttachments?.get(media.stagingId);
          if (!canonicalPath) throw new Error(`Attachment is not staged or has expired: ${media.stagingId}`);
          return {
            data: await readFile(canonicalPath),
            mimeType: media.mimeType || 'application/octet-stream',
            ...(media.fileName ? { fileName: media.fileName } : {}),
          };
        }));
        const accepted = await conversationRouter.prompt({
          conversationId: id,
          turnId: payload.turnId ?? asTurnId(randomUUID()),
          runId: payload.runId ?? asRunId(
            payload.messageId?.trim() ? payload.messageId.trim() : randomUUID(),
          ),
          kernelId,
          generation: payload.generation,
          agentId: agentId(payload),
          workspaceUri: pathToFileURL(payload.cwd).href,
          providerId: payload.providerId ?? pending?.providerId,
          modelId: payload.modelId ?? pending?.modelId,
          permissionMode: pending?.permissionMode,
          message: payload.message ?? '',
          ...(attachmentInputs.length > 0 ? { attachmentInputs } : {}),
        });
        return { success: true, ...accepted };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    cancelAcpSession: async payload => {
      try {
        const id = conversationId(payload);
        const active = conversationRouter.activeRun(id);
        if (!active) return { success: false, error: 'Conversation has no active run' };
        assertActiveIdentity(payload, active);
        await conversationRouter.cancel(active);
        return { success: true, ...active };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    setAcpSessionConfigOption: async payload => {
      try {
        const id = conversationId(payload);
        const previous = pendingConfigurations.get(id) ?? {};
        const value = payload.value;
        const next: PendingConfiguration = { ...previous };
        if (payload.configId === 'provider' && typeof value === 'string') next.providerId = value;
        if (payload.configId === 'model' && typeof value === 'string') next.modelId = value;
        if (
          payload.configId === 'permission_mode'
          && typeof value === 'string'
          && (value === 'default' || value === 'ask' || value === 'deny')
        ) next.permissionMode = value;
        pendingConfigurations.set(id, next);
        const active = conversationRouter.activeRun(id);
        if (active) {
          assertActiveIdentity(payload, active);
          await conversationRouter.configure({ ...active, ...next });
        }
        return { success: true, ...(active ?? {}), configOptions: [] };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    respondAcpPermission: async payload => {
      try {
        const id = conversationId(payload);
        const active = conversationRouter.activeRun(id);
        if (!active) return { success: false, error: 'Conversation has no active run' };
        assertActiveIdentity(payload, active);
        await conversationRouter.resolvePermission({
          ...active,
          requestId: payload.requestId,
          decision: payload.outcome.outcome === 'selected' ? 'allow-once' : 'reject-once',
          ...(payload.outcome.outcome === 'selected' ? { optionId: payload.outcome.optionId } : {}),
        });
        return { success: true, ...active };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
