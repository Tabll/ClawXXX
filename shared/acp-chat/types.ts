import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ConversationId, KernelContextBlock, RunId, TurnId } from '../conversations/contracts';
import type { KernelId } from '../kernels/contracts';

export type AcpJsonRecord = Record<string, unknown>;

export type AcpSessionKeyPayload = {
  sessionKey: string;
  conversationId?: ConversationId;
  turnId?: TurnId;
  runId?: RunId;
  kernelId?: KernelId;
  generation?: number;
};

export type AcpChatLoadPayload = AcpSessionKeyPayload & {
  workspaceRoot: string;
  cwd: string;
  createIfMissing?: boolean;
  /** Main-owned, one-run context. Never populated from renderer/session history. */
  managedSession?: {
    protocol: 'clawx.openclaw-session/v1';
    conversationId: string;
    runId: string;
    turnId: string;
    generation: number;
    agentId: string;
    history: KernelContextBlock[];
    model?: string;
    permissionMode: 'read-only' | 'guarded' | 'workspace';
  };
};

export type AcpPromptMediaItem = {
  filePath: string;
  stagingId: string;
  fileName?: string;
  mimeType?: string;
};

export type AcpChatPromptPayload = AcpSessionKeyPayload & {
  cwd: string;
  message?: string;
  media?: AcpPromptMediaItem[];
  messageId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
};

export type AcpChatCancelPayload = AcpSessionKeyPayload;

export type AcpChatSetConfigOptionPayload = AcpSessionKeyPayload & ({
  configId: string;
  value: string;
} | {
  configId: string;
  value: boolean;
  type: 'boolean';
});

export type AcpChatRespondPermissionPayload = AcpSessionKeyPayload & {
  requestId: string;
  outcome: RequestPermissionResponse['outcome'];
};

export type AcpChatOperationResult = {
  success: boolean;
  stopReason?: string;
  error?: string;
  generation?: number;
  /** The requested session still has a live prompt and was reactivated without history replay. */
  resumedActivePrompt?: boolean;
  /** Raw notifications collected while session/load is in progress. */
  sessionUpdates?: AcpSessionUpdateEnvelope[];
  /** Full ACP session configuration snapshot returned after a successful update. */
  configOptions?: SessionConfigOption[];
  conversationId?: ConversationId;
  turnId?: TurnId;
  runId?: RunId;
  kernelId?: KernelId;
};

export type AcpSessionUpdateEnvelope = {
  sessionKey: string;
  generation: number;
  conversationId?: ConversationId;
  runId?: RunId;
  kernelId?: KernelId;
  eventSeq?: number;
  /** True for ACP updates emitted while session/load is replaying history. */
  historical?: boolean;
  notification: SessionNotification;
};

export type AcpPermissionRequestEnvelope = {
  sessionKey: string;
  generation: number;
  conversationId?: ConversationId;
  runId?: RunId;
  kernelId?: KernelId;
  eventSeq?: number;
  requestId: string;
  request: RequestPermissionRequest;
};

export type AcpPromptContentBlock = ContentBlock;
