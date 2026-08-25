import type { KernelEventEnvelopeV1, KernelId } from '../kernels/contracts';
import type {
  CanonicalContentBlock,
  ConversationId,
  KernelContextSnapshotV1,
  PortableBlockVisibility,
  RunId,
} from './contracts';

export const CONVERSATION_STORE_PROTOCOL = 'clawx.conversation-store/v1' as const;
export const NATIVE_HISTORY_FALLBACK_ALLOWED = false as const;

export type KernelContextBudget = {
  maxBlocks: number;
  maxTextCharacters?: number;
  maxAttachmentBytes?: number;
};

export type ContextCompilationProvenance = {
  compilerVersion: string;
  sourceConversationVersion: number;
  summarizedThroughTurnId?: string;
  redactionPolicyVersion: string;
  budget: KernelContextBudget;
};

export type ConversationCheckpointCodec<T = unknown> = {
  id: string;
  schemaVersion: number;
  kernelId: KernelId;
  encode(value: T): unknown;
  decode(value: unknown): T;
};

export type ConversationStoreProtocolClient = {
  readonly protocol: typeof CONVERSATION_STORE_PROTOCOL;
  readonly nativeHistoryFallback: typeof NATIVE_HISTORY_FALLBACK_ALLOWED;
  compileContext(input: {
    conversationId: ConversationId;
    runId: RunId;
    kernelId: KernelId;
    budget: KernelContextBudget;
  }): Promise<KernelContextSnapshotV1>;
  appendEvents(events: KernelEventEnvelopeV1[]): Promise<{ inserted: number; duplicates: number }>;
  readAttachment(input: {
    grantId: string;
    blobHash: string;
    runId: RunId;
  }): Promise<Uint8Array>;
  putCheckpoint(input: {
    runId: RunId;
    kernelId: KernelId;
    codec: string;
    schemaVersion: number;
    checkpoint: unknown;
    createdAt: string;
  }): Promise<void>;
  getLatestCheckpoint(input: {
    conversationId: ConversationId;
    kernelId: KernelId;
    codec: string;
    schemaVersion: number;
    beforeRunId?: RunId;
  }): Promise<{ runId: RunId; checkpoint: unknown; createdAt: string } | undefined>;
};

export type KernelContextCompiler = {
  readonly version: string;
  compile(input: {
    conversationId: ConversationId;
    runId: RunId;
    kernelId: KernelId;
    budget: KernelContextBudget;
  }): Promise<KernelContextSnapshotV1 & { provenance?: ContextCompilationProvenance }>;
};

export function isBlockVisibleToKernel(
  block: Pick<CanonicalContentBlock, 'visibility' | 'kernelId' | 'revoked'>,
  kernelId: KernelId,
): boolean {
  if (block.revoked || block.visibility === 'private' || block.visibility === 'secret') return false;
  return block.visibility !== 'kernel' || block.kernelId === kernelId;
}

export const PORTABLE_VISIBILITY_RULES: Readonly<Record<PortableBlockVisibility, string>> = {
  portable: 'visible to every kernel unless the attachment grant is revoked',
  kernel: 'visible only to the kernel named by kernelId',
  private: 'durable for UI/audit but never compiled into a later model context',
  secret: 'never persisted as plaintext and never compiled into model context',
};
