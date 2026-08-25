import type { KernelGeneration, KernelId } from '../kernels/contracts';
import type { AgentRunSnapshot } from '../domains/agents';

declare const conversationIdBrand: unique symbol;
declare const turnIdBrand: unique symbol;
declare const runIdBrand: unique symbol;

export type ConversationId = string & { readonly [conversationIdBrand]: true };
export type TurnId = string & { readonly [turnIdBrand]: true };
export type RunId = string & { readonly [runIdBrand]: true };

export type ConversationSummary = {
  id: ConversationId;
  title?: string;
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string;
  workspaceUri?: string;
  lastKernelId?: KernelId;
  /** Every kernel that has durably completed or attempted a run in this Conversation. */
  kernelIds?: KernelId[];
  lastAgentId?: string;
  sourceChannel?: string;
  hasActiveRun?: boolean;
  /** Explicit lineage for compare/fork flows; history before this point is inherited read-only. */
  parentConversationId?: ConversationId;
  branchedFromTurnId?: TurnId;
};

export type ConversationQueryFilters = {
  lastKernelId?: KernelId;
  participatedKernelId?: KernelId;
  agentId?: string;
  sourceChannel?: string;
  workspaceUri?: string;
  pinned?: boolean;
};

export type ConversationPage = {
  items: ConversationSummary[];
  nextCursor?: string;
};

export type BranchConversationInput = {
  sourceConversationId: ConversationId;
  sourceTurnId: TurnId;
  branchConversationId: ConversationId;
  title?: string;
  createdAt: string;
};

export type PortableBlockVisibility = 'portable' | 'kernel' | 'private' | 'secret';

export type CanonicalContentBlock = {
  id: string;
  type: 'text' | 'image' | 'resource-link' | 'tool-call' | 'tool-result' | 'summary' | 'metadata';
  visibility: PortableBlockVisibility;
  kernelId?: KernelId;
  mimeType?: string;
  text?: string;
  json?: unknown;
  blobHash?: string;
  revoked?: boolean;
};

export type RunRoutingSnapshot = {
  kernelId: KernelId;
  kernelVersion: string;
  generation: KernelGeneration;
  agentId: string;
  /** Immutable canonical Agent composition used by this run. */
  agentSnapshot: AgentRunSnapshot;
  workspaceUri?: string;
  providerId?: string;
  modelId?: string;
  contextCompilerVersion: string;
};

export type AdmitRunInput = {
  conversationId: ConversationId;
  turnId: TurnId;
  parentTurnId?: TurnId;
  runId: RunId;
  routing: RunRoutingSnapshot;
  userBlocks: CanonicalContentBlock[];
  attachmentGrants?: Array<{
    id: string;
    blockId: string;
    blobHash: string;
    expiresAt: string;
  }>;
  createdAt: string;
};

export type CommitTerminalRunInput = {
  conversationId: ConversationId;
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  runId: RunId;
  kernelId: KernelId;
  generation: KernelGeneration;
  outcome: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  assistantBlocks: CanonicalContentBlock[];
  usage?: {
    eventKey?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    cost?: number;
    currency?: string;
    source?: 'runtime-event' | 'provider-response';
    /** @deprecated Compatibility input; persisted canonically as USD. */
    costUsd?: number;
  };
  completedAt: string;
};

export type ConversationTurnRecord = {
  id: string;
  role: string;
  position: number;
  createdAt: string;
  blocks: CanonicalContentBlock[];
};

export type ConversationRunEventRecord = {
  eventSeq: number;
  kind: string;
  payload: unknown;
  emittedAt: string;
  nativeEventId?: string;
};

export type ConversationRunRecord = {
  id: RunId;
  turnId: TurnId;
  assistantTurnId?: TurnId;
  kernelId: KernelId;
  kernelVersion: string;
  generation: KernelGeneration;
  agentId: string;
  agentSnapshot: AgentRunSnapshot;
  workspaceUri?: string;
  providerId?: string;
  modelId?: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  events: ConversationRunEventRecord[];
};

export type ConversationExport = {
  schema: 'clawx.conversation-export/v1';
  conversation: ConversationSummary;
  turns: ConversationTurnRecord[];
  runs: ConversationRunRecord[];
  usage: Array<Record<string, unknown>>;
};

export type KernelContextBlock = CanonicalContentBlock & {
  turnId: TurnId;
  role: 'user' | 'assistant' | 'tool';
  position: number;
};

export type KernelContextSnapshotV1 = {
  protocol: 'clawx.conversation-store/v1';
  conversationId: ConversationId;
  runId: RunId;
  kernelId: KernelId;
  compilerVersion: string;
  blocks: KernelContextBlock[];
  omitted: {
    privateBlocks: number;
    secretBlocks: number;
    otherKernelBlocks: number;
    revokedBlocks: number;
    budgetBlocks: number;
  };
  provenance?: {
    sourceConversationVersion: number;
    redactionPolicyVersion: string;
    maxBlocks: number;
    maxTextCharacters?: number;
    contextHash: string;
  };
};

export function asConversationId(value: string): ConversationId {
  return value as ConversationId;
}

export function asTurnId(value: string): TurnId {
  return value as TurnId;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}
